-- Agregar columnas de roles y reset de contraseña a la tabla usuarios
-- Ejecutar: psql $DATABASE_URL -f migration_roles.sql

-- Rol del usuario: cliente | gpa | admin
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rol TEXT NOT NULL DEFAULT 'cliente'
  CHECK (rol IN ('cliente', 'gpa', 'admin'));

-- Tokens para recuperación de contraseña
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token        TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token_expiry TIMESTAMPTZ;

-- Columnas para documentos liberados en tickets (NC y Reporte Técnico)
CREATE TABLE IF NOT EXISTS documentos_ticket (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    UUID        NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  nombre       TEXT        NOT NULL,   -- "Nota de Crédito" / "Reporte Técnico"
  tipo         TEXT        NOT NULL CHECK (tipo IN ('nota_credito','reporte_tecnico','otro')),
  s3_key       TEXT        NOT NULL,   -- key en S3
  subido_por   TEXT,                   -- email del usuario GPA que subió el doc
  fecha        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  liberado     BOOLEAN     NOT NULL DEFAULT true  -- true = visible para el cliente
);

CREATE INDEX IF NOT EXISTS idx_documentos_ticket ON documentos_ticket(ticket_id);

-- Actualizar script create-user para incluir rol
-- Uso: node src/scripts/create-user.js --email x --empresa x --ejecutivo x --cat x --sap x --rol gpa
