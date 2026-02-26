// src/app.js - auth middleware সরিয়ে ফেলুন
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/authRoutes');
const accountRoutes = require('./routes/accountRoutes');
const messageRoutes = require('./routes/messageRoutes');

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

// API Routes - কোন auth middleware নেই
app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/messages', messageRoutes);

// API Documentation
app.get('/api', (req, res) => {
    res.json({
        success: true,
        name: 'Blaster API',
        version: '1.0.0',
        description: 'WhatsApp Account Rental & Blasting System (Public API)',
        authentication: 'No token required - Public API',
        endpoints: {
            auth: {
                register: 'POST /api/auth/register',
                login: 'POST /api/auth/login',
                profile: 'GET /api/auth/profile/:userId'
            },
            accounts: {
                add: 'POST /api/accounts/add (send userId in body)',
                myAccounts: 'GET /api/accounts/my/:userId',
                getQR: 'GET /api/accounts/qr/:accountId',
                offerForRent: 'POST /api/accounts/offer/:accountId (send userId in body)',
                remove: 'DELETE /api/accounts/:accountId (send userId in body)'
            },
            admin: {
                pendingRentals: 'GET /api/accounts/pending',
                availableAccounts: 'GET /api/accounts/available',
                rentedAccounts: 'GET /api/accounts/rented/:adminId',
                approveAccount: 'POST /api/accounts/approve/:accountId',
                rentAccount: 'POST /api/accounts/rent/:accountId',
                returnAccount: 'POST /api/accounts/return/:accountId'
            },
            messages: {
                blast: 'POST /api/messages/blast (send adminId in body)',
                send: 'POST /api/messages/send (send adminId in body)',
                history: 'GET /api/messages/history/:adminId',
                status: 'GET /api/messages/status/:messageId'
            }
        }
    });
});

// Health Check
app.get('/health', (req, res) => {
    res.json({ 
        success: true, 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// 404 Handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'API endpoint not found'
    });
});

// Error Handler
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

module.exports = app;
