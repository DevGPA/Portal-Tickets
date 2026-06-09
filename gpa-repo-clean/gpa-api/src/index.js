// src/index.js
require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');

const logger          = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');

const authRoutes    = require('./routes/auth');
const ticketsRoutes = require('./routes/tickets');
const uploadRoutes  = require('./routes/upload');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Seguridad ─────────────────────────────────────────────────────────────────
app.use(helmet());

app.use(cors({
  origin:      process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,   // necesario para enviar/recibir cookies
}));

// Rate limiting global — 200 req / 15 min por IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      200,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Demasiadas peticiones. Intenta de nuevo en unos minutos.' },
}));

// Rate limiting más estricto para login — 10 intentos / 15 min
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  message: { error: 'Demasiados intentos de login. Intenta en 15 minutos.' },
}));

// ── Parsers ───────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Rutas ─────────────────────────────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/tickets', ticketsRoutes);
app.use('/api/upload',  uploadRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` }));

// Error handler global
app.use(errorHandler);

// ── Arrancar ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`GPA Postventa API corriendo en puerto ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

module.exports = app;
