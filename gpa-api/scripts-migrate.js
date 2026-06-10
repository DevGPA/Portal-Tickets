// Runner de migración: aplica sql/schema.sql y crea un usuario de prueba.
// Uso: DATABASE_URL=... SEED_EMAIL=... SEED_PASS=... SEED_CARDCODE=... node scripts-migrate.js
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const schema = fs.readFileSync(path.join(__dirname, 'sql', 'schema.sql'), 'utf8');
  console.log('Aplicando esquema…');
  await pool.query(schema);

  const email = process.env.SEED_EMAIL || 'cliente@empresa.com';
  const pass = process.env.SEED_PASS || 'demo1234';
  const card = process.env.SEED_CARDCODE || 'C-10045';
  const hash = bcrypt.hashSync(pass, 10);
  console.log(`Creando usuario de prueba ${email}…`);
  await pool.query(
    `INSERT INTO usuarios (email, password_hash, nombre_empresa, rol, sap_cliente_id)
     VALUES ($1,$2,$3,'cliente',$4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [email, hash, 'Distribuidor Demo', card]
  );

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM usuarios');
  console.log('OK. Usuarios en la tabla:', rows[0].n);
  await pool.end();
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
