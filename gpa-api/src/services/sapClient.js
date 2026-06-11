'use strict';

// Cliente de SAP Business One (Service Layer). Si SAP_SERVICE_LAYER_URL no está
// configurado, devuelve los mismos datos DEMO que usa el frontend, para poder
// validar el flujo completo sin un SAP real.
//
// TODO(prod): implementar login a Service Layer (POST /Login con CompanyDB/User/
// Password -> cookie B1SESSION) y las consultas OData reales sobre Invoices.

const https = require('https');
const axios = require('axios');
const config = require('../config');

const sapEnabled = Boolean(config.sap.serviceLayerUrl);

// El Service Layer de SAP B1 usa certificado self-signed → no validar la cadena TLS.
const sapHttp = axios.create({
  baseURL: config.sap.serviceLayerUrl || undefined,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 25000,
});

// SAP maneja MXP (peso mexicano); el frontend formatea con código ISO → MXN.
function normalizaMoneda(m) {
  return m === 'MXP' ? 'MXN' : m || 'MXN';
}

// ── Datos demo (espejo del frontend) ─────────────────────────────────────────
const DEMO_FACTURAS = [
  { docNum: '10284566', fecha: '2026-03-15', total: 45800, moneda: 'MXN' },
  { docNum: '10284433', fecha: '2026-02-28', total: 12300, moneda: 'MXN' },
  { docNum: '10283100', fecha: '2026-01-10', total: 89500, moneda: 'MXN' },
  { docNum: '09876543', fecha: '2025-12-05', total: 23100, moneda: 'MXN' },
  { docNum: '09876200', fecha: '2025-11-20', total: 67400, moneda: 'MXN' },
  { docNum: '11111111', fecha: '2026-04-01', total: 155000, moneda: 'MXN' },
  { docNum: '11110050', fecha: '2026-03-28', total: 8900, moneda: 'MXN' },
];

const DEMO_ARTICULOS = {
  10284566: [
    { itemCode: 'IW-BC-120', descripcion: 'Inter Heat Smart 120,000 BTU', tipoGarantia: 'A1', cantidad: 1 },
    { itemCode: 'CV-FIL-24', descripcion: 'Carvin Filtro Pacific 24"', tipoGarantia: 'B1', cantidad: 1 },
  ],
  '09876543': [
    { itemCode: 'IW-MOT-1.5', descripcion: 'Inter Water Motobomba 1.5 HP', tipoGarantia: 'A2', cantidad: 2 },
  ],
  11111111: [
    { itemCode: 'HW-CLO-T15', descripcion: 'Hayward TurboCell T-15', tipoGarantia: 'B2', cantidad: 1 },
    { itemCode: 'NL-REF-12', descripcion: 'Nova LED Reflector 12W RGB', tipoGarantia: null, cantidad: 4 },
    { itemCode: 'IW-CUB-AUTO', descripcion: 'Inter Water Cubierta Automática', tipoGarantia: 'A1', cantidad: 1 },
  ],
};

// ── Sesión Service Layer (cacheada; expira ~30 min) ──────────────────────────
let sessionCookie = null;

async function login() {
  const res = await sapHttp.post('/Login', {
    CompanyDB: config.sap.companyDb,
    UserName: config.sap.user,
    Password: config.sap.password,
  });
  sessionCookie = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  return sessionCookie;
}

// GET autenticado con re-login automático si la sesión expiró (401).
async function slGet(path) {
  if (!sessionCookie) await login();
  try {
    return await sapHttp.get(path, { headers: { Cookie: sessionCookie } });
  } catch (e) {
    if (e.response && e.response.status === 401) {
      await login();
      return sapHttp.get(path, { headers: { Cookie: sessionCookie } });
    }
    throw e;
  }
}

// POST autenticado con re-login automático si la sesión expiró (401).
async function slPost(path, body) {
  if (!sessionCookie) await login();
  try {
    return await sapHttp.post(path, body, { headers: { Cookie: sessionCookie } });
  } catch (e) {
    if (e.response && e.response.status === 401) {
      await login();
      return sapHttp.post(path, body, { headers: { Cookie: sessionCookie } });
    }
    throw e;
  }
}

