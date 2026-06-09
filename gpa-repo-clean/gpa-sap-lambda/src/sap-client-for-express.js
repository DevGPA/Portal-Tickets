// sap-client-for-express.js
// Reemplaza src/services/sap.js en el proyecto gpa-api.
// El backend Express ya NO llama a SAP directamente —
// invoca la Lambda gpa-sap-lambda que es quien habla con SAP Service Layer.
//
// Instalación en gpa-api:
//   1. Copiar este archivo a gpa-api/src/services/sap.js  (reemplazar el existente)
//   2. npm install @aws-sdk/client-lambda
//   3. Agregar SAP_LAMBDA_NAME al .env de gpa-api
//
// Variable de entorno requerida en gpa-api:
//   SAP_LAMBDA_NAME=gpa-sap-lambda-production

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const logger = require('../utils/logger');

const lambda      = new LambdaClient({ region: process.env.AWS_REGION });
const LAMBDA_NAME = process.env.SAP_LAMBDA_NAME;

// ── Invocar Lambda ─────────────────────────────────────────────────────────────
async function invokeLambda(action, payload) {
  logger.debug(`[SAP Lambda] invoke: ${action}`, payload);

  const cmd = new InvokeCommand({
    FunctionName:   LAMBDA_NAME,
    InvocationType: 'RequestResponse',          // síncrono — esperar respuesta
    Payload:        Buffer.from(JSON.stringify({ action, payload })),
  });

  const res = await lambda.send(cmd);

  // FunctionError = Lambda explotó antes de llegar al handler (error de runtime)
  if (res.FunctionError) {
    const detail = Buffer.from(res.Payload).toString();
    throw new Error(`Lambda FunctionError [${action}]: ${detail}`);
  }

  const result = JSON.parse(Buffer.from(res.Payload).toString());

  if (!result.success) {
    const err = new Error(result.error || 'Error en Lambda SAP');
    err.sapStatus = result.errorCode;
    throw err;
  }

  return result;
}

// ── API pública — misma interfaz que el sap.js anterior ───────────────────────
// El resto del código de gpa-api (routes/tickets.js, etc.) no cambia.

async function createServiceCall(ticket) {
  return invokeLambda('crearTicket', {
    tipoTicket:     ticket.tipo_ticket,
    tipoGarantia:   ticket.tipo_garantia || null,  // de OITM,U_TipoGarantia
    familia:        ticket.familia,
    nombreContacto: ticket.nombre_contacto,
    telefono:       ticket.telefono,
    emailContacto:  ticket.email_contacto,
    numeroFactura:  ticket.numero_factura,
    codigoProducto: ticket.codigo_producto,
    numeroSerie:    ticket.numero_serie || '',
    descripcion:    ticket.descripcion,
    sapClienteId:   ticket.sap_cliente_id,
    ejecutivoGpa:   ticket.ejecutivo_gpa,
  });
}

async function getServiceCallStatus(sapId) {
  return invokeLambda('consultarTicket', { sapId });
}

async function verifyCustomer(cardCode) {
  const res = await invokeLambda('verificarCliente', { cardCode });
  return res.exists;
}

// Obtener datos del artículo desde SAP (descripción + U_TipoGarantia)
// Se llama cuando el distribuidor selecciona un producto en el portal.
async function getArticulo(itemCode) {
  return invokeLambda('obtenerArticulo', { itemCode });
}

// Obtener artículos de una factura específica del cliente.
// Se llama cuando el distribuidor escribe el No. de Factura en el portal.
async function getArticulosFactura(cardCode, docNum) {
  return invokeLambda('obtenerArticulosFactura', { cardCode, docNum: String(docNum) });
}

// Autocompletado de facturas — busca por fragmento de DocNum del cliente.
async function buscarFacturas(cardCode, query) {
  return invokeLambda('buscarFacturas', { cardCode, query: String(query) });
}

module.exports = { createServiceCall, getServiceCallStatus, verifyCustomer, getArticulo, getArticulosFactura, buscarFacturas };
