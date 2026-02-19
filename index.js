const mime = require('mime-types');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 2001;

// Carpeta temporal para archivos adjuntos
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const upload = multer({
    storage: multer.diskStorage({
        destination: UPLOAD_DIR,
        filename: (req, file, cb) => {
            // Conserva la extensión original para que MessageMedia detecte el MIME correcto
            const ext = path.extname(file.originalname);
            cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        }
    })
});

app.use(express.json());

// URL destino del webhook (configurable por variable de entorno)
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:5678/webhook/my-n8n';

// ── Helper: envía un POST JSON a la webhook URL ──────────────────
function fireWebhook(payload) {
    if (!WEBHOOK_URL) return;
    try {
        const body = JSON.stringify(payload);
        const url = new URL(WEBHOOK_URL);
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, res => {
            console.log(`🔔 Webhook enviado → ${res.statusCode}`);
        });
        req.on('error', err => console.error('❌ Webhook error:', err.message));
        req.write(body);
        req.end();
    } catch (err) {
        console.error('❌ Webhook URL inválida:', err.message);
    }
}

// Ruta del navegador: usa CHROME_PATH si está definido, si no busca el primero disponible
function getChromePath() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

    const candidates = {
        win32: [
            `${process.env['PROGRAMFILES'] || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env['LOCALAPPDATA'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env['PROGRAMFILES'] || 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
            `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
            `${process.env['PROGRAMFILES'] || 'C:\\Program Files'}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
        ],
        darwin: [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ],
        linux: [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/microsoft-edge',
            '/usr/bin/brave-browser',
            '/snap/bin/chromium',
        ],
    };

    const list = candidates[process.platform] ?? candidates.linux;
    const found = list.find(p => fs.existsSync(p));
    if (found) return found;

    console.warn('⚠️  No se encontró ningún navegador. Instala Chrome, Edge o Chromium, o define CHROME_PATH en .env');
    return undefined; // puppeteer usará su propio Chromium si está disponible
}

// Estado del cliente
let clientReady = false;
let latestQr = null;
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth', 'session');
['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'].forEach(f => {
    const p = path.join(SESSION_DIR, f);
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`🔓 Eliminado: ${f}`); }
});

// ── WhatsApp Client ──────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        ...(getChromePath() ? { executablePath: getChromePath() } : {}),
        headless: true,
        timeout: 120000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--disable-extensions'
        ]
    },
    qrMaxRetries: 5,
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000,
    webVersionCache: {
        type: 'local',                      // guarda la versión en disco, no la descarga cada vez
        path: path.join(__dirname, '.wwebjs_cache')
    }
});

client.on('qr', qr => {
    latestQr = qr;
    console.log('\n📱 Escanea este QR con WhatsApp:\n');
    qrcode.generate(qr, { small: true });
    console.log(`\n🌐 También puedes escanearlo en: http://<TU-IP-VPS>:${PORT}/qr\n`);
});

client.on('ready', () => {
    clientReady = true;
    latestQr = null;
    console.log('✅ WhatsApp listo. Servidor HTTP escuchando en :' + PORT);
});

client.on('disconnected', reason => {
    clientReady = false;
    console.warn('⚠️  WhatsApp desconectado:', reason);
    // Reintenta reconectar después de 5 segundos
    setTimeout(() => {
        console.log('🔄 Reconectando...');
        ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'].forEach(f => {
            const p = path.join(SESSION_DIR, f);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        });
        client.initialize().catch(err => console.error('Error al reconectar:', err.message));
    }, 5000);
});

client.initialize();
client.on('message', async msg => {
    try {
        const fromRaw = msg.from;                                    // "584140000000@c.us"
        const phoneNumber = fromRaw.replace(/@.*$/, '');             // "584140000000"

        const payload = {
            event: 'message_received',
            timestamp: Date.now(),
            from: fromRaw,
            phoneNumber,                                             // número limpio sin @c.us
            to: msg.to,
            body: msg.body,
            type: msg.type,           // "chat", "image", "document", etc.
            hasMedia: msg.hasMedia,
            isGroup: fromRaw.endsWith('@g.us'),
            id: msg.id._serialized
        };

        // Si tiene media, descarga y adjunta en base64
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if (media) {
                    payload.media = {
                        mimetype: media.mimetype,
                        filename: media.filename || null,
                        data: media.data   // base64
                    };
                }
            } catch (mediaErr) {
                console.warn('⚠️  No se pudo descargar media:', mediaErr.message);
            }
        }

        console.log(`📨 Mensaje de ${payload.from}: ${payload.body || '[media]'}`);
        fireWebhook(payload);
    } catch (err) {
        console.error('❌ Error procesando mensaje entrante:', err.message);
    }
});

