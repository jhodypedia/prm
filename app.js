import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import pino from 'pino';
import axios from 'axios';
import QRCode from 'qrcode';
import crypto from 'crypto';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay } from 'baileys';
import Groq from 'groq-sdk';

import { initDB, pool } from './lib/db.js';
import { getSetting, setSetting } from './lib/settings.js';
import { createDompetXInvoice } from './lib/payment.js';

const logger = pino({
    level: 'info',
    transport: { target: 'pino-pretty', options: { colorize: true } }
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'prm-v3-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const server = http.createServer(app);
const io = new Server(server);
app.set('view engine', 'ejs');
app.use(express.static('public'));

// Auth Middleware
function isAuthenticated(req, res, next) {
    if (req.session.loggedIn) return next();
    res.redirect('/login');
}

function isSuperadmin(req, res, next) {
    if (req.session.role === 'superadmin') return next();
    res.status(403).send('Hanya Superadmin yang boleh akses');
}

// Global State
let sock = null;
let isAiActive = true;
let storeName = process.env.STORE_NAME || 'Pansa Group';
let waStatus = { connected: false, name: '' };
let currentQR = null;

const IS_TEST_MODE = process.env.IS_TEST_MODE === 'true';
const PRICE_MARKUP = parseInt(process.env.MARKUP_UNTUNG) || 2000;

const processedMessages = new Map();
const userSessions = new Map();
const recentChats = [];

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ==================== AUTH ROUTES ====================
app.get('/login', (req, res) => {
    if (req.session.loggedIn) return res.redirect('/');
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.execute('SELECT * FROM admins WHERE username = ?', [username]);
        if (rows.length === 0) return res.render('login', { error: 'User tidak ditemukan' });

        const admin = rows[0];
        const match = await bcrypt.compare(password, admin.password_hash);
        if (!match) return res.render('login', { error: 'Password salah' });

        req.session.loggedIn = true;
        req.session.username = admin.username;
        req.session.role = admin.role;
        res.redirect('/');
    } catch (e) {
        res.render('login', { error: 'Terjadi kesalahan' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// ==================== DASHBOARD ====================
app.get('/', isAuthenticated, (req, res) => {
    res.render('index', { 
        username: req.session.username, 
        role: req.session.role 
    });
});

app.get('/settings', isAuthenticated, isSuperadmin, async (req, res) => {
    const settings = await getAllSettings();
    res.render('settings', { username: req.session.username, settings });
});

app.post('/settings', isAuthenticated, isSuperadmin, async (req, res) => {
    const { store_name, markup, groq_key, dompetx_key, premify_key } = req.body;
    if (store_name) await setSetting('STORE_NAME', store_name);
    if (markup) await setSetting('MARKUP_UNTUNG', markup);
    if (groq_key) await setSetting('GROQ_API_KEY', groq_key);
    if (dompetx_key) await setSetting('DOMPETX_API_KEY', dompetx_key);
    if (premify_key) await setSetting('PREMIFY_API_KEY', premify_key);
    res.redirect('/settings');
});

// ==================== API ====================
app.get('/api/products', isAuthenticated, async (req, res) => {
    const search = req.query.search || '';
    const products = await fetchPremifyProducts(search);
    res.json({ success: true, data: products });
});

app.get('/api/transactions', isAuthenticated, async (req, res) => {
    const [rows] = await pool.execute('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50');
    res.json({ success: true, data: rows });
});

// ==================== PREMIFY ====================
async function fetchPremifyProducts(searchKeyword = '') {
    try {
        const res = await axios.post(`${process.env.PREMIFY_BASE_URL}/products`, {
            api_key: process.env.PREMIFY_API_KEY
        });
        return res.data?.data || [];
    } catch (e) {
        logger.error(e.message);
        return [];
    }
}

// ==================== GROQ AI ====================
const AI_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'fetchPremifyProducts',
            description: 'Cari produk dari Premify',
            parameters: {
                type: 'object',
                properties: { searchKeyword: { type: 'string' } },
                required: ['searchKeyword']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'createDompetXInvoice',
            description: 'Buat invoice QRIS',
            parameters: {
                type: 'object',
                properties: {
                    variantId: { type: 'string' },
                    productName: { type: 'string' },
                    variantName: { type: 'string' },
                    finalPrice: { type: 'number' }
                },
                required: ['variantId', 'productName', 'variantName', 'finalPrice']
            }
        }
    }
];

async function callGroqAI(messages, systemPrompt) {
    const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.7,
        max_tokens: 2048,
        tools: AI_TOOLS,
        tool_choice: "auto"
    });
    return completion;
}

async function getAIResponse(userMessage, senderName, senderPhone) {
    try {
        const systemPrompt = `Lo adalah CS toko digital "${storeName}". Santai, ramah.`;
        const completion = await callGroqAI([{ role: 'user', content: userMessage }], systemPrompt);
        return { text: completion.choices[0].message.content };
    } catch (e) {
        return { text: "Maaf kak, sistem lagi sibuk." };
    }
}

// ==================== WHATSAPP ====================
async function initWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_store');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        if (qr) {
            currentQR = qr;
            io.emit('wa-qr', qr);
        }
        if (connection === 'open') {
            waStatus = { connected: true, name: sock.user?.name || 'Connected' };
            currentQR = null;
            io.emit('wa-status', waStatus);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        // Logic AI dan DompetX
        for (const msg of m.messages) {
            const body = msg.message.conversation || '';
            if (!body.trim()) continue;

            const senderJid = msg.key.remoteJid;
            const senderName = msg.pushName || 'Kak';
            const senderPhone = senderJid.split('@')[0];

            const aiReply = await getAIResponse(body, senderName, senderPhone);
            await sock.sendMessage(senderJid, { text: aiReply.text });
        }
    });
}

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
    socket.emit('wa-status', waStatus);
    if (currentQR) socket.emit('wa-qr', currentQR);
});

// ==================== MAIN ====================
async function main() {
    await initDB();
    await initWhatsApp();

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        logger.info(`🚀 PRM Bot v3 berjalan di http://localhost:${PORT}`);
    });
}

main().catch(e => logger.fatal(e));
