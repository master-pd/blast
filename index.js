const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================
// মিডলওয়্যার
// =============================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================================
// ডাটাবেস সেটআপ (JSON ফাইল)
// =============================================
const DB_PATH = path.join(__dirname, 'database.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

// সেশন ডিরেক্টরি তৈরি
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ডাটাবেস ফাংশন
function loadDatabase() {
    try {
        if (fs.existsSync(DB_PATH)) {
            const data = fs.readFileSync(DB_PATH, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('⚠️ ডাটাবেস লোড করতে সমস্যা:', error.message);
    }
    
    // ডিফল্ট ডাটাবেস
    return {
        pairingCodes: {},      // 8-ডিজিটের কোড
        sessions: {},          // সংযুক্ত সেশন
        stats: {
            totalMessages: 0,
            totalSessions: 0,
            createdAt: new Date().toISOString()
        }
    };
}

function saveDatabase(data) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('❌ ডাটাবেস সেভ করতে সমস্যা:', error.message);
    }
}

// ডাটাবেস ইনিশিয়ালাইজ
let db = loadDatabase();

// =============================================
// ইউটিলিটি ফাংশন
// =============================================

// 8-ডিজিটের পেয়ারিং কোড জেনারেট
function generatePairingCode() {
    return crypto.randomInt(10000000, 99999999).toString();
}

// ফোন নম্বর ফরম্যাট করুন
function formatPhoneNumber(number) {
    let cleaned = number.replace(/\D/g, '');
    if (!cleaned.startsWith('88')) {
        cleaned = '88' + cleaned;
    }
    return cleaned;
}

// =============================================
// WhatsApp ম্যানেজার ক্লাস
// =============================================
class WhatsAppManager {
    constructor() {
        this.clients = {};
        this.readyStates = {};
        this.pairingCodes = db.pairingCodes || {};
        
        console.log('\n🤖 WhatsApp ম্যানেজার চালু হচ্ছে...');
        console.log(`📊 সংযুক্ত সেশন: ${Object.keys(db.sessions).length}`);
        
        // আগের সেশনগুলো লোড করুন
        this.loadSessions();
        
        // প্রতি মিনিটে মেয়াদোত্তীর্ণ কোড ক্লিনআপ
        setInterval(() => this.cleanupExpiredCodes(), 60000);
    }
    
    loadSessions() {
        Object.entries(db.sessions).forEach(([sessionId, sessionData]) => {
            if (sessionData.status === 'active') {
                this.connectSession(sessionId, sessionData);
            }
        });
    }
    
    // নতুন পেয়ারিং কোড তৈরি করুন
    createPairingCode() {
        const code = generatePairingCode();
        const expiresAt = Date.now() + (5 * 60 * 1000); // 5 মিনিট
        
        this.pairingCodes[code] = {
            code,
            createdAt: Date.now(),
            expiresAt,
            status: 'pending'
        };
        
        // ডাটাবেস আপডেট
        db.pairingCodes = this.pairingCodes;
        saveDatabase(db);
        
        return {
            success: true,
            code,
            expiresIn: '5 minutes',
            instructions: 'WhatsApp → Linked Devices → Link with number instead → এই কোড দিন'
        };
    }
    
    // পেয়ারিং কোড ভেরিফাই
    verifyPairingCode(code) {
        const pairingData = this.pairingCodes[code];
        
        if (!pairingData) {
            return { valid: false, error: '❌ ভুল কোড' };
        }
        
        if (pairingData.status !== 'pending') {
            return { valid: false, error: '❌ কোড ইতিমধ্যে ব্যবহার করা হয়েছে' };
        }
        
        if (Date.now() > pairingData.expiresAt) {
            delete this.pairingCodes[code];
            db.pairingCodes = this.pairingCodes;
            saveDatabase(db);
            return { valid: false, error: '❌ কোডের মেয়াদ শেষ' };
        }
        
        return { valid: true, pairingData };
    }
    
    // পেয়ারিং কোড ব্যবহার করে সেশন তৈরি
    async createSessionWithCode(code, phoneNumber, deviceName = 'WhatsApp Device') {
        try {
            const verification = this.verifyPairingCode(code);
            if (!verification.valid) {
                return verification;
            }
            
            const formattedNumber = formatPhoneNumber(phoneNumber);
            const sessionId = `session_${formattedNumber}_${Date.now()}`;
            
            // সেশন ডাটা তৈরি
            const sessionData = {
                sessionId,
                phoneNumber: formattedNumber,
                deviceName,
                createdAt: Date.now(),
                lastActive: Date.now(),
                status: 'initializing',
                messageCount: 0
            };
            
            // ডাটাবেসে সেশন সংরক্ষণ
            db.sessions[sessionId] = sessionData;
            
            // পেয়ারিং কোড মুছে ফেলুন
            delete this.pairingCodes[code];
            db.pairingCodes = this.pairingCodes;
            saveDatabase(db);
            
            // WhatsApp কানেকশন শুরু করুন
            await this.connectSession(sessionId, sessionData);
            
            return {
                success: true,
                sessionId,
                phoneNumber: formattedNumber,
                message: '✅ সেশন তৈরি হচ্ছে। অনুগ্রহ করে WhatsApp-এ কনফার্ম করুন।'
            };
            
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    
    // WhatsApp সেশন কানেক্ট করুন
    async connectSession(sessionId, sessionData) {
        try {
            console.log(`🔄 সেশন কানেক্ট হচ্ছে: ${sessionData.phoneNumber}`);
            
            const client = new Client({
                authStrategy: new LocalAuth({
                    clientId: sessionId,
                    dataPath: SESSIONS_DIR
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--disable-gpu',
                        '--window-size=1920,1080'
                    ]
                }
            });
            
            // ক্লায়েন্ট ইভেন্ট হ্যান্ডলার
            client.on('ready', () => {
                console.log(`✅ সেশন কানেক্টেড: ${sessionData.phoneNumber}`);
                this.clients[sessionId] = client;
                this.readyStates[sessionId] = true;
                
                // ডাটাবেস আপডেট
                sessionData.status = 'active';
                sessionData.connectedAt = Date.now();
                saveDatabase(db);
            });
            
            client.on('disconnected', (reason) => {
                console.log(`❌ সেশন ডিসকানেক্ট: ${sessionData.phoneNumber} - ${reason}`);
                this.readyStates[sessionId] = false;
                sessionData.status = 'disconnected';
                sessionData.lastDisconnect = Date.now();
                sessionData.disconnectReason = reason;
                saveDatabase(db);
                
                // ১০ সেকেন্ড পর রিকানেক্ট করার চেষ্টা
                setTimeout(() => {
                    if (sessionData.status !== 'active') {
                        console.log(`🔄 রিকানেক্ট করা হচ্ছে: ${sessionData.phoneNumber}`);
                        this.connectSession(sessionId, sessionData);
                    }
                }, 10000);
            });
            
            client.on('message', async (message) => {
                // মেসেজ রিসিভ হলে (ঐচ্ছিক)
                console.log(`📩 ${sessionData.phoneNumber} থেকে মেসেজ: ${message.body}`);
            });
            
            client.on('message_create', (message) => {
                // মেসেজ পাঠানো হলে
                if (message.fromMe) {
                    sessionData.messageCount = (sessionData.messageCount || 0) + 1;
                    db.stats.totalMessages++;
                    saveDatabase(db);
                }
            });
            
            // ক্লায়েন্ট ইনিশিয়ালাইজ
            await client.initialize();
            
        } catch (error) {
            console.error(`❌ সেশন এরর ${sessionData.phoneNumber}:`, error.message);
            
            // এরর হলে রিকানেক্ট
            setTimeout(() => {
                this.connectSession(sessionId, sessionData);
            }, 30000);
        }
    }
    
    // মেসেজ পাঠান
    async sendMessage(sessionId, to, message) {
        try {
            if (!this.readyStates[sessionId]) {
                // সেশন আইডি না দিলে প্রথম অ্যাক্টিভ সেশন খুঁজে নিন
                if (sessionId === 'default') {
                    const activeSession = Object.keys(this.readyStates).find(id => this.readyStates[id]);
                    if (activeSession) {
                        sessionId = activeSession;
                    } else {
                        throw new Error('কোনো অ্যাক্টিভ সেশন নেই');
                    }
                } else {
                    throw new Error('সেশন রেডি নয়');
                }
            }
            
            const client = this.clients[sessionId];
            if (!client) {
                throw new Error('ক্লায়েন্ট পাওয়া যায়নি');
            }
            
            // নম্বর ফরম্যাট করুন
            let formattedNumber = to.replace(/\D/g, '');
            if (!formattedNumber.startsWith('88')) {
                formattedNumber = '88' + formattedNumber;
            }
            formattedNumber = `${formattedNumber}@c.us`;
            
            // মেসেজ পাঠান
            const response = await client.sendMessage(formattedNumber, message);
            
            // ডাটাবেস আপডেট
            if (db.sessions[sessionId]) {
                db.sessions[sessionId].lastActive = Date.now();
                db.sessions[sessionId].lastMessage = Date.now();
                saveDatabase(db);
            }
            
            return {
                success: true,
                messageId: response.id.id,
                timestamp: response.timestamp,
                from: db.sessions[sessionId]?.phoneNumber || sessionId
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // সব সেশনের স্ট্যাটাস
    getStatus() {
        const status = {};
        Object.entries(db.sessions).forEach(([id, data]) => {
            status[id] = {
                phoneNumber: data.phoneNumber,
                deviceName: data.deviceName,
                status: data.status,
                isReady: this.readyStates[id] || false,
                connectedAt: data.connectedAt,
                lastActive: data.lastActive,
                messageCount: data.messageCount || 0
            };
        });
        return status;
    }
    
    // মেয়াদোত্তীর্ণ কোড ক্লিনআপ
    cleanupExpiredCodes() {
        let cleaned = 0;
        Object.entries(this.pairingCodes).forEach(([code, data]) => {
            if (Date.now() > data.expiresAt) {
                delete this.pairingCodes[code];
                cleaned++;
            }
        });
        
        if (cleaned > 0) {
            db.pairingCodes = this.pairingCodes;
            saveDatabase(db);
            console.log(`🧹 ${cleaned} টি মেয়াদোত্তীর্ণ কোড ক্লিনআপ করা হয়েছে`);
        }
    }
    
    // সেশন ডিসকানেক্ট
    async disconnectSession(sessionId) {
        try {
            if (this.clients[sessionId]) {
                await this.clients[sessionId].destroy();
                delete this.clients[sessionId];
                delete this.readyStates[sessionId];
                
                if (db.sessions[sessionId]) {
                    db.sessions[sessionId].status = 'disconnected';
                    saveDatabase(db);
                }
                
                return { success: true };
            }
            return { success: false, error: 'সেশন পাওয়া যায়নি' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

// =============================================
// ম্যানেজার ইনিশিয়ালাইজ
// =============================================
const manager = new WhatsAppManager();

// =============================================
// API এন্ডপয়েন্ট
// =============================================

// হোম পেজ
app.get('/', (req, res) => {
    res.json({
        app: '🤖 WhatsApp Link API',
        version: '2.0.0 (Production)',
        status: 'running',
        endpoints: {
            'GET /': 'এই তথ্য',
            'GET /status': 'সব সেশনের স্ট্যাটাস',
            'POST /pairing-code': 'নতুন 8-ডিজিট কোড জেনারেট',
            'POST /connect': 'কোড দিয়ে সেশন কানেক্ট',
            'GET /sessions': 'সব সেশনের তালিকা',
            'POST /send-message': 'মেসেজ পাঠান',
            'DELETE /session/:id': 'সেশন ডিসকানেক্ট',
            'GET /stats': 'পরিসংখ্যান'
        },
        stats: {
            activeSessions: Object.values(manager.readyStates).filter(v => v).length,
            totalSessions: Object.keys(db.sessions).length,
            totalMessages: db.stats.totalMessages || 0
        }
    });
});

// স্ট্যাটাস এন্ডপয়েন্ট
app.get('/status', (req, res) => {
    res.json({
        success: true,
        timestamp: Date.now(),
        sessions: manager.getStatus(),
        stats: {
            active: Object.values(manager.readyStates).filter(v => v).length,
            total: Object.keys(db.sessions).length,
            messages: db.stats.totalMessages || 0
        }
    });
});

// পেয়ারিং কোড জেনারেট
app.post('/pairing-code', (req, res) => {
    const result = manager.createPairingCode();
    res.json(result);
});

// কোড দিয়ে কানেক্ট করুন
app.post('/connect', (req, res) => {
    const { code, phoneNumber, deviceName } = req.body;
    
    if (!code || !phoneNumber) {
        return res.status(400).json({
            success: false,
            error: 'code এবং phoneNumber প্রয়োজন'
        });
    }
    
    manager.createSessionWithCode(code, phoneNumber, deviceName)
        .then(result => res.json(result));
});

// সব সেশনের তালিকা
app.get('/sessions', (req, res) => {
    res.json({
        success: true,
        sessions: db.sessions
    });
});

// মেসেজ পাঠান
app.post('/send-message', async (req, res) => {
    const { sessionId, to, message } = req.body;
    
    if (!to || !message) {
        return res.status(400).json({
            success: false,
            error: 'to এবং message প্রয়োজন'
        });
    }
    
    const result = await manager.sendMessage(sessionId || 'default', to, message);
    res.json(result);
});

// GET মেথডেও মেসেজ পাঠান (সিম্পল ইউজের জন্য)
app.get('/send-message', async (req, res) => {
    const { to, text, session } = req.query;
    
    if (!to || !text) {
        return res.json({
            success: false,
            error: 'to এবং text প্রয়োজন',
            example: '/send-message?to=+8801929671720&text=হ্যালো'
        });
    }
    
    const result = await manager.sendMessage(session || 'default', to, text);
    res.json(result);
});

// সেশন ডিসকানেক্ট
app.delete('/session/:id', async (req, res) => {
    const result = await manager.disconnectSession(req.params.id);
    res.json(result);
});

// পরিসংখ্যান
app.get('/stats', (req, res) => {
    res.json({
        success: true,
        ...db.stats,
        activeNow: Object.values(manager.readyStates).filter(v => v).length,
        uptime: process.uptime()
    });
});

// হেলথ চেক
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: Date.now(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        sessions: Object.keys(manager.readyStates).filter(id => manager.readyStates[id]).length
    });
});

// =============================================
// 404 হ্যান্ডলার
// =============================================
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'এন্ডপয়েন্ট পাওয়া যায়নি',
        availableEndpoints: [
            'GET /',
            'GET /status',
            'POST /pairing-code',
            'POST /connect',
            'GET /sessions',
            'POST /send-message',
            'GET /send-message',
            'DELETE /session/:id',
            'GET /stats',
            'GET /health'
        ]
    });
});

// =============================================
// এরর হ্যান্ডলার
// =============================================
app.use((err, req, res, next) => {
    console.error('❌ সার্ভার এরর:', err);
    res.status(500).json({
        success: false,
        error: 'অভ্যন্তরীণ সার্ভার এরর',
        message: err.message
    });
});

// =============================================
// সার্ভার চালু
// =============================================
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║     🚀 WhatsApp Link API - প্রোডাকশন মোডে চালু হয়েছে     ║
╚══════════════════════════════════════════════════════════╝

📡 লোকাল URL: http://localhost:${PORT}
🌍 লোকাল নেটওয়ার্ক: http://${require('os').networkInterfaces()['eth0']?.[0]?.address || '192.168.x.x'}:${PORT}

📊 পরিসংখ্যান:
   • সংযুক্ত সেশন: ${Object.keys(db.sessions).length}
   • অ্যাক্টিভ সেশন: ${Object.values(manager.readyStates).filter(v => v).length}
   • মোট মেসেজ: ${db.stats.totalMessages || 0}

🔗 API ব্যবহার করুন:

1️⃣ নতুন পেয়ারিং কোড জেনারেট:
   POST /pairing-code
   → রেসপন্স: { "code": "12345678" }

2️⃣ কোড দিয়ে কানেক্ট করুন:
   POST /connect
   Body: { "code": "12345678", "phoneNumber": "8801929671720" }

3️⃣ মেসেজ পাঠান (GET):
   GET /send-message?to=+8801929671720&text=হ্যালো

4️⃣ মেসেজ পাঠান (POST):
   POST /send-message
   Body: { "to": "+8801929671720", "message": "হ্যালো" }

5️⃣ স্ট্যাটাস দেখুন:
   GET /status

6️⃣ পরিসংখ্যান দেখুন:
   GET /stats

⚠️ গুরুত্বপূর্ণ:
   • প্রতিটি কোড ৫ মিনিটের জন্য বৈধ
   • একবার ব্যবহার করলে কোড মুছে যায়
   • সেশন অটোমেটিক্যালি সংরক্ষিত হয়
   • ডিসকানেক্ট হলে অটো রিকানেক্ট করে
`);
});

// গ্রেসফুল শাটডাউন
process.on('SIGINT', async () => {
    console.log('\n\n👋 সার্ভার বন্ধ হচ্ছে...');
    
    // সব সেশন ডিসকানেক্ট করুন
    for (const sessionId of Object.keys(manager.clients)) {
        try {
            await manager.clients[sessionId].destroy();
        } catch (e) {}
    }
    
    saveDatabase(db);
    console.log('✅ ডাটাবেস সংরক্ষিত হয়েছে');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n\n👋 সার্ভার বন্ধ হচ্ছে (SIGTERM)...');
    saveDatabase(db);
    process.exit(0);
});