// Cierra el navegador limpiamente al detener el proceso
async function shutdown() {
    console.log('\n🛑 Cerrando WhatsApp client...');
    try { await client.destroy(); } catch (_) {}
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Helper ───────────────────────────────────────────────────────
/**
 * Resuelve cualquier forma de destinatario a un chatId serializado:
 *   - Número limpio:  "584140000000"  → getNumberId() (resuelve LID automáticamente)
 *   - Con prefijo +: "+584140000000" → igual
 *   - Ya serializado: "584140000000@c.us" o "12345@lid" → se usa tal cual
 */
async function resolveChatId(input) {
    const s = String(input).trim();
    // Si ya tiene @ (ej. @c.us, @lid, @g.us) lo usamos directo
    if (s.includes('@')) return s;
    // Si es un número de teléfono, preguntamos a WhatsApp
    const digits = s.replace(/\D/g, '');
    const resolved = await client.getNumberId(digits);
    if (!resolved) throw Object.assign(new Error(`Número no encontrado en WhatsApp: ${input}`), { status: 404 });
    return resolved._serialized;
}

// ── Rutas HTTP ───────────────────────────────────────────────────

/**
 * GET /qr
 * Muestra el QR de WhatsApp como página HTML escaneable desde el navegador.
 * Útil cuando el proceso corre en un VPS sin acceso directo a la terminal.
 */
app.get('/qr', (req, res) => {
    if (clientReady) {
        return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2 style="color:green">✅ WhatsApp ya está conectado</h2><p>No es necesario escanear ningún QR.</p></body></html>');
    }
    if (!latestQr) {
        return res.send('<html><head><meta http-equiv="refresh" content="3"></head><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>⏳ Esperando QR...</h2><p>El cliente WhatsApp aún está iniciando. Esta página se recarga automáticamente cada 3 segundos.</p></body></html>');
    }
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>WhatsApp QR</title>
  <script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
  <style>
    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f0f0f0; }
    .card { background: white; padding: 32px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); text-align: center; }
    h2 { color: #128C7E; margin-top: 0; }
    p { color: #555; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>📱 Escanea con WhatsApp</h2>
    <canvas id="qr"></canvas>
    <p>Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <p style="color:#aaa">Esta página se recarga automáticamente cada 30 segundos.</p>
  </div>
  <script>
    QRCode.toCanvas(document.getElementById('qr'), ${JSON.stringify(latestQr)}, { width: 300, margin: 2 }, function(err) {
      if (err) document.body.innerHTML += '<p style="color:red">Error al generar QR: ' + err + '</p>';
    });
  </script>
</body>
</html>`);
});

/**
 * GET /status
 * Verifica si el cliente está listo.
 */
app.get('/status', (req, res) => {
    res.json({ ready: clientReady });
});

/**
 * GET /webhook
 * Devuelve la URL de webhook configurada actualmente.
 */
app.get('/webhook', (req, res) => {
    res.json({ webhookUrl: WEBHOOK_URL || null });
});

/**
 * POST /send
 * Envía un mensaje de texto.
 *
 * Body JSON:
 *   { "number": "584140000000", "message": "Hola!" }
 */
app.post('/send', async (req, res) => {
    if (!clientReady) return res.status(503).json({ error: 'WhatsApp no está listo aún.' });

    const { number, message } = req.body;
    if (!number || !message) return res.status(400).json({ error: 'Faltan campos: number, message' });

    try {
        const chatId = await resolveChatId(number);
        const response = await client.sendMessage(chatId, message);
        res.json({ success: true, id: response.id._serialized });
    } catch (err) {
        console.error(err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

/**
 * POST /send-file
 * Envía un archivo adjunto (documento, imagen, audio, etc.).
 *
 * Form-data:
 *   number  : "584140000000"
 *   message : "Aquí va el archivo"  (opcional, caption)
 *   file    : <archivo>
 */
app.post('/send-file', upload.single('file'), async (req, res) => {
    if (!clientReady) return res.status(503).json({ error: 'WhatsApp no está listo aún.' });

    const { number, message } = req.body;
    if (!number || !req.file) return res.status(400).json({ error: 'Faltan campos: number, file' });

    const filePath = path.join(UPLOAD_DIR, req.file.filename);

    try {
        const chatId = await resolveChatId(number);

        // Prioridad: campo 'filename' del form > originalname del multipart > nombre del archivo guardado
        const rawName = req.body.filename || req.file.originalname || req.file.filename;
        const originalName = Buffer.from(rawName, 'latin1').toString('utf8');
        const mimeType = mime.lookup(originalName) || req.file.mimetype || 'application/octet-stream';
        const fileData = fs.readFileSync(filePath).toString('base64');
        const media = new MessageMedia(mimeType, fileData, originalName);

        console.log(`📎 Enviando: ${originalName} | MIME: ${mimeType}`);

        const isImage = /^image\/(jpeg|png|gif|webp|bmp)$/i.test(mimeType);
        const response = await client.sendMessage(chatId, media, {
            caption: message || '',
            sendMediaAsDocument: !isImage,
        });
        res.json({ success: true, id: response.id._serialized });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        // Limpia el archivo temporal
        fs.unlink(filePath, () => {});
    }
});

// ── Arranque HTTP ────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 Servidor HTTP en http://localhost:${PORT}`);
    console.log('   Esperando que WhatsApp esté listo...');
});
