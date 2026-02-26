require('dotenv').config();
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchPairingCode } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || ''; // empty মানে auth off

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessions = new Map(); // active sockets
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const authMiddleware = (req, res, next) => {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ success: false, error: 'Unauthorized - Invalid API Key' });
  next();
};

const loadSessions = async () => {
  const dirs = fs.readdirSync(SESSIONS_DIR);
  for (const sessionId of dirs) {
    if (fs.statSync(path.join(SESSIONS_DIR, sessionId)).isDirectory()) {
      console.log(`🔄 Auto-loading session: ${sessionId}`);
      await createSession(sessionId);
    }
  }
};

const createSession = async (sessionId, phoneNumber = null) => {
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    if (existing.status === 'CONNECTED') return existing.sock;
  }

  const { state, saveCreds } = await useMultiFileAuthState(path.join(SESSIONS_DIR, sessionId));

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: undefined, // production-এ pino logger use করতে পারো
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrData = await qrcode.toDataURL(qr);
      sessions.set(sessionId, { sock, status: 'QR_READY', qr: qrData, pairingCode: null });
      console.log(`📱 QR generated for ${sessionId}`);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`❌ ${sessionId} disconnected. Reconnect? ${shouldReconnect} (Code: ${statusCode})`);

      if (shouldReconnect) {
        setTimeout(() => createSession(sessionId, phoneNumber), 5000);
      } else {
        sessions.delete(sessionId);
      }
    } else if (connection === 'open') {
      console.log(`✅ ${sessionId} connected successfully!`);
      sessions.set(sessionId, { sock, status: 'CONNECTED', qr: null, pairingCode: null });
    }
  });

  // Pairing Code যদি phoneNumber দেয়া থাকে
  let pairingCode = null;
  if (phoneNumber) {
    try {
      pairingCode = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
      sessions.set(sessionId, { sock, status: 'PAIRING_CODE', qr: null, pairingCode });
      console.log(`🔗 Pairing code for ${sessionId}: ${pairingCode}`);
    } catch (err) {
      console.error(`Pairing code error for ${sessionId}:`, err);
    }
  }

  sessions.set(sessionId, { sock, status: 'INITIALIZING', qr: null, pairingCode });
  return sock;
};

// ==================== ROUTES ====================

// Welcome + Docs (browser friendly)
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🚀 Blast WhatsApp Multi-Account API (Node.js + Baileys) - Professional Edition',
    status: 'Online',
    version: '2.1.0',
    features: 'Multi-session, QR + Pairing Code, Send Text (GET/POST), Auto Reconnect',
    how_to_add_account: [
      '1. QR: GET /api/session/sales1/qr → Scan with WhatsApp',
      '2. Pairing Code: GET /api/session/sales1/connect?pairingCode=true&phone=+88017xxxxxxxx → Code পাবে, WhatsApp > Linked Devices > Link with phone number',
      '3. Status: GET /api/session/sales1/status',
      '4. Reconnect: POST /api/session/sales1/reconnect'
    ],
    send_example: 'POST/GET /api/send?sessionId=sales1&to=88017xxxxxxxx&message=Hello',
    tip: 'Scan once → session saved forever (until logout). Use x-api-key header if set.'
  });
});

// All sessions list
app.get('/api/sessions', authMiddleware, (req, res) => {
  const list = Array.from(sessions.entries()).map(([id, data]) => ({
    sessionId: id,
    status: data.status,
    connected: data.status === 'CONNECTED',
    hasQr: !!data.qr,
    hasPairingCode: !!data.pairingCode
  }));
  res.json({ success: true, total: list.length, sessions: list });
});

// Status of one session
app.get('/api/session/:id/status', authMiddleware, (req, res) => {
  const { id } = req.params;
  const session = sessions.get(id);
  if (!session) {
    return res.json({ success: false, message: 'Session not found/initialized' });
  }
  res.json({ success: true, sessionId: id, status: session.status, connected: session.status === 'CONNECTED' });
});

// QR or Pairing Code Route (একসাথে)
app.get('/api/session/:id/qr', authMiddleware, async (req, res) => {
  const { id } = req.params;
  let session = sessions.get(id);

  if (!session || session.status === 'DISCONNECTED') {
    await createSession(id);
    session = sessions.get(id);
  }

  if (session.qr) {
    return res.json({ success: true, sessionId: id, type: 'qr', qr: session.qr });
  } else if (session.status === 'CONNECTED') {
    return res.json({ success: true, sessionId: id, message: 'Already connected - No QR needed' });
  } else {
    return res.json({ success: false, message: 'Not ready yet. Try /api/session/:id/connect for pairing or wait 5s' });
  }
});

// New: Connect with Pairing Code
app.get('/api/session/:id/connect', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { pairingCode = 'true', phone } = req.query; // pairingCode=true & phone=+880...

  let session = sessions.get(id);

  if (!session) {
    await createSession(id, phone);
    session = sessions.get(id);
  }

  if (pairingCode === 'true' && session.pairingCode) {
    return res.json({ success: true, sessionId: id, type: 'pairing_code', code: session.pairingCode, instruction: 'Open WhatsApp > Linked Devices > Link with phone number > Enter this code' });
  }

  if (session.qr) {
    return res.json({ success: true, sessionId: id, type: 'qr', qr: session.qr });
  }

  res.json({ success: false, message: 'Connection in progress. Check /status or try again in few seconds' });
});

// Force reconnect
app.post('/api/session/:id/reconnect', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { phone } = req.body || req.query;

  if (sessions.has(id)) {
    const old = sessions.get(id);
    if (old.sock) old.sock.end();
  }

  await createSession(id, phone);
  res.json({ success: true, message: `Reconnecting session ${id}... Check /qr or /status` });
});

// Send message (GET + POST)
const sendMessageHandler = async (req, res) => {
  const params = req.method === 'GET' ? req.query : req.body;
  const { sessionId, to, message } = params;

  if (!sessionId || !to || !message) {
    return res.status(400).json({ success: false, error: 'Required: sessionId, to (number), message' });
  }

  const session = sessions.get(sessionId);
  if (!session || session.status !== 'CONNECTED') {
    return res.status(400).json({ success: false, error: `Session ${sessionId} not connected. Add/connect first.` });
  }

  try {
    const jid = to.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    await session.sock.sendMessage(jid, { text: message });
    res.json({ success: true, message: 'Sent successfully!', from: sessionId, to, timestamp: new Date() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Send failed' });
  }
};

app.get('/api/send', authMiddleware, sendMessageHandler);
app.post('/api/send', authMiddleware, sendMessageHandler);

// Logout
app.post('/api/session/:id/logout', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const session = sessions.get(id);
  if (session && session.sock) {
    await session.sock.logout();
    sessions.delete(id);
    const dir = path.join(SESSIONS_DIR, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    res.json({ success: true, message: `Session ${id} logged out & deleted` });
  } else {
    res.json({ success: false, message: 'Session not found' });
  }
});

// Start
app.listen(PORT, async () => {
  console.log(`🚀 Blast Multi-WhatsApp API running at http://localhost:${PORT}`);
  await loadSessions();
  console.log('✅ Sessions loaded. Ready for connections!');
});
