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

let sock = null;
let isAiActive = true;
let storeName = "Pansa Group"; 
const recentChats = []; 

// Cache untuk Anti-Spam (Mencegah Bot membalas 2x untuk pesan yang sama)
const processedMessages = new Set();

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
            return `💻 *SALDO SERVER API MODAL*\n\n• Sisa Saldo: *${formattedBalance}*\n• Status: Terhubung Sempurna ✅`;
        }
        return "⚠️ Gagal mengambil data saldo server.";
    } catch (error) { 
        return "❌ Gagal mengontak server pusat Premify."; 
    }
}

async function fetchPremifyProducts(searchKeyword = '') {
    try {
        const response = await axios.post(`${PREMIFY_BASE_URL}/products`, {
            api_key: process.env.PREMIFY_API_KEY
        }, { headers: PREMIFY_HEADERS });
        
        if (response.data && response.data.success === true) {
            const products = response.data.data || [];
            const flattenedVariants = [];
            
            products.forEach(product => {
                if (searchKeyword && !product.name.toLowerCase().includes(searchKeyword.toLowerCase())) return;
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
                    keterangan: `Produk dengan kata kunci '${searchKeyword}' tidak ditemukan atau sedang habis di supplier.` 
                }];
            }

            return flattenedVariants.slice(0, 15);
        }
        return [{ status: "ERROR", keterangan: "Gagal memuat produk dari server." }];
    } catch (error) { 
        return [{ status: "ERROR", keterangan: "Gangguan jaringan saat cek produk." }]; 
    }
}

