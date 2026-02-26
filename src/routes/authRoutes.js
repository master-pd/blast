// src/routes/authRoutes.js
const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const authController = require('../controllers/authController');

console.log('✅ authRoutes loaded');

// পাবলিক রাউটস - কোন auth লাগবে না

// রেজিস্ট্রেশন রাউট
router.post('/register', 
    [
        body('name').notEmpty().withMessage('Name is required'),
        body('email').isEmail().withMessage('Valid email is required'),
        body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
    ],
    (req, res, next) => {
        console.log('📝 Register route hit');
        next();
    },
    authController.register
);

// লগইন রাউট
router.post('/login',
    [
        body('email').isEmail().withMessage('Valid email is required'),
        body('password').notEmpty().withMessage('Password is required')
    ],
    (req, res, next) => {
        console.log('🔑 Login route hit');
        next();
    },
    authController.login
);

// প্রোফাইল রাউট (পাবলিক - ইউজার আইডি প্যারামিটার হিসেবে)
router.get('/profile/:userId',
    (req, res, next) => {
        console.log('👤 Profile route hit for user:', req.params.userId);
        next();
    },
    authController.getProfile
);

// সব ইউজার লিস্ট (পাবলিক - এডমিনের জন্য)
router.get('/users',
    (req, res, next) => {
        console.log('📋 Users list route hit');
        next();
    },
    authController.getAllUsers
);

// টেস্ট রাউট
router.get('/test', (req, res) => {
    console.log('🧪 Test route hit');
    res.json({ 
        success: true, 
        message: 'Auth routes working!',
        timestamp: new Date().toISOString()
    });
});

console.log('✅ authRoutes configured with routes:', 
    router.stack.map(r => ({
        path: r.route?.path,
        method: Object.keys(r.route?.methods || {})[0]
    }))
);

module.exports = router;
