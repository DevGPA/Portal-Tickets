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