async function createPakasirInvoice(variantId, productName, variantName, finalPrice, customerWhatsapp) {
    try {
        const orderId = `INV-${Date.now()}-${variantId}-${customerWhatsapp}`;
        
        const response = await axios.post('https://app.pakasir.com/api/transactioncreate/qris', {
            project: process.env.PAKASIR_PROJECT_SLUG,
            order_id: orderId,
            amount: finalPrice,
            api_key: process.env.PAKASIR_API_KEY
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
            quantity: 1 
        };
        
        if (targetInput && targetInput.includes('@')) payload.email_invite = targetInput.trim();
        
        const response = await axios.post(`${PREMIFY_BASE_URL}/order`, payload, { headers: PREMIFY_HEADERS });
        
        if (response.data && response.data.success === true) {
            return { sukses: true, order_id: response.data.data.order_id, status: response.data.data.status };
        }
        return { sukses: false, pesan: response.data.message };
    } catch (error) { 
        return { sukses: false, pesan: "Gangguan saat checkout h2h ke supplier pusat." }; 
    }
}

async function fetchPremifyTransactions() {
    try {
        const response = await axios.post(`${PREMIFY_BASE_URL}/transactions`, {
            api_key: process.env.PREMIFY_API_KEY
        }, { headers: PREMIFY_HEADERS });
        
        return response.data && response.data.success === true ? response.data.data : [];
    } catch (error) { return []; }
}

// ========================================================
// GEMINI AI INTEGRATION (FUNCTION CALLING INTERCEPTOR)
// ========================================================

async function getGeminiResponse(userMessage, senderName, currentStoreName, senderWhatsapp) {
    try {
        const tools = [{
            functionDeclarations: [
                {
                    name: 'fetchPremifyProducts',
                    description: 'Cari katalog produk digital, harga, dan stok dari database. HANYA gunakan jika pelanggan secara eksplisit menanyakan produk atau harga.',
                    parameters: { 
                        type: Type.OBJECT, 
                        properties: { 
                            searchKeyword: { type: Type.STRING, description: 'Kata kunci produk yang dicari' } 
                        } 
                    }
                },
                {
                    name: 'createPakasirInvoice',
                    description: 'Buat link tagihan pembayaran QRIS ketika pelanggan sudah setuju/DEAL ingin membeli.',
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

        const systemPrompt = `Kamu adalah Customer Service dari "${currentStoreName}". 
Karaktermu: Ramah, asik, sopan. Gunakan bahasa Indonesia sehari-hari yang luwes (pakai aku/kamu atau kami/kakak, sapa pelanggan dengan 'Kak ${senderName}').

ATURAN KERAS:
1. Kamu BUKAN robot atau AI.
2. Jika pelanggan hanya menyapa (contoh: "Hai", "Halo", "P", "Ping"), balaslah sapaannya dengan ramah dan tanyakan apa yang bisa dibantu TANPA memanggil fungsi fetchPremifyProducts.
3. Jika fungsi 'fetchPremifyProducts' mengembalikan status "KOSONG", katakan dengan jujur bahwa stok produk tersebut sedang kosong/belum tersedia. Jangan salahkan sistem.
4. Jika pelanggan sudah setuju mau beli, minta konfirmasi nomor tujuan, lalu panggil tool 'createPakasirInvoice'.`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: userMessage,
            config: {
                tools: tools,
                systemInstruction: systemPrompt,
                temperature: 0.7 
            }
        });

        const functionCalls = response.functionCalls;
        if (functionCalls && functionCalls.length > 0) {
            const call = functionCalls[0];
            let functionResult;
            
            // Amankan argument agar tidak undefined
            const args = call.args || {};
            
            if (call.name === 'fetchPremifyProducts') {
                const keyword = args.searchKeyword || '';
                functionResult = await fetchPremifyProducts(keyword);
            } else if (call.name === 'createPakasirInvoice') {
                functionResult = await createPakasirInvoice(args.variantId, args.productName, args.variantName, args.finalPrice, senderWhatsapp);
            }

            const secondResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [
                    { role: 'user', parts: [{ text: userMessage }] },
                    response.candidates[0].content, 
                    // PERBAIKAN FATAL: Role balasan fungsi harus di-set sebagai 'user'
                    { role: 'user', parts: [{ functionResponse: { name: call.name, response: { result: functionResult } } }] } 
                ],
                config: { tools: tools, systemInstruction: systemPrompt }
            });
            return secondResponse.text || "Mohon ditunggu sebentar ya Kak, sedang diproses...";
        }
        return response.text || "Halo! Ada yang bisa dibantu?";
    } catch (error) { 
        console.error("🔴 GEMINI CRASH DETAIL:", error?.message || error);
        return `Duh maaf Kak ${senderName}, aku lagi buka sistem sebentar nih. Boleh ketik ulang pesannya? 🙏😊`; 
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

                console.log(`[💸 PAYMENT SUCCESS] Nomor ${targetWhatsapp} Lunas membayar. Memotong saldo modal h2h...`);

                const premifyResult = await createPremifyOrder(variantId, targetWhatsapp);

                if (premifyResult.sukses) {
                    if (sock && sock.user) {
                        await sock.sendMessage(`${targetWhatsapp}@s.whatsapp.net`, { 
                            text: `💳 *Pembayaran Terverifikasi Lunas!* 🎉\n\nDana sebesar *Rp ${payload.amount.toLocaleString('id-ID')}* telah kami terima. Sistem kami saat ini sedang memproses pesanan Kakak ke server pusat. Mohon ditunggu sebentar ya Kak! ✨` 
                        });
                    }
                } else {
                    if (sock && sock.user) {
                        await sock.sendMessage(`${targetWhatsapp}@s.whatsapp.net`, { 
                            text: `⚠️ *Antrean Pengisian Sistem*\n\nHalo Kak, pembayaran Kakak sudah masuk, namun antrean server supplier kami sedang sangat padat. Pesanan Kakak akan di-proses secara manual oleh Tim kami secepatnya ya. Terima kasih! 🙏` 
                        });
                    }
                }
            }
        }
        return res.status(200).json({ success: true });
    } catch (error) { 
        return res.status(200).send('OK'); 
    }
});

