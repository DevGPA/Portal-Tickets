'use strict';

// Carga .env solo fuera de Lambda (en Lambda las vars vienen del entorno).
require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),

  // Orígenes permitidos para CORS (con credentials)
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5500')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES || '8h',
  },

  cookie: {
    name: process.env.COOKIE_NAME || 'gpa_token',
    domain: process.env.COOKIE_DOMAIN || undefined,
  },

  db: {
    url: process.env.DATABASE_URL || '', // vacío => almacén en memoria (demo)
  },

  sap: {
    serviceLayerUrl: process.env.SAP_SERVICE_LAYER_URL || '', // vacío => datos demo
    companyDb: process.env.SAP_COMPANY_DB || '',
    user: process.env.SAP_USER || '',
    password: process.env.SAP_PASSWORD || '',
  },

  s3: {
    region: process.env.AWS_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || '',
    presignExpires: parseInt(process.env.S3_PRESIGN_EXPIRES || '300', 10),
  },
};

config.isProd = config.env === 'production';

module.exports = config;
