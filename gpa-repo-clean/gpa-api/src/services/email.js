// src/services/email.js
const nodemailer = require('nodemailer');
const logger     = require('../utils/logger');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

const FROM         = process.env.EMAIL_FROM;
const TO_POSTVENTA = process.env.EMAIL_POSTVENTA;

const TIPO_LABEL = { gar: 'Garantía', dev: 'Devolución', at: 'Apoyo Técnico' };

// ── Confirmación al distribuidor ──────────────────────────────────────────────
async function sendConfirmacion(ticket) {
  const tipo  = TIPO_LABEL[ticket.tipo_ticket] || ticket.tipo_ticket;
  const folio = ticket.folio_sap || 'Pendiente de asignación';

  await transporter.sendMail({
    from:    FROM,
    to:      ticket.email_contacto,
    subject: `GPA Postventa — Solicitud recibida · ${folio}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#003D7A;padding:24px 32px;">
          <h2 style="color:white;margin:0;">General de Productos para el Agua</h2>
          <p style="color:#90CAF9;margin:4px 0 0;">Portal de Postventa</p>
        </div>
        <div style="padding:32px;border:1px solid #DDE4EE;">
          <p>Hola <strong>${ticket.nombre_contacto}</strong>,</p>
          <p>Tu solicitud fue recibida correctamente. Aquí está el resumen:</p>

          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            ${row('Folio',        `<strong style="color:#003D7A;">${folio}</strong>`)}
            ${row('Tipo',         tipo)}
            ${row('Familia',      ticket.familia)}
            ${row('Factura',      ticket.numero_factura)}
            ${row('Producto',     ticket.codigo_producto)}
            ${row('Estado',       'Recibido — en revisión por Postventa')}
          </table>

          <p>El equipo de Postventa revisará tu solicitud y se pondrá en contacto contigo.</p>
          <p>Si tienes dudas, llámanos al <strong>800 APOYO GPA (800 276 9647)</strong>.</p>
        </div>
        <div style="background:#F4F7FB;padding:16px 32px;text-align:center;font-size:12px;color:#64748B;">
          General de Productos para el Agua &nbsp;·&nbsp; postventa@gpa.com.mx
        </div>
      </div>
    `,
  }).catch(err => logger.error('Error enviando confirmación al distribuidor', { error: err.message }));
}

// ── Notificación interna a Postventa ─────────────────────────────────────────
async function sendNotificacionPostventa(ticket, evidencias) {
  const tipo   = TIPO_LABEL[ticket.tipo_ticket] || ticket.tipo_ticket;
  const folio  = ticket.folio_sap || ticket.id;

  const evidenciasHtml = evidencias.map(ev => {
    const archivos = (ev.archivos_s3 || []).length;
    const estado   = archivos > 0
      ? `<span style="color:#16A34A;">✓ ${archivos} archivo(s)</span>`
      : ev.justificacion
        ? `<span style="color:#D97706;">⚠ Justificación: ${ev.justificacion}</span>`
        : `<span style="color:#DC2626;">✗ Sin adjuntar</span>`;
    return `<tr><td style="padding:6px 12px;border-bottom:1px solid #DDE4EE;">${ev.nombre}</td>
                <td style="padding:6px 12px;border-bottom:1px solid #DDE4EE;">${ev.tipo_requerimiento}</td>
                <td style="padding:6px 12px;border-bottom:1px solid #DDE4EE;">${estado}</td></tr>`;
  }).join('');

  await transporter.sendMail({
    from:    FROM,
    to:      TO_POSTVENTA,
    cc:      ticket.ejecutivo_gpa_email || undefined,
    subject: `[NUEVO TICKET] ${tipo} · ${ticket.nombre_empresa} · ${ticket.familia} · ${folio}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;">
        <div style="background:#003D7A;padding:20px 28px;">
          <h2 style="color:white;margin:0;">Nuevo ticket de Postventa</h2>
        </div>
        <div style="padding:28px;border:1px solid #DDE4EE;">
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
            ${row('Folio',        folio)}
            ${row('Tipo',         tipo)}
            ${row('Distribuidor', ticket.nombre_empresa)}
            ${row('Ejecutivo',    ticket.ejecutivo_gpa)}
            ${row('Categoría',    ticket.categoria)}
            ${row('Familia',      ticket.familia)}
            ${row('Factura',      ticket.numero_factura)}
            ${row('Producto',     ticket.codigo_producto)}
            ${ticket.numero_serie ? row('N° Serie/Lote', ticket.numero_serie) : ''}
            ${row('Contacto',     `${ticket.nombre_contacto} · ${ticket.telefono} · ${ticket.email_contacto}`)}
            ${row('Descripción',  ticket.descripcion)}
          </table>

          <h3 style="color:#003D7A;border-bottom:2px solid #003D7A;padding-bottom:8px;">Evidencias</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="background:#E8F2FF;">
                <th style="padding:8px 12px;text-align:left;">Evidencia</th>
                <th style="padding:8px 12px;text-align:left;">Requerimiento</th>
                <th style="padding:8px 12px;text-align:left;">Estado</th>
              </tr>
            </thead>
            <tbody>${evidenciasHtml}</tbody>
          </table>

          <p style="margin-top:20px;font-size:12px;color:#64748B;">
            Los archivos adjuntos están disponibles en el portal con acceso autenticado.<br>
            Ticket ID interno: ${ticket.id}
          </p>
        </div>
      </div>
    `,
  }).catch(err => logger.error('Error enviando notificación a Postventa', { error: err.message }));
}

function row(label, value) {
  return `<tr>
    <td style="padding:6px 12px;border-bottom:1px solid #DDE4EE;color:#64748B;white-space:nowrap;">${label}</td>
    <td style="padding:6px 12px;border-bottom:1px solid #DDE4EE;">${value}</td>
  </tr>`;
}

module.exports = { sendConfirmacion, sendNotificacionPostventa };
