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
    fetchLatestBaileysVersion 
} from 'baileys';

const app = express();
app.use(express.json()); // Middleware wajib untuk menangani JSON Webhook

const server = http.createServer(app);
const io = new Server(server);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.set('view engine', 'ejs');
app.use(express.static('public'));

let sock = null;
let isAiActive = true;
let storeName = "Pansa Digital Store"; 
const recentChats = []; 

const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_store');
const { version } = await fetchLatestBaileysVersion();

const PREMIFY_BASE_URL = 'https://premify.store/api/v1';
const PREMIFY_HEADERS = {
    'Authorization': `Bearer ${process.env.PREMIFY_API_KEY}`,
    'Content-Type': 'application/json'
};

const PRICE_MARKUP = parseInt(process.env.MARKUP_UNTUNG) || 2000;

// ========================================================
// CORE FUNCTIONS (PREMIFY API + PAKASIR GATEWAY)
// ========================================================

async function checkPremifyBalance() {
    try {
        const response = await axios.get(`${PREMIFY_BASE_URL}/balance`, { headers: PREMIFY_HEADERS });
        if (response.data && response.data.success === true) {
            const rawBalance = response.data.data.balance;
            const currency = response.data.data.currency || "IDR";
            const formattedBalance = new Intl.NumberFormat('id-ID', { style: 'currency', currency: currency, minimumFractionDigits: 0 }).format(rawBalance);
            return `💻 *SALDO SERVER API MODAL*\n\n• Sisa Saldo: *${formattedBalance}*\n• Status: Terhubung Sempurna ✅`;
        }
        return "⚠️ Gagal mengambil data saldo server.";
    } catch (error) { return "❌ Gagal mengontak server pusat Premify."; }
}

async function fetchPremifyProducts(searchKeyword = '') {
    try {
        const response = await axios.post(`${PREMIFY_BASE_URL}/products`, {}, { headers: PREMIFY_HEADERS });
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
                            price: hargaJualCustomer, // Harga yang sudah di-markup untung
                            duration: v.duration,
                            type: v.type,
                            stock: v.stock
                        });
                    });
                }
            });
            return flattenedVariants.slice(0, 15);
        }
        return { error: "Gagal memuat produk." };
    } catch (error) { return { error: "Gangguan jaringan produk." }; }
}

async function createPakasirInvoice(variantId, productName, variantName, finalPrice, customerWhatsapp) {
    try {
        // TRIK: Sisipkan variantId dan nomor WA ke dalam order_id karena Pakasir tidak support metadata object
        // Format: INV-timestamp-variantId-customerWhatsapp
        const orderId = `INV-${Date.now()}-${variantId}-${customerWhatsapp}`;
        
        const response = await axios.post('https://app.pakasir.com/api/transactioncreate/qris', {
            project: process.env.PAKASIR_PROJECT_SLUG,
            order_id: orderId,
            amount: finalPrice,
            api_key: process.env.PAKASIR_API_KEY
        }, { 
            headers: { 'Content-Type': 'application/json' } 
        });

        if (response.data && response.data.payment) {
            return {
                sukses: true,
                // Menggunakan URL Simple Integration Pakasir agar user mendapatkan halaman pembayaran yang rapi
                invoice_url: `https://app.pakasir.com/pay/${process.env.PAKASIR_PROJECT_SLUG}/${finalPrice}?order_id=${orderId}&qris_only=1`,
                reference_id: orderId,
                price: finalPrice
            };
        } else {
            return { sukses: false, pesan: "Gagal memproses QRIS Pakasir." };
        }
    } catch (error) {
        console.error("Pakasir API Error:", error?.response?.data || error.message);
        return { sukses: false, pesan: "Gagal membuat tagihan pembayaran ke Pakasir." };
    }
}

async function createPremifyOrder(variantId, targetInput) {
    try {
        const payload = { variant_id: variantId, quantity: 1 };
        if (targetInput && targetInput.includes('@')) payload.email_invite = targetInput.trim();
        
        const response = await axios.post(`${PREMIFY_BASE_URL}/order`, payload, { headers: PREMIFY_HEADERS });
        if (response.data && response.data.success === true) {
            return { sukses: true, order_id: response.data.data.order_id, status: response.data.data.status };
        }
        return { sukses: false, pesan: response.data.message };
    } catch (error) { return { sukses: false, pesan: "Gangguan saat checkout h2h ke supplier pusat." }; }
}

