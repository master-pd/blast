// ===================================================
// BLAST ULTIMATE WHATSAPP API v15.1.0 – FINAL FIXED
// Unlimited Messages | 2 Msg/Sec | 500ms Delay | NO AUTH
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
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const { EventEmitter } = require('events');

// Event listener limit
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

        logger.info(`✅ Sent: ${job.sessionId} -> ${job.jid}`);
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
    if (oldSession.sock) oldSession.sock.end();
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

      logger.warn(`Session ${sessionId} closed: ${statusCode}`);

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

// ==================== APP ====================
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(compression());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

app.get('/', (req, res) => {
  res.json({
    name: 'Blast WhatsApp API',
    version: '15.1.0',
    author: 'Md Dhaka',
    status: 'operational',
    message: 'No API key required'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    sessions: sessions.size,
    queue: queue.queue.length
  });
});

app.post('/api/session/create', async (req, res) => {
  try {
    const { sessionId, phone } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    await createSession(sessionId, phone);
    res.json({ success: true, sessionId, status: sessions.get(sessionId).status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

app.post('/api/send', async (req, res) => {
  try {
    const { sessionId, to, message, type = 'text' } = req.body;
    if (!sessionId || !to || !message) return res.status(400).json({ error: 'Missing params' });

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') return res.status(400).json({ error: 'Session not connected' });

    const jid = jidNormalizedUser(to.includes('@') ? to : `${to}@s.whatsapp.net`);

    let content;
    if (type === 'text') content = { text: message };
    else if (type === 'image') content = { image: { url: message }, caption: req.body.caption };
    else if (type === 'video') content = { video: { url: message }, caption: req.body.caption };
    else if (type === 'audio') content = { audio: { url: message } };
    else if (type === 'document') content = { document: { url: message }, fileName: req.body.filename || 'file' };
    else return res.status(400).json({ error: 'Invalid type' });

    await queue.add(sessionId, jid, content, type);

    res.json({ success: true, queued: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(config.port, async () => {
  logger.info(`BLAST API v15.1.0 running on port ${config.port}`);
  logger.info('Md Dhaka – No API key required');
});
