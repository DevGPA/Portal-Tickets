'use strict';

const express = require('express');
const sap = require('../services/sapClient');
const { requireAuth } = require('../middleware/auth');
const { asyncH } = require('../middleware/errorHandler');

const router = express.Router();

// Todas las rutas SAP requieren sesión: usamos el cardCode del usuario logueado.
router.use(requireAuth);

// POST /sap/buscar-facturas  { query } -> { facturas: [{docNum,fecha,total,moneda}] }
router.post(
  '/buscar-facturas',
  asyncH(async (req, res) => {
    const { query } = req.body || {};
    const facturas = await sap.buscarFacturas({
      cardCode: req.user.sap_cliente_id,
      query: String(query || ''),
    });
    res.json({ facturas });
  })
);

// POST /sap/articulos-factura  { docNum } -> { success, articulos } | { success:false, error }
router.post(
  '/articulos-factura',
  asyncH(async (req, res) => {
    const { docNum } = req.body || {};
    if (!docNum) {
      return res.status(400).json({ success: false, error: 'Falta el número de factura.' });
    }
    const articulos = await sap.articulosDeFactura({
      cardCode: req.user.sap_cliente_id,
      docNum: String(docNum),
    });
    if (articulos === null) {
      return res.json({ success: false, error: 'Factura no encontrada.' });
    }
    return res.json({ success: true, articulos });
  })
);

module.exports = router;
