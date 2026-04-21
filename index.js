const mime = require('mime-types');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const puppeteer = require('puppeteer');
const { PDFParse } = require('pdf-parse');
const { createWorker } = require('tesseract.js');
const { fromBuffer } = require('pdf2pic');

const app = express();
const PORT = process.env.PORT || 2001;

// Carpeta temporal para archivos adjuntos
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const upload = multer({
    storage: multer.diskStorage({
        destination: UPLOAD_DIR,
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        }
    })
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// URL destino del webhook (configurable por variable de entorno)
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:5678/webhook/my-n8n';

// ── Helper: envía un POST JSON a la webhook URL ──────────────────
function fireWebhook(payload) {
    if (!WEBHOOK_URL) return;
    try {
        const body = JSON.stringify(payload);
        const url = new URL(WEBHOOK_URL);
        const target = `${url.protocol}//${url.host}${url.pathname}${url.search}`;
        const lib = url.protocol === 'https:' ? https : http;
        console.log(`📡 Enviando webhook a: ${target}`);
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
            console.log(`🔔 Webhook respuesta ${res.statusCode} desde ${target}`);
        });
        req.on('error', err => console.error(`❌ Webhook error a ${target}:`, err.message));
        req.write(body);
        req.end();
    } catch (err) {
        console.error(`❌ Webhook URL inválida (${WEBHOOK_URL}):`, err.message);
    }
}

// Ruta del navegador
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

const CACHE_DIR = path.join(__dirname, '.wwebjs_cache');
const chromePath = getChromePath();
if (chromePath) {
    console.log(`🔧 executablePath: ${chromePath}`);
} else {
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
    clientReady = false;
    const authDir = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    console.log('🗑️  Sesión borrada. Saliendo para que PM2 reinicie...');
    process.exit(1);
});

client.on('ready', () => {
    clientReady = true;
    latestQr = null;
    console.log('✅ WhatsApp listo. Servidor HTTP escuchando en :' + PORT);
});

client.on('disconnected', reason => {
    clientReady = false;
    console.warn('⚠️  WhatsApp desconectado:', reason);
    console.log('🔄 Reconectando con reintentos...');
    setTimeout(() => initializeWithRetry(), 5000);
});

const MAX_INIT_RETRIES = 5;
const MAX_INIT_DELAY_MS = 30000;
let initRetries = 0;
let isInitializing = false;

function cleanLockFiles() {
    ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'].forEach(f => {
        const p = path.join(SESSION_DIR, f);
        if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`🔓 Eliminado: ${f}`); }
    });
}

