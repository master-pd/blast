require('dotenv').config();
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const Queue = require('bull');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // optional: your webhook endpoint

app.use(cors());
app.use(express.json({ limit: '50mb' })); // media-এর জন্য large body
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const sessions = new Map();
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Rate limiter: per IP/session ৫ req/min (adjustable)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.headers['x-api-key'] || req.ip,
  message: { success: false, error: 'Rate limit exceeded. Try after 1 min.' }
});
app.use('/api/send', limiter);
app.use('/api/session', limiter);

// Message Queue (anti-flood)
const msgQueue = new Queue('whatsapp-messages', { redis: { host: '127.0.0.1', port: 6379 } }); // Redis না থাকলে default in-memory

msgQueue.process(async (job) => {
  const { sessionId, jid, content } = job.data;
  const session = sessions.get(sessionId);
  if (session && session.status === 'CONNECTED') {
    await session.sock.sendMessage(jid, content);
    console.log(`Queued message sent from ${sessionId} to ${jid}`);
  }
});

// Auth middleware
const authMiddleware = (req, res, next) => {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ success: false, error: 'Unauthorized' });
  next();
};

const createSession = async (sessionId, phoneNumber = null) => {
  // ... (আগের createSession logic একই, কিন্তু incoming message handler যোগ করো)
  const sock = makeWASocket({ /* config */ });

  // Incoming messages handle + webhook
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && msg.message) {
      console.log(`Incoming from ${msg.key.remoteJid}:`, msg.message);
      if (WEBHOOK_URL) {
        try {
          await axios.post(WEBHOOK_URL, { event: 'message', sessionId, data: msg });
        } catch (e) { console.error('Webhook failed:', e); }
      }
    }
  });

  // ... rest same as before (qr, pairing, connection update)
};

// Load sessions on start
const loadSessions = async () => { /* same */ };

// Routes

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🚀 Blast Advanced WhatsApp Multi-API v3.0 - Professional 2026',
    features: [
      'Multi-session + Auto reconnect',
      'QR + Pairing Code',
      'Text + Media send (GET/POST)',
      'Webhook for incoming events',
      'Rate limiting + Message queue',
      'Health check /api/health'
    ]
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', sessions: sessions.size, uptime: process.uptime() });
});

// QR / Connect route same + improve

// Media send example (POST /api/send-media)
app.post('/api/send-media', authMiddleware, async (req, res) => {
  const { sessionId, to, type, url, caption, base64 } = req.body; // type: 'image', 'video', 'document'

  if (!sessionId || !to || !type || (!url && !base64)) {
    return res.status(400).json({ success: false, error: 'Missing params' });
  }

  const session = sessions.get(sessionId);
  if (!session || session.status !== 'CONNECTED') return res.status(400).json({ error: 'Session not connected' });

  try {
    let mediaBuffer;
    if (base64) {
      mediaBuffer = Buffer.from(base64, 'base64');
    } else {
      const resp = await axios.get(url, { responseType: 'arraybuffer' });
      mediaBuffer = Buffer.from(resp.data);
    }

    const jid = to.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    let content = {};
    if (type === 'image') content = { image: mediaBuffer, caption };
    else if (type === 'video') content = { video: mediaBuffer, caption };
    else if (type === 'document') content = { document: mediaBuffer, mimetype: 'application/pdf', fileName: 'file.pdf' };

    // Queue-এ পাঠাও delay সহ
    await msgQueue.add({ sessionId, jid, content }, { delay: Math.random() * 2000 + 1000 }); // 1-3s random delay

    res.json({ success: true, message: 'Media queued for sending' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send text same as before, কিন্তু queue-এ পাঠাও
// ... update sendMessageHandler to use queue

// Logout + cleanup same

app.listen(PORT, async () => {
  console.log(`🚀 Advanced Blast API v3 running on port ${PORT}`);
  await loadSessions();
});
