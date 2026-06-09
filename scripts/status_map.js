// src/utils/statusMap.js
// Mapeo de estatus SAP → frases que ve el distribuidor en el portal.
// Basado en OSCL,status y OSCL,U_InfoPendienteCliente / OSCL,resolution

const STATUS_MAP = {
  // SAP: "Abierto"
  'Abierto': (ticket) =>
    'Tu ticket ha sido recibido por el equipo de Postventa, y una persona del equipo te contactará para saber si la información enviada ha sido completada correctamente.',

  // SAP: "Cliente Pendientes"
  'Cliente Pendientes': (ticket) =>
    `Hemos revisado la información pendiente, y solamente está pendiente: ${ticket.info_pendiente_cliente || ''}`,

  // SAP: "Proceso Técnico"
  'Proceso Técnico': (ticket) =>
    'El técnico ya está atendiendo su caso.',

  // SAP: "NC GPA-Cliente Pend"
  'NC GPA-Cliente Pend': (ticket) =>
    'Ya se está preparando su Nota de Crédito.',
};

/**
 * Devuelve la frase de estatus que ve el distribuidor.
 * @param {string} sapStatus  — valor de OSCL,status
 * @param {string} resolution — valor de OSCL,resolution (puede ser null)
 * @param {string} infoPendiente — valor de OSCL,U_InfoPendienteCliente
 */
function getStatusLabel(sapStatus, resolution, infoPendiente) {
  const mapped = STATUS_MAP[sapStatus];
  if (mapped) return mapped({ info_pendiente_cliente: infoPendiente });

  // Cualquier otro status con resolución → cerrado con dictamen
  if (resolution && resolution.trim()) {
    return `Su ticket ha sido cerrado y el dictamen es el siguiente: ${resolution}`;
  }

  // Cualquier otro status sin resolución → en proceso genérico
  return 'Su ticket está en proceso de revisión por el departamento de Postventa. Si tiene alguna duda llame por teléfono a 800 276 9647 ext. 1.';
}

module.exports = { getStatusLabel };
