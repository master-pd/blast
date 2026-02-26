const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// মিডলওয়্যার
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// সেশন ফোল্ডার
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ডাটাবেস ফাইল
const DB_FILE = path.join(__dirname, 'database.json');

// ডাটাবেস ফাংশন
function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) {}
    return { 
        sessions: {}, 
        pendingPairs: {},
        stats: { totalMessages: 0 }
    };
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let db = loadDB();

// =============================================
// 8-ডিজিট পেয়ারিং কোড জেনারেটর
// =============================================
function generatePairingCode() {
    return crypto.randomInt(10000000, 99999999).toString();
}

// =============================================
// WhatsApp ম্যানেজার (পেয়ারিং কোড ভার্শন)
// =============================================
class WhatsAppManager {
    constructor() {
        this.clients = {};
        this.readyStates = {};
        this.pendingPairs = db.pendingPairs || {};
        
        console.log('🤖 WhatsApp ম্যানেজার চালু হচ্ছে...');
        console.log(`📊 সংযুক্ত সেশন: ${Object.keys(db.sessions).length}`);
        
        // আগের সেশন লোড
        this.loadSessions();
        
        // প্রতি মিনিটে মেয়াদোত্তীর্ণ পেয়ারিং কোড ক্লিনআপ
        setInterval(() => this.cleanupExpiredPairs(), 60000);
    }
    
    loadSessions() {
        Object.entries(db.sessions).forEach(([sessionId, sessionData]) => {
            if (sessionData.status === 'active') {
                this.connectSession(sessionId, sessionData);
            }
        });
    }
    
    // নতুন পেয়ারিং কোড তৈরি
    createPairingCode(phoneNumber) {
        const code = generatePairingCode();
        const sessionId = `session_${phoneNumber}_${Date.now()}`;
        const expiresAt = Date.now() + (3 * 60 * 1000); // ৩ মিনিট
        
        this.pendingPairs[code] = {
            code,
            sessionId,
            phoneNumber,
            createdAt: Date.now(),
            expiresAt,
            status: 'pending'
        };
        
        db.pendingPairs = this.pendingPairs;
        saveDB(db);
        
        // ব্যাকগ্রাউন্ডে সেশন তৈরি শুরু করুন
        this.initializePairingSession(sessionId, phoneNumber, code);
        
        return {
            success: true,
            code,
            sessionId,
            expiresIn: '3 minutes',
            instructions: [
                '1️⃣ আপনার WhatsApp খুলুন',
                '2️⃣ তিন ডট মেনু → Linked Devices',
                '3️⃣ "Link with number instead" বাটনে ক্লিক করুন',
                '4️⃣ এই 8-ডিজিটের কোডটি দিন: ' + code,
                '5️⃣ এরপর অপেক্ষা করুন, অটো কানেক্ট হবে'
            ]
        };
    }
    
    // পেয়ারিং সেশন শুরু করুন
    async initializePairingSession(sessionId, phoneNumber, pairCode) {
        try {
            console.log(`🔄 নতুন সেশন তৈরি হচ্ছে: ${phoneNumber}`);
            
            const client = new Client({
                authStrategy: new LocalAuth({
                    clientId: sessionId,
                    dataPath: SESSIONS_DIR
                }),
                puppeteer: {
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                }
            });
            
            // পেয়ারিং কোড জেনারেট হওয়ার ইভেন্ট
            client.on('pairing-code', (code) => {
                console.log(`🔑 পেয়ারিং কোড তৈরি হয়েছে: ${code}`);
                // আমরা আগেই কোড জেনারেট করেছি, তাই এটা শুধু লগ
            });
            
            // রেডি হলে
            client.on('ready', () => {
                console.log(`✅ সেশন কানেক্টেড: ${phoneNumber}`);
                
                this.clients[sessionId] = client;
                this.readyStates[sessionId] = true;
                
                // ডাটাবেস আপডেট
                db.sessions[sessionId] = {
                    phoneNumber,
                    status: 'active',
                    connectedAt: Date.now(),
                    lastActive: Date.now(),
                    messageCount: 0
                };
                
                // পেন্ডিং পেয়ারিং ডিলিট
                if (pairCode && this.pendingPairs[pairCode]) {
                    delete this.pendingPairs[pairCode];
                    db.pendingPairs = this.pendingPairs;
                }
                
                saveDB(db);
            });
            
            // ডিসকানেক্ট হলে
            client.on('disconnected', (reason) => {
                console.log(`❌ ডিসকানেক্টেড: ${phoneNumber} - ${reason}`);
                this.readyStates[sessionId] = false;
                
                if (db.sessions[sessionId]) {
                    db.sessions[sessionId].status = 'disconnected';
                    saveDB(db);
                }
                
                // ১০ সেকেন্ড পর রিকানেক্ট
                setTimeout(() => {
                    this.initializePairingSession(sessionId, phoneNumber, pairCode);
                }, 10000);
            });
            
            // অথেন্টিকেটেড ইভেন্ট
            client.on('authenticated', () => {
                console.log(`🔐 অথেন্টিকেটেড: ${phoneNumber}`);
            });
            
            // অথেনটিকেশন ফেইলিউর
            client.on('auth_failure', (msg) => {
                console.log(`❌ অথেন্টিকেশন ফেইল: ${phoneNumber} - ${msg}`);
            });
            
            await client.initialize();
            
        } catch (error) {
            console.error(`❌ সেশন এরর ${phoneNumber}:`, error.message);
        }
    }
    
