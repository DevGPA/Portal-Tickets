// src/test-local.js
// Prueba el handler localmente sin deployar en AWS.
// Uso: node src/test-local.js
// Requiere .env con las 4 variables de SAP configuradas.

require('dotenv').config();
const { handler } = require('./handler');

const TESTS = [
  {
    label: 'verificarCliente — C001',
    event: { action: 'verificarCliente', payload: { cardCode: 'C001' } },
  },
  {
    label: 'crearTicket — Garantía Bomba de Calor',
    event: {
      action: 'crearTicket',
      payload: {
        tipoTicket:     'gar',
        familia:        'Bombas de Calor',
        nombreContacto: 'Carlos Pérez',
        telefono:       '3312345678',
        emailContacto:  'carlos@dist.com',
        numeroFactura:  'FAC-10001',
        codigoProducto: 'IW-BC-120',
        numeroSerie:    'SN-001',
        descripcion:    'Equipo no enciende tras instalación.',
        sapClienteId:   'C001',
        ejecutivoGpa:   'EV01',
      },
    },
  },
  {
    label: 'consultarTicket — DocEntry 1 (ajustar con uno real de SAP)',
    event: { action: 'consultarTicket', payload: { sapId: '1' } },
  },
  {
    label: 'acción inválida',
    event: { action: 'accionInexistente', payload: {} },
  },
];

(async () => {
  for (const t of TESTS) {
    console.log(`\n${'─'.repeat(60)}\nTEST: ${t.label}\n${'─'.repeat(60)}`);
    const result = await handler(t.event);
    console.log(JSON.stringify(result, null, 2));
  }
  console.log('\n✓ Tests completados.');
})();
