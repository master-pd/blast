const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
require('express-async-errors');

const authRoutes = require('./routes/authRoutes');
const { errorHandler, notFound } = require('./middleware/errorMiddleware');
const logger = require('./utils/logger');
const { RATE_LIMIT } = require('./utils/constants');

const app = express();

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Compression
app.use(compression());

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || RATE_LIMIT.WINDOW_MS,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || RATE_LIMIT.MAX,
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later'
  },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    uptime: process.uptime()
  });
});

// API Routes
app.use('/api/auth', authRoutes);

// Welcome route
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    name: 'Firebase Auth API',
    version: '1.0.0',
    environment: process.env.NODE_ENV,
    endpoints: {
      sendOTP: 'POST /api/auth/send-otp',
      verifyOTP: 'POST /api/auth/verify-otp',
      getUser: 'GET /api/auth/user/:uid',
      updateProfile: 'PUT /api/auth/update-profile',
      deleteUser: 'DELETE /api/auth/user/:uid'
    },
    documentation: 'https://github.com/yourusername/firebase-auth-system'
  });
});

// 404 handler
app.use(notFound);

// Error handler
app.use(errorHandler);

module.exports = app;
