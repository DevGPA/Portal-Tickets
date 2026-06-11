'use strict';

const express = require('express');
const multer = require('multer');
const db = require('../services/db');
const s3 = require('../services/s3');
const sap = require('../services/sapClient');
const { requireAuth } = require('../middleware/auth');
const { asyncH } = require('../middleware/errorHandler');

const router = express.Router();

// Archivos de evidencias en memoria (luego se suben a S3). Límite 25 MB c/u.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 30 },
});

// Todas las rutas de tickets requieren sesión.
router.use(requireAuth);

// GET /tickets?page&limit&tipo&search
//   -> { data: [ticket], pagination: { page, limit, total, pages } }
router.get(
  '/',
  asyncH(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));
    const { tipo, search } = req.query;

    const { data, total, pages } = await db.listTickets({
      sapClienteId: req.user.sap_cliente_id,
      page,
      limit,
      tipo,
      search,
    });

    res.json({ data, pagination: { page, limit, total, pages } });
  })
);

// GET /tickets/:id  -> { ticket, evidencias: [...] }
router.get(
  '/:id',
  asyncH(async (req, res) => {
    const result = await db.getTicketById({
      id: req.params.id,
      sapClienteId: req.user.sap_cliente_id,
    });
    if (!result) return res.status(404).json({ error: 'Ticket no encontrado.' });
    res.json(result);
  })
);

// GET /tickets/:id/evidencias/:key64/url  -> { url }
//   key64 = base64 (btoa) de la key de S3. Verificamos pertenencia antes de firmar.
router.get(
  '/:id/evidencias/:key64/url',
  asyncH(async (req, res) => {
    const result = await db.getTicketById({
      id: req.params.id,
      sapClienteId: req.user.sap_cliente_id,
    });
    if (!result) return res.status(404).json({ error: 'Ticket no encontrado.' });

    let key;
    try {
      key = Buffer.from(req.params.key64, 'base64').toString('utf8');
    } catch (_e) {
      return res.status(400).json({ error: 'Key inválida.' });
    }

    // Seguridad: la key debe pertenecer a una evidencia o documento de ESTE ticket.
    const evidencias = result.evidencias || [];
    const docs = result.ticket.documentos_liberados || [];
    const keysPermitidas = new Set([
      ...evidencias.flatMap((e) => e.archivos_s3 || []),
      ...docs.map((d) => Buffer.from(d.key, 'base64').toString('utf8')),
    ]);
    if (!keysPermitidas.has(key)) {
      return res.status(403).json({ error: 'No autorizado para este archivo.' });
    }

    const url = await s3.urlDescarga(key);
    res.json({ url });
  })
);

// POST /tickets  (multipart/form-data)
//   Campos de texto:  tipo_ticket, familia, numero_factura, codigo_producto,
//                     numero_serie, descripcion, contacto, telefono, emails (JSON),
//                     evidencias (JSON: [{nombre,tipo_requerimiento,justificacion,texto_libre,campoArchivo}])
//   Archivos:         uno o varios, cuyo fieldname referencia la evidencia (ej: "ev_0", "ev_1").
//   -> { id, folio_sap }
//
// NOTA: este es el endpoint que faltaba. El frontend (renderSuccess) debe
// cambiarse para hacer este POST en vez de generar el folio en el navegador.
router.post(
  '/',
  upload.any(),
  asyncH(async (req, res) => {
    const b = req.body || {};
    if (!b.tipo_ticket || !b.familia || !b.numero_factura) {
      return res.status(400).json({ error: 'Faltan campos obligatorios del ticket.' });
    }

    let evidenciasMeta = [];
    try {
      evidenciasMeta = b.evidencias ? JSON.parse(b.evidencias) : [];
    } catch (_e) {
      return res.status(400).json({ error: 'Formato de evidencias inválido.' });
    }

    // Subir archivos a S3 y agrupar las keys por la evidencia a la que pertenecen.
    const keysPorCampo = {};
    for (const file of req.files || []) {
      const slug = file.fieldname; // ej: "ev_0"
      const key = `tickets/2026/06/${b.numero_factura}/${slug}/${file.originalname}`;
      // eslint-disable-next-line no-await-in-loop
      await s3.subirEvidencia({ key, buffer: file.buffer, contentType: file.mimetype });
      (keysPorCampo[slug] = keysPorCampo[slug] || []).push(key);
    }

    const evidencias = evidenciasMeta.map((ev, i) => ({
      nombre: ev.nombre,
      tipo_requerimiento: ev.tipo_requerimiento || 'O',
      archivos_s3: keysPorCampo[ev.campoArchivo || `ev_${i}`] || [],
      justificacion: ev.justificacion || null,
      texto_libre: ev.texto_libre || null,
    }));

    const created = await db.createTicket(
      {
        tipo_ticket: b.tipo_ticket,
        familia: b.familia,
        numero_factura: b.numero_factura,
        codigo_producto: b.codigo_producto || null,
        numero_serie: b.numero_serie || null,
        descripcion: b.descripcion || null,
        sap_cliente_id: req.user.sap_cliente_id,
      },
      evidencias
    );

    // Crear el Service Call en SAP B1 (best-effort: el ticket ya quedó en RDS/S3).
    // Si SAP rechaza (p. ej. cliente inactivo), se registra el error pero no se
    // pierde el ticket; Postventa puede reintentar la sincronización.
    let sapServiceCallId = null;
    let sapError = null;
    if (sap.sapEnabled) {
      try {
        const sc = await sap.crearServiceCall({
          cardCode: req.user.sap_cliente_id,
          tipoTicket: b.tipo_ticket,
          itemCode: b.codigo_producto,
          folio: created.folio_sap,
          descripcion: b.descripcion,
          numeroFactura: b.numero_factura,
          piezas: b.cantidad,
        });
        sapServiceCallId = sc.serviceCallId;
      } catch (e) {
        sapError = e.message;
        // eslint-disable-next-line no-console
        console.error(`[tickets] ${created.folio_sap}: fallo al crear Service Call en SAP:`, e.message);
      }
      await db.setSapServiceCall(created.id, { serviceCallId: sapServiceCallId, error: sapError });
    }

    // TODO(prod): notificar a Postventa (SES).
    res.status(201).json({
      id: created.id,
      folio_sap: created.folio_sap,
      sap_service_call_id: sapServiceCallId,
      sap_sync_error: sapError,
    });
  })
);

module.exports = router;