app.post('/webhook/premify', async (req, res) => {
    try {
        const payload = req.body; 
        
        // Refresh dashboard frontend
        const updatedTransactions = await fetchPremifyTransactions();
        io.emit('transactions-data', updatedTransactions);

        // Validasi payload webhook
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
                                det.credentials.forEach(cred => {
                                    credsText += `• ${cred.label}: ${cred.value}\n`;
                                });
                            }
                        });
                    }
                });
            } else {
                credsText = "Akun berhasil diaktifkan / Silakan cek email Anda.";
            }

            const textReady = `🎉 *PESANAN SELESAI / COMPLETED* ✅\n\nHalo Kak,\nPesanan akun premium Kakak sudah selesai diproses secara otomatis!\n\n🔑 *DATA KREDENSIAL / AKSES LOGIN:* \n${credsText}\n_Harap amankan data akun di atas. Terima kasih banyak telah berbelanja di Pansa Group! 🚀🌟_`;
            
            if (sock && sock.user) await sock.sendMessage(customerJid, { text: textReady });
        }
        return res.status(200).json({ success: true });
    } catch (error) { 
        console.error("Premify Webhook Error:", error);
        return res.status(200).send('OK'); 
    }
});

// ========================================================
// INITIALIZATION ENGINE BAILEYS V7
// ========================================================

function initBaileysV7() {
    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true, 
        logger: pino({ level: 'silent' }), 
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false,            
        downloadHistoryCategories: [],     
        markOnlineOnConnect: true,         
        connectTimeoutMs: 60000,           
        keepAliveIntervalMs: 30000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            io.emit('ready', false);
            if (shouldReconnect) initBaileysV7(); 
        } else if (connection === 'open') {
            io.emit('status', `Terhubung sebagai: ${storeName} ✅`);
            io.emit('ready', true);
            io.emit('store-name', storeName);
            io.emit('chats-data', recentChats);
            fetchPremifyTransactions().then(trx => io.emit('transactions-data', trx));
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                // 1. CEK ANTI SPAM & MENCEGAH DOUBLE RESPONSE
                if (msg.key && msg.key.id) {
                    if (processedMessages.has(msg.key.id)) continue; 
                    processedMessages.add(msg.key.id);
                    // Cegah memory leak
                    if (processedMessages.size > 1000) processedMessages.clear();
                }

                // 2. HANYA PROSES PERSONAL CHAT
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
                        } else {
                            await sock.sendMessage(senderJid, { text: "🔒 _Maaf Kak, perintah tersebut hanya dapat diakses oleh Admin._ 🙏" }, { quoted: msg });
                            continue;
                        }
                    }

                    recentChats.push({ jid: senderJid, name: senderName, lastMessage: `💬 ${bodyMessage}`, timestamp: new Date().toLocaleTimeString() });
                    if(recentChats.length > 50) recentChats.shift();
                    io.emit('chats-data', recentChats);

                    if (isAiActive) {
                        // Animasi Bot Sedang Mengetik
                        await sock.sendPresenceUpdate('composing', senderJid);
                        
                        const aiReply = await getGeminiResponse(bodyMessage, senderName, storeName, cleanSenderNumber);
                        
                        await delay(750); // Jeda natural layaknya manusia
                        await sock.sendPresenceUpdate('paused', senderJid);
                        
                        await sock.sendMessage(senderJid, { text: aiReply }, { quoted: msg });
                    }
                }
            }
        }
    });
}

// Socket IO Dashboard Controller
io.on('connection', (socket) => {
    if (sock?.user) {
        socket.emit('ready', true);
        socket.emit('status', `Terhubung sebagai: ${storeName} ✅`);
        socket.emit('store-name', storeName);
        socket.emit('chats-data', recentChats);
        fetchPremifyTransactions().then(trx => socket.emit('transactions-data', trx));
    }
    socket.on('request-pairing', async (phoneNumber) => {
        try {
            const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
            socket.emit('pairing-code', code);
        } catch (error) {
            console.error('Gagal generate pairing code:', error);
        }
    });
    socket.on('toggle-ai', (status) => { isAiActive = status; });
    socket.on('refresh-transactions', async () => {
        const trx = await fetchPremifyTransactions();
        socket.emit('transactions-data', trx);
    });
});

initBaileysV7();

app.get('/', (req, res) => { res.render('index'); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});
