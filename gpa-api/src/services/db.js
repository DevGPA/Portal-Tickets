'use strict';

// Capa de datos. Si DATABASE_URL está definido, usa PostgreSQL (RDS).
// Si no, cae a un almacén EN MEMORIA con los mismos datos demo del frontend,
// para poder probar el contrato del API sin infraestructura.
//
// TODO(prod): reemplazar las funciones del store en memoria por consultas SQL
// reales. La forma de los objetos (snake_case) ya coincide con lo que el
// frontend espera, así que no hay que tocar las rutas.

const config = require('../config');

let pool = null;
if (config.db.url) {
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: config.db.url,
    ssl: config.isProd ? { rejectUnauthorized: false } : false,
  });
}

// ── Almacén en memoria (demo) ────────────────────────────────────────────────
const memUsers = [
  {
    id: 'u-demo',
    email: 'distribuidor@demo.com',
    // En modo demo (sin DB) la contraseña aceptada es "demo1234" — ver auth.service.js.
    password_hash: 'demo-placeholder',
    nombre_empresa: 'Distribuidor Demo',
    rol: 'cliente',
    sap_cliente_id: 'C-10045',
  },
];

const memTickets = [
  {
    id: 'demo-1', folio_sap: 'GPA-2026-00042', tipo_ticket: 'gar', familia: 'Bombas de Calor',
    numero_factura: 'FAC-10001', codigo_producto: 'IW-BC-120', numero_serie: 'SN-001',
    descripcion: 'Equipo no enciende tras instalación.', sap_status: 'Abierto',
    sap_cliente_id: 'C-10045', creado_en: '2026-06-06T10:00:00.000Z',
    evidencias: [
      { nombre: 'Factura', tipo_requerimiento: 'O', archivos_s3: ['tickets/2026/05/demo-1/factura/file.pdf'] },
      { nombre: 'Video de la falla', tipo_requerimiento: 'O', archivos_s3: ['tickets/2026/05/demo-1/video/falla.mp4'] },
      { nombre: '9 parámetros de química del agua', tipo_requerimiento: 'OJ', archivos_s3: [], justificacion: 'El cliente no tiene los datos disponibles en este momento.' },
    ],
  },
  {
    id: 'demo-2', folio_sap: 'GPA-2026-00038', tipo_ticket: 'dev', familia: 'Motobombas de Velocidad Variable',
    numero_factura: 'FAC-09876', codigo_producto: 'IW-MOT-1.5', descripcion: 'Producto llegó dañado de empaque.',
    sap_status: 'Cliente Pendientes', sap_info_pendiente: 'Foto del embalaje original y guía de paquetería.',
    sap_cliente_id: 'C-10045', creado_en: '2026-06-02T10:00:00.000Z', evidencias: [],
  },
];

let seqFolio = 100;

// ── API de la capa de datos ──────────────────────────────────────────────────

async function getUserByEmail(email) {
  if (pool) {
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE email = $1 LIMIT 1', [email]);
    return rows[0] || null;
  }
  return memUsers.find((u) => u.email === email) || null;
}

async function listTickets({ sapClienteId, page = 1, limit = 10, tipo, search }) {
  if (pool) {
    // TODO(prod): construir WHERE dinámico con parámetros ($1, $2, ...) y COUNT(*).
    const offset = (page - 1) * limit;
    const params = [sapClienteId, limit, offset];
    const { rows } = await pool.query(
      `SELECT id, folio_sap, tipo_ticket, familia, numero_factura, codigo_producto,
              descripcion, sap_status, creado_en
         FROM tickets
        WHERE sap_cliente_id = $1
        ORDER BY creado_en DESC
        LIMIT $2 OFFSET $3`,
      params
    );
    const { rows: c } = await pool.query(
      'SELECT COUNT(*)::int AS total FROM tickets WHERE sap_cliente_id = $1',
      [sapClienteId]
    );
    const total = c[0].total;
    return { data: rows, total, pages: Math.max(1, Math.ceil(total / limit)) };
  }

  // En memoria
  let data = memTickets.filter((t) => t.sap_cliente_id === sapClienteId);
  if (tipo) data = data.filter((t) => t.tipo_ticket === tipo);
  if (search) {
    const q = search.toLowerCase();
    data = data.filter(
      (t) =>
        (t.folio_sap || '').toLowerCase().includes(q) ||
        (t.numero_factura || '').toLowerCase().includes(q) ||
        (t.familia || '').toLowerCase().includes(q)
    );
  }
  const total = data.length;
  const start = (page - 1) * limit;
  const slice = data.slice(start, start + limit).map(({ evidencias, ...rest }) => rest);
  return { data: slice, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

async function getTicketById({ id, sapClienteId }) {
  if (pool) {
    const { rows } = await pool.query(
      'SELECT * FROM tickets WHERE id = $1 AND sap_cliente_id = $2 LIMIT 1',
      [id, sapClienteId]
    );
    if (!rows[0]) return null;
    const { rows: evs } = await pool.query(
      'SELECT nombre, tipo_requerimiento, archivos_s3, justificacion, texto_libre FROM evidencias WHERE ticket_id = $1',
      [id]
    );
    return { ticket: rows[0], evidencias: evs };
  }

  const t = memTickets.find((x) => x.id === id && x.sap_cliente_id === sapClienteId);
  if (!t) return null;
  const { evidencias = [], ...ticket } = t;
  return { ticket, evidencias };
}

async function createTicket(ticket, evidencias) {
  if (pool) {
    // El folio se genera con una secuencia en la BD (única y persistente entre
    // cold starts), no con un contador en memoria. Formato: GPA-<año>-NNNNN.
    // TODO(prod): envolver en transacción; insertar ticket + evidencias.
    const { rows } = await pool.query(
      `INSERT INTO tickets (folio_sap, tipo_ticket, familia, numero_factura, codigo_producto,
                            numero_serie, descripcion, sap_status, sap_cliente_id, creado_en)
       VALUES ('GPA-' || to_char(now(),'YYYY') || '-' || lpad(nextval('gpa_folio_seq')::text, 5, '0'),
               $1,$2,$3,$4,$5,$6,'Abierto',$7, now())
       RETURNING id, folio_sap`,
      [
        ticket.tipo_ticket, ticket.familia, ticket.numero_factura,
        ticket.codigo_producto, ticket.numero_serie, ticket.descripcion, ticket.sap_cliente_id,
      ]
    );
    const created = rows[0];
    for (const ev of evidencias) {
      await pool.query(
        `INSERT INTO evidencias (ticket_id, nombre, tipo_requerimiento, archivos_s3, justificacion, texto_libre)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [created.id, ev.nombre, ev.tipo_requerimiento, ev.archivos_s3, ev.justificacion, ev.texto_libre]
      );
    }
    return created;
  }

  const folio = `GPA-2026-${String(seqFolio++).padStart(5, '0')}`;
  const id = `mem-${seqFolio}`;
  const row = {
    id, folio_sap: folio, sap_status: 'Abierto',
    creado_en: '2026-06-09T12:00:00.000Z', ...ticket, evidencias,
  };
  memTickets.unshift(row);
  return { id, folio_sap: folio };
}

async function updatePassword(email, newHash) {
  if (pool) {
    await pool.query('UPDATE usuarios SET password_hash = $1 WHERE email = $2', [newHash, email]);
    return;
  }
  const u = memUsers.find((x) => x.email === email);
  if (u) u.password_hash = newHash;
}

module.exports = {
  pool,
  getUserByEmail,
  listTickets,
  getTicketById,
  createTicket,
  updatePassword,
};
