
// src/services/clientes.js
// Lookup de correos de ejecutivo y gerente desde la tabla clientes_config en Aurora.
// Se usa al enviar notificaciones de nuevos tickets.

const { getPool } = require('../db/pool');

async function getClienteConfig(sapClienteId) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT email_ejecutivo, email_gerente, sucursal FROM clientes_config WHERE sap_cliente_id = $1',
    [sapClienteId]
  );
  return rows[0] || { email_ejecutivo: null, email_gerente: null, sucursal: null };
}

module.exports = { getClienteConfig };
