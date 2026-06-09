// functions/auth/index.js
// POST /auth/login   → valida credenciales, devuelve JWT en cookie HttpOnly
// POST /auth/logout  → borra la cookie
// GET  /auth/me      → datos del usuario autenticado

const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
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
    if (method === 'POST' && path.endsWith('/login'))  return login(event);
    if (method === 'POST' && path.endsWith('/logout')) return logout();
    if (method === 'GET'  && path.endsWith('/me'))     return me(event);
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
