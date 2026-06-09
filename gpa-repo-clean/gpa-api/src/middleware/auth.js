// src/middleware/auth.js
const jwt  = require('jsonwebtoken');
const pool = require('../db/pool');

/**
 * Verifica el JWT en la cookie HttpOnly gpa_token.
 * Si es válido, adjunta req.user con los datos del distribuidor.
 */
async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.gpa_token;
    if (!token) {
      return res.status(401).json({ error: 'No autenticado.' });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Sesión inválida o expirada. Vuelve a iniciar sesión.' });
    }

    const { rows } = await pool.query(
      `SELECT id, email, nombre_empresa, ejecutivo_gpa, categoria, sap_cliente_id, activo
       FROM usuarios WHERE id = $1`,
      [payload.sub]
    );

    if (!rows.length || !rows[0].activo) {
      return res.status(401).json({ error: 'Usuario no encontrado o desactivado.' });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth };
