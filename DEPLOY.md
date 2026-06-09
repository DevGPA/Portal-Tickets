# Guía de despliegue — Portal de Postventa GPA

Despliegue de la aplicación completa en AWS, paso a paso y con los comandos exactos.

- **Frontend** (`index.html` + `config.js`) → **AWS Amplify Hosting** (estático).
- **Backend** (`gpa-api/`) → **AWS Lambda + API Gateway** (con Serverless Framework).
- **Evidencias** → **Amazon S3** (privado, URLs prefirmadas).
- **Datos** → **Amazon RDS (PostgreSQL)** *(opcional; sin DB corre en modo demo).*

```
Navegador ──HTTPS──► Amplify Hosting (frontend)
    │
    └──fetch (cookie JWT)──► API Gateway ──► Lambda (gpa-api) ──► RDS + S3 + SAP
```

> Los comandos de shell están en **PowerShell** (el entorno de este proyecto).
> Donde difiere, se incluye el equivalente bash en un comentario.

---

## 0. Prerrequisitos (una sola vez)

```powershell
# Node.js 18+ y npm
node -v
npm -v

# AWS CLI v2
aws --version
# Si no está: https://aws.amazon.com/cli/  ->  msiexec /i AWSCLIV2.msi

# Configurar credenciales de AWS (Access Key con permisos de admin o equivalentes)
aws configure
# AWS Access Key ID, Secret, Default region: us-east-1, output: json

# Serverless Framework (para desplegar el backend)
npm install -g serverless
serverless --version
```

Verifica que las credenciales funcionan:

```powershell
aws sts get-caller-identity
```

---

## 1. Crear el bucket S3 de evidencias

```powershell
# Elige un nombre único global
$BUCKET = "gpa-postventa-evidencias"
$REGION = "us-east-1"

aws s3api create-bucket --bucket $BUCKET --region $REGION

# Bloquear todo acceso público (las descargas usan URLs prefirmadas, no acceso público)
aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration `
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Cifrado en reposo (AES256)
aws s3api put-bucket-encryption --bucket $BUCKET --server-side-encryption-configuration `
  '{\"Rules\":[{\"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"AES256\"}}]}'
```

> En `us-east-1` no se pasa `LocationConstraint`. En otras regiones añade:
> `--create-bucket-configuration LocationConstraint=$REGION`.

---

## 2. (Opcional) Base de datos RDS PostgreSQL

Si la omites, el backend arranca con un almacén **en memoria** (datos demo). Para producción:

```powershell
# Crear instancia (ajusta usuario/password/clase según necesidad)
aws rds create-db-instance `
  --db-instance-identifier gpa-db `
  --engine postgres `
  --db-instance-class db.t3.micro `
  --allocated-storage 20 `
  --master-username gpaadmin `
  --master-user-password "CAMBIA_ESTA_PASSWORD" `
  --db-name gpa `
  --publicly-accessible `
  --backup-retention-period 7

# Esperar a que quede disponible y obtener el endpoint
aws rds wait db-instance-available --db-instance-identifier gpa-db
aws rds describe-db-instances --db-instance-identifier gpa-db `
  --query "DBInstances[0].Endpoint.Address" --output text
```

Aplica el esquema (necesitas el cliente `psql` instalado):

```powershell
$DBHOST = "<endpoint-que-devolvió-el-comando-anterior>"
psql "postgresql://gpaadmin:CAMBIA_ESTA_PASSWORD@$DBHOST:5432/gpa" -f gpa-api/sql/schema.sql
```

Crea un usuario de prueba con contraseña hasheada (bcrypt):

```powershell
cd gpa-api
npm install
$HASH = node -e "console.log(require('bcryptjs').hashSync('TuPasswordSegura', 10))"
cd ..
psql "postgresql://gpaadmin:CAMBIA_ESTA_PASSWORD@$DBHOST:5432/gpa" -c `
  "INSERT INTO usuarios (email, password_hash, nombre_empresa, rol, sap_cliente_id) VALUES ('cliente@empresa.com', '$HASH', 'Distribuidor X', 'cliente', 'C-10045');"
