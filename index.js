// ===================================================
// BLAST ULTIMATE WHATSAPP API – FINAL COMPLETE v16.0.0
// No API Key | Unlimited Messages | 2 msg/sec | 500ms Delay
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
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestWaWebVersion,
  proto,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const P = require('pino');

// ==================== CONFIG ====================
const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(process.cwd(), 'sessions');
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 500;
const MSG_PER_SEC = 2;
const MIN_DELAY_MS = 500;

fs.ensureDirSync(SESSIONS_DIR);

// ==================== LOGGER ====================
const logger = P({
  level: 'info',
  timestamp: () => `,"time":"${new Date().toISOString()}"`
});

if (process.env.NODE_ENV !== 'production') {
  const pretty = require('pino-pretty');
  logger.stream = pretty({ colorize: true });
}

// ==================== QUEUE SYSTEM ====================
class BlastQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.lastSend = 0;
    this.msgThisSec = 0;
    this.secStart = Date.now();
  }

  add(sessionId, jid, content, type = 'text') {
    return new Promise((resolve, reject) => {
      this.queue.push({ sessionId, jid, content, type, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing || !this.queue.length) return;
    this.processing = true;

    while (this.queue.length) {
      const now = Date.now();

      // Reset per-second counter
      if (now - this.secStart >= 1000) {
        this.msgThisSec = 0;
        this.secStart = now;
      }

      if (this.msgThisSec >= MSG_PER_SEC) {
        const wait = 1000 - (now - this.secStart) + 50;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      const elapsed = now - this.lastSend;
      if (elapsed < MIN_DELAY_MS) {
        await new Promise(r => setTimeout(r, MIN_DELAY_MS - elapsed));
      }

      const job = this.queue.shift();

      try {
        const s = sessions.get(job.sessionId);
        if (!s || s.status !== 'CONNECTED') throw new Error('Session offline');

        await s.sock.presenceSubscribe(job.jid);
        await s.sock.sendPresenceUpdate('composing', job.jid);
        await new Promise(r => setTimeout(r, 700 + Math.random() * 900));

        await s.sock.sendMessage(job.jid, job.content);

        this.msgThisSec++;
        this.lastSend = Date.now();
        s.stats.totalSent++;

        job.resolve({ success: true, type: job.type });
      } catch (e) {
        job.reject(e);
        logger.error(`Send failed: ${e.message}`);
      }
    }

    this.processing = false;
  }
}

const queue = new BlastQueue();

// ==================== SESSIONS ====================
const sessions = new Map();

async function createSession(id, phone = null) {
  if (sessions.size >= MAX_SESSIONS) throw new Error('Max sessions reached');

  const authPath = path.join(SESSIONS_DIR, id);
  await fs.ensureDir(authPath);

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const version = (await fetchLatestWaWebVersion()).version;

  const sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (upd) => {
    if (upd.qr) {
      const qr64 = await qrcode.toDataURL(upd.qr);
      sessions.set(id, { ...sessions.get(id), qr: qr64, status: 'QR_READY' });
    }

    if (upd.connection === 'open') {
      sessions.set(id, { ...sessions.get(id), sock, status: 'CONNECTED', qr: null });
      logger.info(`Session ${id} connected`);
    }

    if (upd.connection === 'close' && !(upd.lastDisconnect?.error instanceof Boom)?.output?.statusCode === DisconnectReason.loggedOut) {
      setTimeout(() => createSession(id, phone), 3000);
    }
  });

  sessions.set(id, {
    sock,
    status: 'INITIALIZING',
    qr: null,
    stats: { totalSent: 0, received: 0 }
  });

  if (phone) {
    const code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''));
    sessions.set(id, { ...sessions.get(id), pairingCode: code });
  }

  return sessions.get(id);
}

// ==================== EXPRESS APP ====================
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(compression());
app.use(express.json({ limit: '100mb' }));

// ==================== ROUTES ====================

app.get('/', (req, res) => {
  res.json({
    name: 'Blast WhatsApp API – Final v16.0.0',
    status: 'live',
    author: 'Md Dhaka',
    message: 'No authentication required – use freely'
  });
});

