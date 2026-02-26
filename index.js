// ===================================================
// BLAST ULTIMATE WHATSAPP API v15.0.0
// Unlimited Messages | 2 Msg/Sec | 500ms Delay
// Author: Md Dhaka
// ===================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
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

// ==================== CONFIGURATION ====================
const config = {
  port: process.env.PORT || 3000,
  apiKey: process.env.API_KEY || 'blast-production-key-2026',
  nodeEnv: process.env.NODE_ENV || 'production',
  
  // Session Management
  maxSessions: parseInt(process.env.MAX_SESSIONS) || 500,
  
  // Message Configuration
  messagesPerSecond: 2,                    // 2 messages per second
  messageDelay: 500,                        // 500ms delay
  unlimitedMessages: true,                   // No daily limit
  
  // Timing
  reconnectBackoff: parseInt(process.env.RECONNECT_BACKOFF) || 3000,
  
  // Security
  rateLimitWindow: 60000,                    // 1 minute
  rateLimitMax: 200,                          // 200 requests per minute
  
  // Paths
  sessionsDir: path.join(process.cwd(), 'sessions'),
  tempDir: path.join(process.cwd(), 'temp'),
  
  // Cluster Mode (for 500+ sessions)
  useCluster: process.env.USE_CLUSTER === 'true' && cluster.isMaster
};

// Create directories
fs.ensureDirSync(config.sessionsDir);
fs.ensureDirSync(config.tempDir);

// ==================== LOGGER ====================
const logger = P({
  level: 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  timestamp: () => `,"time":"${new Date().toISOString()}"`
});

// Console logger for development
if (config.nodeEnv !== 'production') {
  const pretty = require('pino-pretty');
  logger.stream = pretty({ colorize: true, translateTime: true });
}

