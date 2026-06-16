// src/routes/sap.js
// Endpoints SAP — proxy entre el portal y la Lambda SAP.
// Todas las rutas requieren autenticación JWT.
//
// GET  /api/sap/familias           → grupos de artículos desde OITB
// POST /api/sap/buscar-facturas    → autocompletado de facturas del cliente
// POST /api/sap/articulos-factura  → artículos de una factura específica

const router = require('express').Router();
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { requireAuth } = require('../middleware/auth');
const logger = require('../utils/logger');

const lambda      = new LambdaClient({ region: process.env.AWS_REGION });
const LAMBDA_NAME = process.env.SAP_LAMBDA_NAME;

// ── Helper: invocar Lambda SAP ────────────────────────────────────────────────
async function invokeSAP(action, payload = {}) {
  const cmd = new InvokeCommand({
    FunctionName:   LAMBDA_NAME,
    InvocationType: 'RequestResponse',
    Payload:        Buffer.from(JSON.stringify({ action, payload })),
  });

  const res    = await lambda.send(cmd);
  if (res.FunctionError) {
    const detail = Buffer.from(res.Payload).toString();
    throw new Error(`Lambda FunctionError [${action}]: ${detail}`);
  }

  const result = JSON.parse(Buffer.from(res.Payload).toString());
  if (!result.success) {
    const err = new Error(result.error || `Error en Lambda SAP [${action}]`);
    err.sapStatus = result.errorCode;
    throw err;
  }
  return result;
}

// ── GET /api/sap/familias ─────────────────────────────────────────────────────
// Devuelve los grupos de artículos de SAP (OITB).
// Equivale a: SELECT U_CodigoGPA, U_Descripcion FROM OITB
// El portal usa esto para mapear ItmsGrpCod → nombre de familia.
// Se recomienda cachear en el cliente — los grupos cambian raramente.
router.get('/familias', requireAuth, async (req, res, next) => {
  try {
    const data = await invokeSAP('obtenerFamilias');
    logger.debug('SAP familias obtenidas', { count: data.familias?.length });
    res.json(data);
  } catch (err) {
    logger.error('Error obteniendo familias SAP', { error: err.message });
    next(err);
  }
});

// ── POST /api/sap/buscar-facturas ─────────────────────────────────────────────
// Autocompletado de facturas: busca facturas del cliente que contengan `query`.
// Body: { query: "1028" }
// Respuesta: { success: true, facturas: [{ docNum, fecha, total, moneda }] }
router.post('/buscar-facturas', requireAuth, async (req, res, next) => {
  try {
    const { query } = req.body;
    if (!query || String(query).trim().length < 2) {
      return res.json({ success: true, facturas: [] });
    }
    const data = await invokeSAP('buscarFacturas', {
      cardCode: req.user.sap_cliente_id,
      query:    String(query).trim(),
    });
    res.json(data);
  } catch (err) {
    logger.error('Error buscando facturas SAP', { error: err.message, user: req.user.id });
    next(err);
  }
});

// ── POST /api/sap/articulos-factura ──────────────────────────────────────────
// Artículos de una factura específica del cliente (DocNum).
// Body: { docNum: "10284566" }
// Respuesta: { success: true, articulos: [{ itemCode, descripcion, tipoGarantia, itmsGrpCod, cantidad }] }
router.post('/articulos-factura', requireAuth, async (req, res, next) => {
  try {
    const { docNum } = req.body;
    if (!docNum) {
      return res.status(400).json({ error: 'docNum es requerido.' });
    }
    const data = await invokeSAP('obtenerArticulosFactura', {
      cardCode: req.user.sap_cliente_id,
      docNum:   String(docNum).trim(),
    });
    res.json(data);
  } catch (err) {
    logger.error('Error obteniendo artículos de factura SAP', { error: err.message, user: req.user.id });
    next(err);
  }
});

module.exports = router;
