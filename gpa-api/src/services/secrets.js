'use strict';

// Carga secretos desde AWS Secrets Manager y los inyecta en process.env ANTES
// de que se construya la configuración (config.js lee process.env al requerirse).
//
// El secreto (SECRETS_ID) es un JSON, p.ej.: { "JWT_SECRET": "...", "DATABASE_URL": "..." }
// Si SECRETS_ID no está definido (local/demo), es un no-op y se usan las vars de entorno.

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

let loaded = false;

async function loadIntoEnv() {
  if (loaded) return;
  const secretId = process.env.SECRETS_ID;
  if (!secretId) {
    loaded = true;
    return;
  }
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const secret = JSON.parse(res.SecretString || '{}');
  for (const [k, v] of Object.entries(secret)) {
    // No sobreescribir si ya viene del entorno (permite overrides puntuales).
    if (process.env[k] === undefined || process.env[k] === '') {
      process.env[k] = v;
    }
  }
  loaded = true;
}

module.exports = { loadIntoEnv };
