// functions/auth/index.js
// POST /auth/login   → valida credenciales, devuelve JWT en cookie HttpOnly
// POST /auth/logout  → borra la cookie
// GET  /auth/me      → datos del usuario autenticado

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { getPool } = require('../shared/db');
const { ok, badRequest, unauthorized, serverError, requireAuth, parseBody } = require('../shared/helpers');

const COOKIE = (token) =>
  `gpa_token=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=${8 * 3600}; Path=/`;
const CLEAR_COOKIE =
  'gpa_token=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/';

exports.handler = async (event) => {
  const method = event.httpMethod;
  const path   = event.path;

  try {
    if (method === 'POST' && path.endsWith('/login'))          return login(event);
    if (method === 'POST' && path.endsWith('/logout'))         return logout();
    if (method === 'GET'  && path.endsWith('/me'))             return me(event);
    if (method === 'POST' && path.endsWith('/recover'))        return recover(event);
    if (method === 'POST' && path.endsWith('/reset-password')) return resetPassword(event);
    return { statusCode: 404, body: JSON.stringify({ error: 'Ruta no encontrada.' }) };
  } catch (err) {
    console.error('[auth] error:', err.message);
    return serverError();
  }
};

// ── Login ─────────────────────────────────────────────────────────────────────
async function login(event) {
  const { email, password } = parseBody(event);
  if (!email || !password) return badRequest('Email y contraseña son requeridos.');

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, nombre_empresa, ejecutivo_gpa,
            categoria, sap_cliente_id, activo
     FROM usuarios WHERE email = $1`,
    [email.toLowerCase().trim()]
  );

  const user = rows[0];
  const FAKE = '$2b$12$invalidhashpaddinginvalidhashpadding00000000000';

  // Siempre correr bcrypt para evitar timing attacks
  const match = await bcrypt.compare(password, user?.password_hash || FAKE);

  if (!user || !user.activo || !match) {
    return unauthorized('Credenciales inválidas.');
  }

  const token = jwt.sign(
    { sub: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  return ok(
    { user: { id: user.id, email: user.email, nombreEmpresa: user.nombre_empresa, ejecutivoGpa: user.ejecutivo_gpa } },
    { 'Set-Cookie': COOKIE(token) }
  );
}

// ── Logout ────────────────────────────────────────────────────────────────────
function logout() {
  return ok({ ok: true }, { 'Set-Cookie': CLEAR_COOKIE });
}

// ── Me ────────────────────────────────────────────────────────────────────────
async function me(event) {
  const { payload, response } = requireAuth(event);
  if (response) return response;

  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id, email, nombre_empresa, ejecutivo_gpa FROM usuarios WHERE id = $1 AND activo = true',
    [payload.sub]
  );

  if (!rows.length) return unauthorized('Usuario no encontrado.');
  const u = rows[0];
  return ok({ id: u.id, email: u.email, nombreEmpresa: u.nombre_empresa, ejecutivoGpa: u.ejecutivo_gpa });
}

// ── Recover ───────────────────────────────────────────────────────────────────
// Genera un token temporal y envía correo con enlace de restablecimiento.
// Siempre responde éxito para no revelar si el correo existe.
async function recover(event) {
  const { email } = parseBody(event);
  if (!email || !email.includes('@')) return badRequest('Correo inválido.');

  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id FROM usuarios WHERE email = $1 AND activo = true',
    [email.toLowerCase().trim()]
  );

  if (rows.length) {
    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
    await pool.query(
      'UPDATE usuarios SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
      [token, expiry, rows[0].id]
    );

    const resetUrl = `${process.env.CORS_ORIGIN}/reset-password?token=${token}`;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT), secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
    await transporter.sendMail({
      from: process.env.EMAIL_FROM, to: email,
      subject: 'GPA Postventa — Recuperación de contraseña',
      html: `<p>Recibimos una solicitud para restablecer tu contraseña del Portal de Postventa GPA.</p>
             <p><a href="${resetUrl}" style="background:#003D7A;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Restablecer contraseña</a></p>
             <p style="font-size:12px;color:#64748B">Este enlace expira en 1 hora. Si no solicitaste esto, ignora este correo.</p>`,
    }).catch(e => console.error('[auth] recover email falló:', e.message));
  }

  return ok({ ok: true });
}

// ── Reset password ──────────────────────────────────────────────────────────
// Recibe token + nueva contraseña y actualiza si el token es válido y no expiró.
async function resetPassword(event) {
  const { token, password } = parseBody(event);
  if (!token || !password || password.length < 8)
    return badRequest('Token inválido o contraseña muy corta (mínimo 8 caracteres).');

  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id FROM usuarios WHERE reset_token = $1 AND reset_token_expiry > NOW() AND activo = true',
    [token]
  );
  if (!rows.length) return badRequest('Enlace inválido o expirado. Solicita uno nuevo.');

  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    'UPDATE usuarios SET password_hash = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2',
    [hash, rows[0].id]
  );
  return ok({ ok: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
}
