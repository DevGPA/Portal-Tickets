// functions/tickets/index.js
// POST /tickets                          → crear ticket (async SAP)
// GET  /tickets                          → listar tickets del distribuidor
// GET  /tickets/{id}                     → detalle + evidencias
// GET  /tickets/{id}/evidencias/{key}/url → URL firmada S3

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { S3Client, GetObjectCommand }  = require('@aws-sdk/client-s3');
const { getSignedUrl }                = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 }                  = require('uuid');
const nodemailer                      = require('nodemailer');
const { getPool }                     = require('../shared/db');
const { ok, accepted, badRequest, forbidden, notFound, serverError, unauthorized, requireAuth, parseBody } = require('../shared/helpers');

const lambda = new LambdaClient({ region: process.env.AWS_ACCOUNT_REGION });
const s3     = new S3Client({     region: process.env.AWS_ACCOUNT_REGION });
const BUCKET = process.env.S3_BUCKET;
const TIPO_LABEL = { gar: 'Garantía', dev: 'Devolución', at: 'Apoyo Técnico' };

exports.handler = async (event) => {
  const method = event.httpMethod;
  const path   = event.path;

  try {
    // POST /sap/buscar-facturas
    if (method === 'POST' && path.endsWith('/sap/buscar-facturas'))    return buscarFacturas(event);
    // POST /sap/articulos-factura
    if (method === 'POST' && path.endsWith('/sap/articulos-factura'))  return articulosFactura(event);
    // GET  /sap/familias
    if (method === 'GET'  && path.endsWith('/sap/familias'))           return familias(event);
    // POST /tickets
    if (method === 'POST' && /\/tickets$/.test(path))       return createTicket(event);
    // GET  /tickets
    if (method === 'GET'  && /\/tickets$/.test(path))       return listTickets(event);
    // GET  /tickets/{id}/evidencias/{key}/url
    if (method === 'GET'  && path.includes('/evidencias/')) return getEvidenciaUrl(event);
    // GET  /tickets/{id}
    if (method === 'GET'  && /\/tickets\/[^/]+$/.test(path)) return getTicket(event);

    return notFound('Ruta no encontrada.');
  } catch (err) {
    console.error('[tickets] error:', err.message, err.stack);
    return serverError();
  }
};

// ── Helper: invocar Lambda SAP ────────────────────────────────────────────────
async function invokeSAP(action, payload) {
  const cmd = new InvokeCommand({
    FunctionName:   process.env.SAP_LAMBDA_NAME,
    InvocationType: 'RequestResponse',
    Payload:        Buffer.from(JSON.stringify({ action, payload })),
  });
  const res = await lambda.send(cmd);
  if (res.FunctionError) {
    throw new Error(`Lambda SAP FunctionError [${action}]: ${Buffer.from(res.Payload).toString()}`);
  }
  return JSON.parse(Buffer.from(res.Payload).toString());
}

// Devuelve el sap_cliente_id (CardCode) del usuario autenticado
async function getCardCode(userId) {
  const { rows: [user] } = await getPool().query(
    'SELECT sap_cliente_id FROM usuarios WHERE id = $1 AND activo = true', [userId]
  );
  return user?.sap_cliente_id || null;
}

// ── POST /sap/buscar-facturas ─────────────────────────────────────────────────
// Autocompletado de facturas del cliente. Body: { query }
async function buscarFacturas(event) {
  const { payload, response } = requireAuth(event);
  if (response) return response;

  const { query } = parseBody(event);
  if (!query || String(query).trim().length < 2) return ok({ success: true, facturas: [] });

  const cardCode = await getCardCode(payload.sub);
  if (!cardCode) return unauthorized();

  const data = await invokeSAP('buscarFacturas', { cardCode, query: String(query).trim() });
  return ok(data);
}

// ── POST /sap/articulos-factura ───────────────────────────────────────────────
// Artículos de una factura del cliente. Body: { docNum }
async function articulosFactura(event) {
  const { payload, response } = requireAuth(event);
  if (response) return response;

  const { docNum } = parseBody(event);
  if (!docNum) return badRequest('docNum es requerido.');

  const cardCode = await getCardCode(payload.sub);
  if (!cardCode) return unauthorized();

  const data = await invokeSAP('obtenerArticulosFactura', { cardCode, docNum: String(docNum).trim() });
  return ok(data);
}

