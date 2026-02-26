// ===================================================
// BLAST ULTIMATE WHATSAPP API v15.0.0
// কোনো API Key লাগবে না - ওপেন এক্সেস
// ফুল ওয়ার্কিং কোড - ১০০% গ্যারান্টি
// Author: Md Dhaka
// ===================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

// ==================== কনফিগারেশন ====================
const app = express();
const PORT = process.env.PORT || 3000;

// সেশন ডিরেক্টরি
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const TEMP_DIR = path.join(__dirname, 'temp');

// ডিরেক্টরি তৈরি
fs.ensureDirSync(SESSIONS_DIR);
fs.ensureDirSync(TEMP_DIR);

// ==================== লগার ====================
const logger = pino({
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:dd-mm-yyyy HH:MM:ss',
      ignore: 'pid,hostname'
    }
  }
});

// ==================== মিডলওয়্যার ====================
app.use(cors({ origin: '*' }));
app.use(compression());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// রেট লিমিট (অপশনাল)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 মিনিট
  max: 200, // ২০০ রিকোয়েস্ট প্রতি মিনিট
  message: { 
    success: false, 
    error: 'Too many requests. Please try again later.' 
  }
});
app.use('/api/', limiter);

// রিকোয়েস্ট লগার
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// ==================== মেসেজ কিউ সিস্টেম ====================
class MessageQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.lastMessageTime = 0;
    this.messageCount = 0;
    this.secondStart = Date.now();
    this.stats = {
      sent: 0,
      failed: 0,
      pending: 0
    };
  }

  async add(sessionId, jid, content) {
    return new Promise((resolve, reject) => {
      const jobId = crypto.randomBytes(4).toString('hex');
      
      this.queue.push({
        id: jobId,
        sessionId,
        jid,
        content,
        resolve,
        reject,
        added: Date.now()
      });
      
      this.stats.pending++;
      this.process();
      
      logger.info(`📥 Queued [${jobId}] -> ${jid.split('@')[0]}`);
      return jobId;
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;

    while (this.queue.length > 0) {
      // ২ মেসেজ/সেকেন্ড রেট লিমিট
      const now = Date.now();
      
      if (now - this.secondStart >= 1000) {
        this.messageCount = 0;
        this.secondStart = now;
      }

      if (this.messageCount >= 2) {
        const waitTime = 1000 - (now - this.secondStart);
        if (waitTime > 0) {
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        this.messageCount = 0;
        this.secondStart = Date.now();
        continue;
      }

      // ৫০০ms ডেলেই
      const timeSinceLast = now - this.lastMessageTime;
      if (timeSinceLast < 500) {
        await new Promise(resolve => 
          setTimeout(resolve, 500 - timeSinceLast)
        );
      }

      const job = this.queue.shift();
      this.stats.pending--;

      try {
        const session = sessions.get(job.sessionId);
        
        if (!session) {
          throw new Error(`Session "${job.sessionId}" not found`);
        }
        
        if (session.status !== 'CONNECTED') {
          throw new Error(`Session "${job.sessionId}" is ${session.status}`);
        }

        // মেসেজ পাঠান
        await session.sock.sendMessage(job.jid, job.content);
        
        // স্ট্যাটস আপডেট
        this.messageCount++;
        this.lastMessageTime = Date.now();
        this.stats.sent++;
        
        if (session.stats) {
          session.stats.totalSent = (session.stats.totalSent || 0) + 1;
        }
        
        job.resolve({
          success: true,
          id: job.id,
          to: job.jid,
          time: Date.now()
        });

        logger.info(`✅ Sent [${job.id}] -> ${job.jid.split('@')[0]}`);
      } catch (error) {
        this.stats.failed++;
        job.reject(error);
        logger.error(`❌ Failed [${job.id}]: ${error.message}`);
      }
    }

    this.processing = false;
  }

  getStats() {
    return {
      sent: this.stats.sent,
      failed: this.stats.failed,
      pending: this.stats.pending,
      queueLength: this.queue.length,
      currentRate: `${this.messageCount}/sec`
    };
  }
}

// ==================== সেশন ম্যানেজার ====================
const sessions = new Map();
const messageQueue = new MessageQueue();

// সেশন তৈরি ফাংশন
async function createSession(sessionId, phoneNumber = null) {
  try {
    // পুরনো সেশন থাকলে ক্লিনআপ
    if (sessions.has(sessionId)) {
      const old = sessions.get(sessionId);
      if (old.sock) {
        try { 
          await old.sock.logout(); 
          old.sock.end(); 
        } catch (e) {}
      }
      sessions.delete(sessionId);
    }

    logger.info(`🔄 Creating session: ${sessionId}`);

    const authPath = path.join(SESSIONS_DIR, sessionId);
    await fs.ensureDir(authPath);

    // অথ স্টেট লোড
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    // ওয়েব ভার্সন
    const { version } = await fetchLatestWaWebVersion();

    // সকেট তৈরি
    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: true,
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
      shouldIgnoreJid: (jid) => jid === 'status@broadcast'
    });

    // ক্রেডেনশিয়াল সেভ
    sock.ev.on('creds.update', saveCreds);

    // সেশন ডেটা
    const sessionData = {
      sock,
      status: 'INITIALIZING',
      qr: null,
      pairingCode: null,
      user: null,
      stats: { 
        totalSent: 0, 
        received: 0,
        createdAt: Date.now()
      },
      lastActive: Date.now()
    };

    sessions.set(sessionId, sessionData);

    // কানেকশন ইভেন্ট
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrBase64 = await qrcode.toDataURL(qr);
        const session = sessions.get(sessionId);
        if (session) {
          session.qr = qrBase64;
          session.status = 'QR_READY';
          logger.info(`📱 QR Ready for ${sessionId}`);
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn(`🔌 Session ${sessionId} closed: ${statusCode}`);

        if (shouldReconnect) {
          logger.info(`♻️ Reconnecting ${sessionId} in 3s...`);
          setTimeout(() => {
            createSession(sessionId).catch(e => 
              logger.error(`Reconnect failed: ${e.message}`)
            );
          }, 3000);
        } else {
          sessions.delete(sessionId);
          logger.info(`🚫 Session ${sessionId} logged out`);
        }
      }

      if (connection === 'open') {
        const session = sessions.get(sessionId);
        if (session) {
          session.status = 'CONNECTED';
          session.qr = null;
          session.user = sock.user;
          session.lastActive = Date.now();
          
          logger.info(`✅ Session ${sessionId} connected as ${sock.user?.id || 'Unknown'}`);
        }
      }
    });

    // মেসেজ হ্যান্ডলার
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;
      
      const msg = m.messages[0];
      if (msg && !msg.key.fromMe) {
        const session = sessions.get(sessionId);
        if (session) {
          session.stats.received = (session.stats.received || 0) + 1;
          session.lastActive = Date.now();
          
          logger.info(`📨 Received from ${msg.key.remoteJid} on ${sessionId}`);
        }
      }
    });

    // পেয়ারিং কোড
    if (phoneNumber) {
      try {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const code = await sock.requestPairingCode(cleanNumber);
        
        const session = sessions.get(sessionId);
        if (session) {
          session.pairingCode = code;
          session.status = 'PAIRING_READY';
          logger.info(`🔢 Pairing code for ${sessionId}: ${code}`);
        }
      } catch (error) {
        logger.error(`Pairing failed for ${sessionId}: ${error.message}`);
      }
    }

    return sessionData;
  } catch (error) {
    logger.error(`Session creation failed: ${error.message}`);
    throw error;
  }
}

