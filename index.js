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
    if (found) {
        console.log(`🌐 Navegador encontrado: ${found}`);
        return found;
    }

    console.warn('⚠️  No se encontró Chrome/Chromium. Puppeteer usará su Chromium interno.');
    console.warn('   → En Ubuntu/Debian instala con: apt install -y chromium-browser');
    return undefined;
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
const CACHE_DIR = path.join(__dirname, '.wwebjs_cache');
const chromePath = getChromePath();
if (chromePath) {
    console.log(`🔧 executablePath: ${chromePath}`);
} else {
    // Intenta detectar el Chromium interno de puppeteer
    try {
        const puppeteer = require('puppeteer');
        const execPath = puppeteer.executablePath();
        console.log(`🔧 Chromium interno de puppeteer: ${execPath}`);
        if (!fs.existsSync(execPath)) {
            console.error('❌ El Chromium de puppeteer no existe en disco. Ejecuta: npx puppeteer browsers install chrome');
        }
    } catch (_) {
        console.warn('⚠️  puppeteer no está instalado como dependencia directa.');
    }
}

const isWindows = process.platform === 'win32';
const puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--mute-audio',
    '--safebrowsing-disable-auto-update'
];
// --no-zygote y --single-process causan crashes en Windows
if (!isWindows) {
    puppeteerArgs.push('--no-zygote', '--single-process');
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        ...(chromePath ? { executablePath: chromePath } : {}),
        headless: true,
        timeout: 120000,
        args: puppeteerArgs
    },
    qrMaxRetries: 5,
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000,
    webVersionCache: {
        type: 'local',
        path: path.join(__dirname, '.wwebjs_cache')
    }
});

client.on('qr', qr => {
    latestQr = qr;
    console.log('\n📱 Escanea este QR con WhatsApp:\n');
    qrcode.generate(qr, { small: true });
});

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Cargando WhatsApp Web: ${percent}% — ${message}`);
});

client.on('authenticated', () => {
    console.log('🔐 Autenticado correctamente.');
});

client.on('auth_failure', msg => {
    console.error('❌ Fallo de autenticación:', msg);
    latestQr = null;
    // Borra caché de sesión para forzar nuevo QR
    const authDir = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    console.log('🗑️  Sesión borrada. Reiniciando en 5s...');
    setTimeout(() => client.initialize().catch(err => console.error('Error al reiniciar:', err.message)), 5000);
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

const MAX_INIT_RETRIES = 3;
let initRetries = 0;

async function initializeWithRetry() {
    while (initRetries < MAX_INIT_RETRIES) {
        try {
            initRetries++;
            console.log(`🔄 Iniciando cliente WhatsApp... (intento ${initRetries}/${MAX_INIT_RETRIES})`);
            // Limpiar locks antes de cada intento
            ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'].forEach(f => {
                const p = path.join(SESSION_DIR, f);
                if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`🔓 Eliminado: ${f}`); }
            });
            await client.initialize();
            return; // éxito
        } catch (err) {
            console.error(`💥 Error al inicializar WhatsApp (intento ${initRetries}):`, err.message);
            if (initRetries < MAX_INIT_RETRIES) {
                const delay = initRetries * 5000;
                console.log(`⏳ Reintentando en ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                console.error(err.stack);
                console.error('\n👉 Posibles causas:');
                console.error('   1. Chrome/Chromium no funcional o incompatible');
                console.error('   2. Sesión corrupta → borra la carpeta .wwebjs_auth y reinicia');
                console.error('   3. Sin memoria suficiente → revisa con: free -h (Linux) o Task Manager (Windows)');
            }
        }
    }
}

initializeWithRetry();

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
