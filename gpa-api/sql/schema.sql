-- Esquema de referencia para RDS PostgreSQL (gpa-api).
-- Los nombres de columnas coinciden con lo que el frontend espera (snake_case).

CREATE TABLE IF NOT EXISTS usuarios (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  nombre_empresa  TEXT NOT NULL,
  rol             TEXT NOT NULL DEFAULT 'cliente',  -- cliente | gpa | admin
  sap_cliente_id  TEXT NOT NULL,                    -- CardCode en SAP
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tickets (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folio_sap            TEXT UNIQUE,
  tipo_ticket          TEXT NOT NULL,               -- gar | dev | at
  familia              TEXT,
  numero_factura       TEXT,
  codigo_producto      TEXT,
  numero_serie         TEXT,
  descripcion          TEXT,
  sap_status           TEXT DEFAULT 'Abierto',
  sap_info_pendiente   TEXT,
  sap_resolution       TEXT,
  documentos_liberados JSONB DEFAULT '[]'::jsonb,   -- [{nombre,key,fecha}]
  sap_cliente_id       TEXT NOT NULL,
  creado_en            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tickets_cliente ON tickets (sap_cliente_id, creado_en DESC);

CREATE TABLE IF NOT EXISTS evidencias (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id          UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  nombre             TEXT NOT NULL,
  tipo_requerimiento TEXT,                          -- O (obligatoria) | OJ (obligatoria/justificable)
  archivos_s3        TEXT[] DEFAULT '{}',           -- keys de S3
  justificacion      TEXT,
  texto_libre        TEXT
);

CREATE INDEX IF NOT EXISTS idx_evidencias_ticket ON evidencias (ticket_id);
