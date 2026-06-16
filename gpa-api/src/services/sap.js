// src/services/sap.js
// Proxy hacia la Lambda SAP — invoca las operaciones SAP via AWS SDK.
// El backend Express NO llama a SAP directamente.

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const logger = require('../utils/logger');

const lambda      = new LambdaClient({ region: process.env.AWS_REGION });
const LAMBDA_NAME = process.env.SAP_LAMBDA_NAME;

async function invokeLambda(action, payload = {}) {
  logger.debug('SAP Lambda invoke', { action });
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
    const err = new Error(result.error || `Error SAP [${action}]`);
    err.sapStatus = result.errorCode;
    throw err;
  }
  return result;
}

// Crear ticket en SAP. Devuelve { folio, sapId, callID }
async function createServiceCall(ticket) {
  return invokeLambda('crearTicket', {
    tipoTicket:     ticket.tipo_ticket,
    familia:        ticket.familia,
    nombreContacto: ticket.nombre_contacto,
    telefono:       ticket.telefono,
    emailContacto:  ticket.email_contacto,
    numeroFactura:  ticket.numero_factura,
    codigoProducto: ticket.codigo_producto,
    tipoGarantia:   ticket.tipo_garantia || null,   // OITM,U_TipoGarantia → OSCL,callType
    numeroSerie:    ticket.numero_serie   || '',
    descripcion:    ticket.descripcion    || '',
    sapClienteId:   ticket.sap_cliente_id,
    ejecutivoGpa:   ticket.ejecutivo_gpa,
  });
}

// Consultar estado de un ticket en SAP
async function getServiceCallStatus(sapId) {
  return invokeLambda('consultarTicket', { sapId });
}

// Verificar que un cliente existe en SAP
async function verifyCustomer(cardCode) {
  const res = await invokeLambda('verificarCliente', { cardCode });
  return res.exists;
}

module.exports = { createServiceCall, getServiceCallStatus, verifyCustomer };
