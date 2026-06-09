// src/services/s3.js
// Subida de archivos vía URL prefirmada.
// El frontend sube directamente a S3 sin pasar por este servidor.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { PutObjectCommand }           = require('@aws-sdk/client-s3');
const { getSignedUrl }               = require('@aws-sdk/s3-request-presigner');
const path = require('path');

const s3     = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.S3_BUCKET_NAME;
const EXPIRES = parseInt(process.env.S3_PRESIGNED_EXPIRES_SECONDS || '300', 10);

// ── Tipos y tamaños permitidos por categoría de evidencia ─────────────────────
// Misma lógica que el frontend para mantener coherencia entre ambos lados.

const ALLOWED_MIME = {
  foto:  ['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/webp'],
  video: ['video/mp4', 'video/quicktime', 'video/avi', 'video/x-matroska'],
  ambos: ['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/webp',
          'video/mp4', 'video/quicktime', 'video/avi', 'video/x-matroska'],
  doc:   ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'],
};

const MAX_BYTES = {
  foto:   20 * 1024 * 1024,   // 20 MB
  video: 500 * 1024 * 1024,   // 500 MB
  ambos: 500 * 1024 * 1024,
  doc:    20 * 1024 * 1024,
};

/**
 * Determina la categoría de una evidencia por su nombre.
 * Idéntica a getFileConfig() del frontend.
 */
function getCategory(nombreEvidencia, tipoEvidencia) {
  if (tipoEvidencia === 'file1') return 'doc';
  const n = nombreEvidencia.toLowerCase();
  if (n.startsWith('fotos/video') || n.startsWith('video/foto') || n.startsWith('foto/video')) return 'ambos';
  if (n.startsWith('video'))  return 'video';
  if (n.startsWith('foto') || n.startsWith('fotos')) return 'foto';
  return 'ambos';
}

/**
 * Valida tipo y tamaño. Lanza un error 400 si no pasa.
 */
function validateFile({ nombreEvidencia, tipoEvidencia, mimeType, fileSize }) {
  const cat = getCategory(nombreEvidencia, tipoEvidencia);

  if (!ALLOWED_MIME[cat]?.includes(mimeType)) {
    const allowed = ALLOWED_MIME[cat].join(', ');
    const err = new Error(
      `Tipo de archivo no permitido para "${nombreEvidencia}". ` +
      `Se recibió: "${mimeType}". Permitidos: ${allowed}.`
    );
    err.status = 400;
    throw err;
  }

  if (fileSize > MAX_BYTES[cat]) {
    const maxMB = (MAX_BYTES[cat] / 1024 / 1024).toFixed(0);
    const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
    const err = new Error(
      `Archivo demasiado grande para "${nombreEvidencia}". ` +
      `Tamaño: ${sizeMB} MB. Máximo: ${maxMB} MB.`
    );
    err.status = 400;
    throw err;
  }
}

/**
 * Genera la key de S3 para un archivo.
 * Estructura: tickets/{año}/{mes}/{ticketId}/{slug-evidencia}/{timestamp}_{filename}
 */
function buildS3Key(ticketId, nombreEvidencia, originalFilename) {
  const now    = new Date();
  const year   = now.getFullYear();
  const month  = String(now.getMonth() + 1).padStart(2, '0');
  const slug   = nombreEvidencia.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const ts     = now.getTime();
  const ext    = path.extname(originalFilename) || '';
  const base   = path.basename(originalFilename, ext).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
  return `tickets/${year}/${month}/${ticketId}/${slug}/${ts}_${base}${ext}`;
}

/**
 * Genera una URL prefirmada de S3 (PUT) con expiración.
 * El frontend usa esta URL para subir el archivo directamente a S3.
 *
 * @returns {{ uploadUrl: string, s3Key: string }}
 */
async function generateUploadUrl({ ticketId, nombreEvidencia, tipoEvidencia, mimeType, fileSize, filename }) {
  validateFile({ nombreEvidencia, tipoEvidencia, mimeType, fileSize });

  const s3Key = buildS3Key(ticketId, nombreEvidencia, filename);

  const command = new PutObjectCommand({
    Bucket:             BUCKET,
    Key:                s3Key,
    ContentType:        mimeType,
    ContentLength:      fileSize,
    // Metadatos para auditoría
    Metadata: {
      'ticket-id':         ticketId,
      'evidencia-nombre':  nombreEvidencia,
      'upload-timestamp':  String(Date.now()),
    },
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: EXPIRES });
  return { uploadUrl, s3Key };
}

/**
 * Genera una URL prefirmada de S3 (GET) para que el equipo de Postventa
 * o el distribuidor visualice un archivo ya subido.
 * Expira en 1 hora por defecto.
 *
 * @param {string} s3Key
 * @param {number} expiresInSeconds
 * @returns {string} URL firmada
 */
async function generateViewUrl(s3Key, expiresInSeconds = 3600) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: s3Key });
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
}

module.exports = { generateUploadUrl, generateViewUrl, validateFile };