async function initializeWithRetry() {
    if (isInitializing) return;
    isInitializing = true;
    initRetries = 0;

    while (initRetries < MAX_INIT_RETRIES) {
        try {
            initRetries++;
            console.log(`🔄 Iniciando cliente WhatsApp... (intento ${initRetries}/${MAX_INIT_RETRIES})`);
            cleanLockFiles();
            await client.initialize();
            isInitializing = false;
            return;
        } catch (err) {
            console.error(`💥 Error al inicializar WhatsApp (intento ${initRetries}):`, err.message);
            if (initRetries < MAX_INIT_RETRIES) {
                const delay = Math.min(initRetries * 10000, MAX_INIT_DELAY_MS);
                console.log(`⏳ Reintentando en ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                console.error(err.stack);
                console.error('\n👉 Posibles causas:');
                console.error('   1. Chrome/Chromium no funcional o incompatible');
                console.error('   2. Sesión corrupta → borra la carpeta .wwebjs_auth y reinicia');
                console.error('   3. Sin memoria suficiente → revisa con: free -h (Linux) o Task Manager (Windows)');
                console.error('\n💀 Agotados todos los reintentos. Saliendo para que PM2 reinicie el proceso...');
                process.exit(1);
            }
        }
    }
}

initializeWithRetry();

client.on('message', async msg => {
    try {
        const fromRaw = msg.from;
        const phoneNumber = fromRaw.replace(/@.*$/, '');

        const payload = {
            event: 'message_received',
            timestamp: Date.now(),
            from: fromRaw,
            phoneNumber,
            to: msg.to,
            body: msg.body,
            type: msg.type,
            hasMedia: msg.hasMedia,
            isGroup: fromRaw.endsWith('@g.us'),
            id: msg.id._serialized
        };

        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if (media) {
                    payload.media = {
                        mimetype: media.mimetype,
                        filename: media.filename || null,
                        data: media.data
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

async function shutdown() {
    console.log('\n🛑 Cerrando WhatsApp client...');
    try { await client.destroy(); } catch (_) {}
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Helper ───────────────────────────────────────────────────────
async function resolveChatId(input) {
    const s = String(input).trim();
    if (s.includes('@')) return s;
    const digits = s.replace(/\D/g, '');
    const resolved = await client.getNumberId(digits);
    if (!resolved) throw Object.assign(new Error(`Número no encontrado en WhatsApp: ${input}`), { status: 404 });
    return resolved._serialized;
}

// ── Helper interno: extrae texto de un Buffer PDF ────────────────
async function extractTextFromBuffer(fileBuffer) {
    let extractedText = '';
    let totalPages = 0;

    // Intento 1: texto nativo con PDFParse v2
    try {
        const parser = new PDFParse();
        const parsed = await parser.parse(fileBuffer);

        // pdf-parse v2 puede devolver texto en parsed.text o en parsed.pages[]
        if (parsed.text && parsed.text.trim().length > 0) {
            extractedText = parsed.text.trim();
        } else if (Array.isArray(parsed.pages) && parsed.pages.length > 0) {
            extractedText = parsed.pages.map(p => p.text || '').join('\n').trim();
        }

        totalPages = parsed.numpages
            || (Array.isArray(parsed.pages) ? parsed.pages.length : 0)
            || 1;

        console.log(`📄 PDF leído: ${totalPages} página(s), ${extractedText.length} caracteres extraídos`);
    } catch (parseErr) {
        console.error('⚠️  Error en PDFParse:', parseErr.message);
    }

    if (extractedText.length > 20) {
        return { method: 'text', pages: totalPages, text: extractedText };
    }

    // Intento 2: OCR (PDF escaneado o sin texto)
    console.log('⚠️  Sin texto nativo suficiente, aplicando OCR...');

    const converter = fromBuffer(fileBuffer, {
        density: 200,
        format: 'png',
        width: 1654,
        height: 2339,
        saveFilename: `ocr_${Date.now()}`,
        savePath: UPLOAD_DIR
    });

    const pages = totalPages || 1;
    const worker = await createWorker('spa+eng');
    let fullText = '';

    for (let i = 1; i <= pages; i++) {
        try {
            const pageResult = await converter(i, { responseType: 'buffer' });
            const { data: { text } } = await worker.recognize(pageResult.buffer);
            fullText += `\n--- Página ${i} ---\n${text}`;
            if (pageResult.path && fs.existsSync(pageResult.path)) {
                fs.unlink(pageResult.path, () => {});
            }
        } catch (pageErr) {
            console.error(`⚠️  Error en OCR página ${i}:`, pageErr.message);
        }
    }

    await worker.terminate();
    return { method: 'ocr', pages, text: fullText.trim() };
}

// ── Rutas HTTP ───────────────────────────────────────────────────

/**
 * GET /status
 */
app.get('/status', (req, res) => {
    res.json({ ready: clientReady });
});

/**
 * GET /webhook
 */
app.get('/webhook', (req, res) => {
    res.json({ webhookUrl: WEBHOOK_URL || null });
});

/**
 * POST /send
 * Body JSON: { "number": "584140000000", "message": "Hola!" }
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
 * Form-data: number, message (opcional), file
 */
app.post('/send-file', upload.single('file'), async (req, res) => {
    if (!clientReady) return res.status(503).json({ error: 'WhatsApp no está listo aún.' });

    const { number, message } = req.body;
    if (!number || !req.file) return res.status(400).json({ error: 'Faltan campos: number, file' });

    const filePath = path.join(UPLOAD_DIR, req.file.filename);

    try {
        const chatId = await resolveChatId(number);

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
        fs.unlink(filePath, () => {});
    }
});

/**
 * POST /html-to-pdf
 * Body JSON: { "html": "<html>...</html>", "filename": "doc.pdf" }
 */
app.post('/html-to-pdf', async (req, res) => {
    const { html, filename = 'documento.pdf' } = req.body;
    if (!html) return res.status(400).json({ error: 'Falta el campo html' });

    let browser;
    try {
        browser = await puppeteer.launch({
            ...(chromePath ? { executablePath: chromePath } : {}),
            headless: true,
            args: puppeteerArgs
        });

        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });

        const pdfBuffer = await page.pdf({
            format: 'A4',
            margin: { top: '24px', bottom: '24px', left: '24px', right: '24px' },
            printBackground: true
        });

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': pdfBuffer.length
        });
        res.send(pdfBuffer);

    } catch (err) {
        console.error('❌ Error generando PDF:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

/**
 * POST /extract-pdf
 * Form-data: file (PDF binario)
 * Respuesta: { success, method: "text"|"ocr", pages, text }
 */
app.post('/extract-pdf', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo PDF (campo: file)' });

    const filePath = path.join(UPLOAD_DIR, req.file.filename);

    try {
        const fileBuffer = fs.readFileSync(filePath);
        const result = await extractTextFromBuffer(fileBuffer);
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('❌ Error extrayendo PDF:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        fs.unlink(filePath, () => {});
    }
});

/**
 * POST /extract-pdf-base64
 * Body JSON: { "data": "<base64>", "mimeType": "application/pdf" }
 * Respuesta: { success, method: "text"|"ocr", pages, text }
 */
app.post('/extract-pdf-base64', async (req, res) => {
    const { data, mimeType } = req.body;

    if (!data) return res.status(400).json({ error: 'Falta el campo data (base64 del PDF)' });
    if (mimeType && !mimeType.includes('pdf')) {
        return res.status(400).json({ error: 'El archivo no parece ser un PDF' });
    }

    try {
        const fileBuffer = Buffer.from(data, 'base64');
        const result = await extractTextFromBuffer(fileBuffer);
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('❌ Error extrayendo PDF base64:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Arranque HTTP ────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 Servidor HTTP en http://localhost:${PORT}`);
    console.log('   Esperando que WhatsApp esté listo...');
});