const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifyToken } = require('../middleware/authMiddleware');

// পাবলিক রুটস (কোনো টোকেনের প্রয়োজন নেই)
router.post('/send-otp', authController.sendOTP);
router.post('/verify-otp', authController.verifyOTP);

// প্রোটেক্টেড রুটস (টোকেন প্রয়োজন)
router.get('/user/:uid', verifyToken, authController.getUserData);
router.put('/update-profile', verifyToken, authController.updateUserProfile);
router.delete('/user/:uid', verifyToken, authController.deleteUser);

module.exports = router;
