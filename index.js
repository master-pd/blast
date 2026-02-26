// Blast Ultimate WhatsApp Multi-Session REST API v8.0-enterprise – Production Ready 2026
// Md Dhaka – Enterprise Grade, Distributed, AI-Powered, Full Stack WhatsApp Solution

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const Queue = require('bull');
const Redis = require('ioredis');
const pino = require('pino');
const pretty = require('pino-pretty');
const multer = require('multer');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const http = require('http');
const socketIo = require('socket.io');
const compression = require('compression');
const slowDown = require('express-slow-down');
const promClient = require('prom-client');
const swaggerUi = require('swagger-ui-express');
const yaml = require('yamljs');
const agenda = require('agenda');
const mongodb = require('mongodb').MongoClient;
const { S3Client } = require('@aws-sdk/client-s3');
const { OpenAI } = require('openai');
const { Translate } = require('@google-cloud/translate').v2;
const tf = require('@tensorflow/tfjs-node');
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
  getContentType,
  makeCacheableSignalKeyStore,
  makeInMemoryStore
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const NodeCache = require('node-cache');

// ==================== INITIALIZATION ====================
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});
const wss = new WebSocket.Server({ server, path: '/ws' });

// ==================== CONFIGURATION ====================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const API_KEY = process.env.API_KEY || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/blast';
const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY;
const AWS_SECRET_KEY = process.env.AWS_SECRET_KEY;
const AWS_BUCKET = process.env.AWS_BUCKET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;

// Limits & Delays
const DAILY_MSG_LIMIT = parseInt(process.env.DAILY_MSG_LIMIT || '1000');
const QUEUE_DELAY_MIN = parseInt(process.env.QUEUE_DELAY_MIN || '1000');
const QUEUE_DELAY_MAX = parseInt(process.env.QUEUE_DELAY_MAX || '5000');
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '100');
const MAX_GROUP_SIZE = parseInt(process.env.MAX_GROUP_SIZE || '1000');
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW || '60000');
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '100');

// ==================== LOGGER SETUP ====================
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({ pid: bindings.pid, host: bindings.hostname }),
  },
  timestamp: pino.stdTimeFunctions.isoTime
}, pretty({
  colorize: true,
  translateTime: 'SYS:dd-mm-yyyy HH:MM:ss',
  ignore: 'pid,hostname'
}));

// ==================== DATABASE CONNECTIONS ====================
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => Math.min(times * 50, 2000)
});

let mongoClient;
let db;
const agendaInstance = new agenda({ mongo: MONGO_URL });

// ==================== CLOUD STORAGE ====================
let s3Client;
if (AWS_ACCESS_KEY && AWS_SECRET_KEY) {
  s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: { accessKeyId: AWS_ACCESS_KEY, secretAccessKey: AWS_SECRET_KEY }
  });
}

// ==================== AI SERVICES ====================
let openai;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
}

let translate;
if (GOOGLE_APPLICATION_CREDENTIALS) {
  translate = new Translate({ keyFilename: GOOGLE_APPLICATION_CREDENTIALS });
}

// ==================== CACHE & STORES ====================
const messageCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
const mediaCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 });
const sessionStore = makeInMemoryStore({ logger: pino({ level: 'silent' }) });

// ==================== PROMETHEUS METRICS ====================
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status']
});

const activeSessionsGauge = new promClient.Gauge({
  name: 'active_sessions_total',
  help: 'Total active WhatsApp sessions'
});

const messagesSentTotal = new promClient.Counter({
  name: 'messages_sent_total',
  help: 'Total messages sent',
  labelNames: ['type', 'session']
});

const queueSizeGauge = new promClient.Gauge({
  name: 'queue_size_total',
  help: 'Total jobs in queue'
});

register.registerMetric(httpRequestsTotal);
register.registerMetric(activeSessionsGauge);
register.registerMetric(messagesSentTotal);
register.registerMetric(queueSizeGauge);

// ==================== MIDDLEWARE ====================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  credentials: true
}));
app.use(compression());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    httpRequestsTotal.inc({ method: req.method, path: req.route?.path || req.path, status: res.statusCode });
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
  });
  next();
});

// Rate limiting with slowing
const speedLimiter = slowDown({
  windowMs: RATE_LIMIT_WINDOW,
  delayAfter: RATE_LIMIT_MAX / 2,
  delayMs: (hits) => hits * 100
});

const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW,
  max: RATE_LIMIT_MAX,
  message: { success: false, error: 'Rate limit exceeded', retryAfter: RATE_LIMIT_WINDOW / 1000 },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', speedLimiter, apiLimiter);

// ==================== FILE UPLOAD CONFIG ====================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'audio/mpeg', 'audio/ogg', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  }
});

// ==================== DIRECTORY SETUP ====================
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const MEDIA_DIR = path.join(__dirname, 'media');
const TEMP_DIR = path.join(__dirname, 'temp');
const BACKUP_DIR = path.join(__dirname, 'backups');

fs.ensureDirSync(SESSIONS_DIR);
fs.ensureDirSync(MEDIA_DIR);
fs.ensureDirSync(TEMP_DIR);
fs.ensureDirSync(BACKUP_DIR);

