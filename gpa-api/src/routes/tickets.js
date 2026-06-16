// src/routes/tickets.js
// POST /api/tickets                          → crear ticket
// GET  /api/tickets                          → listar tickets del distribuidor
// GET  /api/tickets/:id                      → detalle con evidencias y documentos
// GET  /api/tickets/:id/evidencias/:key64/url → URL firmada S3

const router  = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const pool    = require('../db/pool');
const sap     = require('../services/sap');
const email   = require('../services/email');
const { generateViewUrl } = require('../services/s3');
const { requireAuth } = require('../middleware/auth');
const logger  = require('../utils/logger');

// ── POST /api/tickets ─────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      tipoTicket, familia, nombreContacto, telefono,
      email1, email2, email3,
      emailContacto,
      numeroFactura, codigoProducto, cantidad,
      tipoGarantia,
      numeroSerie, descripcion,
      evidencias = [],
    } = req.body;

    // Normalizar email contacto (puede venir como email1 o emailContacto)
    const emailPrincipal = email1 || emailContacto;

    const required = { tipoTicket, familia, nombreContacto, telefono, emailPrincipal, numeroFactura, codigoProducto };
    const missing  = Object.entries(required).filter(([,v]) => !v).map(([k]) => k);
    if (missing.length) return res.status(400).json({ error: `Campos faltantes: ${missing.join(', ')}.` });
    if (!['gar','dev','at'].includes(tipoTicket)) return res.status(400).json({ error: 'tipoTicket inválido.' });
    if (cantidad && (isNaN(cantidad) || parseInt(cantidad) < 1)) return res.status(400).json({ error: 'Cantidad debe ser mayor a cero.' });

    const u = req.user;
    const ticketId = uuidv4();

    await client.query('BEGIN');

    await client.query(
      `INSERT INTO tickets
         (id, usuario_id, tipo_ticket, familia,
          nombre_contacto, telefono, email_contacto, email2, email3,
          numero_factura, codigo_producto, cantidad, tipo_garantia,
          numero_serie, descripcion,
          nombre_empresa, ejecutivo_gpa, categoria, sap_cliente_id, estado)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'pendiente_sap')`,
      [
        ticketId, u.id, tipoTicket, familia,
        nombreContacto, telefono, emailPrincipal, email2||null, email3||null,
        numeroFactura, codigoProducto, cantidad ? parseInt(cantidad) : 1, tipoGarantia||null,
        numeroSerie||null, descripcion||null,
        u.nombre_empresa, u.ejecutivo_gpa, u.categoria, u.sap_cliente_id,
      ]
    );

    for (const ev of evidencias) {
      if (!ev.nombre) continue;
      await client.query(
        `INSERT INTO evidencias (ticket_id,nombre,tipo_requerimiento,archivos_s3,justificacion,texto_libre)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ticketId, ev.nombre, ev.tipoRequerimiento||'OJ', JSON.stringify(ev.archivosS3||[]), ev.justificacion||null, ev.textoLibre||null]
      );
    }

    await client.query('COMMIT');

    // Responder inmediatamente — SAP va asíncrono
    res.status(202).json({ ticketId, estado: 'pendiente_sap' });

    // Correo de confirmación al distribuidor (sin esperar SAP)
    email.sendConfirmacion({
      id: ticketId, tipo_ticket: tipoTicket, familia,
      nombre_contacto: nombreContacto,
      email_contacto: emailPrincipal, email2: email2||null, email3: email3||null,
      numero_factura: numeroFactura, codigo_producto: codigoProducto,
      nombre_empresa: u.nombre_empresa, folio_sap: null,
    }).catch(e => logger.error('Email confirmación falló', { error: e.message, ticketId }));

    // Crear en SAP
    try {
      const sapResult = await sap.createServiceCall({
        tipo_ticket: tipoTicket, familia,
        nombre_contacto: nombreContacto, telefono,
        email_contacto: emailPrincipal,
        numero_factura: numeroFactura, codigo_producto: codigoProducto,
        tipo_garantia: tipoGarantia||null,
        numero_serie: numeroSerie||'', descripcion: descripcion||'',
        sap_cliente_id: u.sap_cliente_id, ejecutivo_gpa: u.ejecutivo_gpa,
      });

      const { folio, sapId, callID } = sapResult;

      await pool.query(
        `UPDATE tickets SET folio_sap=$1, sap_ticket_id=$2, call_id=$3, estado='creado' WHERE id=$4`,
        [folio, sapId, callID||null, ticketId]
      );

      logger.info('Ticket creado en SAP', { ticketId, folio, sapId, callID });

      const { rows: evs } = await pool.query('SELECT * FROM evidencias WHERE ticket_id=$1', [ticketId]);

      // Obtener correos de ejecutivo y gerente desde clientes_config
      const { rows: [clienteCfg] } = await pool.query(
        'SELECT email_ejecutivo, email_gerente FROM clientes_config WHERE sap_cliente_id=$1',
        [u.sap_cliente_id]
      );

      email.sendNotificacionInterna(
        { ...(await getTicketRow(ticketId)), folio_sap: folio,
          ejecutivo_gpa_email: clienteCfg?.email_ejecutivo||null,
          gerente_email:       clienteCfg?.email_gerente||null },
        evs
      ).catch(e => logger.error('Email interno falló', { error: e.message, ticketId }));

    } catch (sapErr) {
      logger.error('SAP createServiceCall falló', { error: sapErr.message, ticketId });
      await pool.query(`UPDATE tickets SET estado='error_sap' WHERE id=$1`, [ticketId]).catch(()=>{});
    }

  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    next(err);
  } finally {
    client.release();
  }
});

// ── GET /api/tickets ──────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(50, parseInt(req.query.limit || '20', 10));
    const offset = (page - 1) * limit;
    const filters = ['t.usuario_id=$1'];
    const params  = [req.user.id];
    let idx = 2;

    if (req.query.search) {
      filters.push(`(t.folio_sap ILIKE $${idx} OR t.numero_factura ILIKE $${idx} OR t.familia ILIKE $${idx})`);
      params.push('%' + req.query.search + '%');
      idx++;
    }

    const WHERE = filters.join(' AND ');
    const [{ rows: tickets }, { rows: [{ total }] }] = await Promise.all([
      pool.query(
        `SELECT t.id,t.tipo_ticket,t.familia,t.numero_factura,t.codigo_producto,
                t.descripcion,t.folio_sap,t.call_id,t.estado,t.sap_status,
                t.sap_resolution,t.sap_info_pendiente,t.creado_en
         FROM tickets t WHERE ${WHERE} ORDER BY t.creado_en DESC
         LIMIT $${idx} OFFSET $${idx+1}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*) total FROM tickets t WHERE ${WHERE}`, params),
    ]);

    return res.json({ data: tickets, pagination: { page, limit, total: parseInt(total), pages: Math.ceil(total/limit) } });
  } catch (err) { next(err); }
});

// ── GET /api/tickets/:id ──────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows: [ticket] } = await pool.query(
      'SELECT * FROM tickets WHERE id=$1 AND usuario_id=$2',
      [req.params.id, req.user.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado.' });

    const { rows: evidencias } = await pool.query(
      'SELECT id,nombre,tipo_requerimiento,archivos_s3,justificacion,texto_libre,creado_en FROM evidencias WHERE ticket_id=$1 ORDER BY creado_en',
      [ticket.id]
    );

    // Documentos liberados por GPA (Nota de Crédito, Reporte Técnico)
    const { rows: documentos } = await pool.query(
      'SELECT id,nombre,tipo,s3_key,fecha FROM documentos_ticket WHERE ticket_id=$1 AND liberado=true ORDER BY fecha',
      [ticket.id]
    ).catch(() => ({ rows: [] }));

    // Mapear documentos para el portal (key en base64url para URLs seguras)
    const documentosLiberados = documentos.map(d => ({
      nombre: d.nombre,
      tipo:   d.tipo,
      key:    Buffer.from(d.s3_key).toString('base64url'),
      fecha:  d.fecha,
    }));

    return res.json({ ticket, evidencias, documentos_liberados: documentosLiberados });
  } catch (err) { next(err); }
});

// ── GET /api/tickets/:id/evidencias/:key64/url ────────────────────────────────
router.get('/:id/evidencias/:key64/url', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id FROM tickets WHERE id=$1 AND usuario_id=$2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ticket no encontrado.' });

    const s3Key = Buffer.from(req.params.key64, 'base64url').toString('utf8');
    const url   = await generateViewUrl(s3Key, 3600);
    return res.json({ url, expiresInSeconds: 3600 });
  } catch (err) { next(err); }
});

async function getTicketRow(ticketId) {
  const { rows: [t] } = await pool.query('SELECT * FROM tickets WHERE id=$1', [ticketId]);
  return t;
}

module.exports = router;
