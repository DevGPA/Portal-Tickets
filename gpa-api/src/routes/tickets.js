'use strict';

const express = require('express');
const db = require('../services/db');
const s3 = require('../services/s3');
const sap = require('../services/sapClient');
const { requireAuth } = require('../middleware/auth');
const { asyncH } = require('../middleware/errorHandler');

const router = express.Router();

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

// POST /tickets/upload-url  { campo, filename, contentType, numeroFactura }
//   -> { key, url }  (URL prefirmada para subir el archivo DIRECTO a S3)
// El navegador sube cada evidencia a S3 con esta URL (PUT), evitando el límite
// de 10 MB de API Gateway. Luego POST /tickets solo envía las keys resultantes.
router.post(
  '/upload-url',
  asyncH(async (req, res) => {
    const { campo, filename, contentType, numeroFactura } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'Falta el nombre del archivo.' });
    const safeName = String(filename).replace(/[^\w.\- ]/g, '_').slice(0, 120);
    const fac = String(numeroFactura || 'sin-factura').replace(/[^\w-]/g, '_');
    const slug = String(campo || 'ev').replace(/[^\w-]/g, '_');
    const rand = Math.random().toString(36).slice(2, 10);
    const key = `tickets/${req.user.sap_cliente_id}/${fac}/${slug}/${rand}-${safeName}`;
    const out = await s3.urlSubida({ key, contentType });
    res.json(out);
  })
);

// POST /tickets  (application/json)
//   Body: { tipo_ticket, familia, numero_factura, codigo_producto, numero_serie,
//           descripcion, contacto, telefono, emails, cantidad,
//           evidencias: [{nombre, tipo_requerimiento, archivos_s3:[key], justificacion, texto_libre}] }
//   Los archivos ya fueron subidos a S3 vía /tickets/upload-url; aquí solo van las keys.
//   -> { id, folio_sap, sap_service_call_id, sap_sync_error }
router.post(
  '/',
  asyncH(async (req, res) => {
    const b = req.body || {};
    if (!b.tipo_ticket || !b.familia || !b.numero_factura) {
      return res.status(400).json({ error: 'Faltan campos obligatorios del ticket.' });
    }

    const evidenciasMeta = Array.isArray(b.evidencias) ? b.evidencias : [];
    const evidencias = evidenciasMeta.map((ev) => ({
      nombre: ev.nombre,
      tipo_requerimiento: ev.tipo_requerimiento || 'O',
      archivos_s3: Array.isArray(ev.archivos_s3) ? ev.archivos_s3 : [],
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
