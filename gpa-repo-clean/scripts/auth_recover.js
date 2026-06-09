// src/routes/auth.js — agregar estos endpoints al archivo existente

// ── POST /api/auth/recover ────────────────────────────────────────────────────
// Solicita recuperación de contraseña. Genera un token temporal y envía correo.
// Siempre responde éxito para no revelar si el correo existe.
router.post('/recover', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Correo inválido.' });

    const pool = require('../db/pool');
    const { rows } = await pool.query(
      'SELECT id FROM usuarios WHERE email = $1 AND activo = true',
      [email.toLowerCase().trim()]
    );

    if (rows.length) {
      const token   = require('crypto').randomBytes(32).toString('hex');
      const expiry  = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

      await pool.query(
        `UPDATE usuarios SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3`,
        [token, expiry, rows[0].id]
      );

      const resetUrl = `${process.env.APP_URL}/reset-password?token=${token}`;
      // Enviar correo con resetUrl usando SES (mismo transporter del email.js)
      const { transporter, FROM } = require('../services/email');
      await transporter.sendMail({
        from: FROM, to: email,
        subject: 'GPA Postventa — Recuperación de contraseña',
        html: `<p>Hola,</p>
               <p>Recibimos una solicitud para restablecer tu contraseña del Portal de Postventa GPA.</p>
               <p><a href="${resetUrl}" style="background:#003D7A;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Restablecer contraseña</a></p>
               <p>Este enlace expira en 1 hora. Si no solicitaste esto, ignora este correo.</p>`,
      }).catch(() => {});
    }

    // Siempre responder éxito
    return res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
// Recibe token + nueva contraseña y actualiza.
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password || password.length < 8)
      return res.status(400).json({ error: 'Token inválido o contraseña muy corta (mínimo 8 caracteres).' });

    const pool  = require('../db/pool');
    const { rows } = await pool.query(
      `SELECT id FROM usuarios WHERE reset_token = $1 AND reset_token_expiry > NOW() AND activo = true`,
      [token]
    );

    if (!rows.length) return res.status(400).json({ error: 'Enlace inválido o expirado. Solicita uno nuevo.' });

    const hash = await require('bcrypt').hash(password, 12);
    await pool.query(
      `UPDATE usuarios SET password_hash = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2`,
      [hash, rows[0].id]
    );

    return res.json({ ok: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
  } catch (err) { next(err); }
});
