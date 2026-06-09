// src/db/migrate.js
// Uso: node src/db/migrate.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
-- ── Extensión para UUID ───────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Usuarios (distribuidores) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT        UNIQUE NOT NULL,
  password_hash   TEXT        NOT NULL,
  nombre_empresa  TEXT        NOT NULL,
  ejecutivo_gpa   TEXT        NOT NULL,
  categoria       TEXT        NOT NULL CHECK (categoria IN ('Clave','Premium','Estándar')),
  sap_cliente_id  TEXT        NOT NULL,
  activo          BOOLEAN     NOT NULL DEFAULT true,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tickets ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tickets (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id       UUID        NOT NULL REFERENCES usuarios(id),

  -- Tipo y familia
  tipo_ticket      TEXT        NOT NULL CHECK (tipo_ticket IN ('gar','dev','at')),
  familia          TEXT        NOT NULL,

  -- Contacto capturado en el formulario
  nombre_contacto  TEXT        NOT NULL,
  telefono         TEXT        NOT NULL,
  email_contacto   TEXT        NOT NULL,

  -- Producto
  numero_factura   TEXT        NOT NULL,
  codigo_producto  TEXT        NOT NULL,
  numero_serie     TEXT,
  descripcion      TEXT        NOT NULL,

  -- Snapshot del distribuidor al momento del ticket
  nombre_empresa   TEXT        NOT NULL,
  ejecutivo_gpa    TEXT        NOT NULL,
  categoria        TEXT        NOT NULL,
  sap_cliente_id   TEXT        NOT NULL,

  -- SAP
  folio_sap        TEXT,
  sap_ticket_id    TEXT,

  -- Estado
  estado           TEXT        NOT NULL DEFAULT 'pendiente_sap'
                   CHECK (estado IN ('pendiente_sap','creado','en_revision',
                                     'en_proceso','cerrado','rechazado','error_sap')),
  motivo_rechazo   TEXT,

  creado_en        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Evidencias ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS evidencias (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id           UUID        NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  nombre              TEXT        NOT NULL,
  tipo_requerimiento  TEXT        NOT NULL CHECK (tipo_requerimiento IN ('O','OJ','Op')),
  archivos_s3         JSONB       NOT NULL DEFAULT '[]',  -- array de S3 keys
  justificacion       TEXT,        -- si no pudo adjuntar (solo OJ)
  texto_libre         TEXT,        -- para evidencias de tipo texto
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Índices ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tickets_usuario   ON tickets(usuario_id);
CREATE INDEX IF NOT EXISTS idx_tickets_estado    ON tickets(estado);
CREATE INDEX IF NOT EXISTS idx_tickets_creado    ON tickets(creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_evidencias_ticket ON evidencias(ticket_id);

-- ── Trigger actualizado_en automático ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION _set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.actualizado_en = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_usuarios_upd ON usuarios;
CREATE TRIGGER trg_usuarios_upd
  BEFORE UPDATE ON usuarios FOR EACH ROW EXECUTE FUNCTION _set_updated_at();

DROP TRIGGER IF EXISTS trg_tickets_upd ON tickets;
CREATE TRIGGER trg_tickets_upd
  BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION _set_updated_at();
`;

(async () => {
  const client = await pool.connect();
  try {
    console.log('Ejecutando migraciones...');
    await client.query(SQL);
    console.log('✓ Listo.');
  } catch (err) {
    console.error('✗ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
