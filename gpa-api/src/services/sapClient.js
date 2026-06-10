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

module.exports = { buscarFacturas, articulosDeFactura, sapEnabled };
