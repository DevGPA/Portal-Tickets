'use strict';

// Gestión de evidencias en S3: subida (al crear ticket) y URLs prefirmadas
// para que el frontend descargue/visualice archivos privados de forma segura.

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');

const s3Enabled = Boolean(config.s3.bucket);
const client = s3Enabled ? new S3Client({ region: config.s3.region }) : null;

/**
 * Sube un archivo (buffer) a S3 y devuelve la key.
 * key sugerida: tickets/{yyyy}/{mm}/{ticketId}/{slug}/{filename}
 */
async function subirEvidencia({ key, buffer, contentType }) {
  if (!s3Enabled) {
    // Modo demo: no hay bucket; solo devolvemos la key simulada.
    return key;
  }
  await client.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream',
      ServerSideEncryption: 'AES256',
    })
  );
  return key;
}

/**
 * Genera una URL prefirmada de descarga (GET) para una key de S3.
 * El frontend la usa en verArchivo()/descargarDocumento().
 */
async function urlDescarga(key) {
  if (!s3Enabled) {
    // Sin bucket configurado, devolvemos una URL placeholder para no romper el flujo.
    return `https://example.invalid/demo/${encodeURIComponent(key)}`;
  }
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
    { expiresIn: config.s3.presignExpires }
  );
}

module.exports = { subirEvidencia, urlDescarga, s3Enabled };
