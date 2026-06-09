// src/db/pool.js
const { Pool } = require('pg');
const logger   = require('../utils/logger');

const pool = new Pool({
  connectionString:     process.env.DATABASE_URL,
  max:                  10,
  idleTimeoutMillis:    30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error', { error: err.message });
});

module.exports = pool;
