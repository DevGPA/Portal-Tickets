# GPA Postventa — Backend

## Estructura

```
/
├── gpa-api/           ← Backend Express (auth, tickets, S3, email)
├── gpa-sap-lambda/    ← Lambda SAP Service Layer
├── gpa-sam/           ← Infraestructura AWS SAM (template.yaml + Lambdas)
├── scripts/           ← Migraciones SQL y servicios actualizados
└── .gitignore
```

## Setup rápido

### gpa-api
```bash
cd gpa-api
npm install
cp .env.example .env   # llenar con valores reales
node src/index.js
```

### gpa-sap-lambda
```bash
cd gpa-sap-lambda
npm install
cp .env.example .env   # llenar con datos de SAP
node src/test-local.js
```

### gpa-sam (deploy completo)
```bash
cd gpa-sam
sam build
sam deploy --guided
```

### Migraciones Aurora
```bash
psql $DATABASE_URL -f scripts/seed_clientes.sql
psql $DATABASE_URL -f scripts/migration_roles.sql
```

---

## Historial — backend Express alterno (dado de baja, 2026-06-16)

En paralelo a esta versión se desarrolló y desplegó **otra implementación del backend**
(`gpa-api` como app Express monolítica sobre **una sola Lambda**, llamando al **SAP Service
Layer directamente**, con **RDS** + **Secrets Manager** + **NAT Gateway**). Esa línea de
trabajo **no es la oficial** y su infraestructura AWS fue **dada de baja** para no generar
costos. Se conserva por si se necesita consultar o recuperar.

- **Rama de respaldo:** `archive/backend-gpa-api-express` (en el remoto) — contiene esa
  versión completa: backend Express, frontend `index.html` conectado (subida de evidencias
  directa a S3, cambiar contraseña), `serverless.yml`, `DEPLOY.md` y la guía de despliegue.
- **Diferencias clave con la versión oficial:** entrada `src/server.js` + `serverless-http`
  (vs. `src/index.js` / SAM); SAP por Service Layer directo (vs. Lambda SAP separada);
  conexión a BD por `DATABASE_URL` (vs. `DB_HOST/...`); secretos en Secrets Manager.

### Infraestructura AWS eliminada (no facturar)
Se eliminaron todos los recursos de esa versión: stack CloudFormation `gpa-api-production`
(Lambda + API Gateway + rol IAM), RDS `gpa-db`, NAT Gateway + Elastic IP, VPC endpoints
(S3 gateway + Secrets Manager interface), subredes privadas, route table, 3 security groups,
DB subnet group, buckets S3 (evidencias y despliegue) y el secreto `gpa-api/production`.

> **Intacto:** la app de **AWS Amplify `Portal-Tickets`** (hosting del frontend, conectada a
> este repo con auto-deploy desde `main`) y la VPC/subredes originales de la cuenta.

### Recordatorio
El despliegue del backend **oficial** (este: `gpa-sam` + `gpa-sap-lambda` + Aurora + SES)
debe realizarse con su propia configuración SAM (`cd gpa-sam && sam deploy --guided`).