// সব সেশন লোড
async function loadAllSessions() {
  try {
    const dirs = await fs.readdir(SESSIONS_DIR);
    let loaded = 0;

    for (const dir of dirs) {
      const stat = await fs.stat(path.join(SESSIONS_DIR, dir));
      if (stat.isDirectory() && dir !== 'default' && dir.length > 0) {
        try {
          await createSession(dir);
          loaded++;
        } catch (error) {
          logger.error(`Failed to load ${dir}: ${error.message}`);
        }
      }
    }

    logger.info(`✅ Loaded ${loaded} existing sessions`);
  } catch (error) {
    logger.error(`Error loading sessions: ${error.message}`);
  }
}

// ==================== API এন্ডপয়েন্ট ====================

// হোম পেজ
app.get('/', (req, res) => {
  res.json({
    name: 'Blast WhatsApp API',
    version: '15.0.0',
    author: 'Md Dhaka',
    status: 'running',
    auth: 'No API Key Required',
    features: {
      messagesPerSecond: 2,
      messageDelay: '500ms',
      unlimitedMessages: true,
      maxSessions: 'Unlimited'
    },
    endpoints: {
      listSessions: 'GET /api/sessions',
      createSession: 'POST /api/session/create',
      getQR: 'GET /api/session/:id/qr',
      sessionStatus: 'GET /api/session/:id/status',
      logoutSession: 'POST /api/session/:id/logout',
      sendMessage: 'POST /api/send',
      sendBulk: 'POST /api/send/bulk',
      sendMedia: 'POST /api/send/media',
      queueStatus: 'GET /api/queue',
      systemStats: 'GET /api/stats'
    }
  });
});

