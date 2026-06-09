'use strict';

const express = require('express');
const config = require('../config');
const db = require('../services/db');
const authSvc = require('../services/auth.service');
const { requireAuth } = require('../middleware/auth');
const { asyncH } = require('../middleware/errorHandler');

const router = express.Router();

// POST /auth/login  { email, password } -> { user } + cookie HttpOnly
router.post(
  '/login',
  asyncH(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Correo y contraseña son obligatorios.' });
    }
    const user = await db.getUserByEmail(String(email).toLowerCase().trim());
    if (!user || !(await authSvc.verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }
    const token = authSvc.signToken(user);
    res.cookie(config.cookie.name, token, authSvc.cookieOptions());
    return res.json({ user: authSvc.publicUser(user) });
  })
);

// GET /auth/me -> usuario actual (el frontend lo usa para restaurar sesión)
router.get(
  '/me',
  requireAuth,
  asyncH(async (req, res) => {
    res.json({
      nombreEmpresa: req.user.nombreEmpresa,
      email: req.user.email,
      rol: req.user.rol,
    });
  })
);

// POST /auth/logout -> limpia la cookie
router.post('/logout', (req, res) => {
  res.clearCookie(config.cookie.name, { ...authSvc.cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

// POST /auth/recover  { email } -> 200 siempre (no revela si el correo existe)
router.post(
  '/recover',
  asyncH(async (req, res) => {
    const { email } = req.body || {};
    if (email) {
      // TODO(prod): generar token de reseteo, guardarlo y enviar correo (SES).
      // No revelar el resultado al cliente.
    }
    res.json({ ok: true });
  })
);

module.exports = router;
