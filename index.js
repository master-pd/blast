// ===================================================
// BLAST ULTIMATE WHATSAPP API v15.1.0 – FINAL FIXED & ADVANCE
// Unlimited Messages | 2 Msg/Sec | 500ms Delay | NO API KEY REQUIRED
// Author: Md Dhaka | Dhaka, BD | 2026
// ===================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const compression = require('compression');
const helmet = require('helmet');
const cluster = require('cluster');
const os = require('os');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestWaWebVersion,
  downloadContentFromMessage,
  jidNormalizedUser,
  getContentType,
  makeCacheableSignalKeyStore,
  makeInMemoryStore
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const { EventEmitter } = require('events');

// Increase event listener limit
EventEmitter.defaultMaxListeners = 200;

// ==================== CONFIG ====================
const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'production',
  maxSessions: parseInt(process.env.MAX_SESSIONS) || 500,
  messagesPerSecond: 2,
  messageDelay: 500,
  unlimitedMessages: true,
  reconnectBackoff: parseInt(process.env.RECONNECT_BACKOFF) || 3000,
  rateLimitWindow: 60000,
  rateLimitMax: 200,
  sessionsDir: path.join(process.cwd(), 'sessions'),
  tempDir: path.join(process.cwd(), 'temp'),
  useCluster: process.env.USE_CLUSTER === 'true'
};

fs.ensureDirSync(config.sessionsDir);
fs.ensureDirSync(config.tempDir);

// ==================== LOGGER ====================
const logger = P({
  level: 'info',
  timestamp: () => `,"time":"${new Date().toISOString()}"`
});

if (config.nodeEnv !== 'production') {
  const pretty = require('pino-pretty');
  logger.stream = pretty({ colorize: true, translateTime: true });
}

// ==================== MESSAGE QUEUE ====================
class MessageQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.lastMessageTime = 0;
    this.messageCount = 0;
    this.secondStart = Date.now();
    this.stats = { sent: 0, failed: 0, queued: 0 };
  }

  async add(sessionId, jid, content, type = 'text') {
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: crypto.randomBytes(8).toString('hex'),
        sessionId,
        jid,
        content,
        type,
        resolve,
        reject,
        added: Date.now()
      });
      this.stats.queued++;
      this.process();
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

      if (this.messageCount >= config.messagesPerSecond) {
        const waitTime = 1000 - (now - this.secondStart);
        if (waitTime > 0) await new Promise(r => setTimeout(r, waitTime));
        continue;
      }

      const timeSinceLast = now - this.lastMessageTime;
      if (timeSinceLast < config.messageDelay) {
        await new Promise(r => setTimeout(r, config.messageDelay - timeSinceLast));
      }

      const job = this.queue.shift();
      this.stats.queued--;

      try {
        const session = sessions.get(job.sessionId);
        if (!session || session.status !== 'CONNECTED') {
          throw new Error(`Session ${job.sessionId} not connected`);
        }

        await session.sock.sendMessage(job.jid, job.content);

        this.messageCount++;
        this.lastMessageTime = Date.now();
        this.stats.sent++;
        session.stats.totalSent++;
        session.lastActive = Date.now();

        job.resolve({
          success: true,
          messageId: job.id,
          sessionId: job.sessionId,
          to: job.jid,
          timestamp: Date.now()
        });

        logger.info(`✅ Sent: ${job.sessionId} -> ${job.jid} | Type: ${job.type}`);
      } catch (error) {
        this.stats.failed++;
        job.reject(error);
        logger.error(`❌ Failed: ${job.sessionId} -> ${job.jid}: ${error.message}`);
      }
    }

    this.processing = false;
  }

  getStats() {
    return {
      ...this.stats,
      queueLength: this.queue.length,
      currentRate: this.messageCount,
      lastMessageTime: this.lastMessageTime
    };
  }
}

// ==================== SESSION MANAGER ====================
const sessions = new Map();

