import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { GoogleGenAI, Type } from '@google/genai';
import pino from 'pino';
import axios from 'axios';
import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    delay
} from 'baileys';

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.set('view engine', 'ejs');
app.use(express.static('public'));

// ========================================================
// ⚙️ GLOBAL SETTINGS & TOGGLES
// ========================================================
let sock = null;
let isAiActive = true;
let storeName = "Pansa Group"; 
const recentChats = []; 

// 🔴 SAKELAR MODE TEST (SANDBOX) 🔴
const IS_TEST_MODE = true; 

// Cache untuk Anti-Spam (Mencegah Bot membalas 2x)
const processedMessages = new Set();

// 🧠 MEMORI AI (Menyimpan riwayat obrolan agar AI tidak amnesia)
const userSessions = new Map(); 

const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_store');
const { version } = await fetchLatestBaileysVersion();

const PREMIFY_BASE_URL = 'https://premify.store/api/v1';
const PREMIFY_HEADERS = { 'Content-Type': 'application/json' };

const PRICE_MARKUP = parseInt(process.env.MARKUP_UNTUNG) || 2000;

// ========================================================
// CORE FUNCTIONS (PREMIFY API + PAKASIR GATEWAY)
// ========================================================

async function checkPremifyBalance() {
    try {
        const response = await axios.post(`${PREMIFY_BASE_URL}/balance`, {
            api_key: process.env.PREMIFY_API_KEY
        }, { headers: PREMIFY_HEADERS });
        
        if (response.data && response.data.success === true) {
            const rawBalance = response.data.data.balance || response.data.data.current_balance;
            const currency = response.data.data.currency || "IDR";
            const formattedBalance = new Intl.NumberFormat('id-ID', { style: 'currency', currency: currency, minimumFractionDigits: 0 }).format(rawBalance);
            
            let statusText = `Terhubung Sempurna ✅`;
            if (IS_TEST_MODE) statusText += `\n⚠️ *(BERJALAN DALAM MODE TEST / SANDBOX)*`;

            return `💻 *SALDO SERVER API MODAL*\n\n• Sisa Saldo: *${formattedBalance}*\n• Status: ${statusText}`;
        }
        return "⚠️ Gagal mengambil data saldo server.";
    } catch (error) { 
        return "❌ Gagal mengontak server pusat Premify."; 
    }
}

async function fetchPremifyProducts(searchKeyword = '') {
    console.log(`\n[🔍 DEBUG API] AI mencari produk: "${searchKeyword}"`);

    try {
        const response = await axios.post(`${PREMIFY_BASE_URL}/products`, {
            api_key: process.env.PREMIFY_API_KEY
        }, { headers: PREMIFY_HEADERS });
        
        if (response.data && response.data.success === true) {
            const products = response.data.data || [];
            const flattenedVariants = [];
            
            products.forEach(product => {
                const prodNameLower = product.name.toLowerCase();
                const searchLower = searchKeyword.toLowerCase().trim();
                const firstWord = searchLower.split(' ')[0]; 

                const isMatch = !searchKeyword || 
                                prodNameLower.includes(searchLower) || 
                                searchLower.includes(prodNameLower) || 
                                (firstWord && prodNameLower.includes(firstWord));

                if (!isMatch) return;

                if (product.variants) {
                    product.variants.forEach(v => {
                        const hargaJualCustomer = v.price + PRICE_MARKUP;
                        flattenedVariants.push({
                            product_name: product.name,
                            category: product.category,
                            variant_id: v.id,
                            variant_name: v.name,
                            price: hargaJualCustomer, 
                            duration: v.duration,
                            type: v.type,
                            stock: v.stock
                        });
                    });
                }
            });

            if (flattenedVariants.length === 0) {
                return [{ 
                    status: "KOSONG", 
                    keterangan: `Produk dengan kata '${searchKeyword}' tidak ditemukan / habis.` 
                }];
            }
            return flattenedVariants.slice(0, 15);
        }
        return [{ status: "ERROR", keterangan: `Gagal memuat produk dari server.` }];
    } catch (error) { 
        return [{ status: "ERROR", keterangan: `Gangguan jaringan saat cek produk.` }]; 
    }
}