// ==================== MESSAGE QUEUE SYSTEM ====================
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
      queued: 0
    };
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
      // Rate limiting: 2 messages per second
      const now = Date.now();
      
      // Reset counter every second
      if (now - this.secondStart >= 1000) {
        this.messageCount = 0;
        this.secondStart = now;
      }

      // Check if we can send more messages this second
      if (this.messageCount >= 2) {
        const waitTime = 1000 - (now - this.secondStart);
        if (waitTime > 0) {
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        this.messageCount = 0;
        this.secondStart = Date.now();
        continue;
      }

      // Ensure 500ms delay between messages
      const timeSinceLast = now - this.lastMessageTime;
      if (timeSinceLast < config.messageDelay) {
        await new Promise(resolve => 
          setTimeout(resolve, config.messageDelay - timeSinceLast)
        );
      }

      // Get next message
      const job = this.queue.shift();
      this.stats.queued--;
      
      try {
        const session = sessions.get(job.sessionId);
        if (!session || session.status !== 'CONNECTED') {
          throw new Error(`Session ${job.sessionId} not connected`);
        }

        // Send message
        await session.sock.sendMessage(job.jid, job.content);
        
        // Update stats
        this.messageCount++;
        this.lastMessageTime = Date.now();
        this.stats.sent++;
        session.stats.totalSent++;
        session.lastActive = Date.now();
        
        // Resolve promise
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
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.stores = new Map();
  }

  async create(sessionId, phoneNumber = null) {
    // Check session limit
    if (this.sessions.size >= config.maxSessions) {
      throw new Error(`Maximum ${config.maxSessions} sessions reached`);
    }

    // Clean up existing session
    if (this.sessions.has(sessionId)) {
      await this.logout(sessionId);
    }

    logger.info(`Creating session: ${sessionId}`);

    const authPath = path.join(config.sessionsDir, sessionId);
    await fs.ensureDir(authPath);

    // Load auth state
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    // Create in-memory store
    const store = makeInMemoryStore({ logger: P({ level: 'silent' }) });
    this.stores.set(sessionId, store);

    // Get latest version
    const version = (await fetchLatestWaWebVersion()).version;

    // Create socket
    const sock = makeWASocket({
      version,
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' }))
      },
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: true,
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
      shouldIgnoreJid: (jid) => jid === 'status@broadcast'
    });

    // Bind store
    store.bind(sock.ev);

    // Save credentials on update
    sock.ev.on('creds.update', saveCreds);

    // Connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrBase64 = await qrcode.toDataURL(qr);
        const session = this.sessions.get(sessionId) || {};
        this.sessions.set(sessionId, {
          ...session,
          qr: qrBase64,
          status: 'QR_READY'
        });
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn(`Session ${sessionId} closed: ${statusCode}`);

        if (shouldReconnect) {
          setTimeout(() => this.create(sessionId), config.reconnectBackoff);
        } else {
          await this.cleanup(sessionId);
        }
      }

      if (connection === 'open') {
        const user = sock.user;
        const session = this.sessions.get(sessionId) || {};
        
        this.sessions.set(sessionId, {
          ...session,
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
          stats: session.stats || {
            totalSent: 0,
            received: 0,
            createdAt: Date.now()
          }
        });

        logger.info(`✅ Session ${sessionId} connected as ${user.id}`);
      }
    });

    // Message handler
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;
      
      const msg = m.messages[0];
      if (!msg.key.fromMe) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.stats.received++;
          session.lastActive = Date.now();
        }
      }
    });

    // Store session
    this.sessions.set(sessionId, {
      sock,
      status: 'INITIALIZING',
      qr: null,
      pairingCode: null,
      lastActive: Date.now(),
      stats: {
        totalSent: 0,
        received: 0,
        createdAt: Date.now()
      }
    });

    // Request pairing code if phone number provided
    if (phoneNumber) {
      try {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const code = await sock.requestPairingCode(cleanNumber);
        
        this.sessions.set(sessionId, {
          ...this.sessions.get(sessionId),
          pairingCode: code,
          status: 'PAIRING_READY'
        });
      } catch (error) {
        logger.error(`Pairing failed for ${sessionId}: ${error.message}`);
      }
    }

    return this.sessions.get(sessionId);
  }

  async logout(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session?.sock) {
      try {
        await session.sock.logout();
        session.sock.end();
      } catch (error) {
        logger.error(`Logout error ${sessionId}: ${error.message}`);
      }
    }
    await this.cleanup(sessionId);
  }

  async cleanup(sessionId) {
    this.sessions.delete(sessionId);
    this.stores.delete(sessionId);
    
    // Don't delete auth folder, keep for reconnection
  }

  get(sessionId) {
    return this.sessions.get(sessionId);
  }

  getAll() {
    return Array.from(this.sessions.entries()).map(([id, data]) => ({
      id,
      status: data.status,
      user: data.user,
      stats: data.stats,
      lastActive: data.lastActive,
      hasQR: !!data.qr,
      hasPairingCode: !!data.pairingCode
    }));
  }

  getStats() {
    const connected = Array.from(this.sessions.values()).filter(s => s.status === 'CONNECTED').length;
    const totalSent = Array.from(this.sessions.values()).reduce((acc, s) => acc + (s.stats?.totalSent || 0), 0);
    const totalReceived = Array.from(this.sessions.values()).reduce((acc, s) => acc + (s.stats?.received || 0), 0);

    return {
      total: this.sessions.size,
      connected,
      initializing: this.sessions.size - connected,
      messages: {
        sent: totalSent,
        received: totalReceived
      }
    };
  }
}

// ==================== INITIALIZATION ====================
const app = express();
const messageQueue = new MessageQueue();
const sessionManager = new SessionManager();

// ==================== MIDDLEWARE ====================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({ origin: '*' }));
app.use(compression());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// API Key Authentication
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  
  if (!apiKey || apiKey !== config.apiKey) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or missing API key'
    });
  }
  
  next();
});

// Rate Limiting
const limiter = rateLimit({
  windowMs: config.rateLimitWindow,
  max: config.rateLimitMax,
  message: {
    success: false,
    error: 'Rate limit exceeded. Max 200 requests per minute.'
  }
});
app.use('/api/', limiter);

// Request Logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${Date.now() - start}ms`
    });
  });
  next();
});

