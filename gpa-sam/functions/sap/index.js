// functions/sap/index.js
// Lambda de SAP — no está expuesta en API Gateway.
// Solo la invoca TicketsFunction directamente vía AWS SDK.
// El SAP Service Layer usa un certificado SSL no confiable (autofirmado/CA
// privada), por lo que se usa un https.Agent con rejectUnauthorized:false
// acotado solo a las peticiones a SAP.

const fetch = require('node-fetch');
const https = require('https');

const BASE    = process.env.SAP_SERVICE_LAYER_URL;
const COMPANY = process.env.SAP_COMPANY_DB;
const USER    = process.env.SAP_USER;
const PASS    = process.env.SAP_PASSWORD;

const sapAgent = new https.Agent({ rejectUnauthorized: false });

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
    agent: sapAgent,
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
    agent: sapAgent,
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
    // INTERINO: los UDFs U_GPA_* aún no existen en el ServiceCall (ORSC) de SAP.
    // Mientras el admin SAP los crea, se pliegan los datos en Description para no perderlos.
    // TODO(SAP): cuando existan los UDFs, mover estos campos a sus propiedades U_GPA_*.
    const detalle = [
      p.descripcion,
      '',
      `Producto: ${p.codigoProducto}`,
      p.numeroSerie ? `No. Serie: ${p.numeroSerie}` : null,
      `Contacto: ${p.nombreContacto} · ${p.telefono} · ${p.emailContacto}`,
    ].filter(v => v !== null).join('\n');

    const body = {
      CustomerCode: p.sapClienteId,
      Subject: `${TIPO_LABEL[p.tipoTicket]||p.tipoTicket} — ${p.familia} — Fac: ${p.numeroFactura}`,
      Description: detalle,
    };
    // TechnicianCode en SAP es numérico; el ejecutivo viene como código ("EV01"),
    // así que solo se envía si es un entero válido (si no, se omite).
    if (/^\d+$/.test(String(p.ejecutivoGpa || ''))) body.TechnicianCode = parseInt(p.ejecutivoGpa, 10);
    const data = await withRetry(() => sapRequest('POST', '/ServiceCalls', body), 'crearTicket');
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

// ── Autocompletado de facturas ─────────────────────────────────────────────────
// Busca facturas del cliente cuyo DocNum contenga el texto escrito.
// Payload: { cardCode, query }
// Respuesta: { success: true, facturas: [{ docNum, fecha, total, moneda }] }
async function buscarFacturas(p) {
  if (!p?.cardCode) return { success: false, errorCode: 400, error: 'cardCode requerido.' };
  if (!p?.query || p.query.trim().length < 2) return { success: true, facturas: [] };

  const q = p.query.trim();
  // SAP B1 Service Layer no soporta cast()/contains() sobre DocNum (numérico),
  // así que se traen las facturas recientes del cliente y se filtra el substring
  // por DocNum en JS.
  const filter = `CardCode eq '${encodeURIComponent(p.cardCode)}'`;
  const path   = `/Invoices?$filter=${filter}&$select=DocNum,DocDate,DocTotal,DocCurrency&$orderby=DocNum desc&$top=50`;

  try {
    const data = await withRetry(() => sapRequest('GET', path), 'buscarFacturas');
    const facturas = (data?.value || [])
      .filter(f => String(f.DocNum).includes(q))
      .slice(0, 10)
      .map(f => ({
        docNum: String(f.DocNum),
        fecha:  f.DocDate ? f.DocDate.substring(0, 10) : null,
        total:  f.DocTotal,
        moneda: f.DocCurrency || 'MXN',
      }));
    return { success: true, facturas };
  } catch (e) {
    return { success: false, errorCode: e.sapStatus || 502, error: e.message };
  }
}

// ── Artículos de una factura ─────────────────────────────────────────────────
// Busca la factura (DocNum) del cliente (CardCode) y devuelve sus líneas con
// código, descripción, U_TipoGarantia y cantidad.
// Payload: { cardCode, docNum }
// Respuesta: { success: true, articulos: [{ itemCode, descripcion, tipoGarantia, cantidad }] }
async function obtenerArticulosFactura(p) {
  if (!p?.cardCode) return { success: false, errorCode: 400, error: 'cardCode requerido.' };
  if (!p?.docNum)   return { success: false, errorCode: 400, error: 'docNum requerido.' };

  const docNum = parseInt(p.docNum, 10);
  if (isNaN(docNum)) return { success: false, errorCode: 400, error: 'docNum debe ser numérico.' };

  try {
    const filter = `CardCode eq '${encodeURIComponent(p.cardCode)}' and DocNum eq ${docNum}`;
    const path   = `/Invoices?$filter=${filter}&$select=DocNum,CardCode,DocumentLines&$top=1`;
    const data   = await withRetry(() => sapRequest('GET', path), 'obtenerArticulosFactura');

    const facturas = data?.value || [];
    if (!facturas.length) return { success: false, errorCode: 404, error: `Factura ${p.docNum} no encontrada para este cliente.` };

    const lineas = facturas[0].DocumentLines || [];
    if (!lineas.length) return { success: false, errorCode: 404, error: 'La factura no tiene líneas de artículos.' };

    // DocumentLines no incluye UDFs del artículo — se consultan en el maestro
    const articulos = await Promise.all(
      lineas
        .filter(l => l.ItemCode && l.ItemCode.trim())
        .map(async (linea) => {
          let tipoGarantia = null;
          try {
            const item = await sapRequest('GET', `/Items('${encodeURIComponent(linea.ItemCode)}')`);
            tipoGarantia = item.U_TipoGarantia || null;
          } catch (e) {
            console.warn(`No se pudo obtener U_TipoGarantia para ${linea.ItemCode}: ${e.message}`);
          }
          return {
            itemCode:    linea.ItemCode,
            descripcion: linea.ItemDescription || linea.ItemCode,
            tipoGarantia,
            cantidad:    linea.Quantity || 1,
          };
        })
    );

    return { success: true, docNum: p.docNum, articulos };
  } catch (e) {
    if (e.sapStatus === 404) return { success: false, errorCode: 404, error: `Factura ${p.docNum} no encontrada.` };
    return { success: false, errorCode: e.sapStatus || 502, error: e.message };
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  console.log('[SAP Lambda] action:', event.action);
  switch (event.action) {
    case 'crearTicket':              return crearTicket(event.payload);
    case 'consultarTicket':          return consultarTicket(event.payload);
    case 'verificarCliente':         return verificarCliente(event.payload);
    case 'buscarFacturas':           return buscarFacturas(event.payload);
    case 'obtenerArticulosFactura':  return obtenerArticulosFactura(event.payload);
    default: return { success: false, errorCode: 400, error: `Acción desconocida: "${event.action}"` };
  }
};