async function createPakasirInvoice(variantId, productName, variantName, finalPrice, customerWhatsapp) {
    try {
        console.log(`\n[💳 DEBUG API] AI membuat tagihan untuk varian ID: ${variantId}`);
        const orderId = `INV-${Date.now()}-${variantId}-${customerWhatsapp}`;
        
        const response = await axios.post('https://app.pakasir.com/api/transactioncreate/qris', {
            project: process.env.PAKASIR_PROJECT_SLUG,
            order_id: orderId,
            amount: finalPrice,
            api_key: process.env.PAKASIR_API_KEY,
            is_test: IS_TEST_MODE 
        }, { headers: { 'Content-Type': 'application/json' } });

        if (response.data && response.data.payment) {
            return {
                sukses: true,
                invoice_url: `https://app.pakasir.com/pay/${process.env.PAKASIR_PROJECT_SLUG}/${finalPrice}?order_id=${orderId}&qris_only=1`,
                reference_id: orderId,
                price: finalPrice
            };
        }
        return { sukses: false, pesan: "Gagal memproses QRIS Pakasir." };
    } catch (error) {
        return { sukses: false, pesan: "Gagal membuat tagihan pembayaran ke Pakasir." };
    }
}

async function createPremifyOrder(variantId, targetInput) {
    try {
        const payload = { 
            api_key: process.env.PREMIFY_API_KEY,
            variant_id: variantId, 
            quantity: 1,
            is_test: IS_TEST_MODE 
        };
        if (targetInput && targetInput.includes('@')) payload.email_invite = targetInput.trim();
        
        const response = await axios.post(`${PREMIFY_BASE_URL}/order`, payload, { headers: PREMIFY_HEADERS });
        if (response.data && response.data.success === true) {
            return { sukses: true, order_id: response.data.data.order_id, status: response.data.data.status };
        }
        return { sukses: false, pesan: response.data.message };
    } catch (error) { return { sukses: false, pesan: "Gangguan checkout h2h." }; }
}

async function fetchPremifyTransactions() {
    try {
        const response = await axios.post(`${PREMIFY_BASE_URL}/transactions`, { api_key: process.env.PREMIFY_API_KEY }, { headers: PREMIFY_HEADERS });
        return response.data && response.data.success === true ? response.data.data : [];
    } catch (error) { return []; }
}

// ========================================================
// 🧠 GEMINI AI INTEGRATION (DENGAN MEMORI & LOOPING)
// ========================================================

