// src/routes/upload.js
// POST /api/upload/presigned-url  → genera URL firmada de S3 para el frontend
// POST /api/upload/confirm        → confirma que la subida fue exitosa

const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { generateUploadUrl } = require('../services/s3');
const pool   = require('../db/pool');
const logger = require('../utils/logger');

// ── POST /api/upload/presigned-url ────────────────────────────────────────────
// El frontend llama este endpoint antes de subir un archivo.
// Recibe una URL firmada de S3 (PUT) y la key donde quedará el archivo.
// El frontend sube el archivo directamente a esa URL — no pasa por este servidor.
//
// Body: { ticketId, nombreEvidencia, tipoEvidencia, mimeType, fileSize, filename }

router.post('/presigned-url', requireAuth, async (req, res, next) => {
  try {
    const { ticketId, nombreEvidencia, tipoEvidencia, mimeType, fileSize, filename } = req.body;

    // Validaciones básicas
    const missing = ['ticketId','nombreEvidencia','tipoEvidencia','mimeType','fileSize','filename']
      .filter(k => !req.body[k]);
    if (missing.length) {
      return res.status(400).json({ error: `Campos requeridos faltantes: ${missing.join(', ')}.` });
    }
    if (typeof fileSize !== 'number' || fileSize <= 0) {
      return res.status(400).json({ error: 'fileSize debe ser un número mayor a 0.' });
    }

    // Verificar que el ticket pertenece a este distribuidor
    const { rows } = await pool.query(
      'SELECT id FROM tickets WHERE id = $1 AND usuario_id = $2',
      [ticketId, req.user.id]
    );
    if (!rows.length) {
      return res.status(403).json({ error: 'Ticket no encontrado o sin permisos.' });
    }

    // Generar URL prefirmada (valida tipo y tamaño internamente)
    const { uploadUrl, s3Key } = await generateUploadUrl({
      ticketId,
      nombreEvidencia,
      tipoEvidencia,
      mimeType,
      fileSize,
      filename,
    });

    logger.debug('Presigned URL generada', {
      ticketId,
      evidencia: nombreEvidencia,
      s3Key,
    });

    return res.json({ uploadUrl, s3Key });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// ── POST /api/upload/confirm ──────────────────────────────────────────────────
// El frontend llama este endpoint DESPUÉS de haber subido el archivo a S3.
// Guarda la key de S3 en la tabla evidencias.
//
// Body: { ticketId, nombreEvidencia, tipoRequerimiento, s3Key }

router.post('/confirm', requireAuth, async (req, res, next) => {
  try {
    const { ticketId, nombreEvidencia, tipoRequerimiento, s3Key } = req.body;

    if (!ticketId || !nombreEvidencia || !s3Key) {
      return res.status(400).json({ error: 'ticketId, nombreEvidencia y s3Key son requeridos.' });
    }

    // Verificar que el ticket pertenece a este distribuidor
    const { rows: ticketRows } = await pool.query(
      'SELECT id FROM tickets WHERE id = $1 AND usuario_id = $2',
      [ticketId, req.user.id]
    );
    if (!ticketRows.length) {
      return res.status(403).json({ error: 'Ticket no encontrado o sin permisos.' });
    }

    // Buscar si ya existe un registro de esta evidencia para este ticket
    const { rows: evRows } = await pool.query(
      'SELECT id, archivos_s3 FROM evidencias WHERE ticket_id = $1 AND nombre = $2',
      [ticketId, nombreEvidencia]
    );

    if (evRows.length) {
      // Agregar el nuevo archivo al array existente (máximo 3 para file3, 1 para file1)
      const archivosActuales = evRows[0].archivos_s3 || [];
      const maxFiles = tipoRequerimiento === 'file1' ? 1 : 3;

      if (archivosActuales.length >= maxFiles) {
        return res.status(400).json({
          error: `Esta evidencia ya alcanzó el límite de ${maxFiles} archivo(s).`,
        });
      }

      const nuevosArchivos = [...archivosActuales, s3Key];
      await pool.query(
        'UPDATE evidencias SET archivos_s3 = $1 WHERE id = $2',
        [JSON.stringify(nuevosArchivos), evRows[0].id]
      );
    } else {
      // Crear registro de evidencia
      await pool.query(
        `INSERT INTO evidencias (ticket_id, nombre, tipo_requerimiento, archivos_s3)
         VALUES ($1, $2, $3, $4)`,
        [ticketId, nombreEvidencia, tipoRequerimiento || 'OJ', JSON.stringify([s3Key])]
      );
    }

    logger.debug('Archivo confirmado en evidencias', { ticketId, evidencia: nombreEvidencia });

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
