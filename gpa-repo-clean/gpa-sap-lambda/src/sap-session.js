// src/sap-session.js
// Gestión de sesión con SAP B1 Service Layer.
//
// SAP es accesible vía URL pública HTTPS con certificado SSL válido.
// No se necesita VPC, VPN ni agente especial — fetch estándar funciona.
//
// La sesión se guarda a nivel de módulo para reutilizarla entre
// invocaciones del mismo contenedor Lambda (warm start).
// En cold start siempre hace login fresco.

const fetch = require('node-fetch');

const BASE    = process.env.SAP_SERVICE_LAYER_URL;  // ej: https://sap.gpa.com.mx/b1s/v1
const COMPANY = process.env.SAP_COMPANY_DB;
const USER    = process.env.SAP_USER;
const PASS    = process.env.SAP_PASSWORD;

// Sesión persiste entre invocaciones del mismo contenedor Lambda (warm start)
let _cookie = null;
let _expiry = 0;

const DURATION_MS = 28 * 60 * 1000; // renovar cada 28 min (SAP expira a los 30)

// ── Login / renovación de sesión ──────────────────────────────────────────────
async function getSession() {
  if (_cookie && Date.now() < _expiry) return _cookie;

  console.log('[SAP] Abriendo sesión...');

  const res = await fetch(`${BASE}/Login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ CompanyDB: COMPANY, UserName: USER, Password: PASS }),
    timeout: 10_000,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new SapError(`SAP login falló (${res.status}): ${txt}`, res.status);
  }

  const cookie = (res.headers.get('set-cookie') || '').match(/B1SESSION=([^;]+)/i)?.[1];
  if (!cookie) throw new SapError('SAP login: no se recibió B1SESSION en la respuesta.', 500);

  _cookie = cookie;
  _expiry = Date.now() + DURATION_MS;
  console.log('[SAP] Sesión abierta.');
  return _cookie;
}

// ── Petición autenticada a SAP ────────────────────────────────────────────────
async function sapRequest(method, path, body) {
  const session = await getSession();

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie:         `B1SESSION=${session}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    timeout: 15_000,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // 401 = sesión expirada — limpiar para forzar re-login en la próxima llamada
    if (res.status === 401) { _cookie = null; _expiry = 0; }
    const msg = data?.error?.message?.value || `HTTP ${res.status}`;
    throw new SapError(`${method} ${path} → ${msg}`, res.status, data);
  }

  return data;
}

// ── Backoff exponencial (máx 3 reintentos) ────────────────────────────────────
async function withRetry(fn, label) {
  let last;
  for (let i = 1; i <= 3; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      // Errores 4xx son definitivos (problema de datos), no se reintenta
      if (e instanceof SapError && e.sapStatus >= 400 && e.sapStatus < 500) throw e;
      if (i < 3) {
        const ms = Math.pow(2, i) * 500; // 1 s → 2 s → 4 s
        console.warn(`[SAP] Retry ${i}/3 [${label}]: ${e.message} — ${ms}ms`);
        await new Promise(r => setTimeout(r, ms));
      }
    }
  }
  throw last;
}

// ── Error tipado SAP ──────────────────────────────────────────────────────────
class SapError extends Error {
  constructor(msg, sapStatus, sapBody) {
    super(msg);
    this.name      = 'SapError';
    this.sapStatus = sapStatus;
    this.sapBody   = sapBody;
  }
}

module.exports = { sapRequest, withRetry, SapError };