async function getGeminiResponse(userMessage, senderName, currentStoreName, senderWhatsapp) {
    try {
        const tools = [{
            functionDeclarations: [
                {
                    name: 'fetchPremifyProducts',
                    description: 'Cari katalog produk, harga, dan stok.',
                    parameters: { 
                        type: Type.OBJECT, 
                        properties: { searchKeyword: { type: Type.STRING, description: 'Wajib 1 kata utama saja (contoh: "netflix").' } } 
                    }
                },
                {
                    name: 'createPakasirInvoice',
                    description: 'Buat tagihan/invoice QRIS ketika pelanggan SUDAH SETUJU membeli (misal bilang "Oke", "Boleh", "Gas"). AMBIL data varian dari hasil fetch produk sebelumnya.',
                    parameters: { 
                        type: Type.OBJECT, 
                        properties: { 
                            variantId: { type: Type.STRING },
                            productName: { type: Type.STRING },
                            variantName: { type: Type.STRING },
                            finalPrice: { type: Type.NUMBER }
                        }, 
                        required: ['variantId', 'productName', 'variantName', 'finalPrice'] 
                    }
                }
            ]
        }];

        const systemPrompt = `Kamu adalah Customer Service handal dari "${currentStoreName}". 
Sifatmu ramah dan to the point. Sapa pelanggan 'Kak ${senderName}'.
ATURAN KERAS:
1. Jika pelanggan setuju membeli (bilang "Oke", "Ya", dll), LANSUNG panggil 'createPakasirInvoice' menggunakan data produk terakhir yang dibahas. 
2. Jika fungsi 'createPakasirInvoice' berhasil, berikan link QRIS-nya dan suruh pelanggan bayar.`;

        // 1. Ambil atau Buat Memori Chat untuk Nomor Ini
        if (!userSessions.has(senderWhatsapp)) {
            userSessions.set(senderWhatsapp, []);
        }
        const chatHistory = userSessions.get(senderWhatsapp);

        // Bersihkan memori lama agar tidak berat (simpan 12 riwayat terakhir)
        while (chatHistory.length > 12) chatHistory.shift();

        // Masukkan chat pelanggan terbaru ke memori
        chatHistory.push({ role: 'user', parts: [{ text: userMessage }] });

        let response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: chatHistory,
            config: { tools: tools, systemInstruction: systemPrompt, temperature: 0.5 }
        });

        // 2. SISTEM LOOPING: Biarkan AI menjalankan fungsi berkali-kali jika butuh
        let loopCount = 0;
        while (response.functionCalls && response.functionCalls.length > 0 && loopCount < 3) {
            loopCount++;
            const call = response.functionCalls[0];
            let functionResult;
            const args = call.args || {};
            
            if (call.name === 'fetchPremifyProducts') {
                functionResult = await fetchPremifyProducts(args.searchKeyword || '');
            } else if (call.name === 'createPakasirInvoice') {
                functionResult = await createPakasirInvoice(args.variantId, args.productName, args.variantName, args.finalPrice, senderWhatsapp);
            }

            // Simpan jejak AI memanggil alat ke memori
            chatHistory.push(response.candidates[0].content);
            // Simpan hasil alat tersebut ke memori agar AI bisa membacanya
            chatHistory.push({ role: 'user', parts: [{ functionResponse: { name: call.name, response: { result: functionResult } } }] });

            // Minta AI merespons lagi setelah melihat hasil alatnya
            response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: chatHistory,
                config: { tools: tools, systemInstruction: systemPrompt, temperature: 0.5 }
            });
        }

        const finalReply = response.text || "Sebentar ya Kak, tagihannya sedang disiapkan...";
        
        // Simpan jawaban akhir AI ke dalam memori agar nyambung untuk chat berikutnya!
        chatHistory.push({ role: 'model', parts: [{ text: finalReply }] });

        return finalReply;
    } catch (error) { 
        console.error("🔴 GEMINI CRASH DETAIL:", error?.message || error);
        return `Duh maaf Kak ${senderName}, sistemku agak error dikit nih. Boleh diulang? 🙏`; 
    }
}

// ========================================================
// GATEWAY WEBHOOKS
// ========================================================

app.post('/webhook/pakasir', async (req, res) => {
    try {
        const payload = req.body;
        if (payload.status === 'completed') {
            const orderId = payload.order_id; 
            const orderParts = orderId.split('-');
            if (orderParts.length >= 4) {
                const variantId = orderParts[2];
                const targetWhatsapp = orderParts.slice(3).join('-'); 
                const premifyResult = await createPremifyOrder(variantId, targetWhatsapp);

                if (premifyResult.sukses) {
                    if (sock && sock.user) {
                        let msgText = `💳 *Pembayaran Terverifikasi Lunas!* 🎉\n\nDana *Rp ${payload.amount.toLocaleString('id-ID')}* telah kami terima. Sistem sedang memproses pesanan Kakak...`;
                        if (IS_TEST_MODE) msgText += `\n\n_(ℹ️ Mode Sandbox Aktif)_`;
                        await sock.sendMessage(`${targetWhatsapp}@s.whatsapp.net`, { text: msgText });
                    }
                } else {
                    if (sock && sock.user) {
                        await sock.sendMessage(`${targetWhatsapp}@s.whatsapp.net`, { text: `⚠️ Antrean server supplier sedang padat. Pesanan diproses manual.` });
                    }
                }
            }
        }
        return res.status(200).json({ success: true });
    } catch (error) { return res.status(200).send('OK'); }
});