// ==================== API ENDPOINTS ====================

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'Blast WhatsApp API',
    version: '15.0.0',
    author: 'Md Dhaka',
    status: 'operational',
    features: {
      unlimitedMessages: true,
      messagesPerSecond: 2,
      messageDelay: '500ms',
      maxSessions: config.maxSessions,
      clusterMode: config.useCluster
    },
    documentation: {
      sessions: '/api/sessions',
      create: 'POST /api/session/create',
      qr: 'GET /api/session/:id/qr',
      send: 'POST /api/send',
      bulk: 'POST /api/send/bulk',
      status: 'GET /api/session/:id/status',
      logout: 'POST /api/session/:id/logout',
      stats: '/api/stats'
    }
  });
});

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    sessions: sessionManager.getStats(),
    queue: messageQueue.getStats(),
    memory: process.memoryUsage().heapUsed / 1024 / 1024 + 'MB'
  });
});

// Get all sessions
app.get('/api/sessions', (req, res) => {
  res.json({
    success: true,
    sessions: sessionManager.getAll()
  });
});

// Get system stats
app.get('/api/stats', (req, res) => {
  res.json({
    success: true,
    sessions: sessionManager.getStats(),
    queue: messageQueue.getStats(),
    system: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: os.loadavg(),
      platform: process.platform
    }
  });
});

// Create new session
app.post('/api/session/create', async (req, res) => {
  try {
    const { sessionId, phone } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'sessionId is required'
      });
    }

    if (sessionId.length < 3 || sessionId.length > 50) {
      return res.status(400).json({
        success: false,
        error: 'sessionId must be 3-50 characters'
      });
    }

    const session = await sessionManager.create(sessionId, phone);

    res.json({
      success: true,
      sessionId,
      status: session.status,
      method: phone ? 'pairing_code' : 'qr',
      message: phone ? 'Use /api/session/:id/qr to get pairing code' : 'Use /api/session/:id/qr to scan QR'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get QR or pairing code
app.get('/api/session/:sessionId/qr', (req, res) => {
  const { sessionId } = req.params;
  const session = sessionManager.get(sessionId);

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
      status: session.status,
      message: 'QR not ready yet'
    });
  }
});

