// functions/upload/index.js
// POST /upload/presigned-url  → genera URL firmada S3 para subida directa
// POST /upload/confirm        → confirma que la subida fue exitosa

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl }               = require('@aws-sdk/s3-request-presigner');
const path = require('path');
const { getPool }  = require('../shared/db');
const { ok, badRequest, forbidden, serverError, requireAuth, parseBody } = require('../shared/helpers');

const s3     = new S3Client({ region: process.env.AWS_ACCOUNT_REGION });
const BUCKET = process.env.S3_BUCKET;

// ── Tipos y tamaños permitidos ────────────────────────────────────────────────
const ALLOWED = {
  foto:  ['image/jpeg','image/jpg','image/png','image/heic','image/webp'],
  video: ['video/mp4','video/quicktime','video/avi','video/x-matroska'],
  ambos: ['image/jpeg','image/jpg','image/png','image/heic','image/webp','video/mp4','video/quicktime','video/avi','video/x-matroska'],
  doc:   ['application/pdf','image/jpeg','image/jpg','image/png'],
};
const MAX_BYTES = { foto: 20e6, video: 500e6, ambos: 500e6, doc: 20e6 };

function getCategory(nombre, tipo) {
  if (tipo === 'file1') return 'doc';
  const n = nombre.toLowerCase();
  if (n.startsWith('fotos/video') || n.startsWith('video/foto') || n.startsWith('foto/video')) return 'ambos';
  if (n.startsWith('video'))  return 'video';
  if (n.startsWith('foto') || n.startsWith('fotos'))  return 'foto';
  return 'ambos';
}

exports.handler = async (event) => {
  const path_ = event.path;
  try {
    if (path_.endsWith('/presigned-url')) return presignedUrl(event);
    if (path_.endsWith('/confirm'))       return confirm(event);
    return { statusCode: 404, body: JSON.stringify({ error: 'Ruta no encontrada.' }) };
  } catch (err) {
    console.error('[upload] error:', err.message);
    return serverError();
  }
};

// ── POST /upload/presigned-url ────────────────────────────────────────────────
async function presignedUrl(event) {
  const { payload, response } = requireAuth(event);
  if (response) return response;

  const { ticketId, nombreEvidencia, tipoEvidencia, mimeType, fileSize, filename } = parseBody(event);
  const missing = ['ticketId','nombreEvidencia','tipoEvidencia','mimeType','fileSize','filename'].filter(k => !parseBody(event)[k]);
  if (missing.length) return badRequest(`Campos faltantes: ${missing.join(', ')}.`);

  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id FROM tickets WHERE id=$1 AND usuario_id=$2', [ticketId, payload.sub]
  );
  if (!rows.length) return forbidden('Ticket no encontrado o sin permisos.');

  // Validar tipo y tamaño
  const cat = getCategory(nombreEvidencia, tipoEvidencia);
  if (!ALLOWED[cat]?.includes(mimeType))
    return badRequest(`Tipo de archivo no permitido para "${nombreEvidencia}". MIME: ${mimeType}`);
  if (fileSize > MAX_BYTES[cat])
    return badRequest(`Archivo demasiado grande. Máximo: ${MAX_BYTES[cat]/1e6} MB`);

  // Construir key de S3
  const now   = new Date();
  const slug  = nombreEvidencia.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const ext   = path.extname(filename);
  const base  = path.basename(filename, ext).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
  const s3Key = `tickets/${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${ticketId}/${slug}/${Date.now()}_${base}${ext}`;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, ContentType: mimeType, ContentLength: fileSize }),
    { expiresIn: 300 }
  );

  return ok({ uploadUrl, s3Key });
}

// ── POST /upload/confirm ──────────────────────────────────────────────────────
async function confirm(event) {
  const { payload, response } = requireAuth(event);
  if (response) return response;

  const { ticketId, nombreEvidencia, tipoRequerimiento, s3Key } = parseBody(event);
  if (!ticketId || !nombreEvidencia || !s3Key)
    return badRequest('ticketId, nombreEvidencia y s3Key son requeridos.');

  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id FROM tickets WHERE id=$1 AND usuario_id=$2', [ticketId, payload.sub]
  );
  if (!rows.length) return forbidden();

  const { rows: evRows } = await pool.query(
    'SELECT id, archivos_s3 FROM evidencias WHERE ticket_id=$1 AND nombre=$2', [ticketId, nombreEvidencia]
  );

  if (evRows.length) {
    const archivos = evRows[0].archivos_s3 || [];
    const max = tipoRequerimiento === 'file1' ? 1 : 3;
    if (archivos.length >= max) return badRequest(`Límite de ${max} archivo(s) alcanzado.`);
    await pool.query('UPDATE evidencias SET archivos_s3=$1 WHERE id=$2',
      [JSON.stringify([...archivos, s3Key]), evRows[0].id]);
  } else {
    await pool.query(
      'INSERT INTO evidencias (ticket_id,nombre,tipo_requerimiento,archivos_s3) VALUES ($1,$2,$3,$4)',
      [ticketId, nombreEvidencia, tipoRequerimiento || 'OJ', JSON.stringify([s3Key])]
    );
  }

  return ok({ ok: true });
}