    // পেয়ারিং কোড ভেরিফাই
    verifyPairingCode(code) {
        const pairData = this.pendingPairs[code];
        
        if (!pairData) {
            return { valid: false, error: '❌ ভুল কোড' };
        }
        
        if (Date.now() > pairData.expiresAt) {
            delete this.pendingPairs[code];
            db.pendingPairs = this.pendingPairs;
            saveDB(db);
            return { valid: false, error: '❌ কোডের মেয়াদ শেষ' };
        }
        
        return { valid: true, data: pairData };
    }
    
    // মেসেজ পাঠান
    async sendMessage(to, message, sessionId = null) {
        try {
            // যদি সেশন আইডি না দেওয়া হয়, প্রথম অ্যাক্টিভ সেশন খুঁজি
            if (!sessionId) {
                const activeSession = Object.keys(this.readyStates).find(id => this.readyStates[id]);
                if (activeSession) {
                    sessionId = activeSession;
                } else {
                    throw new Error('কোনো অ্যাক্টিভ সেশন নেই');
                }
            }
            
            if (!this.readyStates[sessionId]) {
                throw new Error('সেশন রেডি নয়');
            }
            
            const client = this.clients[sessionId];
            
            // নম্বর ফরম্যাট
            let formattedNumber = to.replace(/\D/g, '');
            if (!formattedNumber.startsWith('88')) {
                formattedNumber = '88' + formattedNumber;
            }
            formattedNumber = `${formattedNumber}@c.us`;
            
            const response = await client.sendMessage(formattedNumber, message);
            
            // ডাটাবেস আপডেট
            if (db.sessions[sessionId]) {
                db.sessions[sessionId].messageCount++;
                db.sessions[sessionId].lastActive = Date.now();
                db.stats.totalMessages++;
                saveDB(db);
            }
            
            return {
                success: true,
                messageId: response.id.id,
                from: db.sessions[sessionId]?.phoneNumber || 'unknown'
            };
            
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    
    // মেয়াদোত্তীর্ণ পেয়ারিং কোড ক্লিনআপ
    cleanupExpiredPairs() {
        let cleaned = 0;
        Object.entries(this.pendingPairs).forEach(([code, data]) => {
            if (Date.now() > data.expiresAt) {
                delete this.pendingPairs[code];
                cleaned++;
            }
        });
        
        if (cleaned > 0) {
            db.pendingPairs = this.pendingPairs;
            saveDB(db);
            console.log(`🧹 ${cleaned} টি মেয়াদোত্তীর্ণ কোড ক্লিনআপ করা হয়েছে`);
        }
    }
    
    // সব সেশনের স্ট্যাটাস
    getStatus() {
        const status = {};
        Object.entries(db.sessions).forEach(([id, data]) => {
            status[id] = {
                ...data,
                isReady: this.readyStates[id] || false
            };
        });
        return status;
    }
    
    // পেন্ডিং কোডের তালিকা
    getPendingPairs() {
        return Object.values(this.pendingPairs).map(p => ({
            code: p.code,
            phoneNumber: p.phoneNumber,
            expiresAt: p.expiresAt,
            timeLeft: Math.max(0, Math.floor((p.expiresAt - Date.now()) / 1000)) + ' সেকেন্ড'
        }));
    }
}

// ম্যানেজার ইনিশিয়ালাইজ
const manager = new WhatsAppManager();

// =============================================
// API এন্ডপয়েন্ট
// =============================================

// হোম পেজ
app.get('/', (req, res) => {
    res.json({
        app: '🤖 WhatsApp API (পেয়ারিং কোড সিস্টেম)',
        version: '4.0.0',
        status: 'running',
        endpoints: {
            'GET /': 'এই তথ্য',
            'GET /status': 'সব সেশনের স্ট্যাটাস',
            'POST /pair': 'নতুন পেয়ারিং কোড তৈরি (ফোন নম্বর দিয়ে)',
            'GET /verify/:code': 'কোড ভেরিফাই করুন',
            'GET /pending': 'পেন্ডিং কোডের তালিকা',
            'POST /send': 'মেসেজ পাঠান',
            'GET /send': 'মেসেজ পাঠান (GET)',
            'DELETE /session/:id': 'সেশন ডিসকানেক্ট'
        },
        stats: {
            activeSessions: Object.values(manager.readyStates).filter(v => v).length,
            totalSessions: Object.keys(db.sessions).length,
            pendingPairs: Object.keys(manager.pendingPairs).length,
            totalMessages: db.stats.totalMessages || 0
        }
    });
});

// স্ট্যাটাস
app.get('/status', (req, res) => {
    res.json({
        success: true,
        sessions: manager.getStatus(),
        pendingPairs: manager.getPendingPairs()
    });
});

// নতুন পেয়ারিং কোড তৈরি (ফোন নম্বর দিয়ে)
app.post('/pair', (req, res) => {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({
            success: false,
            error: 'phoneNumber প্রয়োজন'
        });
    }
    
    // নম্বর ফরম্যাট ঠিক করা
    let cleanNumber = phoneNumber.replace(/\D/g, '');
    if (!cleanNumber.startsWith('88')) {
        cleanNumber = '88' + cleanNumber;
    }
    
    const result = manager.createPairingCode(cleanNumber);
    res.json(result);
});

// কোড ভেরিফাই
app.get('/verify/:code', (req, res) => {
    const { code } = req.params;
    const verification = manager.verifyPairingCode(code);
    
    if (verification.valid) {
        res.json({
            success: true,
            message: '✅ কোড সঠিক আছে',
            sessionId: verification.data.sessionId,
            phoneNumber: verification.data.phoneNumber
        });
    } else {
        res.json({
            success: false,
            error: verification.error
        });
    }
});

// পেন্ডিং কোডের তালিকা
app.get('/pending', (req, res) => {
    res.json({
        success: true,
        pendingPairs: manager.getPendingPairs()
    });
});

// মেসেজ পাঠান (POST)
app.post('/send', async (req, res) => {
    const { to, message, sessionId } = req.body;
    
    if (!to || !message) {
        return res.status(400).json({
            success: false,
            error: 'to এবং message প্রয়োজন'
        });
    }
    
    const result = await manager.sendMessage(to, message, sessionId);
    res.json(result);
});

// মেসেজ পাঠান (GET)
app.get('/send', async (req, res) => {
    const { to, text, session } = req.query;
    
    if (!to || !text) {
        return res.json({
            success: false,
            error: 'to এবং text প্রয়োজন'
        });
    }
    
    const result = await manager.sendMessage(to, text, session);
    res.json(result);
});

// সেশন ডিসকানেক্ট
app.delete('/session/:id', (req, res) => {
    const { id } = req.params;
    
    if (manager.clients[id]) {
        manager.clients[id].destroy();
        delete manager.clients[id];
        delete manager.readyStates[id];
        
        if (db.sessions[id]) {
            db.sessions[id].status = 'disconnected';
            saveDB(db);
        }
        
        res.json({ success: true, message: 'সেশন ডিসকানেক্ট করা হয়েছে' });
    } else {
        res.json({ success: false, error: 'সেশন পাওয়া যায়নি' });
    }
});

// হেলথ চেক
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: Date.now(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// =============================================
// সার্ভার চালু
// =============================================
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║     🚀 WhatsApp API (পেয়ারিং কোড সিস্টেম) চালু হয়েছে    ║
╚══════════════════════════════════════════════════════════╝

📡 লোকাল URL: http://localhost:${PORT}
🌍 লোকাল নেটওয়ার্ক: http://${require('os').networkInterfaces()['eth0']?.[0]?.address || '192.168.x.x'}:${PORT}

📊 পরিসংখ্যান:
   • সংযুক্ত সেশন: ${Object.keys(db.sessions).length}
   • অ্যাক্টিভ সেশন: ${Object.values(manager.readyStates).filter(v => v).length}
   • পেন্ডিং কোড: ${Object.keys(manager.pendingPairs).length}
   • মোট মেসেজ: ${db.stats.totalMessages || 0}

🔗 API ব্যবহার করুন:

1️⃣ নতুন পেয়ারিং কোড তৈরি করুন:
   POST /pair
   Body: { "phoneNumber": "8801929671720" }

   রেসপন্স: { "code": "12345678", "instructions": [...] }

2️⃣ WhatsApp-এ কোড দিন:
   ➡️ WhatsApp → তিন ডট মেনু → Linked Devices
   ➡️ "Link with number instead" → 8-ডিজিট কোড দিন

3️⃣ কোড ভেরিফাই করুন:
   GET /verify/12345678

4️⃣ মেসেজ পাঠান:
   GET /send?to=+8801929671720&text=হ্যালো
   অথবা POST /send

5️⃣ স্ট্যাটাস দেখুন:
   GET /status

⚠️ গুরুত্বপূর্ণ:
   • কোড ৩ মিনিটের জন্য বৈধ
   • আপনার ফোন দিয়েই কোড দিতে পারবেন
   • একবার কানেক্ট হলে সেশন সংরক্ষিত হবে
   • ডিসকানেক্ট হলে অটো রিকানেক্ট করবে
`);
});

// গ্রেসফুল শাটডাউন
process.on('SIGINT', () => {
    console.log('\n👋 সার্ভার বন্ধ হচ্ছে...');
    saveDB(db);
    process.exit(0);
});