```

> **Importante (red):** el grupo de seguridad de RDS debe permitir el acceso desde la Lambda.
> Para empezar rápido se usa `--publicly-accessible`; en producción coloca la Lambda y RDS
> en la misma VPC y abre el puerto 5432 solo al security group de la Lambda.

---

## 3. Desplegar el backend (gpa-api)

```powershell
cd gpa-api
npm install

# Variables de entorno que lee serverless.yml (sesión actual de PowerShell)
$env:AWS_REGION            = "us-east-1"
$env:JWT_SECRET            = "pon-aqui-un-secreto-largo-y-aleatorio"
$env:JWT_EXPIRES           = "8h"
$env:COOKIE_NAME           = "gpa_token"
$env:COOKIE_DOMAIN         = ""
$env:S3_BUCKET             = "gpa-postventa-evidencias"
$env:S3_PRESIGN_EXPIRES    = "300"
# DB: deja vacío para modo demo, o pon la cadena real de RDS
$env:DATABASE_URL          = "postgresql://gpaadmin:CAMBIA_ESTA_PASSWORD@$DBHOST:5432/gpa"
# SAP: deja vacío para datos demo, o completa la integración real
$env:SAP_SERVICE_LAYER_URL = ""
$env:SAP_COMPANY_DB        = ""
$env:SAP_USER              = ""
$env:SAP_PASSWORD          = ""
# CORS: lo ajustaremos en el paso 5 con el dominio real de Amplify.
# De momento ponemos un placeholder para poder desplegar.
$env:CORS_ORIGINS          = "https://placeholder.amplifyapp.com"

# Desplegar
serverless deploy --stage production
```

> Equivalente bash: `export JWT_SECRET="..."` en lugar de `$env:JWT_SECRET="..."`.

Al terminar, Serverless imprime el **endpoint**. Cópialo (lo necesitas en el paso 4):

```
endpoint: ANY - https://abc123xyz.execute-api.us-east-1.amazonaws.com
```

Prueba que responde:

```powershell
curl https://abc123xyz.execute-api.us-east-1.amazonaws.com/health
# -> {"ok":true,"env":"production"}
```

> **Alternativa sin Lambda (contenedor):** App Runner o ECS Fargate ejecutando
> `npm start` (usa `src/server.js`). Define las mismas variables de entorno y
> expón el puerto 4000. El resto de la guía es igual usando esa URL como API.

---

## 4. Desplegar el frontend en AWS Amplify Hosting

El `amplify.yml` ya genera `config.js` a partir de la variable de entorno `API_BASE`
en cada build. Solo hay que conectar el repo y definir esa variable.

### Vía consola (recomendado, despliegue continuo desde Git)

1. Sube el repositorio a GitHub/GitLab/CodeCommit (ver paso 6 si aún no está).
2. AWS Console → **Amplify** → **New app** → **Host web app**.
3. Conecta tu proveedor Git y selecciona el repo + rama `main`.
4. Amplify detecta el `amplify.yml` automáticamente. **No cambies** la configuración de build.
5. En **Environment variables**, añade:

   | Variable | Valor |
   |----------|-------|
   | `API_BASE` | `https://abc123xyz.execute-api.us-east-1.amazonaws.com` |

6. **Save and deploy**. Al terminar obtienes la URL pública, p.ej.:
   `https://main.d1a2b3c4d5.amplifyapp.com`

> Cada `git push` a `main` redesplegará el frontend. Si cambias `API_BASE`,
> vuelve a desplegar (**Redeploy this version**) para regenerar `config.js`.

### Vía Amplify CLI (despliegue manual sin Git)

```powershell
# Genera config.js localmente con la URL del backend
"window.GPA_CONFIG = { API_BASE: 'https://abc123xyz.execute-api.us-east-1.amazonaws.com' };" `
  | Out-File -Encoding utf8 config.js

