'use strict';

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { errorHandler, notFound } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const sapRoutes = require('./routes/sap');
const ticketRoutes = require('./routes/tickets');

const app = express();

// El frontend va detrás de CloudFront/Amplify; confiar en el proxy para cookies "secure".
app.set('trust proxy', 1);

// ── CORS con credenciales (cookies HttpOnly) ─────────────────────────────────
app.use(
  cors({
    origin(origin, cb) {
      // Permitir herramientas sin Origin (curl, health checks) y orígenes whitelisteados.
      if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`Origen no permitido por CORS: ${origin}`));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ── Health check (para el balanceador / Amplify / API Gateway) ───────────────
app.get('/health', (_req, res) => res.json({ ok: true, env: config.env }));

// ── Rutas del API ────────────────────────────────────────────────────────────
// El frontend llama a API_BASE + '/auth/...', '/sap/...', '/tickets...'.
app.use('/auth', authRoutes);
app.use('/sap', sapRoutes);
app.use('/tickets', ticketRoutes);

// ── 404 + manejador de errores ───────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
