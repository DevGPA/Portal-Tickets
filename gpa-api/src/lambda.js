'use strict';

// Punto de entrada para AWS Lambda detrás de API Gateway (HTTP API o REST API).
// Envuelve la app Express con serverless-http.
//
// En el cold start: primero carga los secretos desde Secrets Manager hacia
// process.env y SOLO DESPUÉS requiere la app (require diferido), para que
// config.js lea el JWT_SECRET y DATABASE_URL ya poblados.

const serverless = require('serverless-http');
const { loadIntoEnv } = require('./services/secrets');

const SERVERLESS_OPTS = {
  binary: ['multipart/form-data', 'application/octet-stream', 'image/*', 'video/*', 'application/pdf'],
};

let handlerPromise = null;

async function bootstrap() {
  await loadIntoEnv(); // pobla process.env con los secretos
  const app = require('./app'); // require diferido: config.js ya ve los secretos
  return serverless(app, SERVERLESS_OPTS);
}

module.exports.handler = async (event, context) => {
  if (!handlerPromise) handlerPromise = bootstrap();
  const wrapped = await handlerPromise;
  return wrapped(event, context);
};
