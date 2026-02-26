// Blast WhatsApp Multi-Session REST API v7.1-final – Production Ready
// Clean Version - Only Essential Features

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const Queue = require('bull');
const pino = require('pino');
const pretty = require('pino-pretty');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestWaWebVersion,
  proto,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  downloadContentFromMessage,
  jidNormalizedUser,
  jidDecode,
  getContentType
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'your-secret-key-here';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const DAILY_MSG_LIMIT = parseInt(process.env.DAILY_MSG_LIMIT || '1000');
const QUEUE_DELAY_MIN = parseInt(process.env.QUEUE_DELAY_MIN || '1000');
const QUEUE_DELAY_MAX = parseInt(process.env.QUEUE_DELAY_MAX || '3000');

const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  pretty({ colorize: true, translateTime: 'SYS:dd-mm-yyyy HH:MM:ss' })
);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const sessions = new Map();

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, error: 'Too many requests' }
});

app.use('/api/', apiLimiter);

// Message Queue
const msgQueue = new Queue('blast-message-queue', {
  redis: { host: '127.0.0.1', port: 6379 },
  defaultJobOptions: { 
    removeOnComplete: true, 
    removeOnFail: true, 
    attempts: 3 
  }
});

msgQueue.process(async (job) => {
  const { sessionId, jid, content } = job.data;
  const session = sessions.get(sessionId);

  if (!session || session.status !== 'CONNECTED') {
    throw new Error('Session not connected');
  }

  if (session.stats.sentToday >= DAILY_MSG_LIMIT) {
    throw new Error('Daily limit reached');
  }

  try {
    await session.sock.sendMessage(jid, content);
    session.stats.sentToday++;
    session.stats.totalSent++;
    session.lastActive = Date.now();
    logger.info(`Message sent: ${sessionId} -> ${jid}`);
  } catch (err) {
    logger.error(`Send failed: ${err.message}`);
    throw err;
  }
});

// Auth Middleware
const authMiddleware = (req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid API Key' });
  }
  next();
};

// Session Management
async function createOrLoadSession(sessionId, phoneNumber = null) {
  if (sessions.has(sessionId)) {
    const s = sessions.get(sessionId);
    if (s.status === 'CONNECTED') return s.sock;
  }

  const authPath = path.join(SESSIONS_DIR, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const version = (await fetchLatestWaWebVersion()).version;

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS('Safari'),
    markOnlineOnConnect: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrBase64 = await qrcode.toDataURL(qr);
      sessions.set(sessionId, { 
        ...sessions.get(sessionId), 
        qr: qrBase64, 
        status: 'QR_READY' 
      });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        setTimeout(() => createOrLoadSession(sessionId, phoneNumber), 5000);
      } else {
        sessions.delete(sessionId);
      }
    }

    if (connection === 'open') {
      sessions.set(sessionId, {
        ...sessions.get(sessionId),
        sock,
        status: 'CONNECTED',
        qr: null,
        pairingCode: null,
        lastActive: Date.now(),
        stats: sessions.get(sessionId)?.stats || {
          sentToday: 0,
          totalSent: 0,
          received: 0
        }
      });
      logger.info(`Session ${sessionId} connected`);
      
      if (WEBHOOK_URL) {
        axios.post(WEBHOOK_URL, { event: 'connected', sessionId }).catch(() => {});
      }
    }
  });

  // Incoming messages
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    
    const msg = m.messages[0];
    if (!msg.key.fromMe) {
      const session = sessions.get(sessionId);
      if (session) {
        session.stats.received++;
        session.lastActive = Date.now();
      }
      
      if (WEBHOOK_URL) {
        axios.post(WEBHOOK_URL, { 
          event: 'message', 
          sessionId, 
          from: msg.key.remoteJid,
          message: msg.message 
        }).catch(() => {});
      }
    }
  });

  // Pairing code
  if (phoneNumber) {
    try {
      const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
      sessions.set(sessionId, { 
        ...sessions.get(sessionId), 
        pairingCode: code,
        status: 'PAIRING_CODE_READY'
      });
    } catch (e) {
      logger.error(`Pairing failed: ${e.message}`);
    }
  }

  sessions.set(sessionId, {
    sock,
    status: 'INITIALIZING',
    qr: null,
    pairingCode: null,
    stats: { sentToday: 0, totalSent: 0, received: 0 },
    lastActive: Date.now()
  });

  return sock;
}

// Load saved sessions on startup
async function loadSessionsOnStart() {
  const dirs = fs.readdirSync(SESSIONS_DIR);
  for (const dir of dirs) {
    const stat = fs.statSync(path.join(SESSIONS_DIR, dir));
    if (stat.isDirectory()) {
      createOrLoadSession(dir).catch(err => {
        logger.error(`Failed to load session ${dir}: ${err.message}`);
      });
    }
  }
}

// ==================== API ROUTES ====================

