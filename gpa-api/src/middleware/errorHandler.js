'use strict';

const config = require('../config');

function notFound(req, res) {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  // eslint-disable-next-line no-console
  console.error(`[error] ${req.method} ${req.path}:`, err.message);
  res.status(status).json({
    error: status >= 500 ? 'Error interno del servidor.' : err.message,
    ...(config.isProd ? {} : { stack: err.stack }),
  });
}

// Helper para envolver controladores async y propagar errores al handler.
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { notFound, errorHandler, asyncH };
