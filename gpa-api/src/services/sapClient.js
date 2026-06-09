'use strict';

// Cliente de SAP Business One (Service Layer). Si SAP_SERVICE_LAYER_URL no está
// configurado, devuelve los mismos datos DEMO que usa el frontend, para poder
// validar el flujo completo sin un SAP real.
//
// TODO(prod): implementar login a Service Layer (POST /Login con CompanyDB/User/
// Password -> cookie B1SESSION) y las consultas OData reales sobre Invoices.

const axios = require('axios');
const config = require('../config');

const sapEnabled = Boolean(config.sap.serviceLayerUrl);

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

// ── Sesión Service Layer (cacheada) ──────────────────────────────────────────
let sessionCookie = null;
async function login() {
  // TODO(prod): manejar expiración de sesión (Service Layer ~30 min) y reintentos.
  const res = await axios.post(`${config.sap.serviceLayerUrl}/Login`, {
    CompanyDB: config.sap.companyDb,
    UserName: config.sap.user,
    Password: config.sap.password,
  });
  sessionCookie = res.headers['set-cookie'];
  return sessionCookie;
}

/**
 * Busca facturas (Invoices) de un cliente cuyo DocNum contenga `query`.
 * @returns {Promise<Array<{docNum,fecha,total,moneda}>>}
 */
async function buscarFacturas({ cardCode, query }) {
  if (!sapEnabled) {
    return DEMO_FACTURAS.filter((f) => f.docNum.includes(query || '')).slice(0, 10);
  }
  if (!sessionCookie) await login();
  // TODO(prod): OData real, p.ej.:
  //   GET /Invoices?$filter=CardCode eq '{cardCode}' and contains(DocNum,'{query}')
  //       &$select=DocNum,DocDate,DocTotal,DocCurrency&$top=10
  const url =
    `${config.sap.serviceLayerUrl}/Invoices?$select=DocNum,DocDate,DocTotal,DocCurrency` +
    `&$filter=CardCode eq '${cardCode}'&$top=10`;
  const { data } = await axios.get(url, { headers: { Cookie: sessionCookie } });
  return (data.value || [])
    .filter((inv) => String(inv.DocNum).includes(query || ''))
    .map((inv) => ({
      docNum: String(inv.DocNum),
      fecha: (inv.DocDate || '').slice(0, 10),
      total: inv.DocTotal,
      moneda: inv.DocCurrency || 'MXN',
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
  if (!sessionCookie) await login();
  // TODO(prod): GET /Invoices?$filter=DocNum eq {docNum} and CardCode eq '{cardCode}'
  //             &$select=DocumentLines  -> mapear cada línea a {itemCode, descripcion, cantidad}
  //             y resolver tipoGarantia desde un UDF o catálogo de productos.
  const url =
    `${config.sap.serviceLayerUrl}/Invoices?$select=DocumentLines` +
    `&$filter=DocNum eq ${Number(docNum)} and CardCode eq '${cardCode}'`;
  const { data } = await axios.get(url, { headers: { Cookie: sessionCookie } });
  const inv = (data.value || [])[0];
  if (!inv) return null;
  return (inv.DocumentLines || []).map((l) => ({
    itemCode: l.ItemCode,
    descripcion: l.ItemDescription,
    tipoGarantia: l.U_TipoGarantia || null, // UDF de ejemplo
    cantidad: l.Quantity,
  }));
}

module.exports = { buscarFacturas, articulosDeFactura, sapEnabled };
