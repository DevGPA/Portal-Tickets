'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');

// Verifica la contraseña contra el hash bcrypt almacenado.
// En modo demo (almacén en memoria) se acepta la contraseña "demo1234".
async function verifyPassword(plain, hash) {
  if (!hash || hash.endsWith('placeholder')) {
    return plain === 'demo1234'; // solo para pruebas locales sin DB real
  }
  return bcrypt.compare(plain, hash);
}

// Firma el JWT que viajará en la cookie HttpOnly.
function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      rol: user.rol,
      nombreEmpresa: user.nombre_empresa,
      sap_cliente_id: user.sap_cliente_id,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

// Opciones de la cookie HttpOnly (segura, SameSite=None para cross-site con Amplify).
function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProd, // HTTPS en producción (CloudFront/Amplify)
    sameSite: config.isProd ? 'none' : 'lax',
    domain: config.cookie.domain,
    maxAge: 8 * 60 * 60 * 1000, // 8h
    path: '/',
  };
}

// Proyección segura del usuario para el frontend (sin password_hash).
function publicUser(user) {
  return {
    nombreEmpresa: user.nombre_empresa,
    email: user.email,
    rol: user.rol,
  };
}

module.exports = { verifyPassword, signToken, cookieOptions, publicUser };
