'use strict';

// Punto de entrada en modo STANDALONE (servidor de larga vida):
// EC2, ECS/Fargate, App Runner, o local con `npm run dev`.
// Para AWS Lambda + API Gateway, usar src/lambda.js.

const app = require('./app');
const config = require('./config');

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`gpa-api escuchando en http://localhost:${config.port} (${config.env})`);
});
