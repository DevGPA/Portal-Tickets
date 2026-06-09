// src/routes/tickets.js
// POST /api/tickets           → crear ticket
// GET  /api/tickets           → listar tickets del distribuidor
// GET  /api/tickets/:id       → detalle de un ticket
// GET  /api/tickets/:id/evidencias/:key64/url → URL firmada de S3 para un archivo

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const pool   = require('../db/pool');
const sap    = require('../services/sap');
const email  = require('../services/email');
const { generateViewUrl } = require('../services/s3');
const { requireAuth } = require('../middleware/auth');
const logger = require('../utils/logger');

// ── POST /api/tickets ─────────────────────────────────────────────────────────
// Flujo:
//   1. Validar campos requeridos
//   2. Guardar ticket en PostgreSQL con estado 'pendiente_sap'
//   3. Guardar evidencias (archivos ya en S3 + justificaciones + textos libres)
//   4. Enviar correo de confirmación al distribuidor (sin esperar SAP)
//   5. Crear ticket en SAP de forma asíncrona
//   6. Actualizar folio y estado cuando SAP responde
//   7. Enviar notificación interna a Postventa con folio real

router.post('/', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      tipoTicket,
      familia,
      nombreContacto,
      telefono,
      emailContacto,
      numeroFactura,
      codigoProducto,
      numeroSerie,
      descripcion,
      evidencias = [],   // array de { nombre, tipoRequerimiento, archivosS3, justificacion, textoLibre }
    } = req.body;

    // ── Validar campos requeridos ─────────────────────────────────────────────
    const required = { tipoTicket, familia, nombreContacto, telefono, emailContacto, numeroFactura, codigoProducto, descripcion };
    const missing  = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      return res.status(400).json({ error: `Campos requeridos faltantes: ${missing.join(', ')}.` });
    }
    if (!['gar','dev','at'].includes(tipoTicket)) {
      return res.status(400).json({ error: 'tipoTicket debe ser gar, dev o at.' });
    }
    if (descripcion.length > 254) {
      return res.status(400).json({ error: 'descripcion no debe superar 254 caracteres.' });
    }

    const u = req.user;

    await client.query('BEGIN');

    // ── 2. Insertar ticket ─────────────────────────────────────────────────────
    const ticketId = uuidv4();
    await client.query(
      `INSERT INTO tickets
         (id, usuario_id, tipo_ticket, familia,
          nombre_contacto, telefono, email_contacto,
          numero_factura, codigo_producto, numero_serie, descripcion,
          nombre_empresa, ejecutivo_gpa, categoria, sap_cliente_id,
          estado)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pendiente_sap')`,
      [
        ticketId, u.id, tipoTicket, familia,
        nombreContacto, telefono, emailContacto,
        numeroFactura, codigoProducto, numeroSerie || null, descripcion,
        u.nombre_empresa, u.ejecutivo_gpa, u.categoria, u.sap_cliente_id,
      ]
    );

    // ── 3. Insertar evidencias ─────────────────────────────────────────────────
    // Las evidencias de tipo archivo ya fueron subidas a S3 por el frontend.
    // Aquí solo guardamos las referencias (keys de S3), justificaciones y textos libres.
    for (const ev of evidencias) {
      if (!ev.nombre) continue;
      await client.query(
        `INSERT INTO evidencias
           (ticket_id, nombre, tipo_requerimiento, archivos_s3, justificacion, texto_libre)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          ticketId,
          ev.nombre,
          ev.tipoRequerimiento || 'OJ',
          JSON.stringify(ev.archivosS3 || []),
          ev.justificacion  || null,
          ev.textoLibre     || null,
        ]
      );
    }

    await client.query('COMMIT');

    // ── 4. Responder de inmediato al frontend ──────────────────────────────────
    // No esperamos a SAP para devolver respuesta. El folio llegará después.
    res.status(202).json({
      ticketId,
      estado:  'pendiente_sap',
      mensaje: 'Solicitud recibida. El folio SAP se asignará en breve.',
    });

    // ── A partir de aquí: proceso asíncrono (no bloquea la respuesta HTTP) ────

    // ── 4b. Correo de confirmación al distribuidor ────────────────────────────
    email.sendConfirmacion({
      id:              ticketId,
      tipo_ticket:     tipoTicket,
      familia,
      nombre_contacto: nombreContacto,
      email_contacto:  emailContacto,
      numero_factura:  numeroFactura,
      codigo_producto: codigoProducto,
      nombre_empresa:  u.nombre_empresa,
      folio_sap:       null,   // aún no tenemos folio
    }).catch(err => logger.error('Email confirmación falló', { error: err.message, ticketId }));

    // ── 5. Crear ticket en SAP ────────────────────────────────────────────────
    try {
      const { folio, sapId } = await sap.createServiceCall({
        id:              ticketId,
        tipo_ticket:     tipoTicket,
        familia,
        nombre_contacto: nombreContacto,
        telefono,
        email_contacto:  emailContacto,
        numero_factura:  numeroFactura,
        codigo_producto: codigoProducto,
        numero_serie:    numeroSerie || '',
        descripcion,
        sap_cliente_id:  u.sap_cliente_id,
        ejecutivo_gpa:   u.ejecutivo_gpa,
      });

      // ── 6. Actualizar folio y estado en PostgreSQL ────────────────────────
      await pool.query(
        `UPDATE tickets SET folio_sap = $1, sap_ticket_id = $2, estado = 'creado'
         WHERE id = $3`,
        [folio, sapId, ticketId]
      );

      logger.info('Ticket creado en SAP', { ticketId, folio, sapId });

      // Recuperar evidencias para el correo de Postventa
      const { rows: evs } = await pool.query(
        'SELECT * FROM evidencias WHERE ticket_id = $1 ORDER BY creado_en',
        [ticketId]
      );

      // ── 7. Notificación interna a Postventa ────────────────────────────────
      email.sendNotificacionPostventa(
        { ...await getTicketRow(ticketId), folio_sap: folio },
        evs
      ).catch(err => logger.error('Email Postventa falló', { error: err.message, ticketId }));

    } catch (sapErr) {
      // SAP falló — marcar el ticket como error_sap para intervención técnica
      logger.error('SAP createServiceCall falló', {
        error:    sapErr.message,
        ticketId,
        sapStatus: sapErr.sapStatus,
        sapBody:   sapErr.sapBody,
      });

      await pool.query(
        `UPDATE tickets SET estado = 'error_sap' WHERE id = $1`,
        [ticketId]
      ).catch(() => {});
    }

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ── GET /api/tickets ──────────────────────────────────────────────────────────
// Lista paginada de tickets del distribuidor autenticado.
// Query params: page (default 1), limit (default 20), tipo, estado

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
    const offset = (page - 1) * limit;

    const filters  = ['t.usuario_id = $1'];
    const params   = [req.user.id];
    let   paramIdx = 2;

    if (req.query.tipo) {
      filters.push(`t.tipo_ticket = $${paramIdx++}`);
      params.push(req.query.tipo);
    }
    if (req.query.estado) {
      filters.push(`t.estado = $${paramIdx++}`);
      params.push(req.query.estado);
    }

    const WHERE = filters.join(' AND ');

    const [{ rows: tickets }, { rows: [{ total }] }] = await Promise.all([
      pool.query(
        `SELECT t.id, t.tipo_ticket, t.familia, t.numero_factura,
                t.codigo_producto, t.descripcion, t.folio_sap,
                t.estado, t.creado_en, t.actualizado_en
         FROM tickets t
         WHERE ${WHERE}
         ORDER BY t.creado_en DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*) AS total FROM tickets t WHERE ${WHERE}`, params),
    ]);

    return res.json({
      data:       tickets,
      pagination: { page, limit, total: parseInt(total, 10), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/tickets/:id ──────────────────────────────────────────────────────
// Detalle completo de un ticket con sus evidencias.

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows: [ticket] } = await pool.query(
      `SELECT * FROM tickets WHERE id = $1 AND usuario_id = $2`,
      [req.params.id, req.user.id]
    );

    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado.' });

    const { rows: evidencias } = await pool.query(
      `SELECT id, nombre, tipo_requerimiento, archivos_s3,
              justificacion, texto_libre, creado_en
       FROM evidencias WHERE ticket_id = $1 ORDER BY creado_en`,
      [ticket.id]
    );

    return res.json({ ticket, evidencias });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/tickets/:id/evidencias/:key64/url ────────────────────────────────
// Genera URL firmada temporal de S3 para visualizar un archivo.
// :key64 es la S3 key en base64url para evitar caracteres problemáticos en la URL.

router.get('/:id/evidencias/:key64/url', requireAuth, async (req, res, next) => {
  try {
    // Verificar que el ticket pertenece a este distribuidor
    const { rows } = await pool.query(
      'SELECT id FROM tickets WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ticket no encontrado.' });

    const s3Key = Buffer.from(req.params.key64, 'base64url').toString('utf8');
    const url   = await generateViewUrl(s3Key, 3600); // expira en 1 hora

    return res.json({ url, expiresInSeconds: 3600 });
  } catch (err) {
    next(err);
  }
});

// ── Helper ────────────────────────────────────────────────────────────────────
async function getTicketRow(ticketId) {
  const { rows: [t] } = await pool.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
  return t;
}

module.exports = router;