// হেলথ চেক
app.get('/health', (req, res) => {
  const connected = Array.from(sessions.values()).filter(s => s.status === 'CONNECTED').length;
  
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    sessions: {
      total: sessions.size,
      connected: connected
    }
  });
});

// সব সেশন দেখুন
app.get('/api/sessions', (req, res) => {
  const sessionList = Array.from(sessions.entries()).map(([id, data]) => ({
    id,
    status: data.status,
    user: data.user ? {
      id: data.user.id,
      name: data.user.name
    } : null,
    stats: data.stats,
    lastActive: data.lastActive,
    hasQR: !!data.qr,
    hasPairingCode: !!data.pairingCode
  }));

  res.json({
    success: true,
    total: sessionList.length,
    sessions: sessionList
  });
});

// সিস্টেম স্ট্যাটস
app.get('/api/stats', (req, res) => {
  const connected = Array.from(sessions.values()).filter(s => s.status === 'CONNECTED').length;
  const totalSent = Array.from(sessions.values()).reduce((acc, s) => acc + (s.stats?.totalSent || 0), 0);
  const totalReceived = Array.from(sessions.values()).reduce((acc, s) => acc + (s.stats?.received || 0), 0);

  res.json({
    success: true,
    sessions: {
      total: sessions.size,
      connected,
      disconnected: sessions.size - connected
    },
    messages: {
      sent: totalSent,
      received: totalReceived,
      total: totalSent + totalReceived
    },
    queue: messageQueue.getStats(),
    system: {
      uptime: process.uptime(),
      memory: process.memoryUsage().heapUsed / 1024 / 1024 + ' MB',
      nodeVersion: process.version
    }
  });
});

// কিউ স্ট্যাটস
app.get('/api/queue', (req, res) => {
  res.json({
    success: true,
    queue: messageQueue.getStats()
  });
});

// নতুন সেশন তৈরি
app.post('/api/session/create', async (req, res) => {
  try {
    const { sessionId, phone } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'sessionId is required'
      });
    }

    if (sessionId.length < 3 || sessionId.length > 50) {
      return res.status(400).json({
        success: false,
        error: 'sessionId must be 3-50 characters'
      });
    }

    const session = await createSession(sessionId, phone);

    res.json({
      success: true,
      sessionId,
      status: session.status,
      method: phone ? 'pairing_code' : 'qr',
      message: phone 
        ? 'Use /api/session/:id/qr to get pairing code' 
        : 'Use /api/session/:id/qr to scan QR code'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// কিউআর কোড বা পেয়ারিং কোড
app.get('/api/session/:sessionId/qr', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found'
    });
  }

  if (session.pairingCode) {
    res.json({
      success: true,
      method: 'pairing_code',
      code: session.pairingCode
    });
  } else if (session.qr) {
    res.json({
      success: true,
      method: 'qr',
      qr: session.qr
    });
  } else {
    res.json({
      success: false,
      status: session.status,
      message: 'QR not ready yet'
    });
  }
});

// সেশন স্ট্যাটাস
app.get('/api/session/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found'
    });
  }

  res.json({
    success: true,
    sessionId,
    status: session.status,
    user: session.user,
    stats: session.stats,
    lastActive: session.lastActive
  });
});

