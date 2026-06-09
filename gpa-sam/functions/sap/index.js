// functions/sap/index.js
// Lambda de SAP — no está expuesta en API Gateway.
// Solo la invoca TicketsFunction directamente vía AWS SDK.
// SAP accesible por URL pública HTTPS con SSL válido — sin agente especial.

const fetch = require('node-fetch');

const BASE    = process.env.SAP_SERVICE_LAYER_URL;
const COMPANY = process.env.SAP_COMPANY_DB;
const USER    = process.env.SAP_USER;
const PASS    = process.env.SAP_PASSWORD;

// Sesión SAP persiste entre invocaciones warm del mismo container
let _cookie = null;
let _expiry = 0;

async function getSession() {
  if (_cookie && Date.now() < _expiry) return _cookie;

  const res = await fetch(`${BASE}/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CompanyDB: COMPANY, UserName: USER, Password: PASS }),
    timeout: 10_000,
  });

  if (!res.ok) throw new Error(`SAP login falló (${res.status}): ${await res.text()}`);

  const cookie = (res.headers.get('set-cookie') || '').match(/B1SESSION=([^;]+)/i)?.[1];
  if (!cookie) throw new Error('SAP login: no se recibió B1SESSION.');

  _cookie = cookie;
  _expiry = Date.now() + 28 * 60 * 1000;
  return _cookie;
}

async function sapRequest(method, path, body) {
  const session = await getSession();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `B1SESSION=${session}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
    timeout: 15_000,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) { _cookie = null; _expiry = 0; }
    throw Object.assign(new Error(data?.error?.message?.value || `HTTP ${res.status}`), { sapStatus: res.status, sapBody: data });
  }
  return data;
}

async function withRetry(fn, label) {
  let last;
  for (let i = 1; i <= 3; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (e.sapStatus >= 400 && e.sapStatus < 500) throw e;
      if (i < 3) { console.warn(`SAP retry ${i}/3 [${label}]`); await new Promise(r => setTimeout(r, Math.pow(2,i)*500)); }
    }
  }
  throw last;
}

const TIPO_LABEL = { gar: 'Garantía', dev: 'Devolución', at: 'Apoyo Técnico' };
const MAP_STATUS = { Open: 'en_revision', Pending: 'en_proceso', Closed: 'cerrado', Cancelled: 'rechazado' };
const folio = (n) => `GPA-${new Date().getFullYear()}-${String(n).padStart(5,'0')}`;

// ── Operaciones ───────────────────────────────────────────────────────────────
async function crearTicket(p) {
  const required = ['tipoTicket','familia','nombreContacto','telefono','emailContacto','numeroFactura','codigoProducto','descripcion','sapClienteId','ejecutivoGpa'];
  const missing = required.filter(k => !p?.[k]);
  if (missing.length) return { success: false, errorCode: 400, error: `Campos faltantes: ${missing.join(', ')}.` };

  try {
    const data = await withRetry(() => sapRequest('POST', '/ServiceCalls', {
      CardCode: p.sapClienteId,
      Subject: `${TIPO_LABEL[p.tipoTicket]||p.tipoTicket} — ${p.familia} — Fac: ${p.numeroFactura}`,
      Description: p.descripcion,
      TechnicianCode: p.ejecutivoGpa,
      // UDFs — confirmar nombres con admin SAP
      U_GPA_TipoSolicitud: p.tipoTicket, U_GPA_Familia: p.familia,
      U_GPA_NumFactura: p.numeroFactura, U_GPA_CodigoProducto: p.codigoProducto,
      U_GPA_NumSerie: p.numeroSerie||'', U_GPA_ContactoNombre: p.nombreContacto,
      U_GPA_ContactoTel: p.telefono, U_GPA_ContactoEmail: p.emailContacto,
    }), 'crearTicket');
    return { success: true, folio: folio(data.DocNum), sapId: String(data.DocEntry) };
  } catch (e) {
    return { success: false, errorCode: e.sapStatus||502, error: e.message };
  }
}

async function consultarTicket(p) {
  if (!p?.sapId) return { success: false, errorCode: 400, error: 'sapId requerido.' };
  try {
    const data = await withRetry(() => sapRequest('GET', `/ServiceCalls(${encodeURIComponent(p.sapId)})`), 'consultarTicket');
    return { success: true, status: MAP_STATUS[data.Status]||'en_revision', folio: folio(data.DocNum), sapId: String(data.DocEntry) };
  } catch (e) {
    return { success: false, errorCode: e.sapStatus||502, error: e.message };
  }
}

async function verificarCliente(p) {
  if (!p?.cardCode) return { success: false, errorCode: 400, error: 'cardCode requerido.' };
  try {
    await sapRequest('GET', `/BusinessPartners('${encodeURIComponent(p.cardCode)}')`);
    return { success: true, exists: true, cardCode: p.cardCode };
  } catch (e) {
    if (e.sapStatus === 404) return { success: true, exists: false, cardCode: p.cardCode };
    return { success: false, errorCode: e.sapStatus||502, error: e.message };
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  console.log('[SAP Lambda] action:', event.action);
  switch (event.action) {
    case 'crearTicket':      return crearTicket(event.payload);
    case 'consultarTicket':  return consultarTicket(event.payload);
    case 'verificarCliente': return verificarCliente(event.payload);
    default: return { success: false, errorCode: 400, error: `Acción desconocida: "${event.action}"` };
  }
};