// Create session
app.post('/api/session/create', async (req, res) => {
  const { id, phone } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    await createSession(id, phone);
    res.json({ success: true, id, status: sessions.get(id).status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get QR or Pairing Code
app.get('/api/session/:id/qr', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  if (s.qr) return res.json({ method: 'qr', qr: s.qr });
  if (s.pairingCode) return res.json({ method: 'pairing', code: s.pairingCode });
  res.json({ status: s.status });
});

// Send text
app.post('/api/send/text', async (req, res) => {
  const { id, to, text } = req.body;
  const s = sessions.get(id);
  if (!s || s.status !== 'CONNECTED') return res.status(400).json({ error: 'Session not ready' });

  const jid = jidNormalizedUser(to + '@s.whatsapp.net');
  await queue.add(id, jid, { text }, 'text');
  res.json({ success: true });
});

// Send poll
app.post('/api/send/poll', async (req, res) => {
  const { id, to, name, values } = req.body;
  const jid = jidNormalizedUser(to + '@s.whatsapp.net');
  const content = {
    pollCreationMessage: {
      name,
      options: values.map(v => ({ optionName: v })),
      selectableCount: 1
    }
  };
  await queue.add(id, jid, content, 'poll');
  res.json({ success: true });
});

// Send button message
app.post('/api/send/button', async (req, res) => {
  const { id, to, text, buttons } = req.body;
  const jid = jidNormalizedUser(to + '@s.whatsapp.net');
  const content = {
    buttonsMessage: {
      contentText: text,
      footerText: 'Blast API',
      buttons: buttons.map(b => ({
        buttonId: b.id || crypto.randomBytes(4).toString('hex'),
        buttonText: { displayText: b.text },
        type: 1
      })),
      headerType: 1
    }
  };
  await queue.add(id, jid, content, 'button');
  res.json({ success: true });
});

// Send location
app.post('/api/send/location', async (req, res) => {
  const { id, to, lat, lng, name = '', address = '' } = req.body;
  const jid = jidNormalizedUser(to + '@s.whatsapp.net');
  const content = {
    locationMessage: {
      degreesLatitude: lat,
      degreesLongitude: lng,
      name,
      address
    }
  };
  await queue.add(id, jid, content, 'location');
  res.json({ success: true });
});

// Send voice note (audio PTT)
app.post('/api/send/voice', async (req, res) => {
  const { id, to, url } = req.body;
  const jid = jidNormalizedUser(to + '@s.whatsapp.net');
  const content = {
    audio: { url },
    ptt: true,
    mimetype: 'audio/ogg; codecs=opus'
  };
  await queue.add(id, jid, content, 'voice');
  res.json({ success: true });
});

// Send status/story
app.post('/api/send/status', async (req, res) => {
  const { id, type, content } = req.body;
  const jid = 'status@broadcast';
  let msgContent;

  if (type === 'text') {
    msgContent = { text: content };
  } else if (type === 'image') {
    msgContent = { image: { url: content }, caption: req.body.caption || '' };
  } else if (type === 'video') {
    msgContent = { video: { url: content }, caption: req.body.caption || '' };
  }

  await queue.add(id, jid, msgContent, 'status');
  res.json({ success: true });
});

// Delete message
app.post('/api/delete', async (req, res) => {
  const { id, to, messageId, forEveryone = true } = req.body;
  const s = sessions.get(id);
  if (!s) return res.status(400).json({ error: 'Session not found' });

  const jid = jidNormalizedUser(to + '@s.whatsapp.net');
  await s.sock.sendMessage(jid, {
    delete: { remoteJid: jid, fromMe: true, id: messageId }
  });
  res.json({ success: true });
});

// Create group
app.post('/api/group/create', async (req, res) => {
  const { id, subject, participants } = req.body;
  const s = sessions.get(id);
  if (!s) return res.status(400).json({ error: 'Session not found' });

  const group = await s.sock.groupCreate(subject, participants.map(p => jidNormalizedUser(p + '@s.whatsapp.net')));
  res.json({ success: true, groupId: group.id, inviteCode: group.inviteCode });
});

// Health & Stats
app.get('/api/health', (req, res) => {
  const active = Array.from(sessions.values()).filter(s => s.status === 'CONNECTED').length;
  res.json({
    status: 'healthy',
    sessions: { total: sessions.size, connected: active },
    queue: { length: queue.queue.length },
    uptime: process.uptime()
  });
});

app.listen(PORT, async () => {
  logger.info(`Blast API v16.0.0 running on port ${PORT} – No authentication`);
  logger.info('Ready for production – Md Dhaka');
});
