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

// Usuario SAP B1 (Users.InternalKey) al que se asignan los tickets del portal.
// 184 = usuario 'procesos' (Andres Orozco). Override vía env var SAP_ASSIGNEE_CODE.
const ASSIGNEE_CODE = parseInt(process.env.SAP_ASSIGNEE_CODE || '184', 10);
// Tipo de Llamada (CallType) obligatorio en la validación custom de su SAP. 17 = valor en uso.
const CALL_TYPE = parseInt(process.env.SAP_CALL_TYPE || '17', 10);

const TIPO_LABEL = { gar: 'Garantía', dev: 'Devolución', at: 'Apoyo Técnico' };
// El ServiceCall trae Status como StatusId numérico (OSCS). Se mapea al nombre
// que el frontend (getStatusInfo) reconoce. IDs obtenidos de /ServiceCallStatus.
const STATUS_BY_ID = {
  '-3': 'Abierto', '-2': 'Pendiente', '-1': 'Cerrado',
  '7':  'Cierre Cliente', '55': 'Proceso Técnico', '59': 'NC GPA-Cliente Pend',
  '60': 'VoBo Proveedor', '62': 'Cancelado', '64': 'Cliente Pendientes',
  '66': 'NC Proveedor Pend', '67': 'Documentando', '68': 'VoBo Direccion',
  '69': 'NC GPA Conta Pend',
};
const folio = (n) => `GPA-${new Date().getFullYear()}-${String(n).padStart(5,'0')}`;

// ── Operaciones ───────────────────────────────────────────────────────────────
async function crearTicket(p) {
  const required = ['tipoTicket','familia','nombreContacto','telefono','emailContacto','numeroFactura','codigoProducto','descripcion','sapClienteId','ejecutivoGpa'];
  const missing = required.filter(k => !p?.[k]);
  if (missing.length) return { success: false, errorCode: 400, error: `Campos faltantes: ${missing.join(', ')}.` };

  try {
    // Subject = descripción del problema capturada por el cliente en el portal.
    // SAP B1 limita OSCL.Subject a 100 chars; el texto completo queda en la BD
    // (tickets.descripcion). Description se deja VACÍO a propósito: Postventa lo
    // usa para sus notas de seguimiento, no debe llevar datos del cliente.
    const body = {
      CustomerCode: p.sapClienteId,
      AssigneeCode: ASSIGNEE_CODE,
      ItemCode: p.codigoProducto,       // obligatorio (SysGPA-191-02: "campo Artículo")
      CallType: CALL_TYPE,              // obligatorio (SysGPA-191-03: "Tipo de Llamada")
      U_TicketUsr: 'CLIENTE',           // obligatorio ("Usuario Ticket")
      U_Factura: p.numeroFactura,       // No. de factura capturado en el portal
      Subject: String(p.descripcion || '').slice(0, 100),
    };
    // TechnicianCode en SAP es numérico; el ejecutivo viene como código ("EV01"),
    // así que solo se envía si es un entero válido (si no, se omite).
    if (/^\d+$/.test(String(p.ejecutivoGpa || ''))) body.TechnicianCode = parseInt(p.ejecutivoGpa, 10);
    const data = await withRetry(() => sapRequest('POST', '/ServiceCalls', body), 'crearTicket');
    // El "CallID" oficial de SAP ES el ServiceCallID (PK de OSCL) — el folio que
    // el cliente referencia con Postventa. (No existe un campo CallID separado.)
    const callId = String(data.ServiceCallID);
    return { success: true, folio: callId, sapId: callId, callId };
  } catch (e) {
    return { success: false, errorCode: e.sapStatus||502, error: e.message };
  }
}

