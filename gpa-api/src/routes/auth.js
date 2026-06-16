// src/routes/auth.js
// POST /api/auth/login           → autenticar distribuidor
// POST /api/auth/logout          → cerrar sesión
// GET  /api/auth/me              → datos del usuario autenticado
// POST /api/auth/recover         → solicitar recuperación de contraseña
// POST /api/auth/reset-password  → establecer nueva contraseña con token

const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const logger = require('../utils/logger');

const COOKIE_NAME = 'gpa_token';
const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge:   8 * 60 * 60 * 1000,
  path:     '/',
};

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña son requeridos.' });
    const { rows } = await pool.query(
      `SELECT id,email,password_hash,nombre_empresa,ejecutivo_gpa,categoria,sap_cliente_id,activo,rol
       FROM usuarios WHERE email=$1`,
      [email.toLowerCase().trim()]
    );
    const user = rows[0];
    const FAKE = '$2b$12$invalidhashpadding...................';
    const match = await bcrypt.compare(password, user?.password_hash || FAKE);
    if (!user || !user.activo || !match) return res.status(401).json({ error: 'Credenciales inválidas.' });
    const token = jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    logger.info('Login exitoso', { userId: user.id });
    return res.json({ user: { id:user.id, email:user.email, nombreEmpresa:user.nombre_empresa, ejecutivoGpa:user.ejecutivo_gpa, rol:user.rol||'cliente' } });
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  return res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  return res.json({ id:u.id, email:u.email, nombreEmpresa:u.nombre_empresa, ejecutivoGpa:u.ejecutivo_gpa, rol:u.rol||'cliente' });
});

router.post('/recover', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Correo inválido.' });
    const { rows } = await pool.query('SELECT id FROM usuarios WHERE email=$1 AND activo=true', [email.toLowerCase().trim()]);
    if (rows.length) {
      const token  = crypto.randomBytes(32).toString('hex');
      const expiry = new Date(Date.now() + 60 * 60 * 1000);
      await pool.query('UPDATE usuarios SET reset_token=$1, reset_token_expiry=$2 WHERE id=$3', [token, expiry, rows[0].id]);
      const resetUrl = process.env.APP_URL + '/reset-password?token=' + token;
      const { transporter, FROM } = require('../services/email');
      await transporter.sendMail({
        from: FROM, to: email,
        subject: 'GPA Postventa — Recuperación de contraseña',
        html: `<p>Para restablecer tu contraseña haz clic en el siguiente enlace (válido 1 hora):</p>
               <p><a href="${resetUrl}" style="background:#003D7A;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Restablecer contraseña</a></p>
               <p style="font-size:12px;color:#64748B">Si no solicitaste esto, ignora este correo.</p>`,
      }).catch(e => logger.error('Email recover falló', { error: e.message }));
    }
    return res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password || password.length < 8)
      return res.status(400).json({ error: 'Token inválido o contraseña muy corta (mínimo 8 caracteres).' });
    const { rows } = await pool.query(
      'SELECT id FROM usuarios WHERE reset_token=$1 AND reset_token_expiry>NOW() AND activo=true', [token]
    );
    if (!rows.length) return res.status(400).json({ error: 'Enlace inválido o expirado. Solicita uno nuevo.' });
    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE usuarios SET password_hash=$1, reset_token=NULL, reset_token_expiry=NULL WHERE id=$2', [hash, rows[0].id]);
    return res.json({ ok: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
  } catch (err) { next(err); }
});

module.exports = router;