// Mapeo tipo de ticket del portal → CallTypeID de SAP B1.
const CALLTYPE_MAP = { gar: 2 /* GARANTIA */, dev: 3 /* DEVOLUCION */, at: 21 /* APOYO TECNICO */ };
const SC_ORIGIN_WEB = -1;
const SC_ASSIGNEE = 100; // usuario Postventa (FactGdl1)

/**
 * Crea un Service Call en SAP B1 para el ticket del portal.
 * Lanza error si SAP rechaza (p. ej. cliente inactivo, artículo faltante).
 * @returns {Promise<{serviceCallId:number, docNum:number}>}
 */
async function crearServiceCall({ cardCode, tipoTicket, itemCode, folio, descripcion, numeroFactura, piezas }) {
  const subject = `[Portal ${folio}] ${descripcion || 'Solicitud de postventa'}`.slice(0, 100);
  const body = {
    Subject: subject,
    CustomerCode: cardCode,
    CallType: CALLTYPE_MAP[tipoTicket] || 5, // 5 = OTROS (fallback)
    Origin: SC_ORIGIN_WEB,
    AssigneeCode: SC_ASSIGNEE,
    ItemCode: itemCode || undefined, // obligatorio por regla SysGPA-191-02
    CustomerRefNo: folio, // referencia cruzada al folio del portal
    Description: descripcion || subject,
    U_TicketUsr: 'CLIENTE', // UDF obligatorio "Usuario Ticket"
  };
  if (numeroFactura) body.U_Factura = String(numeroFactura);
  if (piezas) body.U_Piezas = Number(piezas) || 1;

  try {
    const res = await slPost('/ServiceCalls', body);
    return { serviceCallId: res.data.ServiceCallID, docNum: res.data.DocNum };
  } catch (e) {
    // Extraer el mensaje de negocio de SAP (p. ej. "Customer ... is inactive").
    const sapMsg = e.response?.data?.error?.message?.value;
    throw new Error(sapMsg || e.message);
  }
}

/**
 * Busca facturas (Invoices) de un cliente cuyo DocNum contenga `query`.
 * @returns {Promise<Array<{docNum,fecha,total,moneda}>>}
 */
async function buscarFacturas({ cardCode, query }) {
  if (!sapEnabled) {
    return DEMO_FACTURAS.filter((f) => f.docNum.includes(query || '')).slice(0, 10);
  }
  // Facturas del cliente, más recientes primero; se filtra por DocNum en memoria
  // (DocNum es numérico en SAP, no admite contains() directo).
  const cc = String(cardCode).replace(/'/g, "''");
  const res = await slGet(
    `/Invoices?$select=DocNum,DocDate,DocTotal,DocCurrency` +
      `&$filter=CardCode eq '${cc}'&$orderby=DocEntry desc&$top=50`
  );
  return (res.data.value || [])
    .filter((inv) => String(inv.DocNum).includes(query || ''))
    .slice(0, 10)
    .map((inv) => ({
      docNum: String(inv.DocNum),
      fecha: (inv.DocDate || '').slice(0, 10),
      total: inv.DocTotal,
      moneda: normalizaMoneda(inv.DocCurrency),
    }));
}

/**
 * Devuelve los artículos (líneas) de una factura, con tipo de garantía.
 * @returns {Promise<Array<{itemCode,descripcion,tipoGarantia,cantidad}>|null>}
 *          null => factura no encontrada.
 */
async function articulosDeFactura({ cardCode, docNum }) {
  if (!sapEnabled) {
    return DEMO_ARTICULOS[docNum] || null;
  }
  const cc = String(cardCode).replace(/'/g, "''");
  const res = await slGet(
    `/Invoices?$select=DocNum,DocumentLines` +
      `&$filter=DocNum eq ${Number(docNum)} and CardCode eq '${cc}'`
  );
  const inv = (res.data.value || [])[0];
  if (!inv) return null; // factura no encontrada para ese cliente
  return (inv.DocumentLines || []).map((l) => ({
    itemCode: l.ItemCode,
    descripcion: l.ItemDescription,
    // No existe UDF de garantía en las líneas de SAP; se deja null (el frontend
    // lo maneja). Si más adelante se define un catálogo/UDF, se resuelve aquí.
    tipoGarantia: null,
    cantidad: l.Quantity,
  }));
}

module.exports = { buscarFacturas, articulosDeFactura, crearServiceCall, sapEnabled };
