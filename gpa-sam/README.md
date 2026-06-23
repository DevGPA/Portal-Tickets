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
│   ├── auth/index.js          ← login | logout | me | recover | reset-password
│   ├── tickets/index.js       ← tickets CRUD + /sap/buscar-facturas + /sap/articulos-factura
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

### 1. VPC y subnets (ya configuradas)

El `template.yaml` ya apunta a la VPC default de la cuenta `149857424311` (us-east-1):
```
VpcId   = vpc-5104762c
Subnets = subnet-66486447 (us-east-1a), subnet-2d619761 (us-east-1b)
```
Si despliegas en otra cuenta/región, reemplaza estos valores por los tuyos
(2 subnets en AZs distintas + el VpcId que las contiene).

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
  '$2b$12$HASH_GENERADO_CON_BCRYPT',  -- generar con: node -e "console.log(require('bcryptjs').hashSync('password',12))"
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
| POST | /auth/recover | AuthFunction | Pública |
| POST | /auth/reset-password | AuthFunction | Pública (token) |
| POST | /tickets | TicketsFunction | JWT |
| GET | /tickets | TicketsFunction | JWT |
| GET | /tickets/{id} | TicketsFunction | JWT |
| GET | /tickets/{id}/evidencias/{key}/url | TicketsFunction | JWT |
| POST | /sap/buscar-facturas | TicketsFunction | JWT |
| POST | /sap/articulos-factura | TicketsFunction | JWT |
| POST | /upload/presigned-url | UploadFunction | JWT |
| POST | /upload/confirm | UploadFunction | JWT |

La Lambda SAP (`SapFunction`) NO tiene endpoint — la invoca `TicketsFunction` internamente.
Acciones soportadas por `SapFunction`: `crearTicket`, `consultarTicket`, `verificarCliente`,
`buscarFacturas`, `obtenerArticulosFactura`.

> **Recuperación de contraseña:** `/auth/recover` envía un correo con enlace a
> `${CorsOrigin}/reset-password?token=...` (válido 1 h). El enlace abre el portal, que
> debe llamar a `/auth/reset-password` con `{ token, password }`. Requiere las columnas
> `reset_token` / `reset_token_expiry` en `usuarios` (ya incluidas en `migrate.js`).