async function createSession(sessionId, phoneNumber = null) {
  if (sessions.size >= config.maxSessions) {
    throw new Error(`Maximum ${config.maxSessions} sessions reached`);
  }

  if (sessions.has(sessionId)) {
    const oldSession = sessions.get(sessionId);
    if (oldSession.sock) {
      oldSession.sock.end();
    }
    sessions.delete(sessionId);
  }

  logger.info(`Creating session: ${sessionId}`);

  const authPath = path.join(config.sessionsDir, sessionId);
  await fs.ensureDir(authPath);

  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  const version = (await fetchLatestWaWebVersion()).version;

  const sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: true,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrBase64 = await qrcode.toDataURL(qr);
      sessions.set(sessionId, { ...sessions.get(sessionId), qr: qrBase64, status: 'QR_READY' });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn(`Session ${sessionId} closed with code ${statusCode}`);

      if (shouldReconnect) {
        setTimeout(() => createSession(sessionId, phoneNumber), config.reconnectBackoff);
      } else {
        sessions.delete(sessionId);
      }
    }

    if (connection === 'open') {
      const user = sock.user;
      sessions.set(sessionId, {
        sock,
        status: 'CONNECTED',
        qr: null,
        pairingCode: null,
        lastActive: Date.now(),
        user: {
          id: user.id,
          name: user.name,
          phone: user.id?.split('@')[0]
        },
        stats: { totalSent: 0, received: 0 }
      });

      logger.info(`✅ Session ${sessionId} connected as ${user.id}`);
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    const msg = m.messages[0];
    if (!msg.key.fromMe) {
      const session = sessions.get(sessionId);
      if (session) {
        session.stats.received++;
        session.lastActive = Date.now();
      }
    }
  });

  sessions.set(sessionId, {
    status: 'INITIALIZING',
    qr: null,
    pairingCode: null,
    lastActive: Date.now(),
    stats: { totalSent: 0, received: 0 }
  });

  if (phoneNumber) {
    try {
      const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
      const code = await sock.requestPairingCode(cleanNumber);
      sessions.set(sessionId, { ...sessions.get(sessionId), pairingCode: code, status: 'PAIRING_READY' });
    } catch (error) {
      logger.error(`Pairing failed for ${sessionId}: ${error.message}`);
    }
  }

  return sessions.get(sessionId);
}

// ==================== EXPRESS APP ====================
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(compression());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// No API key authentication as per request

// Rate Limiting (optional protection)
const limiter = rateLimit({
  windowMs: config.rateLimitWindow,
  max: config.rateLimitMax,
  message: { success: false, error: 'Too many requests, slow down.' }
});
app.use('/api/', limiter);

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'Blast WhatsApp API',
    version: '15.1.0-fixed',
    author: 'Md Dhaka',
    status: 'operational',
    features: {
      unlimitedMessages: true,
      messagesPerSecond: config.messagesPerSecond,
      messageDelay: `${config.messageDelay}ms`,
      maxSessions: config.maxSessions
    },
    endpoints: {
      createSession: 'POST /api/session/create {sessionId, phone?}',
      getQR: 'GET /api/session/:id/qr',
      sendMessage: 'POST /api/send {sessionId, to, message, type?}',
      bulkSend: 'POST /api/send/bulk {sessionId, messages[]}',
      status: 'GET /api/session/:id/status',
      logout: 'POST /api/session/:id/logout',
      stats: 'GET /api/stats'
    }
  });
});

// Health
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    sessionsCount: sessions.size,
    connected: Array.from(sessions.values()).filter(s => s.status === 'CONNECTED').length,
    queueLength: queue.queue.length,
    memoryMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)
  });
});

