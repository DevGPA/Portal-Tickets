'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');

// Lee el JWT desde la cookie HttpOnly y adjunta el usuario a req.user.
// El payload del token contiene: { sub, email, rol, nombreEmpresa, sap_cliente_id }.
function requireAuth(req, res, next) {
  const token = req.cookies?.[config.cookie.name];
  if (!token) {
    return res.status(401).json({ error: 'No autenticado.' });
  }
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = {
      id: payload.sub,
      email: payload.email,
      rol: payload.rol,
      nombreEmpresa: payload.nombreEmpresa,
      sap_cliente_id: payload.sap_cliente_id, // cardCode en SAP
    };
    return next();
  } catch (_e) {
    return res.status(401).json({ error: 'Sesión inválida o expirada.' });
  }
}

// Restringe una ruta a ciertos roles (ej: requireRole('gpa','admin')).
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.rol)) {
      return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole };
