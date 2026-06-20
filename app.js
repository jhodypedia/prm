import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import pino from 'pino';
import axios from 'axios';
import QRCode from 'qrcode';
import crypto from 'crypto';
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    delay
} from 'baileys';

// ============================================================
// LOGGER — ASCII only untuk Windows terminal (no emoji di log)
// ============================================================
let logger;
try {
    const { createRequire } = await import('module');
    const req = createRequire(import.meta.url);
    req.resolve('pino-pretty');
    logger = pino({
        level: process.env.LOG_LEVEL || 'info',
        transport: { target: 'pino-pretty', options: { colorize: true } }
    });
} catch {
    logger = pino({ level: process.env.LOG_LEVEL || 'info' });
}

// ============================================================
// APP INIT
// ============================================================
const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server);
app.set('view engine', 'ejs');
app.use(express.static('public'));

// ============================================================
// GLOBAL STATE
// ============================================================
let sock           = null;
let isShuttingDown = false;   // flag agar reconnect berhenti saat shutdown
let isAiActive     = true;
let storeName      = process.env.STORE_NAME || 'Pansa Group';
const recentChats  = [];

const IS_TEST_MODE      = process.env.IS_TEST_MODE === 'true';
const PRICE_MARKUP      = parseInt(process.env.MARKUP_UNTUNG) || 2000;
const PREMIFY_BASE_URL  = 'https://premify.store/api/v1';
const PREMIFY_HEADERS   = { 'Content-Type': 'application/json' };
const OPENROUTER_BASE   = 'https://openrouter.ai/api/v1';

// ============================================================
// IN-MEMORY STORES + AUTO CLEANUP
// ============================================================
const processedMessages = new Map(); // msgId  -> timestamp
const userSessions      = new Map(); // phone  -> { history[], lastActive }
const userRateLimits    = new Map(); // phone  -> { count, windowStart }
const messageQueue      = new Map(); // jid    -> Promise chain

const CLEANUP_INTERVAL  = 10 * 60 * 1000;
const MSG_TTL           = 30 * 60 * 1000;
const SESSION_TTL       = 2  * 60 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of processedMessages) {
        if (now - ts > MSG_TTL) processedMessages.delete(id);
    }
    for (const [phone, s] of userSessions) {
        if (now - s.lastActive > SESSION_TTL) {
            userSessions.delete(phone);
            logger.info(`[SESSION] sesi ${phone} expired`);
        }
    }
    for (const [phone, rl] of userRateLimits) {
        if (now - rl.windowStart > 60_000) userRateLimits.delete(phone);
    }
}, CLEANUP_INTERVAL);

// ============================================================
// RATE LIMITER
// ============================================================
const RATE_LIMIT_MAX    = parseInt(process.env.RATE_LIMIT_MAX) || 10;
const RATE_LIMIT_WINDOW = 60_000;

function isRateLimited(phone) {
    const now = Date.now();
    const rl  = userRateLimits.get(phone) || { count: 0, windowStart: now };
    if (now - rl.windowStart > RATE_LIMIT_WINDOW) {
        rl.count = 1; rl.windowStart = now;
    } else {
        rl.count++;
    }
    userRateLimits.set(phone, rl);
    return rl.count > RATE_LIMIT_MAX;
}

// ============================================================
// WEBHOOK SIGNATURE VALIDATOR
// ============================================================
function validatePakasirSignature(req) {
    const secret = process.env.PAKASIR_WEBHOOK_SECRET;
    if (!secret) return true;
    const sig      = req.headers['x-pakasir-signature'] || req.headers['x-signature'];
    if (!sig) return false;
    const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
    try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

// ============================================================
// OPENROUTER — MULTI MODEL FALLBACK
// ============================================================
const AI_MODELS = [
    'meta-llama/llama-3.3-70b-instruct',
    'google/gemini-2.0-flash-001',
    'mistralai/mistral-nemo',
    'anthropic/claude-3-haiku',
];

async function callOpenRouter(messages, tools = [], systemPrompt = '', modelIndex = 0) {
    if (modelIndex >= AI_MODELS.length) throw new Error('Semua model AI tidak tersedia.');
    const model = AI_MODELS[modelIndex];
    logger.info(`[AI] model: ${model}`);

    try {
        const body = {
            model,
            messages: [{ role: 'system', content: systemPrompt }, ...messages],
            temperature: 0.7,
            max_tokens: 1024,
        };
        if (tools.length) { body.tools = tools; body.tool_choice = 'auto'; }

        const res = await axios.post(`${OPENROUTER_BASE}/chat/completions`, body, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type':  'application/json',
                'HTTP-Referer':  process.env.APP_URL || 'http://localhost:3000',
                'X-Title':       storeName,
            },
            timeout: 30_000,
        });
        return { model, data: res.data };

    } catch (err) {
        const status     = err?.response?.status;
        const retryable  = [429, 502, 503].includes(status);
        logger.warn(`[AI] ${model} gagal (${status}). ${retryable ? 'fallback...' : 'error permanen'}`);
        if (retryable) { await delay(1200); return callOpenRouter(messages, tools, systemPrompt, modelIndex + 1); }
        throw err;
    }
}

// ============================================================
// HUMAN-LIKE TYPING DELAY
// Simulasi delay sesuai panjang teks, biar keliatan ngetik beneran
// ============================================================
function humanDelay(text = '') {
    // rata2 orang ngetik 40-60 karakter/detik, tapi CS online lebih slow
    const base = Math.min(text.length * 35, 4000); // max 4 detik
    const jitter = Math.random() * 600;             // variasi natural
    return Math.floor(base + jitter);
}

// ============================================================
// PREMIFY API
// ============================================================
async function checkPremifyBalance() {
    try {
        const res = await axios.post(`${PREMIFY_BASE_URL}/balance`,
            { api_key: process.env.PREMIFY_API_KEY },
            { headers: PREMIFY_HEADERS }
        );
        if (res.data?.success) {
            const raw = res.data.data.balance || res.data.data.current_balance;
            const fmt = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(raw);
            let note = IS_TEST_MODE ? '\n[MODE SANDBOX AKTIF]' : '';
            return `*SALDO SERVER*\n\nSaldo: *${fmt}*\nStatus: Terhubung${note}`;
        }
        return 'Gagal ambil data saldo server.';
    } catch { return 'Gagal kontak server Premify.'; }
}

async function fetchPremifyProducts(searchKeyword = '') {
    logger.info(`[PREMIFY] cari produk: "${searchKeyword}"`);
    try {
        const res = await axios.post(`${PREMIFY_BASE_URL}/products`,
            { api_key: process.env.PREMIFY_API_KEY },
            { headers: PREMIFY_HEADERS, timeout: 15_000 }
        );
        if (res.data?.success !== true) return [{ status: 'ERROR', keterangan: 'Gagal load produk.' }];

        const products    = res.data.data || [];
        const searchLower = searchKeyword.toLowerCase().trim();
        const firstWord   = searchLower.split(' ')[0];
        const results     = [];

        for (const p of products) {
            const nameLow = p.name.toLowerCase();
            const match   = !searchKeyword
                || nameLow.includes(searchLower)
                || searchLower.includes(nameLow)
                || (firstWord && nameLow.includes(firstWord));
            if (!match || !p.variants) continue;

            for (const v of p.variants) {
                results.push({
                    product_name: p.name,
                    category:     p.category,
                    variant_id:   v.id,
                    variant_name: v.name,
                    price:        v.price + PRICE_MARKUP,
                    duration:     v.duration,
                    type:         v.type,
                    stock:        v.stock,
                });
            }
        }

        if (!results.length) return [{ status: 'KOSONG', keterangan: `Produk "${searchKeyword}" ga ada / habis.` }];
        return results.slice(0, 15);

    } catch (e) {
        logger.error(`[PREMIFY] fetchProducts: ${e.message}`);
        return [{ status: 'ERROR', keterangan: 'Gangguan jaringan ke supplier.' }];
    }
}

async function fetchPremifyTransactions() {
    try {
        const res = await axios.post(`${PREMIFY_BASE_URL}/transactions`,
            { api_key: process.env.PREMIFY_API_KEY },
            { headers: PREMIFY_HEADERS, timeout: 10_000 }
        );
        return res.data?.success ? res.data.data : [];
    } catch { return []; }
}

async function createPremifyOrder(variantId, targetInput) {
    try {
        const payload = {
            api_key:    process.env.PREMIFY_API_KEY,
            variant_id: variantId,
            quantity:   1,
            is_test:    IS_TEST_MODE,
        };
        if (targetInput?.includes('@')) payload.email_invite = targetInput.trim();

        const res = await axios.post(`${PREMIFY_BASE_URL}/order`, payload,
            { headers: PREMIFY_HEADERS, timeout: 15_000 }
        );
        if (res.data?.success) return { sukses: true, order_id: res.data.data.order_id, status: res.data.data.status };
        return { sukses: false, pesan: res.data?.message || 'Order ditolak.' };
    } catch (e) {
        logger.error(`[PREMIFY] createOrder: ${e.message}`);
        return { sukses: false, pesan: 'Gangguan checkout ke supplier.' };
    }
}

// ============================================================
// PAKASIR GATEWAY — safe order ID encoding
// ============================================================
function encodeOrderId(variantId, phone) {
    return `INV-${Date.now()}-${Buffer.from(`${variantId}|${phone}`).toString('base64url')}`;
}

function decodeOrderId(orderId) {
    try {
        const parts = orderId.split('-');
        if (parts.length < 3) return null;
        const [variantId, phone] = Buffer.from(parts[2], 'base64url').toString().split('|');
        if (!variantId || !phone) return null;
        return { variantId, phone };
    } catch { return null; }
}

async function createPakasirInvoice(variantId, productName, variantName, finalPrice, customerPhone) {
    try {
        logger.info(`[PAKASIR] buat invoice varian=${variantId} harga=${finalPrice}`);
        const orderId = encodeOrderId(variantId, customerPhone);

        const res = await axios.post('https://app.pakasir.com/api/transactioncreate/qris', {
            project:  process.env.PAKASIR_PROJECT_SLUG,
            order_id: orderId,
            amount:   Math.round(Number(finalPrice)),
            api_key:  process.env.PAKASIR_API_KEY,
            is_test:  IS_TEST_MODE,
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 });

        logger.info(`[PAKASIR] response (HTTP ${res.status}): ${JSON.stringify(res.data)}`);

        const d = res.data;
        let qrisString = d.payment || d.payment_number || d.data?.payment || d.data?.payment_number;
        const invoiceUrl = `https://app.pakasir.com/pay/${process.env.PAKASIR_PROJECT_SLUG}/${finalPrice}?order_id=${orderId}&qris_only=1`;

        if (typeof qrisString !== 'string' || !qrisString.trim()) qrisString = invoiceUrl;

        return { sukses: true, invoice_url: invoiceUrl, reference_id: orderId, price: finalPrice, qris_string: qrisString };

    } catch (err) {
        const detail  = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
        const status  = err?.response?.status || 'NO_STATUS';
        logger.error(`[PAKASIR] createInvoice error (HTTP ${status}): ${detail}`);
        return { sukses: false, pesan: `Gagal buat tagihan: ${detail}` };
    }
}

// ============================================================
// AI TOOLS DEFINITION
// ============================================================
const AI_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'fetchPremifyProducts',
            description: 'Cari produk, harga, stok dari katalog. Pakai saat customer nanya harga atau mau beli sesuatu.',
            parameters: {
                type: 'object',
                properties: {
                    searchKeyword: { type: 'string', description: '1 kata kunci utama, contoh: netflix, spotify, dll' }
                },
                required: ['searchKeyword'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'createPakasirInvoice',
            description: 'Buat invoice QRIS. Panggil HANYA kalau customer udah bilang mau beli (oke/gas/jadi/ya/deal dll). Jangan panggil sebelum customer confirm.',
            parameters: {
                type: 'object',
                properties: {
                    variantId:   { type: 'string', description: 'ID varian dari hasil fetchPremifyProducts' },
                    productName: { type: 'string' },
                    variantName: { type: 'string' },
                    finalPrice:  { type: 'number', description: 'Harga jual sudah include markup' },
                },
                required: ['variantId', 'productName', 'variantName', 'finalPrice'],
            },
        },
    },
];

// ============================================================
// SYSTEM PROMPT — gaya CS anak zaman sekarang, casual & real
// ============================================================
function buildSystemPrompt(senderName, storeName) {
    const sandboxNote = IS_TEST_MODE ? '\n\n[SISTEM BERJALAN DI MODE SANDBOX/TEST]' : '';

    return `Lo adalah CS dari toko digital "${storeName}". Nama customer: ${senderName}.

GAYA BAHASA LO:
- Casual, friendly, kayak chat sama temen tapi tetep sopan
- Pake "kak" buat sapa, tapi sesekali boleh pake nama langsung kalau udah kenal
- Boleh pake singkatan wajar: "yg", "dgn", "utk", "krn", "aja", "sih", "nih", "dong"
- Boleh pake "wkwk", "hehe", "btw", "fyi", "gasss" tapi jangan lebay
- Kalimat pendek-pendek, ga perlu panjang lebar
- DILARANG pake bahasa formal kaku atau template CS jadul
- JANGAN pake emoji berlebihan, maksimal 1-2 per pesan, sisipkan natural aja
- Kalau customer nanya hal receh/lucu, boleh bales santai
- Kalau ada error/kosong, jangan panik, bilang dengan santai

ATURAN BISNIS:
1. Selalu cek produk dulu (fetchPremifyProducts) sebelum sebut harga
2. Kalau customer bilang oke/gas/deal/jadi/ya/mau/beli → langsung bikin invoice (createPakasirInvoice)
3. Setelah invoice sukses → bilang QRIS dikirim di bawah, suruh scan
4. Produk ga ada → minta maaf santai, tawarkan alternatif kalau ada
5. Error sistem → bilang santai, minta coba lagi bentar
6. Jawab to the point, ga perlu basa-basi panjang
${sandboxNote}`;
}

// ============================================================
// AI AGENT — agentic loop
// ============================================================
async function getAIResponse(userMessage, senderName, storeName, senderPhone) {
    try {
        if (!userSessions.has(senderPhone)) {
            userSessions.set(senderPhone, { history: [], lastActive: Date.now() });
        }
        const session      = userSessions.get(senderPhone);
        session.lastActive = Date.now();
        const history      = session.history;

        history.push({ role: 'user', content: userMessage });
        while (history.length > 14) history.shift();

        const systemPrompt      = buildSystemPrompt(senderName, storeName);
        let generatedQris       = null;
        let generatedInvoiceUrl = null;
        let loopCount           = 0;
        const MAX_LOOPS         = 5;

        while (loopCount < MAX_LOOPS) {
            loopCount++;
            const { data } = await callOpenRouter(history, AI_TOOLS, systemPrompt);
            const choice   = data.choices?.[0];
            if (!choice) throw new Error('Respons AI kosong');

            const msg = choice.message;

            // Selesai — tidak ada tool call
            if (!msg.tool_calls?.length) {
                history.push({ role: 'assistant', content: msg.content || '' });
                return {
                    text:       msg.content || 'sorry kak, ada gangguan dikit. coba kirim lagi ya 🙏',
                    qrisString: generatedQris,
                    invoiceUrl: generatedInvoiceUrl,
                };
            }

            // Ada tool call
            history.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });

            for (const call of msg.tool_calls) {
                let args = {};
                try { args = JSON.parse(call.function.arguments || '{}'); } catch {}

                let result;
                if (call.function.name === 'fetchPremifyProducts') {
                    result = await fetchPremifyProducts(args.searchKeyword || '');

                } else if (call.function.name === 'createPakasirInvoice') {
                    result = await createPakasirInvoice(args.variantId, args.productName, args.variantName, args.finalPrice, senderPhone);
                    if (result.sukses && result.qris_string) {
                        generatedQris       = result.qris_string;
                        generatedInvoiceUrl = result.invoice_url;
                    }
                } else {
                    result = { error: 'fungsi tidak dikenal' };
                }

                history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
            }
        }

        // Max loop tercapai — paksa teks akhir
        logger.warn(`[AI] loop limit (${MAX_LOOPS}x), paksa respons`);
        const { data: fd } = await callOpenRouter(
            [...history, { role: 'user', content: 'Kasih jawaban teks aja sekarang ya, ga perlu tool lagi.' }],
            [],
            systemPrompt
        );
        const finalText = fd.choices?.[0]?.message?.content || 'bentar kak sistem lagi rame, coba lagi ya hehe';
        history.push({ role: 'assistant', content: finalText });
        return { text: finalText, qrisString: generatedQris, invoiceUrl: generatedInvoiceUrl };

    } catch (err) {
        logger.error(`[AI] crash: ${err.message}`);
        return { text: `aduh sori kak ${senderName} sistemnya lagi ngadat bentar, coba lagi ya 🙏` };
    }
}

// ============================================================
// MESSAGE QUEUE — serialisasi per JID
// ============================================================
function enqueueMessage(jid, handler) {
    const prev = messageQueue.get(jid) || Promise.resolve();
    const next = prev.then(handler).catch(e => logger.error(`[QUEUE] ${jid}: ${e.message}`));
    messageQueue.set(jid, next);
    return next;
}

// ============================================================
// WEBHOOK ROUTES
// ============================================================
app.post('/webhook/pakasir', async (req, res) => {
    try {
        if (!validatePakasirSignature(req)) {
            logger.warn('[WEBHOOK] signature Pakasir invalid');
            return res.status(401).json({ success: false });
        }

        const payload = req.body;
        logger.info(`[WEBHOOK/PAKASIR] ${JSON.stringify(payload)}`);

        if (payload.status === 'completed') {
            const decoded = decodeOrderId(payload.order_id);
            if (!decoded) {
                logger.error(`[WEBHOOK/PAKASIR] gagal decode order_id: ${payload.order_id}`);
                return res.status(200).json({ success: true });
            }

            const { variantId, phone } = decoded;
            const premResult           = await createPremifyOrder(variantId, phone);
            const jid                  = `${phone}@s.whatsapp.net`;
            const amount               = Number(payload.amount || 0).toLocaleString('id-ID');

            if (sock?.user) {
                if (premResult.sukses) {
                    let msg = `pembayaran Rp ${amount} udah masuk kak! lagi diproses otomatis nih, tunggu bentar ya`;
                    if (IS_TEST_MODE) msg += `\n_(sandbox mode)_`;
                    await sock.sendMessage(jid, { text: msg });
                } else {
                    await sock.sendMessage(jid, { text: `bayaran udah masuk kak, tapi server supplier lagi rame. pesanan bakal diproses manual max 10 menit ya, sori ya kak 🙏` });
                }
            }
        }
        return res.status(200).json({ success: true });
    } catch (e) {
        logger.error(`[WEBHOOK/PAKASIR] ${e.message}`);
        return res.status(200).send('OK');
    }
});

app.post('/webhook/premify', async (req, res) => {
    try {
        const payload = req.body;
        logger.info(`[WEBHOOK/PREMIFY] event: ${payload.event}`);
        fetchPremifyTransactions().then(trx => io.emit('transactions-data', trx));

        if (!payload.data || !payload.event) return res.status(200).send('OK');

        const data  = payload.data;
        const phone = data.customer?.whatsapp || data.email_invite;
        if (!phone) return res.status(200).send('OK');

        const jid = `${phone}@s.whatsapp.net`;

        if (payload.event === 'order.completed') {
            let credsText = '';
            if (Array.isArray(data.account_details)) {
                data.account_details.forEach(acc => {
                    credsText += `\n*${acc.product || 'Produk'}*\n`;
                    acc.details?.forEach(det => {
                        det.credentials?.forEach(c => {
                            credsText += `• ${c.label}: \`${c.value}\`\n`;
                        });
                    });
                });
            } else {
                credsText = 'cek email kak buat detail akunnya';
            }

            const msg = `gasss pesanan selesai kak! ini data loginnya:\n${credsText}\nmakasih udah belanja di ${storeName} yaa, kalau ada butuh lagi chat sini aja`;
            if (sock?.user) await sock.sendMessage(jid, { text: msg });
        }
        return res.status(200).json({ success: true });
    } catch (e) {
        logger.error(`[WEBHOOK/PREMIFY] ${e.message}`);
        return res.status(200).send('OK');
    }
});

// ============================================================
// WHATSAPP ENGINE — Baileys
// ============================================================
async function initWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_store');
    const { version }          = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth:                  state,
        printQRInTerminal:     true,
        logger:                pino({ level: 'silent' }),
        browser:               ['Ubuntu', 'Chrome', '20.0.04'],
        markOnlineOnConnect:   true,
        generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const code          = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut   = code === DisconnectReason.loggedOut;

            logger.warn(`[WA] koneksi putus (code: ${code})`);

            if (isLoggedOut) {
                logger.error('[WA] session logout. hapus folder baileys_auth_store lalu restart.');
                io.emit('status', 'Session berakhir. Hapus folder baileys_auth_store dan restart.');
                return; // jangan reconnect
            }

            // Jika sedang proses shutdown, skip reconnect
            if (isShuttingDown) {
                logger.info('[WA] shutdown mode, skip reconnect');
                return;
            }

            logger.info('[WA] reconnect dalam 3 detik...');
            await delay(3000);
            initWhatsApp();

        } else if (connection === 'open') {
            logger.info(`[WA] terhubung sebagai ${sock.user?.name || storeName}`);
            io.emit('status', `Terhubung sebagai: ${storeName}`);
            io.emit('ready', true);
            io.emit('store-name', sock.user?.name || storeName);
            fetchPremifyTransactions().then(trx => io.emit('transactions-data', trx));
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            // Deduplikasi
            if (msg.key?.id) {
                if (processedMessages.has(msg.key.id)) continue;
                processedMessages.set(msg.key.id, Date.now());
            }

            if (msg.key.fromMe) continue;
            if (msg.key.remoteJid?.endsWith('@g.us')) continue;
            if (!msg.message) continue;

            const senderJid   = msg.key.remoteJid;
            const senderPhone = senderJid.split('@')[0];
            const senderName  = msg.pushName || 'Kak';
            const body        = msg.message.conversation
                             || msg.message.extendedTextMessage?.text
                             || '';

            if (!body.trim()) continue;

            // Perintah admin
            if (senderPhone === process.env.ADMIN_NUMBER) {
                if (body.trim() === '/balance') {
                    const info = await checkPremifyBalance();
                    await sock.sendMessage(senderJid, { text: info }, { quoted: msg });
                    continue;
                }
                if (body.trim() === '/clearsession') {
                    userSessions.clear();
                    await sock.sendMessage(senderJid, { text: 'semua sesi user udah dibersihin' }, { quoted: msg });
                    continue;
                }
                if (body.trim() === '/ping') {
                    await sock.sendMessage(senderJid, { text: `bot aktif, uptime: ${Math.floor(process.uptime())}s` }, { quoted: msg });
                    continue;
                }
            }

            // Log ke dashboard
            recentChats.push({
                jid: senderJid, name: senderName,
                lastMessage: body.slice(0, 60),
                timestamp:   new Date().toLocaleTimeString('id-ID'),
            });
            if (recentChats.length > 50) recentChats.shift();
            io.emit('chats-data', recentChats);

            if (!isAiActive) continue;

            enqueueMessage(senderJid, async () => {
                if (isRateLimited(senderPhone)) {
                    await sock.sendMessage(senderJid, {
                        text: `bentar kak, pesannya kelamaan nih hehe. coba lagi 1 menit ya`
                    });
                    return;
                }

                // Mulai typing indicator
                await sock.sendPresenceUpdate('composing', senderJid);

                const aiReply = await getAIResponse(body, senderName, storeName, senderPhone);

                // Delay manusiawi sesuai panjang teks
                await delay(humanDelay(aiReply.text));
                await sock.sendPresenceUpdate('paused', senderJid);

                // Kirim teks reply
                await sock.sendMessage(senderJid, { text: aiReply.text }, { quoted: msg });

                // Kirim QRIS jika ada
                if (aiReply.qrisString) {
                    await delay(900);
                    try {
                        const buf = await QRCode.toBuffer(String(aiReply.qrisString), {
                            scale: 8, margin: 2,
                            color: { dark: '#000000', light: '#ffffff' },
                        });
                        await sock.sendMessage(senderJid, {
                            image:   buf,
                            caption: `nih kak QRISnya, scan pake m-banking atau e-wallet (Dana, OVO, Gopay dll)\n\nsetelah bayar pesanan langsung otomatis diproses ya, ga perlu konfirm lagi`
                        });
                    } catch (qrErr) {
                        logger.error(`[QR] gagal render: ${qrErr.message}`);
                        if (aiReply.invoiceUrl) {
                            await sock.sendMessage(senderJid, {
                                text: `sori kak gambar QRISnya gagal dimuat, ini link bayarnya aja ya:\n${aiReply.invoiceUrl}`
                            });
                        }
                    }
                }
            });
        }
    });

    return sock;
}

// ============================================================
// SOCKET.IO DASHBOARD
// ============================================================
io.on('connection', (socket) => {
    logger.info(`[DASHBOARD] client: ${socket.id}`);
    socket.emit('chats-data', recentChats);

    socket.on('request-pairing', async (phone) => {
        try {
            const code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''));
            socket.emit('pairing-code', code);
        } catch { socket.emit('pairing-code', 'ERROR'); }
    });

    socket.on('toggle-ai', (status) => {
        isAiActive = Boolean(status);
        logger.info(`[DASHBOARD] AI = ${isAiActive}`);
        io.emit('ai-status', isAiActive);
    });

    socket.on('change-store-name', (name) => {
        if (name?.trim()) { storeName = name.trim(); io.emit('store-name-updated', storeName); }
    });

    socket.on('refresh-transactions', async () => {
        const trx = await fetchPremifyTransactions();
        socket.emit('transactions-data', trx);
    });

    socket.on('clear-sessions', () => {
        userSessions.clear();
        socket.emit('sessions-cleared');
    });

    socket.on('disconnect', () => logger.info(`[DASHBOARD] disconnect: ${socket.id}`));
});

// ============================================================
// MAIN
// ============================================================
async function main() {
    logger.info(`[BOOT] starting ${storeName}...`);
    logger.info(`[BOOT] mode: ${IS_TEST_MODE ? 'SANDBOX/TEST' : 'PRODUCTION'}`);
    logger.info(`[BOOT] AI: OpenRouter | model utama: ${AI_MODELS[0]}`);

    await initWhatsApp();

    app.get('/', (req, res) => res.render('index'));
    app.get('/health', (req, res) => res.json({
        status:    'ok',
        wa:        sock?.user ? 'connected' : 'disconnected',
        aiActive:  isAiActive,
        storeName,
        mode:      IS_TEST_MODE ? 'sandbox' : 'production',
        uptime:    Math.floor(process.uptime()),
    }));

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => logger.info(`[BOOT] server ready at http://localhost:${PORT}`));
}

// ============================================================
// GRACEFUL SHUTDOWN — disconnect tanpa logout session WA
// ============================================================
let shutdownCalled = false;

async function gracefulShutdown(signal) {
    if (shutdownCalled) return; // cegah multiple calls
    shutdownCalled = true;
    isShuttingDown = true;

    logger.info(`[SHUTDOWN] received ${signal}, closing...`);

    // Tutup koneksi WA tanpa logout (cukup end(), bukan logout())
    // logout() = cabut session permanen → harus scan/pairing ulang
    // end()    = putus koneksi saja → sesi tetap tersimpan, bisa reconnect
    if (sock) {
        try {
            sock.end(undefined); // undefined = tidak kirim pesan apapun ke WA server
            logger.info('[SHUTDOWN] WA connection closed (session preserved)');
        } catch (e) {
            logger.warn(`[SHUTDOWN] sock.end error: ${e.message}`);
        }
    }

    server.close(() => {
        logger.info('[SHUTDOWN] HTTP server closed. bye!');
        process.exit(0);
    });

    // Force exit setelah 5 detik kalau masih hang
    setTimeout(() => {
        logger.warn('[SHUTDOWN] force exit after timeout');
        process.exit(0);
    }, 5000);
}

process.once('SIGINT',  () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

main().catch(e => {
    logger.fatal(`[BOOT] fatal: ${e.message}`);
    process.exit(1);
});
