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
 * Genera una URL prefirmada de SUBIDA (PUT) para que el navegador suba la
 * evidencia DIRECTO a S3, sin pasar por API Gateway (que limita a 10 MB).
 * La encriptación en reposo la aplica el bucket por defecto (no se exige header).
 * @returns {Promise<{key:string,url:string}>}
 */
async function urlSubida({ key, contentType }) {
  if (!s3Enabled) {
    return { key, url: `https://example.invalid/upload/${encodeURIComponent(key)}` };
  }
  const url = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, ContentType: contentType || 'application/octet-stream' }),
    { expiresIn: config.s3.presignExpires }
  );
  return { key, url };
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

module.exports = { subirEvidencia, urlSubida, urlDescarga, s3Enabled };
