// src/app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

console.log('🚀 Initializing Express app...');

const app = express();

// Security Middleware
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { 
        success: false, 
        error: 'Too many requests, please try again later.' 
    }
});
app.use('/api/', limiter);

// Body Parser
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request Logger
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} | ${req.method} ${req.path} | IP: ${req.ip}`);
    next();
});

// রুট রাউট
app.get('/', (req, res) => {
    console.log('🏠 Home route hit');
    res.json({
        success: true,
        message: 'Blaster API is running',
        version: '1.0.0',
        endpoints: {
            auth: '/api/auth',
            accounts: '/api/accounts',
            messages: '/api/messages',
            health: '/health',
            docs: '/api'
        }
    });
});

// হেলথ চেক
app.get('/health', (req, res) => {
    console.log('❤️ Health check hit');
    res.json({ 
        success: true, 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// API Routes
console.log('📦 Loading routes...');

try {
    const authRoutes = require('./routes/authRoutes');
    const accountRoutes = require('./routes/accountRoutes');
    const messageRoutes = require('./routes/messageRoutes');

    console.log('✅ Routes loaded successfully');

    app.use('/api/auth', authRoutes);
    console.log('✅ /api/auth route mounted');

    app.use('/api/accounts', accountRoutes);
    console.log('✅ /api/accounts route mounted');

    app.use('/api/messages', messageRoutes);
    console.log('✅ /api/messages route mounted');

} catch (error) {
    console.error('❌ Error loading routes:', error);
}

// API Documentation
app.get('/api', (req, res) => {
    console.log('📚 API docs hit');
    res.json({
        success: true,
        name: 'Blaster API',
        version: '1.0.0',
        description: 'WhatsApp Account Rental & Blasting System (Public API)',
        endpoints: {
            auth: {
                register: 'POST /api/auth/register',
                login: 'POST /api/auth/login',
                profile: 'GET /api/auth/profile/:userId',
                users: 'GET /api/auth/users',
                test: 'GET /api/auth/test'
            },
            accounts: {
                add: 'POST /api/accounts/add',
                myAccounts: 'GET /api/accounts/my/:userId',
                getQR: 'GET /api/accounts/qr/:accountId',
                offerForRent: 'POST /api/accounts/offer/:accountId',
                remove: 'DELETE /api/accounts/:accountId'
            },
            messages: {
                blast: 'POST /api/messages/blast',
                send: 'POST /api/messages/send',
                history: 'GET /api/messages/history/:adminId',
                status: 'GET /api/messages/status/:messageId'
            }
        }
    });
});

// 404 Handler
app.use('*', (req, res) => {
    console.log('❓ 404 for:', req.originalUrl);
    res.status(404).json({
        success: false,
        error: 'API endpoint not found',
        path: req.originalUrl
    });
});

// Error Handler
app.use((err, req, res, next) => {
    console.error('💥 Server Error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

console.log('✅ Express app configured');
module.exports = app;
