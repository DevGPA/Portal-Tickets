// src/handler.js
// Lambda que actúa como puente entre el backend Express (gpa-api) y SAP B1 Service Layer.
//
// SAP es accesible por URL pública HTTPS — no se requiere VPC ni configuración de red especial.
//
// El backend Express invoca esta Lambda directamente via AWS SDK (InvokeCommand).
// La Lambda gestiona la sesión SAP y ejecuta la operación solicitada.
//
// Operaciones soportadas (campo "action" en el event):
//   "crearTicket"      → POST /ServiceCalls
//   "consultarTicket"  → GET  /ServiceCalls({sapId})
//   "verificarCliente" → GET  /BusinessPartners('{cardCode}')

const { sapRequest, withRetry, SapError } = require('./sap-session');
const { getPrioridad } = require('./prioridad_map');  // mapa itemCode → prioridad SAP

const TIPO_LABEL = { gar: 'Garantía', dev: 'Devolución', at: 'Apoyo Técnico' };

// ── Handler principal ─────────────────────────────────────────────────────────
exports.handler = async (event) => {
  console.log('[Lambda] action:', event.action);

  switch (event.action) {
    case 'crearTicket':      return crearTicket(event.payload);
    case 'consultarTicket':  return consultarTicket(event.payload);
    case 'verificarCliente': return verificarCliente(event.payload);
    default:
      return error(400, `Acción desconocida: "${event.action}". Válidas: crearTicket, consultarTicket, verificarCliente.`);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// OPERACIÓN 1 — Crear ticket de servicio en SAP
// ══════════════════════════════════════════════════════════════════════════════
//
// Payload esperado:
// {
//   tipoTicket:     "gar" | "dev" | "at",
//   familia:        string,
//   nombreContacto: string,
//   telefono:       string,
//   emailContacto:  string,
//   numeroFactura:  string,
//   codigoProducto: string,
//   numeroSerie:    string (opcional),
//   descripcion:    string (máx 254 chars),
//   sapClienteId:   string,   ← CardCode del cliente en SAP
//   ejecutivoGpa:   string,   ← TechnicianCode (confirmar con admin SAP)
// }
//
// Respuesta exitosa: { success: true, folio: "GPA-2026-00042", sapId: "42" }
//
// NOTA — UDFs (User Defined Fields):
// Los campos U_GPA_* son campos personalizados que deben existir en SAP B1.
// El admin SAP los crea en:
//   Administración → Definición de campos → Campos de usuario
// Si alguno no existe, SAP devolverá error 400 con el nombre del campo faltante.
//
async function crearTicket(p) {
  const required = [
    'tipoTicket','familia','nombreContacto','telefono',
    'emailContacto','numeroFactura','codigoProducto',
    'descripcion','sapClienteId','ejecutivoGpa',
  ];
  const missing = required.filter(k => !p?.[k]);
  if (missing.length) return error(400, `Campos faltantes: ${missing.join(', ')}.`);

  try {
    const data = await withRetry(() =>
      sapRequest('POST', '/ServiceCalls', {
        // ── Campos estándar SAP B1 ──────────────────────────────────────────
        CardCode:       p.sapClienteId,
        // Subject = Descripción del problema capturada por el cliente en el portal (punto 3)
        Subject:        p.descripcion,
        // Description se deja vacío intencionalmente — no debe llevar datos
        // del cliente/producto ni la descripción (punto 5)
        TechnicianCode: p.ejecutivoGpa,
        // CallType = mapeo según tipo de ticket + tipo de garantía (punto 7/8,
        // ya tenía la función mapCallType pero nunca se invocaba)
        CallType:       mapCallType(p.tipoTicket, p.tipoGarantia),
        // U_Factura = No. de Factura capturado en el portal (punto 4)
        U_Factura:      p.numeroFactura,
        // Priority = mapa desde Excel de datos maestros del artículo
        // En NetSuite este dato vendrá directamente del maestro del artículo
        ...(getPrioridad(p.codigoProducto) ? { Priority: getPrioridad(p.codigoProducto) } : {}),

        // ── UDFs GPA — confirmar nombres exactos con el admin SAP ───────────
        U_GPA_TipoSolicitud:  p.tipoTicket,
        U_GPA_Familia:        p.familia,
        U_GPA_NumFactura:     p.numeroFactura,
        U_GPA_CodigoProducto: p.codigoProducto,
        U_GPA_NumSerie:       p.numeroSerie || '',
        U_GPA_ContactoNombre: p.nombreContacto,
        U_GPA_ContactoTel:    p.telefono,
        U_GPA_ContactoEmail:  p.emailContacto,
      }),
    'crearTicket');

    // SAP devuelve DocEntry (ID interno), DocNum (secuencial del documento)
    // y CallID (consecutivo oficial de Llamadas de Servicio — punto 2).
    // CallID viene en la respuesta del POST; si por alguna razón no llega,
    // se hace una consulta de respaldo inmediata por DocEntry.
    const sapId = String(data.DocEntry);
    let callId  = data.CallID != null ? String(data.CallID) : null;

    if (!callId) {
      try {
        const detalle = await sapRequest('GET', `/ServiceCalls(${encodeURIComponent(sapId)})`);
        callId = detalle.CallID != null ? String(detalle.CallID) : null;
      } catch (e) {
        console.warn('[SAP] No se pudo recuperar CallID por consulta de respaldo:', e.message);
      }
    }

    // El folio que ve el cliente en el portal ES el CallID real de SAP.
    // Si por algún motivo no se obtuvo, se usa el DocEntry como respaldo.
    const folio = callId || sapId;

    console.log(`[SAP] Ticket creado: folio=${folio} callId=${callId} sapId=${sapId}`);
    return ok({ folio, sapId, callId });

  } catch (err) {
    console.error('[SAP] crearTicket error:', err.message, err.sapBody);
    return error(err.sapStatus || 502, err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// OPERACIÓN 2 — Consultar estado de un ticket en SAP
// ══════════════════════════════════════════════════════════════════════════════
//
// Payload:  { sapId: "42" }   ← DocEntry devuelto al crear el ticket
// Respuesta: { success: true, status: "en_revision", folio: "GPA-2026-00042" }
//
async function consultarTicket(p) {
  if (!p?.sapId) return error(400, 'sapId es requerido.');

  try {
    const data = await withRetry(() =>
      sapRequest('GET', `/ServiceCalls(${encodeURIComponent(p.sapId)})`),
    'consultarTicket');

    const callId = data.CallID != null ? String(data.CallID) : null;

    // status se regresa TAL CUAL viene de SAP (ej. "Abierto", "Cliente Pendientes",
    // "Proceso Técnico", "NC GPA-Cliente Pend") — el portal hace el mapeo a frases
    // amigables comparando estos strings literales, no se traduce aquí.
    // SAP Service Layer usa PascalCase: Status, Resolution, U_InfoPendienteCliente
    return ok({
      status:        data.Status        || data.status        || null,
      resolution:    data.Resolution    || data.resolution    || null,
      infoPendiente: data.U_InfoPendienteCliente              || null,
      folio:         callId || String(data.DocEntry),
      callId,
      sapId:         String(data.DocEntry),
    });

  } catch (err) {
    if (err.sapStatus === 404) return error(404, `Ticket ${p.sapId} no encontrado en SAP.`);
    console.error('[SAP] consultarTicket error:', err.message);
    return error(err.sapStatus || 502, err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// OPERACIÓN 3 — Verificar que un cliente existe en SAP
// ══════════════════════════════════════════════════════════════════════════════
//
// Payload:  { cardCode: "C001" }
// Respuesta: { success: true, exists: true, cardCode: "C001" }
//
async function verificarCliente(p) {
  if (!p?.cardCode) return error(400, 'cardCode es requerido.');

  try {
    await sapRequest('GET', `/BusinessPartners('${encodeURIComponent(p.cardCode)}')`);
    return ok({ exists: true, cardCode: p.cardCode });
  } catch (err) {
    if (err.sapStatus === 404) return ok({ exists: false, cardCode: p.cardCode });
    console.error('[SAP] verificarCliente error:', err.message);
    return error(err.sapStatus || 502, err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function ok(data)         { return { success: true,  ...data }; }
function error(code, msg) { return { success: false, errorCode: code, error: msg }; }

function buildFolio(docNum) {
  return `GPA-${new Date().getFullYear()}-${String(docNum).padStart(5, '0')}`;
}

function mapStatus(s) {
  return ({ Open: 'en_revision', Pending: 'en_proceso', Closed: 'cerrado', Cancelled: 'rechazado' })[s]
    || 'en_revision';
}

// ── OPERACIÓN NUEVA: obtenerArticulo ─────────────────────────────────────────
// Llama a SAP al seleccionar un producto en el portal.
// Devuelve descripción + U_TipoGarantia → se usa para llenar OSCL,callType.
// Payload: { itemCode: 'IW-BC-120' }
async function obtenerArticulo(p) {
  if (!p?.itemCode) return { success: false, errorCode: 400, error: 'itemCode es requerido.' };
  try {
    const data = await withRetry(() =>
      sapRequest('GET', `/Items('${encodeURIComponent(p.itemCode)}')`),
    'obtenerArticulo');
    return {
      success:      true,
      itemCode:     data.ItemCode,
      descripcion:  data.ItemName,
      tipoGarantia: data.U_TipoGarantia || null,
    };
  } catch (err) {
    if (err.sapStatus === 404)
      return { success: false, errorCode: 404, error: `Artículo '${p.itemCode}' no encontrado en SAP.` };
    return { success: false, errorCode: err.sapStatus || 502, error: err.message };
  }
}

// ── Mapeo tipoTicket + tipoGarantia → OSCL,callType ─────────────────────────
function mapCallType(tipoTicket, tipoGarantia) {
  if (tipoTicket === 'dev') return 'DEVOLUCION';
  if (tipoTicket === 'at')  return 'APOYO TECNICO';
  // Garantía: usar el valor EXACTO que viene de OITM,U_TipoGarantia (A1/A2/B1/B2)
  if (tipoTicket === 'gar') return tipoGarantia || 'A1'; // fallback si no llegó
  return 'APOYO TECNICO';
}

// ── OPERACIÓN: obtenerArticulosFactura ────────────────────────────────────────
// Se llama cuando el distribuidor escribe el número de factura en el portal.
// Busca en SAP la factura (DocNum) del cliente (CardCode) y devuelve
// las líneas del documento con código, descripción y U_TipoGarantia.
//
// Payload: { cardCode: 'C001', docNum: '10284566' }
// Respuesta: { success: true, articulos: [{ itemCode, descripcion, tipoGarantia, cantidad }] }
//
// Endpoint SAP:
//   GET /Invoices?$filter=CardCode eq '{cardCode}' and DocNum eq {docNum}
//   &$select=DocNum,CardCode,DocumentLines
//
// NOTA: Si el distribuidor tiene facturas de Notas de Crédito o facturas de
// otro tipo, considerar también /CreditNotes. Por ahora solo facturas normales.

async function obtenerArticulosFactura(p) {
  if (!p?.cardCode) return { success: false, errorCode: 400, error: 'cardCode es requerido.' };
  if (!p?.docNum)   return { success: false, errorCode: 400, error: 'docNum es requerido.' };

  const docNum = parseInt(p.docNum, 10);
  if (isNaN(docNum)) return { success: false, errorCode: 400, error: 'docNum debe ser numérico.' };

  try {
    const filter   = `CardCode eq '${encodeURIComponent(p.cardCode)}' and DocNum eq ${docNum}`;
    const select   = 'DocNum,CardCode,DocumentLines';
    const path     = `/Invoices?$filter=${filter}&$select=${select}&$top=1`;

    const data = await withRetry(() => sapRequest('GET', path), 'obtenerArticulosFactura');

    const facturas = data?.value || [];
    if (!facturas.length) {
      return { success: false, errorCode: 404, error: `Factura ${p.docNum} no encontrada para este cliente.` };
    }

    const lineas = facturas[0].DocumentLines || [];
    if (!lineas.length) {
      return { success: false, errorCode: 404, error: 'La factura no tiene líneas de artículos.' };
    }

    // Para cada línea obtener U_TipoGarantia del maestro del artículo
    // (DocumentLines no incluye UDFs del artículo, hay que consultarlos)
    const articulos = await Promise.all(
      lineas
        .filter(l => l.ItemCode && l.ItemCode.trim())
        .map(async (linea) => {
          let tipoGarantia = null;
          try {
            const item = await sapRequest('GET', `/Items('${encodeURIComponent(linea.ItemCode)}')`);
            tipoGarantia = item.U_TipoGarantia || null;
          } catch(e) {
            // Si no se puede obtener el artículo, continuar sin tipoGarantia
            console.warn(`No se pudo obtener U_TipoGarantia para ${linea.ItemCode}: ${e.message}`);
          }
          return {
            itemCode:     linea.ItemCode,
            descripcion:  linea.ItemDescription || linea.ItemCode,
            tipoGarantia,
            cantidad:     linea.Quantity || 1,
          };
        })
    );

    console.log(`[SAP] Factura ${p.docNum} → ${articulos.length} artículos`);
    return { success: true, docNum: p.docNum, articulos };

  } catch (err) {
    if (err.sapStatus === 404) {
      return { success: false, errorCode: 404, error: `Factura ${p.docNum} no encontrada.` };
    }
    console.error('[SAP] obtenerArticulosFactura error:', err.message);
    return { success: false, errorCode: err.sapStatus || 502, error: err.message };
  }
}

// ── OPERACIÓN: buscarFacturas ─────────────────────────────────────────────────
// Autocompletado del campo "No. de Factura".
// Busca facturas del cliente cuyo DocNum contenga el texto escrito.
// Se llama con debounce cada vez que el cliente teclea en el campo.
//
// Payload: { cardCode: 'C001', query: '1028' }
// Respuesta: { success: true, facturas: [{ docNum, fecha, total, moneda }] }
//
// SAP endpoint:
//   GET /Invoices?$filter=CardCode eq '{cardCode}' and contains(cast(DocNum,Edm.String),'{query}')
//   &$select=DocNum,DocDate,DocTotal,DocCurrency&$orderby=DocNum desc&$top=10

async function buscarFacturas(p) {
  if (!p?.cardCode) return { success: false, errorCode: 400, error: 'cardCode es requerido.' };
  if (!p?.query || p.query.trim().length < 2)
    return { success: true, facturas: [] }; // menos de 2 chars → no buscar

  const q    = p.query.trim();
  const filter = `CardCode eq '${encodeURIComponent(p.cardCode)}' and contains(cast(DocNum,Edm.String),'${q}')`;
  const path   = `/Invoices?$filter=${filter}&$select=DocNum,DocDate,DocTotal,DocCurrency&$orderby=DocNum desc&$top=10`;

  try {
    const data = await withRetry(() => sapRequest('GET', path), 'buscarFacturas');
    const facturas = (data?.value || []).map(f => ({
      docNum:   String(f.DocNum),
      fecha:    f.DocDate ? f.DocDate.substring(0, 10) : null,
      total:    f.DocTotal,
      moneda:   f.DocCurrency || 'MXN',
    }));
    return { success: true, facturas };
  } catch (err) {
    console.error('[SAP] buscarFacturas error:', err.message);
    return { success: false, errorCode: err.sapStatus || 502, error: err.message };
  }
}