async function fetchPremifyTransactions() {
    try {
        const response = await axios.post(`${PREMIFY_BASE_URL}/transactions`, {}, { headers: PREMIFY_HEADERS });
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
                    description: 'Mengambil daftar produk digital, kuota, durasi, dan harga jual store berdasarkan kata kunci pencarian.',
                    parameters: { type: Type.OBJECT, properties: { searchKeyword: { type: Type.STRING } } }
                },
                {
                    name: 'createPakasirInvoice',
                    description: 'Membuatkan tagihan/link pembayaran invoice digital ketika pelanggan sudah deal memilih varian produk dan memberikan email/nomor target.',
                    parameters: { 
                        type: Type.OBJECT, 
                        properties: { 
                            variantId: { type: Type.STRING, description: 'ID varian produk pilihan pelanggan.' },
                            productName: { type: Type.STRING, description: 'Nama utama produk.' },
                            variantName: { type: Type.STRING, description: 'Nama durasi/varian produk.' },
                            finalPrice: { type: Type.NUMBER, description: 'Harga produk yang tertera (harga yang sudah di markup).' }
                        }, 
                        required: ['variantId', 'productName', 'variantName', 'finalPrice'] 
                    }
                }
            ]
        }];

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: userMessage,
            config: {
                tools: tools,
                systemInstruction: `Kamu adalah "${currentStoreName} Bot", asisten virtual super ramah dari toko produk digital ${currentStoreName}. Berbicaralah dengan bahasa Indonesia yang santai, modern, gunakan sebutan 'Kak ${senderName}' dan emoji relevan. Selalu gunakan tools fetchPremifyProducts untuk cek harga asli produk toko. Jika pelanggan sudah setuju dengan varian harga dan memberikan email/nomor target, panggil tool createPakasirInvoice untuk memberikan mereka link pembayaran QRIS/VA Pakasir.`,
                temperature: 0.5
            }
        });

        const functionCalls = response.functionCalls;
        if (functionCalls && functionCalls.length > 0) {
            const call = functionCalls[0];
            let functionResult;
            
            if (call.name === 'fetchPremifyProducts') {
                functionResult = await fetchPremifyProducts(call.args.searchKeyword);
            } else if (call.name === 'createPakasirInvoice') {
                functionResult = await createPakasirInvoice(call.args.variantId, call.args.productName, call.args.variantName, call.args.finalPrice, senderWhatsapp);
            }

            const secondResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [
                    { role: 'user', parts: [{ text: userMessage }] },
                    response.candidates[0].content,
                    { role: 'function', parts: [{ functionResponse: { name: call.name, response: { result: functionResult } } }] }
                ],
                config: { tools: tools }
            });
            return secondResponse.text;
        }
        return response.text;
    } catch (error) { 
        console.error("Gemini Error:", error);
        return `Maaf ya Kak, jaringan otak pintar toko sedang padat, boleh ketik ulang produk yang Kakak cari? 😊`; 
    }
}

// ========================================================
// GATEWAY WEBHOOKS
// ========================================================

app.post('/webhook/pakasir', async (req, res) => {
    try {
        const payload = req.body;
        
        // Cek apakah status pembayaran "completed"
        if (payload.status === 'completed') {
            const orderId = payload.order_id; 
            
            // Ekstrak data (Format: INV-timestamp-variantId-customerWhatsapp)
            const orderParts = orderId.split('-');
            if (orderParts.length >= 4) {
                const variantId = orderParts[2];
                const targetWhatsapp = orderParts.slice(3).join('-'); 

                console.log(`[💸 PAYMENT SUCCESS] Nomor ${targetWhatsapp} Lunas membayar (Order: ${orderId}). Memotong saldo modal h2h...`);

                // HIT PROVIDER PREMIFY
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
                            text: `⚠️ *Antrean Pengisian Sistem*\n\nHalo Kak, pembayaran Kakak sudah masuk, namun antrean server supplier kami sedang sangat padat. Pesanan Kakak akan di-proses secara manual oleh Owner secepatnya ya Kak. Terima kasih! 🙏` 
                        });
                    }
                }
            }
        }
        return res.status(200).json({ success: true });
    } catch (error) { 
        console.error("Pakasir Webhook Error:", error);
        return res.status(200).send('OK'); 
    }
});

app.post('/webhook/premify', async (req, res) => {
    try {
        const { event, data } = req.body;
        
        const updatedTransactions = await fetchPremifyTransactions();
        io.emit('transactions-data', updatedTransactions);

        if (!data.customer || !data.customer.whatsapp) return res.status(200).send('OK');
        const customerJid = `${data.customer.whatsapp}@s.whatsapp.net`;

        if (event === 'order.completed') {
            const accountDetails = data.items[0].account_details;
            const textReady = `🎉 *PESANAN SELESAI / COMPLETED* ✅\n\nHalo Kak,\nAkun premium pesanan Kakak untuk produk *${data.items[0].product_name} - ${data.items[0].variant_name}* sudah selesai di-generate secara instant!\n\n🔑 *DATA KREDENSIAL AKUN / AKSES LOGIN:* \n\`\`\`\n${accountDetails}\n\`\`\`\n\n_Harap amankan data akun premium di atas. Terima kasih banyak telah berbelanja di store kami! 🚀🌟_`;
            
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
    // Perbaikan: Hapus .default pada makeWASocket
    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true, // Set true sementara agar bisa scan QR di terminal jika belum connect
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
            storeName = sock.user.name || "Premify H2H Store";
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
                // TINGKATKAN KEAMANAN: HANYA CHAT PERSONAL, ABAIKAN GROUP CHAT (@g.us) SECARA TOTAL
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
                            await sock.sendMessage(senderJid, { text: "🔒 _Maaf Kak, perintah tersebut hanya dapat diakses oleh Owner utama store kami._ 🙏" }, { quoted: msg });
                            continue;
                        }
                    }

                    recentChats.push({ jid: senderJid, name: senderName, lastMessage: `💬 ${bodyMessage}`, timestamp: new Date().toLocaleTimeString() });
                    // Batasi array chat agar tidak memakan memori berlebih
                    if(recentChats.length > 50) recentChats.shift();
                    
                    io.emit('chats-data', recentChats);

                    if (isAiActive) {
                        const aiReply = await getGeminiResponse(bodyMessage, senderName, storeName, cleanSenderNumber);
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
