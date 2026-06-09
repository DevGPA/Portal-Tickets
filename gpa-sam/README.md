# GPA Postventa — Infraestructura SAM

## Estructura

```
gpa-sam/
├── template.yaml              ← Toda la infraestructura AWS
├── layers/nodejs/package.json ← Dependencias compartidas (layer)
├── functions/
│   ├── shared/
│   │   ├── db.js              ← Pool Aurora (compartido)
│   │   └── helpers.js         ← Respuestas HTTP + auth JWT
│   ├── auth/index.js          ← POST /auth/login | POST /auth/logout | GET /auth/me
│   ├── tickets/index.js       ← POST /tickets | GET /tickets | GET /tickets/{id}
│   ├── upload/index.js        ← POST /upload/presigned-url | POST /upload/confirm
│   └── sap/index.js           ← Lambda interna SAP (sin API Gateway)
└── frontend/
    └── api.js                 ← Cliente JS del portal → API Gateway
```

---

## Pre-requisitos

```bash
# Instalar AWS SAM CLI
brew install aws-sam-cli       # macOS
# o: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html

# Configurar credenciales AWS
aws configure
# AWS Access Key ID: ...
# AWS Secret Access Key: ...
# Default region: us-east-1   ← o la que uses
```

---

## Deploy (primera vez)

### 1. Ajustar subnet y VPC en template.yaml

Buscar y reemplazar estos valores con los reales de tu cuenta AWS:
```
subnet-XXXXXXXX  → ID de subnet real (necesitas 2 de distintas AZs)
subnet-YYYYYYYY  → segunda subnet
vpc-XXXXXXXX     → ID de tu VPC
```

### 2. Construir

```bash
cd gpa-sam
sam build
```

Esto instala las dependencias del layer y empaqueta cada función.

### 3. Desplegar

```bash
sam deploy --guided
```

El asistente te pedirá:
```
Stack Name:         gpa-postventa
AWS Region:         us-east-1
Environment:        production
JwtSecret:          [clave random de 32+ chars]
DbPassword:         [contraseña segura para Aurora]
SapServiceLayerUrl: https://sap.gpa.com.mx/b1s/v1
SapCompanyDb:       NOMBRE_EMPRESA
SapUser:            usuario_sap
SapPassword:        password_sap
SmtpHost:           mail.gpa.com.mx
SmtpPort:           587
SmtpUser:           postventa@gpa.com.mx
SmtpPassword:       password_correo
EmailPostventa:     postventa@gpa.com.mx
CorsOrigin:         https://postventa-gpa.com
```

Al terminar verás el Output:
```
ApiUrl = https://XXXXXXXXXX.execute-api.us-east-1.amazonaws.com/production
```

### 4. Correr migraciones de base de datos

Aurora ya está creada. Ahora crear las tablas:

```bash
# Instalar dependencias localmente para correr migrate
npm install pg dotenv

# Crear .env temporal con el endpoint de Aurora
echo "DATABASE_URL=postgresql://gpa_admin:TU_PASSWORD@ENDPOINT_AURORA:5432/gpa_postventa" > .env.migrate

# Correr migrate (usando el script del proyecto gpa-api o adaptando el SQL)
DATABASE_URL=postgresql://gpa_admin:PASSWORD@ENDPOINT/gpa_postventa node ../gpa-api/src/db/migrate.js
```

### 5. Actualizar el frontend

En `frontend/api.js`, reemplazar la URL:
```js
const API_BASE_URL = 'https://XXXXXXXXXX.execute-api.us-east-1.amazonaws.com/production';
//                    ↑ pegar el ApiUrl del Output del deploy
```

Incluir el archivo en el portal HTML:
```html
<script src="api.js"></script>
```

---

## Deploys posteriores (actualizar código)

```bash
sam build && sam deploy
```

Solo actualiza lo que cambió — SAM detecta qué funciones necesitan re-deploy.

---

## Crear usuario distribuidor

```bash
# Conectarse a Aurora y ejecutar:
psql postgresql://gpa_admin:PASSWORD@ENDPOINT/gpa_postventa

INSERT INTO usuarios (email, password_hash, nombre_empresa, ejecutivo_gpa, categoria, sap_cliente_id)
VALUES (
  'dist@empresa.com',
  '$2b$12$HASH_GENERADO_CON_BCRYPT',  -- generar con: node -e "console.log(require('bcrypt').hashSync('password',12))"
  'Distribuidora SA',
  'EV01',
  'Estándar',
  'C001'
);
```

---

## Logs y monitoreo

```bash
# Ver logs de una función en tiempo real
sam logs -n AuthFunction --stack-name gpa-postventa --tail
sam logs -n TicketsFunction --stack-name gpa-postventa --tail
sam logs -n SapFunction --stack-name gpa-postventa --tail
```

---

## Endpoints del API Gateway

| Método | Ruta | Función | Auth |
|--------|------|---------|------|
| POST | /auth/login | AuthFunction | Pública |
| POST | /auth/logout | AuthFunction | Pública |
| GET | /auth/me | AuthFunction | JWT |
| POST | /tickets | TicketsFunction | JWT |
| GET | /tickets | TicketsFunction | JWT |
| GET | /tickets/{id} | TicketsFunction | JWT |
| GET | /tickets/{id}/evidencias/{key}/url | TicketsFunction | JWT |
| POST | /upload/presigned-url | UploadFunction | JWT |
| POST | /upload/confirm | UploadFunction | JWT |

La Lambda SAP (`SapFunction`) NO tiene endpoint — solo la invoca `TicketsFunction` internamente.