app.post('/webhook/premify', async (req, res) => {
    try {
        const payload = req.body; 
        const updatedTransactions = await fetchPremifyTransactions();
        io.emit('transactions-data', updatedTransactions);

        if (!payload.data || !payload.event) return res.status(200).send('OK');
        const data = payload.data;
        const customerPhone = data.customer?.whatsapp || data.email_invite; 
        if (!customerPhone) return res.status(200).send('OK');
        const customerJid = `${customerPhone}@s.whatsapp.net`;

        if (payload.event === 'order.completed') {
            let credsText = "";
            if (data.account_details && Array.isArray(data.account_details)) {
                data.account_details.forEach(acc => {
                    credsText += `\n📦 *${acc.product || 'Produk'}*\n`;
                    if (acc.details && Array.isArray(acc.details)) {
                        acc.details.forEach(det => {
                            if (det.credentials && Array.isArray(det.credentials)) {
                                det.credentials.forEach(cred => { credsText += `• ${cred.label}: ${cred.value}\n`; });
                            }
                        });
                    }
                });
            } else { credsText = "Silakan cek email Anda."; }

            const textReady = `🎉 *PESANAN SELESAI / COMPLETED* ✅\n\n🔑 *DATA AKSES LOGIN:* \n${credsText}\n_Terima kasih telah berbelanja di Pansa Group! 🚀_`;
            if (sock && sock.user) await sock.sendMessage(customerJid, { text: textReady });
        }
        return res.status(200).json({ success: true });
    } catch (error) { return res.status(200).send('OK'); }
});

// ========================================================
// INITIALIZATION ENGINE BAILEYS V7
// ========================================================

function initBaileysV7() {
    sock = makeWASocket({
        version, auth: state, printQRInTerminal: true, logger: pino({ level: 'silent' }), 
        browser: ["Ubuntu", "Chrome", "20.0.04"], markOnlineOnConnect: true
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) initBaileysV7(); 
        } else if (connection === 'open') {
            io.emit('status', `Terhubung sebagai: ${storeName} ✅`);
            io.emit('ready', true);
            fetchPremifyTransactions().then(trx => io.emit('transactions-data', trx));
        }
    });
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (msg.key && msg.key.id) {
                    if (processedMessages.has(msg.key.id)) continue; 
                    processedMessages.add(msg.key.id);
                }
                if (!msg.key.fromMe && msg.message && !msg.key.remoteJid.endsWith('@g.us')) {
                    const senderJid = msg.key.remoteJid;
                    const senderName = msg.pushName || "Kak";
                    const bodyMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
                    if (!bodyMessage) continue;
                    const cleanSenderNumber = senderJid.split('@')[0];

                    if (bodyMessage.trim() === '/balance') {
                        if (cleanSenderNumber === process.env.ADMIN_NUMBER) {
                            const balanceInfo = await checkPremifyBalance();
                            await sock.sendMessage(senderJid, { text: balanceInfo }, { quoted: msg });
                            continue;
                        }
                    }

                    recentChats.push({ jid: senderJid, name: senderName, lastMessage: `💬 ${bodyMessage}`, timestamp: new Date().toLocaleTimeString() });
                    if(recentChats.length > 50) recentChats.shift();
                    io.emit('chats-data', recentChats);

                    if (isAiActive) {
                        await sock.sendPresenceUpdate('composing', senderJid);
                        const aiReply = await getGeminiResponse(bodyMessage, senderName, storeName, cleanSenderNumber);
                        await delay(750); 
                        await sock.sendPresenceUpdate('paused', senderJid);
                        await sock.sendMessage(senderJid, { text: aiReply }, { quoted: msg });
                    }
                }
            }
        }
    });
}

io.on('connection', (socket) => {
    socket.on('request-pairing', async (phoneNumber) => {
        const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
        socket.emit('pairing-code', code);
    });
    socket.on('toggle-ai', (status) => { isAiActive = status; });
    socket.on('refresh-transactions', async () => {
        const trx = await fetchPremifyTransactions();
        socket.emit('transactions-data', trx);
    });
});

initBaileysV7();
app.get('/', (req, res) => { res.render('index'); });
server.listen(process.env.PORT || 3000, () => { console.log(`Server Pansa Group berjalan di port ${process.env.PORT || 3000}`); });
