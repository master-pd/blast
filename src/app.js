// src/app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

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
    allowedHeaders: ['Content-Type', 'Authorization']
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

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/messages', messageRoutes);

// API Documentation
app.get('/api', (req, res) => {
    res.json({
        success: true,
        name: 'Blaster API',
        version: '1.0.0',
        description: 'WhatsApp Account Rental & Blasting System',
        authentication: 'Bearer Token required',
        endpoints: {
            auth: {
                register: 'POST /api/auth/register',
                login: 'POST /api/auth/login',
                profile: 'GET /api/auth/profile'
            },
            accounts: {
                add: 'POST /api/accounts/add',
                myAccounts: 'GET /api/accounts/my',
                getQR: 'GET /api/accounts/qr/:accountId',
                offerForRent: 'POST /api/accounts/offer/:accountId',
                remove: 'DELETE /api/accounts/:accountId'
            },
            admin: {
                pendingRentals: 'GET /api/accounts/pending',
                availableAccounts: 'GET /api/accounts/available',
                rentedAccounts: 'GET /api/accounts/rented',
                approveAccount: 'POST /api/accounts/approve/:accountId',
                rentAccount: 'POST /api/accounts/rent/:accountId',
                returnAccount: 'POST /api/accounts/return/:accountId'
            },
            messages: {
                blast: 'POST /api/messages/blast',
                history: 'GET /api/messages/history',
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
