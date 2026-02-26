require('dotenv').config();
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessions = new Map(); // runtime-এ active sockets
const SESSIONS_DIR = path.join(__dirname, 'sessions');

// Create sessions folder
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Simple auth middleware (optional but professional)
const authMiddleware = (req, res, next) => {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// Load all existing sessions on startup
const loadSessions = async () => {
  const dirs = fs.readdirSync(SESSIONS_DIR);
  for (const sessionId of dirs) {
    if (fs.statSync(path.join(SESSIONS_DIR, sessionId)).isDirectory()) {
      console.log(`🔄 Loading session: ${sessionId}`);
      await createSession(sessionId);
    }
  }
};

// Create / Connect WhatsApp Session
const createSession = async (sessionId) => {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(SESSIONS_DIR, sessionId));

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrData = await qrcode.toDataURL(qr);
      sessions.set(sessionId, { sock, status: 'QR', qr: qrData });
      console.log(`📱 QR Ready for ${sessionId}`);
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`❌ Connection closed for ${sessionId}, reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => createSession(sessionId), 5000);
      } else {
        sessions.delete(sessionId);
      }
    } else if (connection === 'open') {
      console.log(`✅ ${sessionId} Connected!`);
      sessions.set(sessionId, { sock, status: 'CONNECTED', qr: null });
    }
  });

  sessions.set(sessionId, { sock, status: 'INITIALIZING', qr: null });
  return sock;
};

// ==================== ROUTES ====================

// GET /api/sessions → সব account list + status
app.get('/api/sessions', authMiddleware, (req, res) => {
  const list = Array.from(sessions.entries()).map(([id, data]) => ({
    sessionId: id,
    status: data.status,
    connected: data.status === 'CONNECTED'
  }));
  res.json({ success: true, sessions: list });
});

// GET /api/session/:id/qr → QR code (base64)
app.get('/api/session/:id/qr', authMiddleware, async (req, res) => {
  const { id } = req.params;
  let session = sessions.get(id);

  if (!session) {
    await createSession(id);
    session = sessions.get(id);
  }

  if (session.qr) {
    res.json({ success: true, sessionId: id, qr: session.qr });
  } else if (session.status === 'CONNECTED') {
    res.json({ success: true, sessionId: id, message: 'Already connected' });
  } else {
    res.json({ success: false, message: 'QR not ready yet, try again in 2 seconds' });
  }
});

// POST /api/send (text message) → GET ও POST দুইটাতেই কাজ করে
const sendMessageHandler = async (req, res) => {
  const { sessionId, to, message } = req.method === 'GET' ? req.query : req.body;

  if (!sessionId || !to || !message) {
    return res.status(400).json({ error: 'sessionId, to, message required' });
  }

  const session = sessions.get(sessionId);
  if (!session || session.status !== 'CONNECTED') {
    return res.status(400).json({ error: `Session ${sessionId} not connected. Scan QR first.` });
  }

  try {
    const jid = to.endsWith('@s.whatsapp.net') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    await session.sock.sendMessage(jid, { text: message });
    res.json({ success: true, message: 'Message sent!', from: sessionId, to });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.get('/api/send', authMiddleware, sendMessageHandler);
app.post('/api/send', authMiddleware, sendMessageHandler);

// Extra: Logout session
app.post('/api/session/:id/logout', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const session = sessions.get(id);
  if (session) {
    await session.sock.logout();
    sessions.delete(id);
    fs.rmSync(path.join(SESSIONS_DIR, id), { recursive: true, force: true });
  }
  res.json({ success: true, message: `Session ${id} logged out` });
});

// Start Server
app.listen(PORT, async () => {
  console.log(`🚀 WhatsMultiAPI Professional Server running on http://localhost:${PORT}`);
  await loadSessions();
  console.log('✅ All sessions loaded!');
});