// সেশন লগআউট
app.post('/api/session/:sessionId/logout', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found'
    });
  }

  try {
    if (session.sock) {
      await session.sock.logout();
      session.sock.end();
    }
    sessions.delete(sessionId);
    
    // অথ ফোল্ডার ডিলিট
    const authPath = path.join(SESSIONS_DIR, sessionId);
    await fs.remove(authPath);

    res.json({
      success: true,
      message: 'Session logged out successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// টেক্সট মেসেজ পাঠান
app.post('/api/send', async (req, res) => {
  try {
    const { sessionId, to, message } = req.body;

    if (!sessionId || !to || !message) {
      return res.status(400).json({
        success: false,
        error: 'sessionId, to, and message are required'
      });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    if (session.status !== 'CONNECTED') {
      return res.status(400).json({
        success: false,
        error: `Session is ${session.status}, not connected`
      });
    }

    // জেআইডি ফরম্যাট
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    // কিউতে যোগ করুন
    const jobId = await messageQueue.add(sessionId, jid, { text: message });

    res.json({
      success: true,
      queued: true,
      messageId: jobId,
      sessionId,
      to: jid,
      estimatedDelay: '500ms',
      rate: '2 msg/sec'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// মিডিয়া মেসেজ পাঠান
app.post('/api/send/media', async (req, res) => {
  try {
    const { sessionId, to, type, url, caption } = req.body;

    if (!sessionId || !to || !type || !url) {
      return res.status(400).json({
        success: false,
        error: 'sessionId, to, type, url required'
      });
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({
        success: false,
        error: 'Session not connected'
      });
    }

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    // মিডিয়া কন্টেন্ট
    let content;
    if (type === 'image') {
      content = { image: { url }, caption };
    } else if (type === 'video') {
      content = { video: { url }, caption };
    } else if (type === 'audio') {
      content = { audio: { url } };
    } else if (type === 'document') {
      content = { document: { url }, fileName: caption || 'file' };
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid type. Use: image/video/audio/document'
      });
    }

    const jobId = await messageQueue.add(sessionId, jid, content);

    res.json({
      success: true,
      queued: true,
      messageId: jobId,
      type
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// বাল্ক মেসেজ পাঠান
app.post('/api/send/bulk', async (req, res) => {
  try {
    const { sessionId, messages } = req.body;

    if (!sessionId || !messages || !messages.length) {
      return res.status(400).json({
        success: false,
        error: 'sessionId and messages array required'
      });
    }

    if (messages.length > 500) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 500 messages per bulk request'
      });
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({
        success: false,
        error: 'Session not connected'
      });
    }

    const results = [];
    const startTime = Date.now();

    for (const msg of messages) {
      try {
        const jid = msg.to.includes('@') ? msg.to : `${msg.to}@s.whatsapp.net`;
        
        let content;
        if (msg.type === 'text' || !msg.type) {
          content = { text: msg.message };
        } else {
          content = { [msg.type]: { url: msg.message }, caption: msg.caption };
        }

        const jobId = await messageQueue.add(sessionId, jid, content);
        
        results.push({
          to: msg.to,
          success: true,
          messageId: jobId
        });
      } catch (error) {
        results.push({
          to: msg.to,
          success: false,
          error: error.message
        });
      }
    }

    const totalTime = Date.now() - startTime;

    res.json({
      success: true,
      total: messages.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
      performance: {
        totalTime: `${totalTime}ms`,
        averagePerMessage: `${(totalTime / messages.length).toFixed(0)}ms`,
        rate: '2 msg/sec',
        delay: '500ms'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== সার্ভার স্টার্ট ====================
const server = app.listen(PORT, async () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 BLAST WHATSAPP API v15.0.0');
  console.log('='.repeat(60));
  console.log(`📱 Server: http://localhost:${PORT}`);
  console.log(`🔓 Authentication: No API Key Required`);
  console.log(`⚡ Message Rate: 2 messages/second`);
  console.log(`⏱️  Message Delay: 500ms`);
  console.log(`📦 Unlimited Messages: Yes`);
  console.log(`📊 Max Sessions: Unlimited`);
  console.log('='.repeat(60) + '\n');

  // সব সেশন লোড
  await loadAllSessions();
  
  // স্ট্যাটস দেখান
  setTimeout(() => {
    const connected = Array.from(sessions.values()).filter(s => s.status === 'CONNECTED').length;
    console.log(`✅ Ready: ${connected}/${sessions.size} sessions connected\n`);
  }, 2000);
});

// গ্রেসফুল শাটডাউন
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
  console.log('\n🛑 Shutting down...');
  
  // সব সেশন লগআউট
  for (const [id, session] of sessions.entries()) {
    if (session.sock) {
      try {
        await session.sock.logout();
        session.sock.end();
      } catch (e) {}
    }
  }

  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });

  setTimeout(() => {
    console.log('❌ Force shutdown');
    process.exit(1);
  }, 10000);
}

// ==================== এক্সপোর্ট ====================
module.exports = { app, sessions, messageQueue };