// ==================== SESSION MANAGEMENT ====================
const sessions = new Map(); // sessionId → { sock, status, qr, pairingCode, stats, reconnects, lastActive, metadata, webhooks }

// ==================== ADVANCED QUEUE SYSTEM ====================
const msgQueue = new Queue('blast-enterprise-queue', {
  redis: { host: '127.0.0.1', port: 6379 },
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 100,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 }
  }
});

// Queue monitoring
msgQueue.on('active', (job) => queueSizeGauge.inc());
msgQueue.on('completed', (job) => queueSizeGauge.dec());
msgQueue.on('failed', (job) => queueSizeGauge.dec());

// ==================== AUTHENTICATION MIDDLEWARE ====================
const authenticate = (req, res, next) => {
  if (!API_KEY && !JWT_SECRET) return next();
  
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  const token = req.headers['authorization']?.split(' ')[1];
  
  if (apiKey && apiKey === API_KEY) {
    req.user = { type: 'api_key', id: 'system' };
    return next();
  }
  
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      return next();
    } catch (err) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
  }
  
  return res.status(401).json({ success: false, error: 'Authentication required' });
};

// ==================== WEBHOOK SIGNATURE ====================
const signWebhook = (payload) => {
  return crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');
};

const sendWebhook = async (event, sessionId, data) => {
  if (!WEBHOOK_URL) return;
  
  const payload = {
    event,
    sessionId,
    data,
    timestamp: new Date().toISOString(),
    signature: signWebhook({ event, sessionId, data })
  };
  
  try {
    await axios.post(WEBHOOK_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    });
  } catch (error) {
    logger.error(`Webhook delivery failed: ${error.message}`);
    // Store failed webhooks in Redis for retry
    await redis.lpush('failed_webhooks', JSON.stringify(payload));
  }
};

// ==================== MEDIA PROCESSING ====================
async function processMedia(buffer, type, options = {}) {
  try {
    switch (type) {
      case 'image':
        let image = sharp(buffer);
        if (options.resize) {
          image = image.resize(options.resize.width, options.resize.height, {
            fit: options.resize.fit || 'cover',
            withoutEnlargement: true
          });
        }
        if (options.quality) {
          image = image.jpeg({ quality: options.quality });
        }
        return await image.toBuffer();
        
      case 'video':
        return new Promise((resolve, reject) => {
          const outputPath = path.join(TEMP_DIR, `${crypto.randomBytes(16).toString('hex')}.mp4`);
          ffmpeg()
            .input(buffer)
            .inputFormat('mp4')
            .videoCodec('libx264')
            .audioCodec('aac')
            .size(options.resize ? `${options.resize.width}x${options.resize.height}` : undefined)
            .autopad()
            .outputOptions([
              '-preset ultrafast',
              '-movflags +faststart',
              '-crf 23'
            ])
            .on('end', () => {
              const processedBuffer = fs.readFileSync(outputPath);
              fs.unlinkSync(outputPath);
              resolve(processedBuffer);
            })
            .on('error', reject)
            .save(outputPath);
        });
        
      default:
        return buffer;
    }
  } catch (error) {
    logger.error(`Media processing error: ${error.message}`);
    return buffer;
  }
}

// ==================== AI INTEGRATION ====================
async function generateAIResponse(message, context = {}) {
  if (!openai) return null;
  
  try {
    const completion = await openai.chat.completions.create({
      model: context.model || 'gpt-4',
      messages: [
        { role: 'system', content: context.systemPrompt || 'You are a helpful WhatsApp assistant.' },
        { role: 'user', content: message }
      ],
      temperature: context.temperature || 0.7,
      max_tokens: context.maxTokens || 500
    });
    
    return completion.choices[0].message.content;
  } catch (error) {
    logger.error(`AI generation error: ${error.message}`);
    return null;
  }
}

async function translateMessage(message, targetLanguage) {
  if (!translate) return message;
  
  try {
    const [translation] = await translate.translate(message, targetLanguage);
    return translation;
  } catch (error) {
    logger.error(`Translation error: ${error.message}`);
    return message;
  }
}

