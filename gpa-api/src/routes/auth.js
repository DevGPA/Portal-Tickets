// src/routes/auth.js
// POST /api/auth/login
// POST /api/auth/logout
// GET  /api/auth/me

const router  = require('express').Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const logger  = require('../utils/logger');

const COOKIE_NAME = 'gpa_token';
const COOKIE_OPTS = {
  httpOnly: true,                                    // no accesible desde JS del frontend
  secure:   process.env.NODE_ENV === 'production',   // solo HTTPS en producción
  sameSite: 'strict',
  maxAge:   8 * 60 * 60 * 1000,                      // 8 horas en ms
  path:     '/',
};

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son requeridos.' });
    }

    // Buscar usuario
    const { rows } = await pool.query(
      `SELECT id, email, password_hash, nombre_empresa, ejecutivo_gpa,
              categoria, sap_cliente_id, activo
       FROM usuarios WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    const user = rows[0];

    // Respuesta genérica — no revelar si el email existe o no
    const INVALID = 'Credenciales inválidas.';

    if (!user || !user.activo) {
      // Correr bcrypt igual para evitar timing attacks
      await bcrypt.compare(password, '$2b$12$invalidhashpadding...................');
      return res.status(401).json({ error: INVALID });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: INVALID });
    }

    // Generar JWT — payload mínimo, los datos completos se cargan en requireAuth
    const token = jwt.sign(
      { sub: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    // Guardar en cookie HttpOnly
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);

    logger.info('Login exitoso', { userId: user.id, empresa: user.nombre_empresa });

    return res.json({
      user: {
        id:            user.id,
        email:         user.email,
        nombreEmpresa: user.nombre_empresa,
        ejecutivoGpa:  user.ejecutivo_gpa,
        // categoría no se expone al frontend — solo uso interno
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  return res.json({ ok: true });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
// Devuelve los datos del usuario autenticado.
// El frontend lo llama al cargar para saber si hay sesión activa.
router.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  return res.json({
    id:            u.id,
    email:         u.email,
    nombreEmpresa: u.nombre_empresa,
    ejecutivoGpa:  u.ejecutivo_gpa,
  });
});

module.exports = router;
