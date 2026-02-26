// Blast Advanced WhatsApp Multi-Session API - Professional Edition 2026
// Features: Multi-session, QR/Pairing, Text/Media, Queue, Webhook, Rate Limit, Auto Reconnect
// Deploy: Render.com with Disk for sessions (mount /app/sessions)

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
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchPairingCode,
  Browsers,
  DisconnectReason: DR
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const logger = pino({ level: LOG_LEVEL, transport: { target: 'pino-pretty' } });

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  logger.info('Sessions directory created');
}

const sessions = new Map(); // sessionId -> { sock, status, qr, pairingCode, lastActive }

// Rate Limiter - Anti-ban + Abuse protection
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP/session to 10 requests per window
  keyGenerator: (req) => req.headers['x-api-key'] || req.ip || 'default',
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later (rate limit 10/min)' }
});

app.use('/api/send', apiLimiter);
app.use('/api/session', apiLimiter);

// Message Queue - Random delay 1-5s to mimic human
const messageQueue = new Queue('whatsapp-send-queue', {
  redis: { host: '127.0.0.1', port: 6379 }, // Render-এ Redis add-on বা in-memory fallback
  defaultJobOptions: { removeOnComplete: true, removeOnFail: true }
});

messageQueue.process(async (job) => {
  const { sessionId, jid, content } = job.data;
  const session = sessions.get(sessionId);

  if (!session || session.status !== 'CONNECTED') {
    logger.warn(`Session ${sessionId} not connected for queued job`);
    return;
  }

  try {
    await session.sock.sendMessage(jid, content);
    logger.info(`Queued message sent | Session: ${sessionId} | To: ${jid}`);
  } catch (err) {
    logger.error(`Queue send failed | ${sessionId} | Error: ${err.message}`);
  }
});

// Auth Middleware
const authCheck = (req, res, next) => {
  if (!API_KEY) return next();
  const providedKey = req.headers['x-api-key'] || req.query.api_key;
  if (providedKey !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid API Key - Unauthorized' });
  }
  next();
};

