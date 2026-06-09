// src/services/sap.js
// Integración real con SAP B1 Service Layer.
// Gestiona la sesión automáticamente y reintenta con backoff exponencial.

const fetch   = require('node-fetch');
const https   = require('https');
const logger  = require('../utils/logger');

const BASE_URL = process.env.SAP_SERVICE_LAYER_URL;

// Acepta certificados autofirmados (común en SAP B1 on-premise)
const agent = new https.Agent({ rejectUnauthorized: false });

// ── Gestión de sesión ─────────────────────────────────────────────────────────
// SAP SL autentica por sesión (cookie B1SESSION).
// La renovamos 2 minutos antes de que expire (default SAP: 30 min).

let _session       = null;
let _sessionExpiry = 0;
const SESSION_DURATION_MS = 30 * 60 * 1000;
const SESSION_MARGIN_MS   =  2 * 60 * 1000;

async function getSession() {
  if (_session && Date.now() < _sessionExpiry - SESSION_MARGIN_MS) {
    return _session;
  }

  logger.debug('SAP: abriendo sesión...');

  const res = await fetch(`${BASE_URL}/Login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      CompanyDB: process.env.SAP_COMPANY_DB,
      UserName:  process.env.SAP_USER,
      Password:  process.env.SAP_PASSWORD,
    }),
    agent,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SAP Login falló (${res.status}): ${text}`);
  }

  // SAP devuelve la cookie B1SESSION en Set-Cookie
  const setCookie = res.headers.get('set-cookie') || '';
  const match     = setCookie.match(/B1SESSION=([^;]+)/i);
  if (!match) throw new Error('SAP Login: no se recibió B1SESSION en la respuesta.');

  _session       = match[1];
  _sessionExpiry = Date.now() + SESSION_DURATION_MS;

  logger.debug('SAP: sesión abierta.');
  return _session;
}

// ── Petición autenticada a SAP ────────────────────────────────────────────────
async function sapRequest(method, path, body) {
  const session = await getSession();

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie:         `B1SESSION=${session}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    agent,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.error?.message?.value || `HTTP ${res.status}`;
    const err = new Error(`SAP ${method} ${path} → ${msg}`);
    err.sapStatus = res.status;
    err.sapBody   = data;
    throw err;
  }

  return data;
}

// ── Backoff exponencial ────────────────────────────────────────────────────────
async function withRetry(fn, maxRetries = 3, label = '') {
  let lastErr;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // No reintentar errores 4xx (son errores de negocio, no de red)
      if (err.sapStatus >= 400 && err.sapStatus < 500) throw err;
      if (i < maxRetries) {
        const ms = Math.pow(2, i) * 500; // 1 s, 2 s, 4 s
        logger.warn(`SAP retry ${i}/${maxRetries} [${label}]: ${err.message} — esperando ${ms} ms`);
        await new Promise(r => setTimeout(r, ms));
      }
    }
  }
  throw lastErr;
}

// ── API pública ────────────────────────────────────────────────────────────────

/**
 * Crea un ticket de servicio en SAP B1.
 *
 * IMPORTANTE: Los nombres de campos U_GPA_* son UDFs (User Defined Fields).
 * Deben existir en SAP antes del primer uso.
 * Confirmar nombres exactos con el administrador SAP de GPA.
 *
 * @param {object} ticket  - Registro de la tabla tickets
 * @returns {{ folio: string, sapId: string }}
 */
async function createServiceCall(ticket) {
  return withRetry(async () => {
    const payload = {
      // ── Campos estándar SAP ────────────────────────────────────────────────
      CardCode:       ticket.sap_cliente_id,
      Subject:        buildSubject(ticket),
      Description:    ticket.descripcion,
      TechnicianCode: ticket.ejecutivo_gpa,   // confirmar si va ejecutivo o técnico

      // ── UDFs GPA (confirmar nombres con admin SAP) ─────────────────────────
      U_GPA_TipoSolicitud:  ticket.tipo_ticket,      // gar | dev | at
      U_GPA_Familia:        ticket.familia,
      U_GPA_NumFactura:     ticket.numero_factura,
      U_GPA_CodigoProducto: ticket.codigo_producto,
      U_GPA_NumSerie:       ticket.numero_serie || '',
      U_GPA_ContactoNombre: ticket.nombre_contacto,
      U_GPA_ContactoTel:    ticket.telefono,
      U_GPA_ContactoEmail:  ticket.email_contacto,
    };

    logger.debug('SAP createServiceCall', {
      cardCode: payload.CardCode,
      subject:  payload.Subject,
    });

    const data = await sapRequest('POST', '/ServiceCalls', payload);

    // SAP devuelve DocEntry (ID interno) y DocNum (número secuencial visible)
    const folio = buildFolio(data.DocNum);
    const sapId  = String(data.DocEntry);

    logger.info('SAP ticket creado', { folio, sapId });
    return { folio, sapId };
  }, 3, 'createServiceCall');
}

/**
 * Consulta el estado actual de un ticket en SAP.
 * @param {string} sapId  - DocEntry del ticket en SAP
 * @returns {{ status: string, folio: string }}
 */
async function getServiceCallStatus(sapId) {
  return withRetry(async () => {
    const data = await sapRequest('GET', `/ServiceCalls(${sapId})`);
    return {
      status: mapSapStatus(data.Status),
      folio:  buildFolio(data.DocNum),
    };
  }, 2, 'getServiceCallStatus');
}

/**
 * Verifica que un cliente existe en SAP antes de crear el ticket.
 * Retorna true/false sin lanzar error.
 */
async function verifyCustomer(cardCode) {
  try {
    await sapRequest('GET', `/BusinessPartners('${encodeURIComponent(cardCode)}')`);
    return true;
  } catch {
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const TIPO_LABEL = { gar: 'Garantía', dev: 'Devolución', at: 'Apoyo Técnico' };

function buildSubject(ticket) {
  const tipo = TIPO_LABEL[ticket.tipo_ticket] || ticket.tipo_ticket;
  return `${tipo} — ${ticket.familia} — Fac: ${ticket.numero_factura}`;
}

function buildFolio(docNum) {
  return `GPA-${new Date().getFullYear()}-${String(docNum).padStart(5, '0')}`;
}

// Mapear estados SAP a los estados internos del portal
function mapSapStatus(sapStatus) {
  const MAP = {
    'Open':      'en_revision',
    'Pending':   'en_proceso',
    'Closed':    'cerrado',
    'Cancelled': 'rechazado',
  };
  return MAP[sapStatus] || 'en_revision';
}

module.exports = { createServiceCall, getServiceCallStatus, verifyCustomer };
