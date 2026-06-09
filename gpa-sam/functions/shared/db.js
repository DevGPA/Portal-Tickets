// functions/shared/db.js
// Pool de PostgreSQL compartido entre Lambdas.
// Lambda reutiliza el módulo entre invocaciones warm — el pool persiste.
const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      host:     process.env.DB_HOST,
      port:     parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl:      { rejectUnauthorized: false },  // Aurora requiere SSL
      max:      5,     // max conexiones por Lambda container
      idleTimeoutMillis:    30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

module.exports = { getPool };