// ==================== SESSION MANAGEMENT FUNCTIONS ====================
async function createOrLoadSession(sessionId, phoneNumber = null, options = {}) {
  // Check session limit
  if (sessions.size >= MAX_SESSIONS && !sessions.has(sessionId)) {
    throw new Error(`Maximum sessions limit (${MAX_SESSIONS}) reached`);
  }
  
  if (sessions.has(sessionId)) {
    const s = sessions.get(sessionId);
    if (s.status === 'CONNECTED') return s.sock;
    if (s.sock) {
      try { s.sock.end(); } catch (e) {}
    }
  }

  logger.info(`Creating/loading session: ${sessionId}`);

  const authPath = path.join(SESSIONS_DIR, sessionId);
  await fs.ensureDir(authPath);
  
  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  const version = (await fetchLatestWaWebVersion()).version;

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: true,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    patchMessageBeforeSending: (msg) => {
      // Add custom message patches here
      return msg;
    },
    shouldIgnoreJid: (jid) => {
      // Ignore status broadcasts
      return jid === 'status@broadcast';
    },
    getMessage: async (key) => {
      const cached = messageCache.get(key.id);
      if (cached) return cached;
      
      const msg = await sessionStore.loadMessage(key.remoteJid, key.id);
      messageCache.set(key.id, msg);
      return msg;
    }
  });

  sessionStore.bind(sock.ev);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrBase64 = await qrcode.toDataURL(qr);
      const s = sessions.get(sessionId) || {};
      sessions.set(sessionId, { ...s, qr: qrBase64, status: 'QR_READY' });
      await sendWebhook('qr_ready', sessionId, { qr: qrBase64 });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      activeSessionsGauge.dec();
      
      logger.warn(`Disconnected ${sessionId} | Code: ${statusCode} | Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        const backoff = Math.min(300000, 5000 * Math.pow(2, sessions.get(sessionId)?.reconnects || 1));
        setTimeout(() => createOrLoadSession(sessionId, phoneNumber, options), backoff);
        const s = sessions.get(sessionId);
        if (s) s.reconnects = (s.reconnects || 0) + 1;
        await sendWebhook('reconnecting', sessionId, { backoff });
      } else {
        sessions.delete(sessionId);
        await sendWebhook('logged_out', sessionId, {});
        logger.info(`Session ${sessionId} permanently logged out`);
      }
    }

    if (connection === 'open') {
      const s = sessions.get(sessionId) || {};
      const user = sock.user;
      
      sessions.set(sessionId, {
        ...s,
        sock,
        status: 'CONNECTED',
        qr: null,
        pairingCode: null,
        lastActive: Date.now(),
        reconnects: 0,
        metadata: {
          ...s.metadata,
          user: {
            id: user.id,
            name: user.name,
            phone: user.id?.split('@')[0]
          },
          connectedAt: new Date().toISOString()
        }
      });
      
      activeSessionsGauge.inc();
      
      logger.info(`Session ${sessionId} connected as ${user.id}`);
      await sendWebhook('connection_open', sessionId, { user: user.id });
      
      // Send connected event via Socket.IO
      io.to(sessionId).emit('connected', { sessionId, user: user.id });
    }
  });

  // Enhanced message handling
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    
    const msg = m.messages[0];
    if (!msg || !msg.key) return;
    
    const jid = msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');
    const isFromMe = msg.key.fromMe;
    const messageType = getContentType(msg.message);
    
    if (!isFromMe) {
      const s = sessions.get(sessionId);
      if (s) {
        s.stats.received++;
        s.lastActive = Date.now();
      }
      
      // Cache message
      messageCache.set(msg.key.id, msg);
      
      // Log message
      logger.info(`📨 Incoming [${messageType}] from ${jid} on ${sessionId}`);
      
      // Send to webhook
      await sendWebhook('message', sessionId, {
        id: msg.key.id,
        from: jid,
        fromMe: false,
        type: messageType,
        timestamp: msg.messageTimestamp,
        content: msg.message,
        isGroup
      });
      
      // Socket.IO broadcast
      io.to(sessionId).emit('message', {
        id: msg.key.id,
        from: jid,
        type: messageType,
        timestamp: msg.messageTimestamp
      });
      
      // Auto-reply if configured
      const session = sessions.get(sessionId);
      if (session?.metadata?.autoReply?.enabled) {
        const reply = await generateAIResponse(
          msg.message?.conversation || msg.message?.extendedTextMessage?.text,
          session.metadata.autoReply
        );
        
        if (reply) {
          await sock.sendMessage(jid, { text: reply });
        }
      }
    }
  });

  // Handle reactions
  sock.ev.on('messages.reaction', async (reactions) => {
    for (const reaction of reactions) {
      await sendWebhook('reaction', sessionId, reaction);
    }
  });

  // Handle read receipts
  sock.ev.on('message-receipt.update', async (updates) => {
    for (const update of updates) {
      await sendWebhook('receipt', sessionId, update);
    }
  });

  // Handle presence updates
  sock.ev.on('presence.update', async (update) => {
    await sendWebhook('presence', sessionId, update);
  });

  // Handle group updates
  sock.ev.on('groups.update', async (updates) => {
    for (const update of updates) {
      await sendWebhook('group_update', sessionId, update);
    }
  });

  // Handle group participants update
  sock.ev.on('group-participants.update', async (update) => {
    await sendWebhook('group_participants', sessionId, update);
  });

  // Pairing code generation
  if (phoneNumber) {
    try {
      const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
      const code = await sock.requestPairingCode(cleanNumber);
      
      sessions.set(sessionId, { 
        ...sessions.get(sessionId), 
        pairingCode: code,
        status: 'PAIRING_CODE_READY'
      });
      
      logger.info(`Pairing code for ${sessionId}: ${code}`);
      await sendWebhook('pairing_code', sessionId, { code, phone: cleanNumber });
    } catch (e) {
      logger.error(`Pairing failed: ${e.message}`);
      await sendWebhook('pairing_error', sessionId, { error: e.message });
    }
  }

  // Initialize session stats
  sessions.set(sessionId, {
    sock,
    status: 'INITIALIZING',
    qr: null,
    pairingCode: null,
    stats: { 
      sentToday: 0, 
      totalSent: 0, 
      received: 0, 
      lastReset: Date.now(),
      groups: 0,
      contacts: 0
    },
    reconnects: 0,
    lastActive: Date.now(),
    metadata: options.metadata || {},
    webhooks: options.webhooks || []
  });

  return sock;
}

// ==================== LOAD SESSIONS ON START ====================
async function loadSessionsOnStart() {
  const dirs = await fs.readdir(SESSIONS_DIR);
  let loaded = 0;
  
  for (const dir of dirs) {
    const stat = await fs.stat(path.join(SESSIONS_DIR, dir));
    if (stat.isDirectory() && dir !== 'default') {
      try {
        await createOrLoadSession(dir);
        loaded++;
      } catch (error) {
        logger.error(`Failed to load session ${dir}: ${error.message}`);
      }
    }
  }
  
  logger.info(`Loaded ${loaded} saved sessions`);
}

// ==================== BACKGROUND JOBS ====================
agendaInstance.define('reset daily limits', async (job) => {
  for (const [sessionId, session] of sessions) {
    if (session.stats) {
      session.stats.sentToday = 0;
      session.stats.lastReset = Date.now();
      logger.debug(`Reset daily limits for ${sessionId}`);
    }
  }
});

agendaInstance.define('cleanup old sessions', async (job) => {
  const now = Date.now();
  const maxInactive = 7 * 24 * 60 * 60 * 1000; // 7 days
  
  for (const [sessionId, session] of sessions) {
    if (session.status === 'CONNECTED' && now - session.lastActive > maxInactive) {
      logger.info(`Cleaning up inactive session: ${sessionId}`);
      try {
        if (session.sock) {
          await session.sock.logout();
        }
      } catch (e) {}
      sessions.delete(sessionId);
    }
  }
});

agendaInstance.define('backup sessions', async (job) => {
  const backupPath = path.join(BACKUP_DIR, `sessions_${Date.now()}`);
  await fs.copy(SESSIONS_DIR, backupPath);
  
  // Keep only last 5 backups
  const backups = await fs.readdir(BACKUP_DIR);
  if (backups.length > 5) {
    backups.sort().slice(0, -5).forEach(async (b) => {
      await fs.remove(path.join(BACKUP_DIR, b));
    });
  }
  
  logger.info(`Sessions backed up to ${backupPath}`);
});

// ==================== API ROUTES ====================

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '8.0.0-enterprise'
  });
});

// Metrics endpoint for Prometheus
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// API Documentation
const swaggerDocument = yaml.load(path.join(__dirname, 'swagger.yaml'));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ==================== SESSION MANAGEMENT ENDPOINTS ====================

// List all sessions
app.get('/api/sessions', authenticate, async (req, res) => {
  const sessionList = Array.from(sessions.entries()).map(([id, data]) => ({
    id,
    status: data.status,
    qr: data.qr,
    pairingCode: data.pairingCode,
    stats: data.stats,
    lastActive: data.lastActive,
    metadata: data.metadata,
    user: data.metadata?.user
  }));
  
  res.json({
    success: true,
    total: sessionList.length,
    sessions: sessionList
  });
});

// Create new session
app.post('/api/session/create', authenticate, async (req, res) => {
  try {
    const { sessionId, phone, metadata, webhooks } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId required' });
    }
    
    if (sessions.has(sessionId)) {
      return res.status(409).json({ success: false, error: 'Session already exists' });
    }
    
    await createOrLoadSession(sessionId, phone, { metadata, webhooks });
    
    res.json({
      success: true,
      sessionId,
      status: 'initializing',
      method: phone ? 'pairing_code' : 'qr'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get session QR
app.get('/api/session/:sessionId/qr', authenticate, async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  if (session.qr) {
    res.json({ success: true, qr: session.qr });
  } else if (session.pairingCode) {
    res.json({ success: true, method: 'pairing_code', code: session.pairingCode });
  } else {
    res.json({ success: false, error: 'QR not ready yet', status: session.status });
  }
});

// Get session status
app.get('/api/session/:sessionId/status', authenticate, async (req, res) => {
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
    lastActive: session.lastActive,
    user: session.metadata?.user
  });
});

// Logout session
app.post('/api/session/:sessionId/logout', authenticate, async (req, res) => {
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
    
    // Remove auth folder
    const authPath = path.join(SESSIONS_DIR, sessionId);
    await fs.remove(authPath);
    
    activeSessionsGauge.dec();
    
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== MESSAGING ENDPOINTS ====================

// Send text message
app.post('/api/send/text', authenticate, async (req, res) => {
  try {
    const { sessionId, to, message, options = {} } = req.body;
    
    if (!sessionId || !to || !message) {
      return res.status(400).json({ success: false, error: 'sessionId, to, and message required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    if (session.stats.sentToday >= DAILY_MSG_LIMIT) {
      return res.status(429).json({ success: false, error: 'Daily message limit reached' });
    }
    
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    
    // Prepare message content
    let messageContent = { text: message };
    
    // Add mentions if provided
    if (options.mentions && options.mentions.length > 0) {
      messageContent.mentions = options.mentions.map(m => m.includes('@') ? m : `${m}@s.whatsapp.net`);
    }
    
    // Add link preview
    if (options.linkPreview !== false) {
      messageContent.contextInfo = { mentionedJid: messageContent.mentions };
    }
    
    // Send with optional delay for human-like behavior
    if (options.humanLike) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
      await session.sock.presenceSubscribe(jid);
      await session.sock.sendPresenceUpdate('composing', jid);
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    }
    
    const sent = await session.sock.sendMessage(jid, messageContent, {
      quoted: options.quoted ? { key: options.quoted } : undefined
    });
    
    // Update stats
    session.stats.sentToday++;
    session.stats.totalSent++;
    session.lastActive = Date.now();
    
    messagesSentTotal.inc({ type: 'text', session: sessionId });
    
    res.json({
      success: true,
      messageId: sent.key.id,
      timestamp: Date.now()
    });
  } catch (error) {
    logger.error(`Send error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send media message
app.post('/api/send/media', authenticate, upload.single('file'), async (req, res) => {
  try {
    const { sessionId, to, caption, type = 'image', options = {} } = req.body;
    const file = req.file;
    
    if (!sessionId || !to) {
      return res.status(400).json({ success: false, error: 'sessionId and to required' });
    }
    
    if (!file && !req.body.url && !req.body.base64) {
      return res.status(400).json({ success: false, error: 'file, url, or base64 required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    
    // Get media buffer
    let buffer;
    let mimetype;
    
    if (file) {
      buffer = file.buffer;
      mimetype = file.mimetype;
    } else if (req.body.url) {
      const response = await axios.get(req.body.url, { responseType: 'arraybuffer' });
      buffer = Buffer.from(response.data);
      mimetype = response.headers['content-type'];
    } else if (req.body.base64) {
      buffer = Buffer.from(req.body.base64, 'base64');
      mimetype = req.body.mimetype || 'image/jpeg';
    }
    
    // Process media if needed
    if (options.process) {
      buffer = await processMedia(buffer, type, options.process);
    }
    
    // Upload to cloud storage if configured
    let mediaUrl;
    if (s3Client && AWS_BUCKET) {
      const key = `media/${sessionId}/${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
      await s3Client.putObject({
        Bucket: AWS_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimetype
      });
      mediaUrl = `https://${AWS_BUCKET}.s3.amazonaws.com/${key}`;
    }
    
    // Prepare media message
    const mediaMessage = await prepareWAMessageMedia({
      [type]: buffer,
      caption: caption,
      mimetype: mimetype
    }, { upload: session.sock.waUploadToServer });
    
    const message = {
      ...mediaMessage,
      caption: caption
    };
    
    const sent = await session.sock.sendMessage(jid, message, {
      quoted: options.quoted ? { key: options.quoted } : undefined
    });
    
    session.stats.sentToday++;
    session.stats.totalSent++;
    messagesSentTotal.inc({ type, session: sessionId });
    
    res.json({
      success: true,
      messageId: sent.key.id,
      mediaUrl,
      timestamp: Date.now()
    });
  } catch (error) {
    logger.error(`Media send error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send location
app.post('/api/send/location', authenticate, async (req, res) => {
  try {
    const { sessionId, to, latitude, longitude, name, address } = req.body;
    
    if (!sessionId || !to || !latitude || !longitude) {
      return res.status(400).json({ success: false, error: 'sessionId, to, latitude, longitude required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    
    const sent = await session.sock.sendMessage(jid, {
      location: {
        degreesLatitude: latitude,
        degreesLongitude: longitude,
        name: name,
        address: address
      }
    });
    
    res.json({
      success: true,
      messageId: sent.key.id,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send contact
app.post('/api/send/contact', authenticate, async (req, res) => {
  try {
    const { sessionId, to, contacts } = req.body;
    
    if (!sessionId || !to || !contacts || !contacts.length) {
      return res.status(400).json({ success: false, error: 'sessionId, to, and contacts required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    
    const vcards = contacts.map((contact, index) => {
      return `BEGIN:VCARD\nVERSION:3.0\nFN:${contact.name}\nTEL;type=CELL;waid=${contact.phone}:+${contact.phone}\nEND:VCARD`;
    }).join('\n');
    
    const sent = await session.sock.sendMessage(jid, {
      contacts: {
        displayName: contacts.length > 1 ? `${contacts.length} contacts` : contacts[0].name,
        contacts: contacts.map(c => ({
          vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${c.name}\nTEL;type=CELL;waid=${c.phone}:+${c.phone}\nEND:VCARD`
        }))
      }
    });
    
    res.json({
      success: true,
      messageId: sent.key.id,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send button message
app.post('/api/send/button', authenticate, async (req, res) => {
  try {
    const { sessionId, to, text, buttons, footer } = req.body;
    
    if (!sessionId || !to || !text || !buttons) {
      return res.status(400).json({ success: false, error: 'sessionId, to, text, buttons required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    
    const buttonMessage = {
      text: text,
      footer: footer,
      buttons: buttons.map((btn, i) => ({
        buttonId: btn.id || `btn_${i}`,
        buttonText: { displayText: btn.text },
        type: 1
      })),
      headerType: 1
    };
    
    const sent = await session.sock.sendMessage(jid, buttonMessage);
    
    res.json({
      success: true,
      messageId: sent.key.id,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send poll
app.post('/api/send/poll', authenticate, async (req, res) => {
  try {
    const { sessionId, to, name, options, selectableCount = 1 } = req.body;
    
    if (!sessionId || !to || !name || !options || !options.length) {
      return res.status(400).json({ success: false, error: 'sessionId, to, name, options required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    
    const pollMessage = {
      poll: {
        name: name,
        values: options,
        selectableCount: selectableCount
      }
    };
    
    const sent = await session.sock.sendMessage(jid, pollMessage);
    
    res.json({
      success: true,
      messageId: sent.key.id,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send reaction
app.post('/api/send/reaction', authenticate, async (req, res) => {
  try {
    const { sessionId, to, messageId, emoji } = req.body;
    
    if (!sessionId || !to || !messageId || !emoji) {
      return res.status(400).json({ success: false, error: 'sessionId, to, messageId, emoji required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    
    const reactionMessage = {
      react: {
        text: emoji,
        key: { remoteJid: jid, id: messageId }
      }
    };
    
    const sent = await session.sock.sendMessage(jid, reactionMessage);
    
    res.json({
      success: true,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send status/story
app.post('/api/send/status', authenticate, upload.single('media'), async (req, res) => {
  try {
    const { sessionId, type = 'text', text, backgroundColor = '#000000', font = 1 } = req.body;
    const file = req.file;
    
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    let statusContent;
    
    if (type === 'text') {
      if (!text) {
        return res.status(400).json({ success: false, error: 'text required for text status' });
      }
      
      statusContent = {
        text: text,
        backgroundColor: backgroundColor,
        font: font
      };
    } else {
      if (!file) {
        return res.status(400).json({ success: false, error: 'media required' });
      }
      
      statusContent = {
        [type]: file.buffer,
        caption: text,
        backgroundColor: backgroundColor
      };
    }
    
    const sent = await session.sock.sendMessage('status@broadcast', statusContent);
    
    res.json({
      success: true,
      messageId: sent.key.id,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bulk send messages
app.post('/api/send/bulk', authenticate, async (req, res) => {
  try {
    const { sessionId, messages } = req.body;
    
    if (!sessionId || !messages || !messages.length) {
      return res.status(400).json({ success: false, error: 'sessionId and messages array required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    const results = [];
    let successCount = 0;
    
    for (const msg of messages) {
      try {
        // Check daily limit
        if (session.stats.sentToday >= DAILY_MSG_LIMIT) {
          break;
        }
        
        const job = await msgQueue.add({
          sessionId,
          jid: msg.to.includes('@') ? msg.to : `${msg.to}@s.whatsapp.net`,
          content: msg.content,
          type: msg.type
        });
        
        results.push({
          to: msg.to,
          queued: true,
          jobId: job.id
        });
        
        successCount++;
      } catch (error) {
        results.push({
          to: msg.to,
          error: error.message
        });
      }
      
      // Add delay between sends
      const delay = QUEUE_DELAY_MIN + Math.random() * (QUEUE_DELAY_MAX - QUEUE_DELAY_MIN);
      await new Promise(r => setTimeout(r, delay));
    }
    
    res.json({
      success: true,
      totalQueued: successCount,
      results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== GROUP MANAGEMENT ENDPOINTS ====================

// Create group
app.post('/api/group/create', authenticate, async (req, res) => {
  try {
    const { sessionId, subject, participants, description } = req.body;
    
    if (!sessionId || !subject || !participants || participants.length === 0) {
      return res.status(400).json({ success: false, error: 'sessionId, subject, participants required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    // Format participants
    const formattedParticipants = participants.map(p => 
      p.includes('@') ? p : `${p}@s.whatsapp.net`
    );
    
    const group = await session.sock.groupCreate(subject, formattedParticipants);
    
    if (description) {
      await session.sock.groupUpdateDescription(group.id, description);
    }
    
    res.json({
      success: true,
      groupId: group.id,
      participants: group.participants
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update group settings
app.post('/api/group/:groupId/settings', authenticate, async (req, res) => {
  try {
    const { sessionId, groupId } = req.params;
    const { whoCanSend, whoCanEditInfo, whoCanApproveMembers } = req.body;
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
    
    if (whoCanSend) {
      await session.sock.groupUpdateSetting(jid, 'announcement', whoCanSend === 'admin' ? 'on' : 'off');
    }
    
    if (whoCanEditInfo) {
      await session.sock.groupUpdateSetting(jid, 'locked', whoCanEditInfo === 'admin' ? 'on' : 'off');
    }
    
    if (whoCanApproveMembers) {
      await session.sock.groupUpdateSetting(jid, 'approve_new_members', whoCanApproveMembers === 'admin' ? 'on' : 'off');
    }
    
    res.json({ success: true, message: 'Group settings updated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add participants to group
app.post('/api/group/:groupId/add', authenticate, async (req, res) => {
  try {
    const { sessionId, groupId } = req.params;
    const { participants } = req.body;
    
    if (!participants || !participants.length) {
      return res.status(400).json({ success: false, error: 'participants required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
    
    const formattedParticipants = participants.map(p => 
      p.includes('@') ? p : `${p}@s.whatsapp.net`
    );
    
    const result = await session.sock.groupParticipantsUpdate(jid, formattedParticipants, 'add');
    
    res.json({
      success: true,
      result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Remove participants from group
app.post('/api/group/:groupId/remove', authenticate, async (req, res) => {
  try {
    const { sessionId, groupId } = req.params;
    const { participants } = req.body;
    
    if (!participants || !participants.length) {
      return res.status(400).json({ success: false, error: 'participants required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
    
    const formattedParticipants = participants.map(p => 
      p.includes('@') ? p : `${p}@s.whatsapp.net`
    );
    
    const result = await session.sock.groupParticipantsUpdate(jid, formattedParticipants, 'remove');
    
    res.json({
      success: true,
      result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Promote participants to admin
app.post('/api/group/:groupId/promote', authenticate, async (req, res) => {
  try {
    const { sessionId, groupId } = req.params;
    const { participants } = req.body;
    
    if (!participants || !participants.length) {
      return res.status(400).json({ success: false, error: 'participants required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
    
    const formattedParticipants = participants.map(p => 
      p.includes('@') ? p : `${p}@s.whatsapp.net`
    );
    
    const result = await session.sock.groupParticipantsUpdate(jid, formattedParticipants, 'promote');
    
    res.json({
      success: true,
      result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Demote participants from admin
app.post('/api/group/:groupId/demote', authenticate, async (req, res) => {
  try {
    const { sessionId, groupId } = req.params;
    const { participants } = req.body;
    
    if (!participants || !participants.length) {
      return res.status(400).json({ success: false, error: 'participants required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
    
    const formattedParticipants = participants.map(p => 
      p.includes('@') ? p : `${p}@s.whatsapp.net`
    );
    
    const result = await session.sock.groupParticipantsUpdate(jid, formattedParticipants, 'demote');
    
    res.json({
      success: true,
      result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get group info
app.get('/api/group/:groupId/info', authenticate, async (req, res) => {
  try {
    const { sessionId, groupId } = req.query;
    
    if (!sessionId || !groupId) {
      return res.status(400).json({ success: false, error: 'sessionId and groupId required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
    
    const metadata = await session.sock.groupMetadata(jid);
    
    res.json({
      success: true,
      metadata
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all groups
app.get('/api/groups', authenticate, async (req, res) => {
  try {
    const { sessionId } = req.query;
    
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: 'Session not connected' });
    }
    
    const groups = await session.sock.groupFetchAllParticipating();
    
    res.json({
      success: true,
      total: Object.keys(groups).length,
      groups
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== AI FEATURES ENDPOINTS ====================

// AI Chat completion
app.post('/api/ai/chat', authenticate, async (req, res) => {
  try {
    const { message, context = {} } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, error: 'message required' });
    }
    
    if (!openai) {
      return res.status(503).json({ success: false, error: 'AI service not configured' });
    }
    
    const response = await generateAIResponse(message, context);
    
    res.json({
      success: true,
      response
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Translate message
app.post('/api/ai/translate', authenticate, async (req, res) => {
  try {
    const { message, targetLanguage } = req.body;
    
    if (!message || !targetLanguage) {
      return res.status(400).json({ success: false, error: 'message and targetLanguage required' });
    }
    
    if (!translate) {
      return res.status(503).json({ success: false, error: 'Translation service not configured' });
    }
    
    const translation = await translateMessage(message, targetLanguage);
    
    res.json({
      success: true,
      original: message,
      translation,
      targetLanguage
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== WEBHOOK MANAGEMENT ====================

// Register webhook for session
app.post('/api/session/:sessionId/webhook', authenticate, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { url, events = ['message', 'connection_open', 'qr_ready'] } = req.body;
    
    if (!url) {
      return res.status(400).json({ success: false, error: 'url required' });
    }
    
    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    if (!session.webhooks) {
      session.webhooks = [];
    }
    
    session.webhooks.push({
      url,
      events,
      created: new Date().toISOString()
    });
    
    res.json({
      success: true,
      message: 'Webhook registered',
      webhooks: session.webhooks
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ANALYTICS ENDPOINTS ====================

// Get session analytics
app.get('/api/analytics/session/:sessionId', authenticate, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { period = 'day' } = req.query;
    
    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    // Get analytics from Redis
    const messagesSent = await redis.get(`stats:${sessionId}:sent:${period}`) || 0;
    const messagesReceived = await redis.get(`stats:${sessionId}:received:${period}`) || 0;
    const groupsCount = await redis.get(`stats:${sessionId}:groups`) || 0;
    
    res.json({
      success: true,
      sessionId,
      period,
      stats: {
        messagesSent: parseInt(messagesSent),
        messagesReceived: parseInt(messagesReceived),
        groups: parseInt(groupsCount),
        dailyLimit: DAILY_MSG_LIMIT,
        remainingToday: DAILY_MSG_LIMIT - (session.stats?.sentToday || 0)
      },
      performance: {
        uptime: session.status === 'CONNECTED' ? process.uptime() : 0,
        lastActive: session.lastActive,
        reconnects: session.reconnects
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// System analytics
app.get('/api/analytics/system', authenticate, async (req, res) => {
  try {
    const activeSessions = Array.from(sessions.values()).filter(s => s.status === 'CONNECTED').length;
    const totalMessages = Array.from(sessions.values()).reduce((acc, s) => acc + (s.stats?.totalSent || 0), 0);
    
    const memoryUsage = process.memoryUsage();
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      system: {
        uptime: process.uptime(),
        nodeVersion: process.version,
        platform: process.platform,
        cpuUsage: process.cpuUsage()
      },
      sessions: {
        total: sessions.size,
        active: activeSessions,
        inactive: sessions.size - activeSessions
      },
      messages: {
        total: totalMessages,
        averagePerSession: sessions.size ? (totalMessages / sessions.size).toFixed(2) : 0
      },
      memory: {
        rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        external: `${(memoryUsage.external / 1024 / 1024).toFixed(2)} MB`
      },
      queue: {
        waiting: await msgQueue.getWaitingCount(),
        active: await msgQueue.getActiveCount(),
        completed: await msgQueue.getCompletedCount(),
        failed: await msgQueue.getFailedCount()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SOCKET.IO CONNECTION ====================
io.on('connection', (socket) => {
  logger.info(`Socket connected: ${socket.id}`);
  
  socket.on('subscribe', (sessionId) => {
    socket.join(sessionId);
    logger.info(`Socket ${socket.id} subscribed to ${sessionId}`);
  });
  
  socket.on('unsubscribe', (sessionId) => {
    socket.leave(sessionId);
  });
  
  socket.on('disconnect', () => {
    logger.info(`Socket disconnected: ${socket.id}`);
  });
});

// ==================== WEBSOCKET SERVER ====================
wss.on('connection', (ws, req) => {
  logger.info('WebSocket client connected');
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      
      switch (message.type) {
        case 'subscribe':
          ws.sessionId = message.sessionId;
          break;
          
        case 'send':
          // Handle real-time sending via WebSocket
          const { sessionId, to, content } = message;
          const session = sessions.get(sessionId);
          
          if (session && session.status === 'CONNECTED') {
            const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
            await session.sock.sendMessage(jid, content);
            ws.send(JSON.stringify({ type: 'sent', success: true }));
          }
          break;
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', error: error.message }));
    }
  });
  
  ws.on('close', () => {
    logger.info('WebSocket client disconnected');
  });
});

// ==================== ERROR HANDLING MIDDLEWARE ====================
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.stack}`);
  
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    timestamp: new Date().toISOString()
  });
});

// ==================== GRACEFUL SHUTDOWN ====================
async function gracefulShutdown() {
  logger.info('Received shutdown signal, cleaning up...');
  
  // Close all socket connections
  for (const [sessionId, session] of sessions) {
    if (session.sock) {
      try {
        await session.sock.logout();
        session.sock.end();
      } catch (e) {
        logger.error(`Error closing session ${sessionId}: ${e.message}`);
      }
    }
  }
  
  // Close queue
  await msgQueue.close();
  
  // Close database connections
  await redis.quit();
  if (mongoClient) {
    await mongoClient.close();
  }
  await agendaInstance.stop();
  
  // Close server
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  
  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ==================== START SERVER ====================
server.listen(PORT, async () => {
  logger.info('='.repeat(60));
  logger.info(`🚀 Blast Ultimate WhatsApp API v8.0-enterprise`);
  logger.info(`📱 Production Ready - Enterprise Edition`);
  logger.info(`👨‍💻 Author: Md Dhaka`);
  logger.info(`🌐 Server running on port ${PORT}`);
  logger.info(`📊 Metrics: http://localhost:${PORT}/metrics`);
  logger.info(`📚 API Docs: http://localhost:${PORT}/api/docs`);
  logger.info(`🔌 WebSocket: ws://localhost:${PORT}/ws`);
  logger.info(`⚡ Socket.IO: http://localhost:${PORT}`);
  logger.info('='.repeat(60));
  
  try {
    // Connect to MongoDB
    mongoClient = await mongodb.connect(MONGO_URL);
    db = mongoClient.db();
    await agendaInstance.start();
    logger.info('✅ MongoDB connected');
    
    // Start background jobs
    await agendaInstance.every('24 hours', 'reset daily limits');
    await agendaInstance.every('1 hour', 'cleanup old sessions');
    await agendaInstance.every('24 hours', 'backup sessions');
    logger.info('✅ Background jobs scheduled');
    
    // Load existing sessions
    await loadSessionsOnStart();
    
    logger.info('✅ Server fully operational');
  } catch (error) {
    logger.error(`❌ Startup error: ${error.message}`);
  }
});

// ==================== EXPORT FOR TESTING ====================
module.exports = { app, server, sessions };
