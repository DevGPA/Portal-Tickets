// src/middleware/errorHandler.js
const logger = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  logger.error('Error no manejado', {
    error:  err.message,
    status: err.status,
    path:   req.path,
    method: req.method,
    userId: req.user?.id,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });

  const status = err.status || 500;
  const message = status < 500
    ? err.message
    : process.env.NODE_ENV === 'production'
      ? 'Error interno del servidor.'
      : err.message;

  res.status(status).json({ error: message });
}

module.exports = { errorHandler };