# Empaqueta solo los artefactos publicables
Compress-Archive -Path index.html, config.js -DestinationPath site.zip -Force

# Crea la app y un deployment manual
$APPID = aws amplify create-app --name gpa-portal --query "app.appId" --output text
aws amplify create-branch --app-id $APPID --branch-name main
aws amplify start-deployment --app-id $APPID --branch-name main --source-url "site.zip"
```

---

## 5. Conectar CORS (backend ↔ dominio real de Amplify)

Ahora que conoces el dominio de Amplify, actualiza el backend para permitirlo:

```powershell
cd gpa-api
$env:CORS_ORIGINS = "https://main.d1a2b3c4d5.amplifyapp.com"
serverless deploy --stage production
```

> Esto es **obligatorio**: el frontend hace llamadas con cookies (`credentials:'include'`),
> y el origen debe estar en la lista blanca. En producción (`NODE_ENV=production`) la cookie
> se emite con `SameSite=None; Secure`, necesaria porque Amplify y API Gateway son dominios
> distintos. Ambos sirven por HTTPS, así que la cookie viaja correctamente.

---

## 6. (Si aún no lo hiciste) Subir el repositorio a Git

```powershell
cd "C:\Users\Desarrollador\Documents\AWS Portal Tickets\Portal-Tickets"
git add .
git commit -m "feat: backend gpa-api + frontend conectado y configurable"
git push origin main
```

---

## 7. Verificación end-to-end

1. Abre `https://main.d1a2b3c4d5.amplifyapp.com` en el navegador.
2. **Login** con el usuario creado en el paso 2 (o cualquier correo si estás en modo demo).
3. Crea un ticket: selecciona tipo → factura (autocompletado desde SAP/demo) →
   producto → adjunta evidencias → **Confirmar envío**.
4. Debe mostrarse un **folio real** (`GPA-2026-…`) devuelto por el backend.
5. Ve a **Mis Tickets**: el ticket recién creado debe aparecer en la lista.
6. Abre el detalle y descarga una evidencia (URL prefirmada de S3).

Comprobaciones rápidas por CLI:

```powershell
# Salud del backend
curl https://abc123xyz.execute-api.us-east-1.amazonaws.com/health

# El frontend ya trae la URL inyectada
curl https://main.d1a2b3c4d5.amplifyapp.com/config.js
# -> window.GPA_CONFIG = { API_BASE: 'https://abc123xyz...' };
```

---

## 8. Solución de problemas

| Síntoma | Causa probable | Solución |
|---------|----------------|----------|
| El portal sigue en modo demo (login acepta cualquier correo) | `config.js` quedó vacío | Verifica que `API_BASE` esté en las env vars de Amplify y **redepliega** |
| Error CORS en la consola del navegador | El dominio de Amplify no está en `CORS_ORIGINS` | Repite el paso 5 con la URL exacta (con `https://`, sin `/` final) |
| Login "funciona" pero `/auth/me` da 401 al recargar | Cookie no se guarda (cross-site) | Confirma `NODE_ENV=production` en el backend (cookie `SameSite=None; Secure`) |
| `POST /tickets` da 500 con `NoSuchBucket` | `S3_BUCKET` apunta a un bucket inexistente | Crea el bucket (paso 1) o deja `S3_BUCKET` vacío para modo demo |
| El backend no conecta a RDS | Security group / VPC | Abre el puerto 5432 al SG de la Lambda o usa `--publicly-accessible` para pruebas |

---

## 9. Limpieza (eliminar todo)

```powershell
# Backend
cd gpa-api
serverless remove --stage production

# Frontend (si usaste Amplify CLI)
aws amplify delete-app --app-id $APPID

# Datos
aws s3 rb s3://gpa-postventa-evidencias --force
aws rds delete-db-instance --db-instance-identifier gpa-db --skip-final-snapshot
```
