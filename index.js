const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const qrcode = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================================
// ডাটাবেস সেটআপ
// =============================================
const DB_PATH = path.join(__dirname, 'database.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function loadDatabase() {
    try {
        if (fs.existsSync(DB_PATH)) {
            return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        }
    } catch (error) {
        console.error('⚠️ ডাটাবেস লোড করতে সমস্যা:', error.message);
    }
    return {
        pairingRequests: {},
        sessions: {},
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

let db = loadDatabase();

// =============================================
// WhatsApp ম্যানেজার ক্লাস (সঠিক ভার্সন)
// =============================================
class WhatsAppManager {
    constructor() {
        this.clients = {};
        this.readyStates = {};
        this.pairingRequests = db.pairingRequests || {};
        
        console.log('\n🤖 WhatsApp ম্যানেজার চালু হচ্ছে...');
        console.log(`📊 সংযুক্ত সেশন: ${Object.keys(db.sessions).length}`);
        
        this.loadSessions();
        setInterval(() => this.cleanupExpiredRequests(), 60000);
    }
    
    loadSessions() {
        Object.entries(db.sessions).forEach(([sessionId, sessionData]) => {
            if (sessionData.status === 'active') {
                this.connectSession(sessionId, sessionData);
            }
        });
    }
    
    // **সঠিক পদ্ধতি: WhatsApp-এ পেয়ারিং কোড রিকোয়েস্ট করুন**
    async createPairingCode(phoneNumber) {
        try {
            // ফোন নম্বর ফরম্যাট করুন (কান্ট্রি কোড সহ, + ছাড়া)
            let formattedNumber = phoneNumber.replace(/\D/g, '');
            
            // ইউনিক রিকোয়েস্ট আইডি তৈরি
            const requestId = `req_${Date.now()}_${crypto.randomInt(1000, 9999)}`;
            
            // টেম্পোরারি ক্লায়েন্ট তৈরি করুন শুধু পেয়ারিং কোড জেনারেটের জন্য
            const tempClient = new Client({
                authStrategy: new LocalAuth({
                    clientId: `temp_${requestId}`,
                    dataPath: SESSIONS_DIR
                }),
                puppeteer: {
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                }
            });
            
            let pairingCode = null;
            let codeGenerated = false;
            
            // পেয়ারিং কোড ইভেন্ট
            tempClient.on('pairing-code', (code) => {
                console.log(`🔑 পেয়ারিং কোড জেনারেট হয়েছে: ${code}`);
                pairingCode = code;
                codeGenerated = true;
                
                // রিকোয়েস্ট ডাটাবেজে সংরক্ষণ
                this.pairingRequests[requestId] = {
                    requestId,
                    phoneNumber: formattedNumber,
                    pairingCode: code,
                    createdAt: Date.now(),
                    expiresAt: Date.now() + (5 * 60 * 1000), // 5 মিনিট
                    status: 'pending',
                    tempClientId: `temp_${requestId}`
                };
                
                db.pairingRequests = this.pairingRequests;
                saveDatabase(db);
            });
            
            // ক্লায়েন্ট রেডি হলে
            tempClient.on('ready', async () => {
                console.log(`📱 টেম্পোরারি ক্লায়েন্ট রেডি: ${formattedNumber}`);
                
                // যদি পেয়ারিং কোড এখনও জেনারেট না হয়ে থাকে, তাহলে রিকোয়েস্ট করুন
                if (!codeGenerated) {
                    try {
                        // **মূল লাইন: WhatsApp-এ পেয়ারিং কোড রিকোয়েস্ট করুন**
                        pairingCode = await tempClient.requestPairingCode(formattedNumber);
                        console.log(`🔑 পেয়ারিং কোড পেয়েছি: ${pairingCode}`);
                        
                        this.pairingRequests[requestId] = {
                            requestId,
                            phoneNumber: formattedNumber,
                            pairingCode,
                            createdAt: Date.now(),
                            expiresAt: Date.now() + (5 * 60 * 1000),
                            status: 'pending',
                            tempClientId: `temp_${requestId}`
                        };
                        
                        db.pairingRequests = this.pairingRequests;
                        saveDatabase(db);
                    } catch (error) {
                        console.error('❌ পেয়ারিং কোড রিকোয়েস্ট করতে সমস্যা:', error);
                    }
                }
            });
            
            // ক্লায়েন্ট ইনিশিয়ালাইজ করুন
            await tempClient.initialize();
            
            // ১০ সেকেন্ড পর্যন্ত অপেক্ষা করুন কোড জেনারেট হওয়ার জন্য
            let waitCount = 0;
            while (!pairingCode && waitCount < 20) {
                await new Promise(resolve => setTimeout(resolve, 500));
                waitCount++;
            }
            
            if (!pairingCode) {
                throw new Error('পেয়ারিং কোড জেনারেট করা যায়নি');
            }
            
            // কোড ফরম্যাট করুন (৮ ডিজিট, যেমন: 7777 7777)
            const formattedCode = this.formatPairingCode(pairingCode);
            
            return {
                success: true,
                requestId,
                pairingCode: pairingCode,
                formattedCode: formattedCode,
                expiresIn: '5 minutes',
                instructions: `WhatsApp → Linked Devices → Link with number instead → এই কোড দিন: ${formattedCode}`
            };
            
        } catch (error) {
            console.error('❌ পেয়ারিং কোড তৈরি করতে সমস্যা:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // পেয়ারিং কোড ফরম্যাট করুন (8 ডিজিট, যেমন: 7777 7777)
    formatPairingCode(code) {
        if (!code) return '';
        // কোড থেকে সব non-digit বাদ দিন
        const digits = code.replace(/\D/g, '');
        // 8 ডিজিটে ফরম্যাট করুন (XXXX XXXX)
        if (digits.length >= 8) {
            return `${digits.substring(0, 4)} ${digits.substring(4, 8)}`;
        }
        return digits;
    }
    
    // পেয়ারিং কোড দিয়ে সেশন কনফার্ম করুন
    async confirmSessionWithCode(requestId, phoneNumber) {
        try {
            const request = this.pairingRequests[requestId];
            
            if (!request) {
                return { success: false, error: '❌ রিকোয়েস্ট পাওয়া যায়নি' };
            }
            
            if (request.status !== 'pending') {
                return { success: false, error: '❌ এই রিকোয়েস্ট ইতিমধ্যে ব্যবহার করা হয়েছে' };
            }
            
            if (Date.now() > request.expiresAt) {
                delete this.pairingRequests[requestId];
                db.pairingRequests = this.pairingRequests;
                saveDatabase(db);
                return { success: false, error: '❌ রিকোয়েস্টের মেয়াদ শেষ' };
            }
            
            const formattedNumber = phoneNumber.replace(/\D/g, '');
            const sessionId = `session_${formattedNumber}_${Date.now()}`;
            
            const sessionData = {
                sessionId,
                phoneNumber: formattedNumber,
                createdAt: Date.now(),
                lastActive: Date.now(),
                status: 'initializing',
                messageCount: 0,
                requestId: requestId
            };
            
            db.sessions[sessionId] = sessionData;
            
            // রিকোয়েস্ট আপডেট করুন
            request.status = 'used';
            request.sessionId = sessionId;
            request.usedAt = Date.now();
            db.pairingRequests = this.pairingRequests;
            saveDatabase(db);
            
            // মূল সেশন কানেক্ট করুন
            await this.connectSession(sessionId, sessionData);
            
            return {
                success: true,
                sessionId,
                phoneNumber: formattedNumber,
                message: '✅ সেশন তৈরি হচ্ছে। অনুগ্রহ করে অপেক্ষা করুন...'
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
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                }
            });
            
            client.on('ready', () => {
                console.log(`✅ সেশন কানেক্টেড: ${sessionData.phoneNumber}`);
                this.clients[sessionId] = client;
                this.readyStates[sessionId] = true;
                
                sessionData.status = 'active';
                sessionData.connectedAt = Date.now();
                saveDatabase(db);
            });
            
            client.on('disconnected', (reason) => {
                console.log(`❌ সেশন ডিসকানেক্ট: ${sessionData.phoneNumber} - ${reason}`);
                this.readyStates[sessionId] = false;
                sessionData.status = 'disconnected';
                saveDatabase(db);
                
                setTimeout(() => {
                    if (sessionData.status !== 'active') {
                        this.connectSession(sessionId, sessionData);
                    }
                }, 10000);
            });
            
            await client.initialize();
            
        } catch (error) {
            console.error(`❌ সেশন এরর:`, error.message);
            setTimeout(() => {
                this.connectSession(sessionId, sessionData);
            }, 30000);
        }
    }
    
    // মেসেজ পাঠান
    async sendMessage(sessionId, to, message) {
        try {
            let targetSessionId = sessionId;
            
            if (!this.readyStates[targetSessionId]) {
                const activeSession = Object.keys(this.readyStates).find(id => this.readyStates[id]);
                if (activeSession) {
                    targetSessionId = activeSession;
                } else {
                    throw new Error('কোনো অ্যাক্টিভ সেশন নেই');
                }
            }
            
            const client = this.clients[targetSessionId];
            if (!client) throw new Error('ক্লায়েন্ট পাওয়া যায়নি');
            
            let formattedNumber = to.replace(/\D/g, '');
            if (!formattedNumber.startsWith('88')) {
                formattedNumber = '88' + formattedNumber;
            }
            formattedNumber = `${formattedNumber}@c.us`;
            
            const response = await client.sendMessage(formattedNumber, message);
            
            if (db.sessions[targetSessionId]) {
                db.sessions[targetSessionId].lastActive = Date.now();
                db.sessions[targetSessionId].messageCount++;
                db.stats.totalMessages++;
                saveDatabase(db);
            }
            
            return {
                success: true,
                messageId: response.id.id,
                from: db.sessions[targetSessionId]?.phoneNumber
            };
            
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    
    // মেয়াদোত্তীর্ণ রিকোয়েস্ট ক্লিনআপ
    cleanupExpiredRequests() {
        let cleaned = 0;
        Object.entries(this.pairingRequests).forEach(([id, data]) => {
            if (Date.now() > data.expiresAt) {
                delete this.pairingRequests[id];
                cleaned++;
            }
        });
        
        if (cleaned > 0) {
            db.pairingRequests = this.pairingRequests;
            saveDatabase(db);
            console.log(`🧹 ${cleaned} টি মেয়াদোত্তীর্ণ রিকোয়েস্ট ক্লিনআপ`);
        }
    }
    
    getStatus() {
        const status = {};
        Object.entries(db.sessions).forEach(([id, data]) => {
            status[id] = {
                phoneNumber: data.phoneNumber,
                status: data.status,
                isReady: this.readyStates[id] || false,
                connectedAt: data.connectedAt,
                messageCount: data.messageCount || 0
            };
        });
        return status;
    }
}

// =============================================
// ম্যানেজার ইনিশিয়ালাইজ
// =============================================
const manager = new WhatsAppManager();

// =============================================
// API এন্ডপয়েন্ট (আপডেটেড)
// =============================================

app.get('/', (req, res) => {
    res.json({
        app: '🤖 WhatsApp Link API (সঠিক পেয়ারিং কোড সহ)',
        version: '3.0.0',
        status: 'running',
        endpoints: {
            'GET /': 'এই তথ্য',
            'GET /status': 'সব সেশনের স্ট্যাটাস',
            'POST /request-pairing': 'পেয়ারিং কোড রিকোয়েস্ট করুন (ফোন নম্বর দিয়ে)',
            'POST /confirm-pairing': 'পেয়ারিং কনফার্ম করুন',
            'POST /send-message': 'মেসেজ পাঠান',
            'GET /send-message': 'মেসেজ পাঠান (GET)'
        }
    });
});

// **নতুন এন্ডপয়েন্ট: পেয়ারিং কোড রিকোয়েস্ট করুন**
app.post('/request-pairing', async (req, res) => {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({
            success: false,
            error: 'phoneNumber প্রয়োজন (যেমন: 8801929671720)'
        });
    }
    
    const result = await manager.createPairingCode(phoneNumber);
    res.json(result);
});

// **নতুন এন্ডপয়েন্ট: পেয়ারিং কনফার্ম করুন**
app.post('/confirm-pairing', (req, res) => {
    const { requestId, phoneNumber } = req.body;
    
    if (!requestId || !phoneNumber) {
        return res.status(400).json({
            success: false,
            error: 'requestId এবং phoneNumber প্রয়োজন'
        });
    }
    
    manager.confirmSessionWithCode(requestId, phoneNumber)
        .then(result => res.json(result));
});

// মেসেজ পাঠান
app.post('/send-message', async (req, res) => {
    const { to, message } = req.body;
    
    if (!to || !message) {
        return res.status(400).json({
            success: false,
            error: 'to এবং message প্রয়োজন'
        });
    }
    
    const result = await manager.sendMessage(null, to, message);
    res.json(result);
});

app.get('/send-message', async (req, res) => {
    const { to, text } = req.query;
    
    if (!to || !text) {
        return res.json({
            success: false,
            error: 'to এবং text প্রয়োজন',
            example: '/send-message?to=+8801929671720&text=হ্যালো'
        });
    }
    
    const result = await manager.sendMessage(null, to, text);
    res.json(result);
});

app.get('/status', (req, res) => {
    res.json({
        success: true,
        sessions: manager.getStatus(),
        activeCount: Object.values(manager.readyStates).filter(v => v).length
    });
});

// =============================================
// সার্ভার চালু
// =============================================
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║   🚀 WhatsApp Link API (সঠিক পেয়ারিং কোড সহ) চালু হয়েছে   ║
╚══════════════════════════════════════════════════════════╝

📡 URL: http://localhost:${PORT}

🔑 **সঠিক পদ্ধতি:** 
   
1️⃣ পেয়ারিং কোড রিকোয়েস্ট করুন:
   POST /request-pairing
   Body: { "phoneNumber": "8801929671720" }
   
   রেসপন্স: { 
     "success": true, 
     "requestId": "req_12345",
     "pairingCode": "77777777",
     "formattedCode": "7777 7777"
   }

2️⃣ WhatsApp-এ কোড দিন:
   WhatsApp → Linked Devices → Link with number instead
   কোড: 7777 7777

3️⃣ পেয়ারিং কনফার্ম করুন:
   POST /confirm-pairing
   Body: { 
     "requestId": "req_12345",
     "phoneNumber": "8801929671720" 
   }

4️⃣ মেসেজ পাঠান:
   GET /send-message?to=+8801929671720&text=হ্যালো
`);
});
