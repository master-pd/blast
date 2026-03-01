const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const morgan = require('morgan');
require('dotenv').config();

const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Logging middleware
app.use(morgan('combined'));

// Rate limiting - 100 requests per 15 minutes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again after 15 minutes'
  }
});
app.use('/api/', limiter);

// Body parser middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/api/auth', authRoutes);

// Health check endpoint (Render এর জন্য গুরুত্বপূর্ণ)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    success: true,
    status: 'OK', 
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    name: 'Firebase Authentication API',
    version: '1.0.0',
    description: 'Phone Number OTP Authentication System',
    environment: process.env.NODE_ENV || 'development',
    endpoints: {
      sendOTP: {
        method: 'POST',
        url: '/api/auth/send-otp',
        body: { phoneNumber: 'string' }
      },
      verifyOTP: {
        method: 'POST',
        url: '/api/auth/verify-otp',
        body: { idToken: 'string', phoneNumber: 'string' }
      },
      getUserData: {
        method: 'GET',
        url: '/api/auth/user/:uid',
        headers: { Authorization: 'Bearer <token>' }
      },
      updateProfile: {
        method: 'PUT',
        url: '/api/auth/update-profile',
        headers: { Authorization: 'Bearer <token>' },
        body: { uid: 'string', displayName: 'string', email: 'string', photoURL: 'string' }
      },
      deleteUser: {
        method: 'DELETE',
        url: '/api/auth/user/:uid',
        headers: { Authorization: 'Bearer <token>' }
      }
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error:', err.stack);
  
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Server start
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
