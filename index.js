// ===================================================
// BLAST ULTIMATE WHATSAPP API v15.0.0
// index.js - প্রোডাকশন রেডি
// কোনো API Key লাগবে না - ওপেন এক্সেস
// Author: Md Dhaka
// ===================================================

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

// রেট লিমিট
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { 
    success: false, 
    error: 'Too many requests' 
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

// ==================== মেসেজ কিউ ====================
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
      
      return jobId;
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;

    while (this.queue.length > 0) {
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
        this.secondStart = now;
        continue;
      }

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
        
        if (!session || session.status !== 'CONNECTED') {
          throw new Error('Session not connected');
        }

        await session.sock.sendMessage(job.jid, job.content);
        
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
      } catch (error) {
        this.stats.failed++;
        job.reject(error);
      }
    }

    this.processing = false;
  }

  getStats() {
    return {
      sent: this.stats.sent,
      failed: this.stats.failed,
      pending: this.stats.pending,
      queueLength: this.queue.length
    };
  }
}

// ==================== সেশন ম্যানেজার ====================
const sessions = new Map();
const messageQueue = new MessageQueue();

async function createSession(sessionId, phoneNumber = null) {
  try {
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

    logger.info(`Creating session: ${sessionId}`);

    const authPath = path.join(SESSIONS_DIR, sessionId);
    await fs.ensureDir(authPath);

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestWaWebVersion();

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
      shouldIgnoreJid: (jid) => jid === 'status@broadcast'
    });

    sock.ev.on('creds.update', saveCreds);

    const sessionData = {
      sock,
      status: 'INITIALIZING',
      qr: null,
      pairingCode: null,
      user: null,
      stats: { totalSent: 0, received: 0 },
      lastActive: Date.now()
    };

    sessions.set(sessionId, sessionData);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrBase64 = await qrcode.toDataURL(qr);
        const session = sessions.get(sessionId);
        if (session) {
          session.qr = qrBase64;
          session.status = 'QR_READY';
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          setTimeout(() => {
            createSession(sessionId).catch(() => {});
          }, 3000);
        } else {
          sessions.delete(sessionId);
        }
      }

      if (connection === 'open') {
        const session = sessions.get(sessionId);
        if (session) {
          session.status = 'CONNECTED';
          session.qr = null;
          session.user = sock.user;
          session.lastActive = Date.now();
        }
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;
      
      const msg = m.messages[0];
      if (msg && !msg.key.fromMe) {
        const session = sessions.get(sessionId);
        if (session) {
          session.stats.received = (session.stats.received || 0) + 1;
          session.lastActive = Date.now();
        }
      }
    });

    if (phoneNumber) {
      try {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const code = await sock.requestPairingCode(cleanNumber);
        
        const session = sessions.get(sessionId);
        if (session) {
          session.pairingCode = code;
          session.status = 'PAIRING_READY';
        }
      } catch (error) {
        logger.error(`Pairing failed: ${error.message}`);
      }
    }

    return sessionData;
  } catch (error) {
    logger.error(`Session creation failed: ${error.message}`);
    throw error;
  }
}

async function loadAllSessions() {
  try {
    const dirs = await fs.readdir(SESSIONS_DIR);
    let loaded = 0;

    for (const dir of dirs) {
      const stat = await fs.stat(path.join(SESSIONS_DIR, dir));
      if (stat.isDirectory() && dir !== 'default') {
        try {
          await createSession(dir);
          loaded++;
        } catch (error) {}
      }
    }

    logger.info(`Loaded ${loaded} sessions`);
  } catch (error) {}
}

// ==================== API এন্ডপয়েন্ট ====================

app.get('/', (req, res) => {
  res.json({
    name: 'Blast WhatsApp API',
    version: '15.0.0',
    author: 'Md Dhaka',
    endpoints: {
      health: 'GET /health',
      sessions: 'GET /api/sessions',
      create: 'POST /api/session/create',
      qr: 'GET /api/session/:id/qr',
      status: 'GET /api/session/:id/status',
      send: 'POST /api/send',
      bulk: 'POST /api/send/bulk',
      logout: 'POST /api/session/:id/logout',
      stats: 'GET /api/stats'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    sessions: sessions.size
  });
});

app.get('/api/sessions', (req, res) => {
  const sessionList = Array.from(sessions.entries()).map(([id, data]) => ({
    id,
    status: data.status,
    user: data.user,
    stats: data.stats,
    lastActive: data.lastActive
  }));

  res.json({
    success: true,
    total: sessionList.length,
    sessions: sessionList
  });
});

app.get('/api/stats', (req, res) => {
  const connected = Array.from(sessions.values()).filter(s => s.status === 'CONNECTED').length;
  const totalSent = Array.from(sessions.values()).reduce((acc, s) => acc + (s.stats?.totalSent || 0), 0);
  const totalReceived = Array.from(sessions.values()).reduce((acc, s) => acc + (s.stats?.received || 0), 0);

  res.json({
    success: true,
    sessions: {
      total: sessions.size,
      connected
    },
    messages: {
      sent: totalSent,
      received: totalReceived
    },
    queue: messageQueue.getStats()
  });
});

app.post('/api/session/create', async (req, res) => {
  try {
    const { sessionId, phone } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'sessionId required'
      });
    }

    const session = await createSession(sessionId, phone);

    res.json({
      success: true,
      sessionId,
      status: session.status,
      method: phone ? 'pairing_code' : 'qr'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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
      status: session.status
    });
  }
});

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
    
    const authPath = path.join(SESSIONS_DIR, sessionId);
    await fs.remove(authPath);

    res.json({
      success: true,
      message: 'Logged out'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/send', async (req, res) => {
  try {
    const { sessionId, to, message } = req.body;

    if (!sessionId || !to || !message) {
      return res.status(400).json({
        success: false,
        error: 'sessionId, to, message required'
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
    const jobId = await messageQueue.add(sessionId, jid, { text: message });

    res.json({
      success: true,
      queued: true,
      messageId: jobId
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/send/bulk', async (req, res) => {
  try {
    const { sessionId, messages } = req.body;

    if (!sessionId || !messages || !messages.length) {
      return res.status(400).json({
        success: false,
        error: 'sessionId and messages required'
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

    for (const msg of messages) {
      try {
        const jid = msg.to.includes('@') ? msg.to : `${msg.to}@s.whatsapp.net`;
        const jobId = await messageQueue.add(sessionId, jid, { text: msg.message });
        
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

    res.json({
      success: true,
      total: messages.length,
      successful: results.filter(r => r.success).length,
      results
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
  console.log('\n' + '='.repeat(50));
  console.log('🚀 BLAST WHATSAPP API v15.0.0');
  console.log('='.repeat(50));
  console.log(`📱 Server: http://localhost:${PORT}`);
  console.log(`⚡ 2 msg/sec | 500ms delay`);
  console.log('='.repeat(50) + '\n');

  await loadAllSessions();
});

// গ্রেসফুল শাটডাউন
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
  console.log('\nShutting down...');
  
  for (const [id, session] of sessions.entries()) {
    if (session.sock) {
      try {
        await session.sock.logout();
        session.sock.end();
      } catch (e) {}
    }
  }

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
}

module.exports = app;