// Get session status
app.get('/api/session/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = sessionManager.get(sessionId);

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

// Logout session
app.post('/api/session/:sessionId/logout', async (req, res) => {
  const { sessionId } = req.params;

  try {
    await sessionManager.logout(sessionId);
    res.json({
      success: true,
      message: 'Session logged out'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Send message
app.post('/api/send', async (req, res) => {
  try {
    const { sessionId, to, message, type = 'text' } = req.body;

    if (!sessionId || !to || !message) {
      return res.status(400).json({
        success: false,
        error: 'sessionId, to, and message are required'
      });
    }

    const session = sessionManager.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({
        success: false,
        error: `Session ${sessionId} is not connected`
      });
    }

    // Format JID
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    // Prepare content
    let content;
    if (type === 'text') {
      content = { text: message };
    } else if (type === 'image') {
      content = { image: { url: message }, caption: req.body.caption };
    } else if (type === 'video') {
      content = { video: { url: message }, caption: req.body.caption };
    } else if (type === 'audio') {
      content = { audio: { url: message } };
    } else if (type === 'document') {
      content = { document: { url: message }, fileName: req.body.filename || 'document' };
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid message type'
      });
    }

    // Queue message
    const result = await messageQueue.add(sessionId, jid, content, type);

    res.json({
      success: true,
      queued: true,
      messageId: result.messageId,
      sessionId,
      to: jid,
      estimatedDelay: `${config.messageDelay}ms`,
      rate: `${config.messagesPerSecond} msg/sec`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Bulk send
app.post('/api/send/bulk', async (req, res) => {
  try {
    const { sessionId, messages } = req.body;

    if (!sessionId || !messages || !messages.length) {
      return res.status(400).json({
        success: false,
        error: 'sessionId and messages array required'
      });
    }

    if (messages.length > 1000) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 1000 messages per bulk request'
      });
    }

    const session = sessionManager.get(sessionId);
    if (!session || session.status !== 'CONNECTED') {
      return res.status(400).json({
        success: false,
        error: `Session ${sessionId} is not connected`
      });
    }

    const results = [];
    const startTime = Date.now();

    for (const msg of messages) {
      try {
        const jid = msg.to.includes('@') ? msg.to : `${msg.to}@s.whatsapp.net`;
        
        const content = msg.type === 'text' 
          ? { text: msg.message }
          : { [msg.type]: { url: msg.message }, caption: msg.caption };

        const result = await messageQueue.add(sessionId, jid, content, msg.type);
        
        results.push({
          to: msg.to,
          success: true,
          messageId: result.messageId
        });
      } catch (error) {
        results.push({
          to: msg.to,
          success: false,
          error: error.message
        });
      }
    }

    const totalTime = Date.now() - startTime;

    res.json({
      success: true,
      total: messages.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
      performance: {
        totalTime: `${totalTime}ms`,
        averagePerMessage: `${(totalTime / messages.length).toFixed(0)}ms`,
        rate: `${config.messagesPerSecond} msg/sec`,
        delay: `${config.messageDelay}ms`
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get queue status
app.get('/api/queue/status', (req, res) => {
  res.json({
    success: true,
    queue: messageQueue.getStats(),
    config: {
      messagesPerSecond: config.messagesPerSecond,
      messageDelay: config.messageDelay,
      unlimited: config.unlimitedMessages
    }
  });
});

// ==================== LOAD SESSIONS ON START ====================
async function loadExistingSessions() {
  try {
    const dirs = await fs.readdir(config.sessionsDir);
    let loaded = 0;

    for (const dir of dirs) {
      const stat = await fs.stat(path.join(config.sessionsDir, dir));
      if (stat.isDirectory() && dir !== 'default') {
        try {
          await sessionManager.create(dir);
          loaded++;
        } catch (error) {
          logger.error(`Failed to load session ${dir}: ${error.message}`);
        }
      }
    }

    logger.info(`✅ Loaded ${loaded} existing sessions`);
  } catch (error) {
    logger.error(`Error loading sessions: ${error.message}`);
  }
}

// ==================== CLUSTER SETUP ====================
if (config.useCluster) {
  const numCPUs = os.cpus().length;
  
  logger.info(`Primary ${process.pid} is running`);
  logger.info(`Starting ${numCPUs} workers...`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    logger.warn(`Worker ${worker.process.pid} died`);
    logger.info('Starting new worker...');
    cluster.fork();
  });
} else {
  // ==================== START SERVER ====================
  server = app.listen(config.port, async () => {
    logger.info('='.repeat(60));
    logger.info('🚀 BLAST WHATSAPP API v15.0.0');
    logger.info('='.repeat(60));
    logger.info(`📱 Server: http://localhost:${config.port}`);
    logger.info(`🔑 API Key: ${config.apiKey.substring(0, 8)}...`);
    logger.info(`📊 Sessions: 0/${config.maxSessions}`);
    logger.info(`⚡ Message Rate: ${config.messagesPerSecond} msg/sec`);
    logger.info(`⏱️  Message Delay: ${config.messageDelay}ms`);
    logger.info(`📦 Unlimited Messages: Yes`);
    logger.info(`🔄 Cluster Mode: ${config.useCluster ? 'Yes' : 'No'}`);
    logger.info('='.repeat(60));

    await loadExistingSessions();
    
    // Show final stats
    setTimeout(() => {
      const stats = sessionManager.getStats();
      logger.info(`✅ Ready: ${stats.connected}/${stats.total} sessions connected`);
    }, 2000);
  });

  // ==================== GRACEFUL SHUTDOWN ====================
  const shutdown = async () => {
    logger.info('Shutting down...');
    
    // Logout all sessions
    const sessions = sessionManager.getAll();
    for (const session of sessions) {
      await sessionManager.logout(session.id).catch(() => {});
    }

    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Force shutdown');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ==================== EXPORTS ====================
module.exports = { app, sessionManager, messageQueue };
