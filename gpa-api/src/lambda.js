'use strict';

// Punto de entrada para AWS Lambda detrás de API Gateway (HTTP API o REST API).
// Envuelve la app Express con serverless-http.
//
// Despliegue sugerido (ver README): API Gateway -> Lambda(handler) -> esta app.
// El handler exportado es `handler`.

const serverless = require('serverless-http');
const app = require('./app');

module.exports.handler = serverless(app, {
  // Tratar multipart/form-data y binarios correctamente al subir evidencias.
  binary: ['multipart/form-data', 'application/octet-stream', 'image/*', 'video/*', 'application/pdf'],
});
