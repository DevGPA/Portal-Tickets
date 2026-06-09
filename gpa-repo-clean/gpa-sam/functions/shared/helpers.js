// functions/shared/helpers.js
const jwt = require('jsonwebtoken');

const CORS = {
  'Access-Control-Allow-Origin':      process.env.CORS_ORIGIN,
  'Access-Control-Allow-Credentials': 'true',
  'Content-Type':                     'application/json',
};

// ── Respuestas HTTP ───────────────────────────────────────────────────────────
function ok(body, extraHeaders = {}) {
  return { statusCode: 200, headers: { ...CORS, ...extraHeaders }, body: JSON.stringify(body) };
}
function created(body) {
  return { statusCode: 201, headers: CORS, body: JSON.stringify(body) };
}
function accepted(body) {
  return { statusCode: 202, headers: CORS, body: JSON.stringify(body) };
}
function badRequest(msg) {
  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: msg }) };
}
function unauthorized(msg = 'No autenticado.') {
  return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: msg }) };
}
function forbidden(msg = 'Sin permisos.') {
  return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: msg }) };
}
function notFound(msg = 'No encontrado.') {
  return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: msg }) };
}
function serverError(msg = 'Error interno del servidor.') {
  return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: msg }) };
}

// ── JWT / Autenticación ───────────────────────────────────────────────────────
function verifyToken(event) {
  const cookieHeader = event.headers?.Cookie || event.headers?.cookie || '';
  const match = cookieHeader.match(/gpa_token=([^;]+)/);
  if (!match) return null;
  try {
    return jwt.verify(match[1], process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

// Extrae y verifica el JWT. Si no es válido devuelve una respuesta 401.
// Uso: const { payload, response } = requireAuth(event);
//      if (response) return response;
function requireAuth(event) {
  const payload = verifyToken(event);
  if (!payload) return { payload: null, response: unauthorized() };
  return { payload, response: null };
}

// ── Body parsing ──────────────────────────────────────────────────────────────
function parseBody(event) {
  try {
    return typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
  } catch {
    return {};
  }
}

module.exports = { ok, created, accepted, badRequest, unauthorized, forbidden, notFound, serverError, requireAuth, parseBody };