async function consultarTicket(p) {
  if (!p?.sapId) return { success: false, errorCode: 400, error: 'sapId requerido.' };
  try {
    const data = await withRetry(() => sapRequest('GET', `/ServiceCalls(${encodeURIComponent(p.sapId)})`), 'consultarTicket');
    const callId = String(data.ServiceCallID);
    return {
      success: true,
      status:        STATUS_BY_ID[String(data.Status)] || String(data.Status),
      resolution:    data.Resolution || null,
      infoPendiente: data.U_InfoPendienteCliente || null,
      folio:         callId,
      sapId:         callId,
      callId,
    };
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

// ── Datos del cliente (BusinessPartner) ─────────────────────────────────────────
// Devuelve los campos del maestro de clientes en SAP para sincronizar el perfil
// del usuario del portal. Payload: { cardCode }
// Respuesta: { success, cardCode, cardName, salesPersonCode, groupCode, ...udfs }
async function obtenerCliente(p) {
  if (!p?.cardCode) return { success: false, errorCode: 400, error: 'cardCode requerido.' };
  try {
    const bp = await sapRequest('GET', `/BusinessPartners('${encodeURIComponent(p.cardCode)}')`);
    const udfs = Object.fromEntries(
      Object.entries(bp).filter(([k]) => k.startsWith('U_') && bp[k] != null)
    );
    return {
      success: true,
      cardCode:        bp.CardCode,
      cardName:        bp.CardName,
      salesPersonCode: bp.SalesPersonCode ?? null,
      groupCode:       bp.GroupCode ?? null,
      federalTaxID:    bp.FederalTaxID ?? null,
      email:           bp.EmailAddress ?? null,
      phone:           bp.Phone1 ?? null,
      valid:           bp.Valid ?? null,
      udfs,
    };
  } catch (e) {
    if (e.sapStatus === 404) return { success: false, errorCode: 404, error: `Cliente ${p.cardCode} no existe en SAP.` };
    return { success: false, errorCode: e.sapStatus || 502, error: e.message };
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
          let tipoGarantia = null, itmsGrpCod = null;
          try {
            const item = await sapRequest('GET', `/Items('${encodeURIComponent(linea.ItemCode)}')`);
            tipoGarantia = item.U_TipoGarantia || null;
            itmsGrpCod   = item.ItemsGroupCode ?? null;   // OITM.ItmsGrpCod → para resolver familia
          } catch (e) {
            console.warn(`No se pudo obtener el maestro de ${linea.ItemCode}: ${e.message}`);
          }
          return {
            itemCode:    linea.ItemCode,
            descripcion: linea.ItemDescription || linea.ItemCode,
            tipoGarantia,
            itmsGrpCod,
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

// ── Familias (grupos de artículos, OITB / entidad ItemGroups) ─────────────────
// Respuesta: { success, familias: [{ itmsGrpCod, groupName, descripcion }] }
// El frontend arma FAMILIA_ITMSGRP_MAP[itmsGrpCod] = descripcion || groupName.
async function obtenerFamilias() {
  try {
    const familias = [];
    let path = '/ItemGroups';            // sin $select para incluir U_Descripcion si existe
    for (let i = 0; i < 25 && path; i++) {   // pagina via nextLink (cap defensivo)
      const data = await withRetry(() => sapRequest('GET', path), 'obtenerFamilias');
      for (const g of (data?.value || [])) {
        familias.push({ itmsGrpCod: g.Number, groupName: g.GroupName, descripcion: g.U_Descripcion || null });
      }
      const next = data['@odata.nextLink'] || data['odata.nextLink'];
      path = next ? (next.startsWith('/') ? next : '/' + next) : null;
    }
    return { success: true, familias };
  } catch (e) {
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
    case 'obtenerCliente':           return obtenerCliente(event.payload);
    case 'buscarFacturas':           return buscarFacturas(event.payload);
    case 'obtenerArticulosFactura':  return obtenerArticulosFactura(event.payload);
    case 'obtenerFamilias':          return obtenerFamilias();
    default: return { success: false, errorCode: 400, error: `Acción desconocida: "${event.action}"` };
  }
};
