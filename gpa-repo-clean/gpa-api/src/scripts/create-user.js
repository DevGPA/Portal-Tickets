// src/scripts/create-user.js
// Uso: node src/scripts/create-user.js \
//        --email dist@empresa.com \
//        --empresa "Distribuidora SA" \
//        --ejecutivo "Juan López" \
//        --cat Estándar \
//        --sap C001
//
// Si no se pasa --password, se genera uno aleatorio y se muestra en pantalla.

require('dotenv').config();
const bcrypt = require('bcrypt');
const pool   = require('../db/pool');
const crypto = require('crypto');

const args = process.argv.slice(2).reduce((acc, val, i, arr) => {
  if (val.startsWith('--')) acc[val.slice(2)] = arr[i + 1];
  return acc;
}, {});

async function main() {
  const { email, empresa, ejecutivo, cat, sap, password } = args;

  if (!email || !empresa || !ejecutivo || !cat || !sap) {
    console.error('Uso: node src/scripts/create-user.js --email --empresa --ejecutivo --cat --sap [--password]');
    console.error('  --cat: Clave | Premium | Estándar');
    process.exit(1);
  }

  if (!['Clave','Premium','Estándar'].includes(cat)) {
    console.error('--cat debe ser: Clave, Premium o Estándar');
    process.exit(1);
  }

  const plainPassword = password || crypto.randomBytes(10).toString('hex');
  const hash = await bcrypt.hash(plainPassword, 12);

  try {
    const { rows } = await pool.query(
      `INSERT INTO usuarios (email, password_hash, nombre_empresa, ejecutivo_gpa, categoria, sap_cliente_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE
         SET password_hash  = EXCLUDED.password_hash,
             nombre_empresa = EXCLUDED.nombre_empresa,
             ejecutivo_gpa  = EXCLUDED.ejecutivo_gpa,
             categoria      = EXCLUDED.categoria,
             sap_cliente_id = EXCLUDED.sap_cliente_id,
             activo         = true,
             actualizado_en = NOW()
       RETURNING id, email, nombre_empresa, categoria`,
      [email.toLowerCase(), hash, empresa, ejecutivo, cat, sap]
    );

    const u = rows[0];
    console.log('\n✓ Usuario creado/actualizado:');
    console.log(`  ID:      ${u.id}`);
    console.log(`  Email:   ${u.email}`);
    console.log(`  Empresa: ${u.nombre_empresa}`);
    console.log(`  Categ:   ${u.categoria}`);
    if (!password) {
      console.log(`\n  Contraseña generada: ${plainPassword}`);
      console.log('  (Cópiala ahora — no se mostrará de nuevo)');
    }
    console.log('');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