// Home
app.get('/', (req, res) => {
  res.json({
    name: 'Blast WhatsApp API',
    version: '7.1-final',
    status: 'online',
    endpoints: [
      'GET    /health',
      'GET    /api/sessions',
      'POST   /api/session/create',
      'GET    /api/session/:id/qr',
      'GET    /api/session/:id/status',
      'POST   /api/session/:id/logout',
      'POST   /api/send/text',
      'POST   /api/send/media',
      'POST   /api/send/bulk'
    ],
    auth: 'x-api-key header required'
  });
});

// Health check
app.get('/health', (req, res) => {
  const connectedSessions = Array.from(sessions.values()).filter(s => s.status === 'CONNECTED').length;
  
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    sessions: {
      total: sessions.size,
      connected: connectedSessions
    },
    memory: process.memoryUsage().heapUsed / 1024 / 1024 + 'MB'
  });
});

// List all sessions
app.get('/api/sessions', authMiddleware, (req, res) => {
  const sessionList = Array.from(sessions.entries()).map(([id, data]) => ({
    id,
    status: data.status,
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

// Create new session
app.post('/api/session/create', authMiddleware, async (req, res) => {
  try {
    const { sessionId, phone } = req.body;

    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId required' });
    }

    if (sessions.has(sessionId)) {
      return res.status(409).json({ success: false, error: 'Session already exists' });
    }

    await createOrLoadSession(sessionId, phone);

    res.json({
      success: true,
      sessionId,
      method: phone ? 'pairing_code' : 'qr',
      message: phone ? 'Check pairing code via /qr endpoint' : 'Scan QR code via /qr endpoint'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get session QR/Pairing Code
app.get('/api/session/:sessionId/qr', authMiddleware, (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
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
      error: 'Not ready yet',
      status: session.status 
    });
  }
});

// Get session status
app.get('/api/session/:sessionId/status', authMiddleware, (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  res.json({
    success: true,
    sessionId,
    status: session.status,
    stats: session.stats,
    lastActive: session.lastActive
  });
});

// Logout session
app.post('/api/session/:sessionId/logout', authMiddleware, async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  try {
    if (session.sock) {
      await session.sock.logout();
      session.sock.end();
    }
    sessions.delete(sessionId);
    
    // Clean up auth folder
    const authPath = path.join(SESSIONS_DIR, sessionId);
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
    }

    res.json({ success: true, message: 'Logged out' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send text message
app.post('/api/send/text', authMiddleware, async (req, res) => {
  try {
    const { sessionId, to, message } = req.body;

    if (!sessionId || !to || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'sessionId, to, and message required' 
      });
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ 
        success: false, 
        error: 'Session not connected' 
      });
    }

    if (session.stats.sentToday >= DAILY_MSG_LIMIT) {
      return res.status(429).json({ 
        success: false, 
        error: 'Daily message limit reached' 
      });
    }

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    const job = await msgQueue.add({
      sessionId,
      jid,
      content: { text: message }
    });

    res.json({
      success: true,
      queued: true,
      jobId: job.id,
      message: 'Message queued for sending'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send media message
app.post('/api/send/media', authMiddleware, async (req, res) => {
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

    // Download media from URL
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const mediaBuffer = Buffer.from(response.data);

    let mediaMessage;
    if (type === 'image') {
      mediaMessage = { image: mediaBuffer, caption };
    } else if (type === 'video') {
      mediaMessage = { video: mediaBuffer, caption };
    } else if (type === 'audio') {
      mediaMessage = { audio: mediaBuffer };
    } else if (type === 'document') {
      mediaMessage = { document: mediaBuffer, fileName: caption || 'file' };
    }

    const job = await msgQueue.add({
      sessionId,
      jid,
      content: mediaMessage
    });

    res.json({
      success: true,
      queued: true,
      jobId: job.id
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bulk send messages
app.post('/api/send/bulk', authMiddleware, async (req, res) => {
  try {
    const { sessionId, messages } = req.body;

    if (!sessionId || !messages || !messages.length) {
      return res.status(400).json({ 
        success: false, 
        error: 'sessionId and messages array required' 
      });
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ 
        success: false, 
        error: 'Session not connected' 
      });
    }

    const jobs = [];
    for (const msg of messages) {
      if (session.stats.sentToday >= DAILY_MSG_LIMIT) break;

      const jid = msg.to.includes('@') ? msg.to : `${msg.to}@s.whatsapp.net`;
      
      const job = await msgQueue.add({
        sessionId,
        jid,
        content: msg.type === 'text' 
          ? { text: msg.content }
          : { [msg.type]: msg.content }
      });
      
      jobs.push(job.id);
      
      // Small delay between queue adds
      await new Promise(r => setTimeout(r, 200));
    }

    res.json({
      success: true,
      queued: jobs.length,
      jobIds: jobs
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== START SERVER ====================
app.listen(PORT, async () => {
  logger.info(`🚀 Blast WhatsApp API v7.1-final`);
  logger.info(`📱 Server running on port ${PORT}`);
  logger.info(`🔑 API Key: ${API_KEY.substring(0, 5)}...`);
  
  await loadSessionsOnStart();
  logger.info(`✅ Loaded saved sessions`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('Shutting down...');
  msgQueue.close();
  process.exit(0);
});
