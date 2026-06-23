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

  // Responder de inmediato — SAP y correos van asíncronos
  const res = accepted({ ticketId, estado: 'pendiente_sap' });

  // Proceso asíncrono (no bloquea la respuesta)
  setImmediate(() => procesarTicketSAP(ticketId, b, user).catch(console.error));

  return res;
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
          descripcion: b.descripcion,
          sapClienteId: user.sap_cliente_id, ejecutivoGpa: user.ejecutivo_gpa,
        },
      })),
    });

    const sapRes = JSON.parse(Buffer.from((await lambda.send(cmd)).Payload).toString());

    if (sapRes.success) {
      await pool.query(
        `UPDATE tickets SET folio_sap=$1, sap_ticket_id=$2, estado='creado' WHERE id=$3`,
        [sapRes.folio, sapRes.sapId, ticketId]
      );
      console.log(`[tickets] SAP ticket creado: ${sapRes.folio}`);
      await enviarCorreos(ticketId, b, sapRes.folio);
    } else {
      await pool.query(`UPDATE tickets SET estado='error_sap' WHERE id=$1`, [ticketId]);
      console.error('[tickets] SAP error:', sapRes.error);
    }
  } catch (err) {
    await pool.query(`UPDATE tickets SET estado='error_sap' WHERE id=$1`, [ticketId]).catch(() => {});
    console.error('[tickets] SAP invocation error:', err.message);
  }
}

async function enviarCorreos(ticketId, b, folio) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT), secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  });
  const tipo = TIPO_LABEL[b.tipoTicket] || b.tipoTicket;

  // Confirmación al distribuidor
  await transporter.sendMail({
    from: process.env.EMAIL_FROM, to: b.emailContacto,
    subject: `GPA Postventa — Solicitud recibida · ${folio}`,
    html: `<p>Hola <strong>${b.nombreContacto}</strong>,</p>
           <p>Tu solicitud fue recibida. Folio: <strong>${folio}</strong></p>
           <p>Tipo: ${tipo} · Familia: ${b.familia} · Factura: ${b.numeroFactura}</p>
           <p>Postventa se pondrá en contacto contigo. Dudas: <strong>800 APOYO GPA</strong></p>`,
  }).catch(err => console.error('[email] confirmación:', err.message));

  // Notificación a Postventa
  await transporter.sendMail({
    from: process.env.EMAIL_FROM, to: process.env.EMAIL_POSTVENTA,
    subject: `[NUEVO TICKET] ${tipo} · ${b.nombreContacto} · ${b.familia} · ${folio}`,
    html: `<p>Ticket ID: ${ticketId}</p><p>Folio SAP: <strong>${folio}</strong></p>
           <p>Tipo: ${tipo} · Familia: ${b.familia} · Factura: ${b.numeroFactura}</p>
           <p>Contacto: ${b.nombreContacto} · ${b.telefono} · ${b.emailContacto}</p>
           <p>Descripción: ${b.descripcion}</p>`,
  }).catch(err => console.error('[email] postventa:', err.message));
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
