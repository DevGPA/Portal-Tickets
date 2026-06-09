# gpa-api — Backend del Portal de Postventa GPA

API REST que da servicio al frontend estático (`../index.html`, desplegado en AWS Amplify).
Expone autenticación con JWT en cookie HttpOnly, integración con SAP Business One
(Service Layer) y gestión de tickets/evidencias con almacenamiento en S3.

> **Esqueleto funcional.** Arranca sin DB ni SAP ni S3: en ese caso usa datos
> **demo** (los mismos del frontend) para que puedas validar el contrato extremo
> a extremo. Los puntos a completar para producción están marcados con `TODO(prod)`.

## Estructura

```
gpa-api/
├── package.json
├── serverless.yml            # Despliegue Lambda + API Gateway (opcional)
├── .env.example              # Copiar a .env
├── sql/schema.sql            # Esquema de referencia (RDS PostgreSQL)
└── src/
    ├── server.js             # Entrada standalone (EC2/ECS/App Runner/local)
    ├── lambda.js             # Entrada Lambda (serverless-http)
    ├── app.js                # App Express (CORS, rutas, errores)
    ├── config.js             # Lee variables de entorno
    ├── middleware/
    │   ├── auth.js           # requireAuth / requireRole (JWT por cookie)
    │   └── errorHandler.js
    ├── routes/
    │   ├── auth.js           # /auth/login /me /logout /recover
    │   ├── sap.js            # /sap/buscar-facturas /articulos-factura
    │   └── tickets.js        # /tickets (CRUD + evidencias + URLs prefirmadas)
    └── services/
        ├── auth.service.js   # bcrypt + JWT + cookies
        ├── db.js             # PostgreSQL (o almacén en memoria si no hay DB)
        ├── sapClient.js      # SAP Service Layer (o datos demo)
        └── s3.js             # Subida y URLs prefirmadas de S3
```

## Endpoints (contrato que ya espera el frontend)

| Método | Ruta | Auth | Cuerpo / Query | Respuesta |
|--------|------|:----:|----------------|-----------|
| POST | `/auth/login` | — | `{email,password}` | `{user}` + cookie |
| GET | `/auth/me` | ✅ | — | `{nombreEmpresa,email,rol}` |
| POST | `/auth/logout` | — | — | `{ok}` |
| POST | `/auth/recover` | — | `{email}` | `{ok}` (siempre) |
| POST | `/sap/buscar-facturas` | ✅ | `{query}` | `{facturas:[{docNum,fecha,total,moneda}]}` |
| POST | `/sap/articulos-factura` | ✅ | `{docNum}` | `{success,articulos:[{itemCode,descripcion,tipoGarantia,cantidad}]}` |
| GET | `/tickets` | ✅ | `?page&limit&tipo&search` | `{data:[ticket],pagination:{page,limit,total,pages}}` |
| GET | `/tickets/:id` | ✅ | — | `{ticket,evidencias:[...]}` |
| GET | `/tickets/:id/evidencias/:key64/url` | ✅ | `key64` = base64(key S3) | `{url}` |
| POST | `/tickets` | ✅ | `multipart/form-data` | `{id,folio_sap}` |
| GET | `/health` | — | — | `{ok,env}` |

## Puesta en marcha (local)

```bash
cd gpa-api
cp .env.example .env      # ajusta CORS_ORIGINS y JWT_SECRET
npm install
npm run dev               # http://localhost:4000
```

Sin `DATABASE_URL`/SAP/S3, el API corre en **modo demo**. Login de prueba:
`distribuidor@demo.com` / `demo1234`.

## Conectar el frontend

En `../index.html` (línea ~1227) cambia:

```js
const API_BASE = ''; // demo
```

por la URL del API desplegado, por ejemplo:

```js
const API_BASE = 'https://abc123.execute-api.us-east-1.amazonaws.com';
```

Las llamadas ya usan `credentials: 'include'`, así que el navegador enviará la
cookie HttpOnly. Asegúrate de que `CORS_ORIGINS` incluya el dominio de Amplify.

> **Pendiente en el frontend:** `renderSuccess()` genera el folio en el navegador y
> **no** envía el ticket. Para usar `POST /tickets`, hay que construir un `FormData`
> con los campos (`tipo_ticket`, `familia`, `numero_factura`, `codigo_producto`,
> `numero_serie`, `descripcion`, `emails`, `evidencias` como JSON) y los archivos
> (`ev_0`, `ev_1`, …) antes de mostrar la pantalla de éxito.

## Despliegue en AWS

**Opción A — Lambda + API Gateway (recomendada, sin servidores):**
```bash
export CORS_ORIGINS=https://main.dXXXX.amplifyapp.com
export JWT_SECRET=... S3_BUCKET=gpa-postventa-evidencias DATABASE_URL=...
serverless deploy --stage production
```

**Opción B — Contenedor (App Runner / ECS Fargate):** usa `src/server.js` como
entrada (`npm start`) y configura las variables de entorno del `.env.example`.

En ambos casos, despliega el frontend por separado en **AWS Amplify Hosting**
(este repo, según `../amplify.yml`).

## Para producción (TODO)

- [ ] Tabla `usuarios` real con hashes bcrypt (o integrar Cognito).
- [ ] Implementar consultas SQL en `services/db.js` (ya están esbozadas).
- [ ] Implementar las llamadas OData reales en `services/sapClient.js`.
- [ ] Crear bucket S3 privado y rol IAM con `s3:GetObject`/`s3:PutObject`.
- [ ] `/auth/recover`: generar token y enviar correo con SES.
- [ ] `POST /tickets`: crear el ticket/servicio en SAP y notificar a Postventa.
- [ ] Rate limiting y validación de esquema (zod/express-validator).