// Create/Load Session
async function initializeSession(sessionId, phoneNumber = null) {
  if (sessions.has(sessionId)) {
    const s = sessions.get(sessionId);
    if (s.status === 'CONNECTED') return s.sock;
    if (s.sock) s.sock.end(); // cleanup old
  }

  logger.info(`Initializing session: ${sessionId} ${phoneNumber ? `(phone: ${phoneNumber})` : ''}`);

  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    version: (await fetchLatestWaWebVersion()).version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrBase64 = await qrcode.toDataURL(qr, { margin: 1 });
        sessions.set(sessionId, { ...sessions.get(sessionId), qr: qrBase64, status: 'QR_READY' });
        logger.info(`QR generated for ${sessionId}`);
      } catch (e) {
        logger.error(`QR generation failed: ${e.message}`);
      }
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DR.loggedOut && statusCode !== DR.connectionClosed;

      logger.warn(`Connection closed | ${sessionId} | Code: ${statusCode} | Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => initializeSession(sessionId, phoneNumber), 4000 + Math.random() * 3000);
      } else {
        sessions.delete(sessionId);
        logger.info(`Session permanently closed: ${sessionId}`);
      }
    }

    if (connection === 'open') {
      sessions.set(sessionId, { sock, status: 'CONNECTED', qr: null, pairingCode: null, lastActive: Date.now() });
      logger.info(`Session connected: ${sessionId}`);
      if (WEBHOOK_URL) {
        axios.post(WEBHOOK_URL, { event: 'connection', sessionId, status: 'CONNECTED' }).catch(() => {});
      }
    }
  });

  // Incoming Messages + Webhook
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    const msg = m.messages[0];
    if (!msg.key.fromMe) {
      logger.info(`Incoming message | From: ${msg.key.remoteJid} | Session: ${sessionId}`);
      if (WEBHOOK_URL) {
        axios.post(WEBHOOK_URL, { event: 'message', sessionId, data: msg }).catch(e => logger.error(`Webhook fail: ${e.message}`));
      }
    }
  });

  // Pairing Code if phone provided
  let pairingCode = null;
  if (phoneNumber) {
    try {
      pairingCode = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
      sessions.set(sessionId, { sock, status: 'PAIRING_READY', pairingCode, qr: null });
      logger.info(`Pairing code generated: ${pairingCode} for ${sessionId}`);
    } catch (err) {
      logger.error(`Pairing code error: ${err.message}`);
    }
  }

  sessions.set(sessionId, { sock, status: 'INITIALIZING', qr: null, pairingCode, lastActive: Date.now() });
  return sock;
}

// Load all sessions on startup
async function loadAllSessions() {
  const sessionFolders = fs.readdirSync(SESSIONS_DIR).filter(f => fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory());
  logger.info(`Found ${sessionFolders.length} saved sessions to load`);

  for (const id of sessionFolders) {
    await initializeSession(id);
  }
}

// ==================== ROUTES ====================

app.get('/', (req, res) => {
  res.json({
    success: true,
    app: 'Blast Advanced WhatsApp Multi-API v4.0 (2026 Professional)',
    status: 'Running',
    features: [
      'Unlimited multi-sessions',
      'QR Code + Pairing Code (phone number)',
      'Text, Image, Video, Document send',
      'Incoming message webhook',
      'Anti-ban queue + random delay + rate limit',
      'Auto reconnect + session persistence',
      'Detailed logging + health check'
    ],
    endpoints_summary: {
      connect: 'GET /api/session/:id/connect?phone=+880... or /qr',
      send_text: 'POST/GET /api/send {sessionId, to, message}',
      send_media: 'POST /api/send-media {sessionId, to, type, url or base64, caption}',
      status: 'GET /api/session/:id/status',
      sessions: 'GET /api/sessions',
      health: 'GET /api/health'
    },
    security: API_KEY ? 'API Key required' : 'No auth (open)'
  });
});

app.get('/api/health', (req, res) => {
  const activeSessions = Array.from(sessions.values()).filter(s => s.status === 'CONNECTED').length;
  res.json({
    status: 'healthy',
    uptime: Math.floor(process.uptime() / 3600) + ' hours',
    activeSessions,
    totalSessions: sessions.size,
    memory: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + ' MB'
  });
});

app.get('/api/sessions', authCheck, (req, res) => {
  const list = Array.from(sessions.entries()).map(([id, data]) => ({
    id,
    status: data.status,
    connected: data.status === 'CONNECTED',
    lastActive: new Date(data.lastActive).toISOString(),
    hasQR: !!data.qr,
    hasPairing: !!data.pairingCode
  }));
  res.json({ success: true, count: list.length, sessions: list });
});

app.get('/api/session/:id/status', authCheck, (req, res) => {
  const { id } = req.params;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ success: false, error: 'Session not found' });
  res.json({ success: true, sessionId: id, ...s });
});

app.get('/api/session/:id/qr', authCheck, async (req, res) => {
  const { id } = req.params;
  let s = sessions.get(id);

  if (!s || ['DISCONNECTED', 'QR_EXPIRED'].includes(s.status)) {
    await initializeSession(id);
    s = sessions.get(id);
  }

  if (s.qr) {
    res.json({ success: true, type: 'qr', qr: s.qr, sessionId: id });
  } else if (s.status === 'CONNECTED') {
    res.json({ success: true, message: 'Already connected', sessionId: id });
  } else {
    res.json({ success: false, message: 'Not ready. Try again in 5-10 seconds or use /connect' });
  }
});

app.get('/api/session/:id/connect', authCheck, async (req, res) => {
  const { id } = req.params;
  const { phone } = req.query;

  let s = sessions.get(id);
  if (!s) {
    await initializeSession(id, phone);
    s = sessions.get(id);
  }

  if (s.pairingCode) {
    res.json({ success: true, type: 'pairing_code', code: s.pairingCode, instruction: 'WhatsApp > Linked Devices > Link with phone number > Enter code' });
  } else if (s.qr) {
    res.json({ success: true, type: 'qr', qr: s.qr });
  } else {
    res.json({ success: false, message: 'Connection in progress. Check /status' });
  }
});

app.post('/api/send', authCheck, async (req, res) => {
  const data = req.body || req.query;
  const { sessionId, to, message } = data;

  if (!sessionId || !to || !message) {
    return res.status(400).json({ success: false, error: 'Missing:
