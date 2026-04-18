# send-whatsapp

Microservicio HTTP que conecta WhatsApp Web a cualquier flujo de automatización (n8n, Make, Zapier, etc.).  
Expone una API REST para **enviar mensajes y archivos**, y reenvía los **mensajes entrantes** a una URL de webhook configurable.

---

## Tabla de contenidos

1. [Arquitectura](#arquitectura)
2. [Requisitos](#requisitos)
3. [Instalación](#instalación)
4. [Configuración](#configuración)
5. [Inicio y autenticación QR](#inicio-y-autenticación-qr)
6. [Ejecutar en segundo plano con PM2](#ejecutar-en-segundo-plano-con-pm2)
7. [API REST](#api-rest)
   - [GET /status](#get-status)
   - [GET /webhook](#get-webhook)
   - [POST /send](#post-send)
   - [POST /send-file](#post-send-file)
8. [Webhook de mensajes entrantes](#webhook-de-mensajes-entrantes)
9. [Reconexión automática](#reconexión-automática)
10. [Estructura del proyecto](#estructura-del-proyecto)
11. [Dependencias](#dependencias)
12. [Notas de seguridad](#notas-de-seguridad)

---

## Arquitectura

```
┌─────────────┐   HTTP REST   ┌──────────────────────┐   WhatsApp Web   ┌───────────────┐
│  Cliente /  │ ────────────► │  send-whatsapp       │ ◄──────────────► │  WhatsApp     │
│  n8n / etc. │              │  (Express + WWebJS)  │                  │  (Chrome/     │
└─────────────┘              └──────────────────────┘                  │   Puppeteer)  │
                                        │                              └───────────────┘
                                        │ POST (webhook)
                                        ▼
                              ┌──────────────────────┐
                              │  WEBHOOK_URL         │
                              │  (n8n, Make, etc.)   │
                              └──────────────────────┘
```

- El servicio levanta un **servidor Express** en el puerto `2001` (configurable).
- Internamente inicializa un **cliente WhatsApp Web** usando `whatsapp-web.js` sobre un Chrome headless.
- La sesión se persiste en disco (`.wwebjs_auth/`) para no requerir escanear el QR en cada reinicio.
- Cada mensaje recibido por WhatsApp se reenvía mediante **POST** a `WEBHOOK_URL`.

---

## Requisitos

| Requisito | Versión mínima |
|---|---|
| Node.js | 18 LTS o superior |
| npm | 8+ |
| Google Chrome | Cualquier versión estable |
| Sistema Operativo | Windows, macOS o Linux |

> **Windows:** el ejecutable de Chrome debe estar en  
> `C:\Program Files\Google\Chrome\Application\chrome.exe`  
> (o actualizar `executablePath` en `index.js`).

---

## Instalación

```bash
# 1. Clonar o copiar el proyecto
cd send-whatsapp

# 2. Instalar dependencias
npm install
```

---

## Configuración

La configuración se realiza mediante **variables de entorno** o directamente en `index.js`.

| Variable | Valor por defecto | Descripción |
|---|---|---|
| `PORT` | `2001` | Puerto en el que escucha el servidor HTTP |
| `WEBHOOK_URL` | `http://localhost:5678/webhook/my-n8n` | URL destino para los mensajes de WhatsApp entrantes |

### Ejemplo con variables de entorno (PowerShell)

```powershell
$env:PORT = "3000"
$env:WEBHOOK_URL = "https://mi-n8n.ejemplo.com/webhook/whatsapp"
node index.js
```

### Ejemplo con `.env` (usando dotenv — instalar por separado)

```env
PORT=2001
WEBHOOK_URL=https://mi-n8n.ejemplo.com/webhook/whatsapp
```

---

## Inicio y autenticación QR

```bash
npm start
# o
node index.js
```

**Primera ejecución:**

1. El servicio imprime en consola un **código QR** en texto ASCII.
2. Abre WhatsApp en tu teléfono → **Dispositivos vinculados** → **Vincular un dispositivo**.
3. Escanea el QR. Una vez autenticado verás:
   ```
   ✅ WhatsApp listo. Servidor HTTP escuchando en :2001
   ```
4. La sesión se guarda en `.wwebjs_auth/` — los **reinicios posteriores no requieren QR**.

---

## Ejecutar en segundo plano con PM2

PM2 mantiene el proceso activo, lo reinicia automáticamente si falla y arranca con el sistema operativo.

### 1. Instalar PM2

```bash
npm install -g pm2
```

### 2. Primera autenticación (escanear QR)

Antes de dejar el servicio en segundo plano, es necesario autenticarse **una vez** con la terminal visible para poder escanear el código QR:

```bash
npm start
```

Una vez que veas `✅ WhatsApp listo`, detén el proceso con `Ctrl+C`. La sesión queda guardada en `.wwebjs_auth/` y los reinicios posteriores no requerirán QR.

### 3. Iniciar con PM2

```bash
pm2 start ecosystem.config.js
```

### 4. Comandos útiles de PM2

```bash
# Ver estado del proceso
pm2 status

# Ver logs en tiempo real
pm2 logs whatsapp-gateway

# Ver solo los últimos 100 registros
pm2 logs whatsapp-gateway --lines 100

# Reiniciar manualmente
pm2 restart whatsapp-gateway

# Detener
pm2 stop whatsapp-gateway

# Eliminar del registro de PM2
pm2 delete whatsapp-gateway
```

### 5. Arranque automático con el sistema

Para que PM2 inicie el servicio automáticamente al arrancar el sistema operativo:

```bash
# Genera e instala el script de inicio
pm2 startup

# Guarda la lista de procesos activos
pm2 save
```

> En Windows, `pm2 startup` puede requerir ejecutar el comando resultante como Administrador.

### 6. Comportamiento de reinicio automático

El archivo `ecosystem.config.js` configura PM2 con las siguientes políticas:

| Parámetro | Valor | Descripción |
|---|---|---|
| `restart_delay` | 5 s | Espera antes de cada reinicio |
| `max_restarts` | 20 | Máximo de reinicios antes de marcar el proceso como `errored` |
| `min_uptime` | 30 s | Tiempo mínimo de vida para que el reinicio no cuente |
| `exp_backoff_restart_delay` | 100 ms | Aumenta el delay entre reinicios sucesivos |
| `max_memory_restart` | 500 MB | Reinicia si el proceso supera este uso de memoria |

El proceso sale con código `1` en estos casos (lo que dispara el reinicio de PM2):
- Se agotan todos los reintentos de inicialización de WhatsApp
- Fallo de autenticación (sesión corrupta) — borra `.wwebjs_auth/` y reinicia limpio

### 7. Resetear sesión manualmente

Si WhatsApp pide volver a escanear el QR (por ejemplo, tras cerrar sesión desde el teléfono):

```bash
# Detener el proceso
pm2 stop whatsapp-gateway

# Borrar la sesión guardada
rm -rf .wwebjs_auth

# Iniciar con terminal visible para escanear el nuevo QR
node index.js
# (escanear QR y esperar "✅ WhatsApp listo")
# Ctrl+C

# Volver a segundo plano
pm2 start ecosystem.config.js
pm2 save
```

---

## API REST

Base URL: `http://localhost:2001`

---

### GET /status

Verifica si el cliente de WhatsApp está conectado y listo para enviar mensajes.

**Respuesta exitosa `200`**
```json
{ "ready": true }
```

**Respuesta cuando no está listo**
```json
{ "ready": false }
```

---

### GET /webhook

Devuelve la URL de webhook configurada actualmente.

**Respuesta `200`**
```json
{ "webhookUrl": "http://localhost:5678/webhook/my-n8n" }
```

---

### POST /send

Envía un **mensaje de texto** a un número de WhatsApp.

**Headers**
```
Content-Type: application/json
```

**Body**
```json
{
  "number": "584140000000",
  "message": "Hola! Este es un mensaje de prueba."
}
```

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `number` | string | ✅ | Número en cualquier formato: `"584140000000"`, `"+584140000000"` o `"584140000000@c.us"` |
| `message` | string | ✅ | Texto del mensaje |

**Respuesta exitosa `200`**
```json
{
  "success": true,
  "id": "true_584140000000@c.us_3EB0A1B2C3D4E5F6"
}
```

**Errores posibles**

| Código | Motivo |
|---|---|
| `400` | Faltan campos `number` o `message` |
| `404` | El número no existe en WhatsApp |
| `503` | El cliente de WhatsApp no está listo |

---

### POST /send-file

Envía un **archivo adjunto** (imagen, documento, audio, video, etc.) a un número de WhatsApp.

**Headers**
```
Content-Type: multipart/form-data
```

**Campos del formulario**

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `number` | string | ✅ | Número de destino (mismo formato que `/send`) |
| `file` | file | ✅ | Archivo a enviar |
| `message` | string | ❌ | Texto que aparece como caption (pie del archivo) |
| `filename` | string | ❌ | Nombre del archivo que verá el destinatario (sobreescribe el nombre original) |

**Comportamiento según tipo de archivo**

- **Imágenes** (`jpeg`, `png`, `gif`, `webp`, `bmp`): se envían como imagen inline con previsualización.
- **Cualquier otro tipo**: se envía como documento descargable.

**Ejemplo con curl**
```bash
curl -X POST http://localhost:2001/send-file \
  -F "number=584140000000" \
  -F "message=Te mando el reporte" \
  -F "file=@/ruta/al/reporte.pdf"
```

**Respuesta exitosa `200`**
```json
{
  "success": true,
  "id": "true_584140000000@c.us_3EB0A1B2C3D4E5F6"
}
```

**Errores posibles**

| Código | Motivo |
|---|---|
| `400` | Faltan campos `number` o `file` |
| `500` | Error al enviar (límite de tamaño, tipo no soportado, etc.) |
| `503` | El cliente de WhatsApp no está listo |

> Los archivos subidos se eliminan automáticamente del servidor después del envío.

---

## Webhook de mensajes entrantes

Cada vez que llega un mensaje a WhatsApp, el servicio hace un **POST** a `WEBHOOK_URL` con el siguiente payload JSON:

```json
{
  "event": "message_received",
  "timestamp": 1708300000000,
  "from": "584140000000@c.us",
  "phoneNumber": "584140000000",
  "to": "584141234567@c.us",
  "body": "Hola, ¿cómo estás?",
  "type": "chat",
  "hasMedia": false,
  "isGroup": false,
  "id": "true_584140000000@c.us_3EB0A1B2C3D4E5F6"
}
```

### Campos del payload

| Campo | Tipo | Descripción |
|---|---|---|
| `event` | string | Siempre `"message_received"` |
| `timestamp` | number | Epoch en milisegundos |
| `from` | string | ID completo del remitente (`@c.us` = individual, `@g.us` = grupo) |
| `phoneNumber` | string | Número limpio sin sufijo `@...` |
| `to` | string | ID del destinatario (tu número) |
| `body` | string | Texto del mensaje (vacío si es solo media) |
| `type` | string | Tipo de mensaje: `chat`, `image`, `document`, `audio`, `video`, `sticker`, etc. |
| `hasMedia` | boolean | Indica si el mensaje contiene un archivo multimedia |
| `isGroup` | boolean | `true` si el mensaje viene de un grupo |
| `id` | string | ID único del mensaje |
| `media` | object | **Solo si `hasMedia: true`** — ver abajo |

### Objeto `media` (cuando hay archivo adjunto)

```json
{
  "media": {
    "mimetype": "image/jpeg",
    "filename": "foto.jpg",
    "data": "<base64>"
  }
}
```

| Campo | Descripción |
|---|---|
| `mimetype` | Tipo MIME del archivo |
| `filename` | Nombre del archivo (puede ser `null`) |
| `data` | Contenido del archivo codificado en **Base64** |

---

## Reconexión automática

Si WhatsApp se desconecta (cierre de sesión, pérdida de red, conflicto de sesión), el servicio:

1. Registra la desconexión en consola.
2. Espera **5 segundos**.
3. Limpia los archivos de bloqueo de Chromium (`SingletonLock`, etc.).
4. Reintenta la inicialización hasta **5 veces** con espera incremental (10 s, 20 s, 30 s…).
5. Si se agotan todos los reintentos, el proceso termina con código `1` para que **PM2 lo reinicie automáticamente**.

Si la sesión ya estaba guardada (`.wwebjs_auth/`), no se pedirá QR nuevamente.

---

## Estructura del proyecto

```
send-whatsapp/
├── index.js             # Entrada principal: servidor Express + cliente WhatsApp
├── ecosystem.config.js  # Configuración de PM2
├── package.json         # Metadatos y dependencias
├── .env                 # Variables de entorno (PORT, WEBHOOK_URL) — no incluir en git
├── logs/                # Logs de PM2 (se autocrea)
├── uploads/             # Carpeta temporal para archivos entrantes (se autocrea)
├── .wwebjs_auth/        # Sesión persistente de WhatsApp (se autocrea al autenticar)
└── .wwebjs_cache/       # Caché de versión de WhatsApp Web (se autocrea)
```

> Las carpetas `.wwebjs_auth/` y `.wwebjs_cache/` son generadas automáticamente y **no deben incluirse en control de versiones**.

---

## Dependencias

| Paquete | Versión | Uso |
|---|---|---|
| [`whatsapp-web.js`](https://wwebjs.dev/) | ^1.34.6 | Cliente de WhatsApp Web sobre Puppeteer |
| [`express`](https://expressjs.com/) | ^5.2.1 | Servidor HTTP / API REST |
| [`multer`](https://github.com/expressjs/multer) | ^2.0.2 | Manejo de archivos `multipart/form-data` |
| [`mime-types`](https://github.com/jshttp/mime-types) | ^3.0.2 | Detección del tipo MIME por extensión |
| [`qrcode-terminal`](https://github.com/gtanner/qrcode-terminal) | ^0.12.0 | Renderizado del QR en consola |

---

## Notas de seguridad

- **No exponer el servicio a Internet sin autenticación.** Cualquiera que acceda al puerto podría enviar mensajes desde tu número.
- Añadir un **token de API** o restringir acceso por IP si se despliega en red pública.
- El campo `media.data` en el webhook contiene los archivos en Base64, lo que puede generar payloads grandes. Considera limitar el tipo o tamaño de media aceptado si el volumen es alto.
- Los archivos temporales en `uploads/` se eliminan automáticamente tras cada envío exitoso (y también en caso de error en el bloque `finally`).