// ── GET /sap/familias ─────────────────────────────────────────────────────────
// Catálogo de familias (grupos de artículos OITB) para mapear ItmsGrpCod → familia.
async function familias(event) {
  const { response } = requireAuth(event);
  if (response) return response;

  const data = await invokeSAP('obtenerFamilias', {});
  return ok(data);
}

// ── POST /tickets ─────────────────────────────────────────────────────────────
async function createTicket(event) {
  const { payload, response } = requireAuth(event);
  if (response) return response;

  const b = parseBody(event);
  const required = ['tipoTicket','familia','nombreContacto','telefono',
                    'emailContacto','numeroFactura','codigoProducto','descripcion'];
  const missing = required.filter(k => !b[k]);
  if (missing.length) return badRequest(`Campos faltantes: ${missing.join(', ')}.`);
  if (!['gar','dev','at'].includes(b.tipoTicket)) return badRequest('tipoTicket inválido.');
  if ((b.descripcion || '').length > 254) return badRequest('descripcion máximo 254 caracteres.');

  const pool = getPool();

  // Cargar datos completos del usuario (snapshot en el ticket)
  const { rows: [user] } = await pool.query(
    'SELECT nombre_empresa, ejecutivo_gpa, categoria, sap_cliente_id FROM usuarios WHERE id = $1',
    [payload.sub]
  );
  if (!user) return unauthorized();

  const ticketId = uuidv4();
  const client   = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO tickets
         (id, usuario_id, tipo_ticket, familia,
          nombre_contacto, telefono, email_contacto,
          numero_factura, codigo_producto, numero_serie, descripcion,
          nombre_empresa, ejecutivo_gpa, categoria, sap_cliente_id, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pendiente_sap')`,
      [ticketId, payload.sub, b.tipoTicket, b.familia,
       b.nombreContacto, b.telefono, b.emailContacto,
       b.numeroFactura, b.codigoProducto, b.numeroSerie || null, b.descripcion,
       user.nombre_empresa, user.ejecutivo_gpa, user.categoria, user.sap_cliente_id]
    );

    for (const ev of (b.evidencias || [])) {
      if (!ev.nombre) continue;
      await client.query(
        `INSERT INTO evidencias (ticket_id, nombre, tipo_requerimiento, archivos_s3, justificacion, texto_libre)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ticketId, ev.nombre, ev.tipoRequerimiento || 'OJ',
         JSON.stringify(ev.archivosS3 || []), ev.justificacion || null, ev.textoLibre || null]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Crear el ServiceCall en SAP de forma SÍNCRONA: en Lambda el trabajo posterior
  // a la respuesta (setImmediate) no se ejecuta de forma confiable y dejaba el
  // ticket atascado en 'pendiente_sap'. Si SAP falla, el ticket queda 'error_sap'
  // pero la respuesta es exitosa (el ticket ya existe en BD; Postventa lo revisa).
  const sap = await procesarTicketSAP(ticketId, b, user);
  return accepted({ ticketId, estado: sap.estado, folio: sap.folio || null });
}

async function procesarTicketSAP(ticketId, b, user) {
  const pool = getPool();

  // 1. Invocar Lambda SAP
  try {
    const cmd = new InvokeCommand({
      FunctionName:   process.env.SAP_LAMBDA_NAME,
      InvocationType: 'RequestResponse',
      Payload:        Buffer.from(JSON.stringify({
        action: 'crearTicket',
        payload: {
          tipoTicket: b.tipoTicket, familia: b.familia,
          nombreContacto: b.nombreContacto, telefono: b.telefono,
          emailContacto: b.emailContacto, numeroFactura: b.numeroFactura,
          codigoProducto: b.codigoProducto, numeroSerie: b.numeroSerie || '',
          tipoGarantia: b.tipoGarantia || null, cantidad: b.cantidad || 1,
          descripcion: b.descripcion,
          sapClienteId: user.sap_cliente_id, ejecutivoGpa: user.ejecutivo_gpa,
        },
      })),
    });

    const sapRes = JSON.parse(Buffer.from((await lambda.send(cmd)).Payload).toString());

    if (sapRes.success) {
      await pool.query(
        `UPDATE tickets SET folio_sap=$1, sap_ticket_id=$2, call_id=$3, estado='creado' WHERE id=$4`,
        [sapRes.folio, sapRes.sapId, sapRes.callId || null, ticketId]
      );
      console.log(`[tickets] SAP ticket creado: folio=${sapRes.folio} callId=${sapRes.callId}`);
      // El correo es best-effort: un fallo de SMTP NO debe marcar el ticket como error.
      await enviarCorreos(ticketId, b, sapRes.folio).catch(e => console.error('[tickets] correos:', e.message));
      return { estado: 'creado', folio: sapRes.folio, sapId: sapRes.sapId, callId: sapRes.callId };
    } else {
      await pool.query(`UPDATE tickets SET estado='error_sap' WHERE id=$1`, [ticketId]);
      console.error('[tickets] SAP error:', sapRes.error);
      return { estado: 'error_sap', error: sapRes.error };
    }
  } catch (err) {
    await pool.query(`UPDATE tickets SET estado='error_sap' WHERE id=$1`, [ticketId]).catch(() => {});
    console.error('[tickets] SAP invocation error:', err.message);
    return { estado: 'error_sap', error: err.message };
  }
}

async function enviarCorreos(ticketId, b, folio) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT), secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    connectionTimeout: 7000, greetingTimeout: 7000, socketTimeout: 7000,
  });

  const tipo = TIPO_LABEL[b.tipoTicket] || b.tipoTicket;

  // Remitente según tipo de ticket:
  // Devolución → devoluciones@gpa.com.mx
  // Garantía / Apoyo Técnico → atencion.clientes@gpa.com.mx
  const from = b.tipoTicket === 'dev'
    ? 'GPA Devoluciones <devoluciones@gpa.com.mx>'
    : 'GPA Atención a Clientes <atencion.clientes@gpa.com.mx>';

  // Destinatarios:
  // - To: correos del cliente (los que puso en el portal)
  // - Cc: postventa@gpa.com.mx (siempre)
  const toCliente = [b.emailContacto, b.email2, b.email3].filter(Boolean).join(', ');

  const subject = `Tu solicitud de ${tipo} fue registrada - #${folio}`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#003D7A;padding:20px 28px">
        <h2 style="color:white;margin:0;font-size:18px">General de Productos para el Agua</h2>
        <p style="color:#AEC9E8;margin:4px 0 0;font-size:13px">Portal de Postventa</p>
      </div>
      <div style="padding:24px 28px;border:1px solid #DDE4EE;border-top:none">
        <p style="font-size:15px">Hola <strong>${b.nombreContacto}</strong>,</p>
        <p>Tu solicitud ha sido recibida por el equipo de Postventa de GPA. A continuación los datos registrados:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
          <tr style="background:#F1F5F9">
            <td style="padding:8px 12px;font-weight:700;width:40%">No. de Ticket</td>
            <td style="padding:8px 12px"><strong style="color:#003D7A;font-size:16px">${folio}</strong></td>
          </tr>
          <tr>
            <td style="padding:8px 12px;font-weight:700;border-top:1px solid #E2E8F0">Tipo de solicitud</td>
            <td style="padding:8px 12px;border-top:1px solid #E2E8F0">${tipo}</td>
          </tr>
          <tr style="background:#F1F5F9">
            <td style="padding:8px 12px;font-weight:700">Familia</td>
            <td style="padding:8px 12px">${b.familia}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;font-weight:700;border-top:1px solid #E2E8F0">No. de Factura</td>
            <td style="padding:8px 12px;border-top:1px solid #E2E8F0">${b.numeroFactura}</td>
          </tr>
          <tr style="background:#F1F5F9">
            <td style="padding:8px 12px;font-weight:700">Producto</td>
            <td style="padding:8px 12px">${b.codigoProducto}</td>
          </tr>
        </table>
        <p style="font-size:13px;color:#475569">
          Una persona del equipo de Postventa se pondrá en contacto contigo para validar
          que la información enviada esté completa.<br><br>
          ¿Tienes dudas? Llámanos al <strong>800 APOYO GPA (800 276 9647)</strong>
        </p>
      </div>
      <div style="padding:12px 28px;background:#F8FAFC;font-size:11px;color:#94A3B8;border:1px solid #DDE4EE;border-top:none">
        Este correo fue generado automáticamente por el Portal de Postventa GPA.
      </div>
    </div>`;

  // Un solo envío — todos reciben el mismo correo
  await transporter.sendMail({
    from,
    to:      toCliente,
    cc:      'postventa@gpa.com.mx',
    subject,
    html,
  }).catch(err => console.error('[email] envío falló:', err.message));
}

// ── GET /tickets ──────────────────────────────────────────────────────────────
async function listTickets(event) {
  const { payload, response } = requireAuth(event);
  if (response) return response;

  const q      = event.queryStringParameters || {};
  const page   = Math.max(1, parseInt(q.page  || '1',  10));
  const limit  = Math.min(50, parseInt(q.limit || '20', 10));
  const offset = (page - 1) * limit;
  const pool   = getPool();

  const filters = ['usuario_id = $1'];
  const params  = [payload.sub];
  let   idx     = 2;

  if (q.tipo)   { filters.push(`tipo_ticket = $${idx++}`); params.push(q.tipo); }
  if (q.estado) { filters.push(`estado = $${idx++}`);      params.push(q.estado); }

  const WHERE = filters.join(' AND ');
  const [{ rows: data }, { rows: [{ total }] }] = await Promise.all([
    pool.query(`SELECT id,tipo_ticket,familia,numero_factura,codigo_producto,
                       folio_sap,estado,creado_en FROM tickets WHERE ${WHERE}
                ORDER BY creado_en DESC LIMIT $${idx} OFFSET $${idx+1}`,
               [...params, limit, offset]),
    pool.query(`SELECT COUNT(*) total FROM tickets WHERE ${WHERE}`, params),
  ]);

  return ok({ data, pagination: { page, limit, total: parseInt(total), pages: Math.ceil(total/limit) } });
}

// ── GET /tickets/{id} ─────────────────────────────────────────────────────────
async function getTicket(event) {
  const { payload, response } = requireAuth(event);
  if (response) return response;

  const id   = event.pathParameters?.id;
  const pool = getPool();
  const { rows: [ticket] } = await pool.query(
    'SELECT * FROM tickets WHERE id=$1 AND usuario_id=$2', [id, payload.sub]
  );
  if (!ticket) return notFound('Ticket no encontrado.');

  const { rows: evidencias } = await pool.query(
    'SELECT id,nombre,tipo_requerimiento,archivos_s3,justificacion,texto_libre,creado_en FROM evidencias WHERE ticket_id=$1 ORDER BY creado_en',
    [id]
  );

  // Estatus en vivo desde SAP (si el ticket ya existe en SAP). No bloquea si falla.
  if (ticket.sap_ticket_id && ticket.sap_ticket_id !== 'undefined') {
    try {
      const sap = await invokeSAP('consultarTicket', { sapId: ticket.sap_ticket_id });
      if (sap?.success) {
        // Nombres EXACTOS que espera el frontend (getStatusInfo en index.html)
        ticket.sap_status         = sap.status;
        ticket.sap_resolution     = sap.resolution;
        ticket.sap_info_pendiente = sap.infoPendiente;
        // call_id puede no estar guardado aún en BD si el ticket es viejo —
        // si SAP lo regresa ahora, lo reflejamos también en la respuesta.
        if (sap.callId && !ticket.call_id) ticket.call_id = sap.callId;
      }
    } catch (e) { console.error('[tickets] consultarTicket falló:', e.message); }
  }

  return ok({ ticket, evidencias });
}

// ── GET /tickets/{id}/evidencias/{key}/url ────────────────────────────────────
async function getEvidenciaUrl(event) {
  const { payload, response } = requireAuth(event);
  if (response) return response;

  const { id, key } = event.pathParameters || {};
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id FROM tickets WHERE id=$1 AND usuario_id=$2', [id, payload.sub]
  );
  if (!rows.length) return notFound();

  const s3Key  = Buffer.from(key, 'base64url').toString('utf8');
  const url    = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }), { expiresIn: 3600 });
  return ok({ url, expiresInSeconds: 3600 });
}
