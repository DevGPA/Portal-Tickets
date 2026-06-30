-- Agrega la columna call_id a tickets: guarda el CallID/ServiceCallID oficial
-- de SAP B1 (PK de OSCL), que es el folio que el cliente referencia con Postventa.
-- Ejecutar: psql $DATABASE_URL -f migration_call_id.sql

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS call_id TEXT;