// Create session
app.post('/api/session/create', async (req, res) => {
  try {
    const { sessionId, phone } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    await createSession(sessionId, phone);
    res.json({ success: true, sessionId, status: sessions.get(sessionId).status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get QR / Pairing
app.get('/api/session/:sessionId/qr', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (session.pairingCode) {
    return res.json({ success: true, method: 'pairing_code', code: session.pairingCode });
  }
  if (session.qr) {
    return res.json({ success: true, method: 'qr', qr: session.qr });
  }
  res.json({ success: false, status: session.status });
});

// Send message
app.post('/api/send', async (req, res) => {
  try {
    const { sessionId, to, message, type = 'text', caption, filename } = req.body;

    if (!sessionId || !to || !message) {
      return res.status(400).json({ error: 'sessionId, to, message required' });
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ error: 'Session not connected' });
    }

    const jid = jidNormalizedUser(to.includes('@') ? to : `${to}@s.whatsapp.net`);

    let content;
    switch (type) {
      case 'text':
        content = { text: message };
        break;
      case 'image':
        content = { image: { url: message }, caption: caption || '' };
        break;
      case 'video':
        content = { video: { url: message }, caption: caption || '' };
        break;
      case 'audio':
        content = { audio: { url: message } };
        break;
      case 'document':
        content = { document: { url: message }, fileName: filename || 'file' };
        break;
      default:
        return res.status(400).json({ error: 'Invalid message type' });
    }

    const result = await queue.add(sessionId, jid, content, type);

    res.json({
      success: true,
      queued: true,
      messageId: result.messageId,
      sessionId,
      to: jid
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bulk send
app.post('/api/send/bulk', async (req, res) => {
  try {
    const { sessionId, messages } = req.body;
    if (!sessionId || !messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'sessionId and messages array required' });
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ error: 'Session not connected' });
    }

    const results = [];
    for (const msg of messages) {
      try {
        const jid = jidNormalizedUser(msg.to.includes('@') ? msg.to : `${msg.to}@s.whatsapp.net`);
        const content = msg.type === 'text' ? { text: msg.message } : { [msg.type]: { url: msg.message }, caption: msg.caption || '' };
        await queue.add(sessionId, jid, content, msg.type || 'text');
        results.push({ to: msg.to, success: true });
      } catch (e) {
        results.push({ to: msg.to, success: false, error: e.message });
      }
    }

    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Logout
app.post('/api/session/:sessionId/logout', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (session.sock) {
    await session.sock.logout().catch(() => {});
    session.sock.end();
  }
  sessions.delete(sessionId);
  res.json({ success: true, message: 'Logged out' });
});

// Start server
if (cluster.isMaster && config.useCluster) {
  const numCPUs = os.cpus().length;
  logger.info(`Master ${process.pid} running, forking ${numCPUs} workers`);
  for (let i = 0; i < numCPUs; i++) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    logger.warn(`Worker ${worker.process.pid} died, restarting...`);
    cluster.fork();
  });
} else {
  const server = app.listen(config.port, async () => {
    logger.info('='.repeat(60));
    logger.info('BLAST WHATSAPP API v15.1.0 – FIXED');
    logger.info(`Port: ${config.port}`);
    logger.info(`Max Sessions: ${config.maxSessions}`);
    logger.info(`Rate: ${config.messagesPerSecond} msg/sec | Delay: ${config.messageDelay}ms`);
    logger.info('No API Key required');
    logger.info('='.repeat(60));

    // Load existing sessions
    const dirs = await fs.readdir(config.sessionsDir);
    let loaded = 0;
    for (const dir of dirs) {
      const stat = await fs.stat(path.join(config.sessionsDir, dir));
      if (stat.isDirectory()) {
        try {
          await createSession(dir);
          loaded++;
        } catch (e) {
          logger.error(`Failed to load ${dir}: ${e.message}`);
        }
      }
    }
    logger.info(`Loaded ${loaded} sessions`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    for (const [id] of sessions) {
      const s = sessions.get(id);
      if (s?.sock) {
        await s.sock.logout().catch(() => {});
        s.sock.end();
      }
    }
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
