// src/routes/messageRoutes.js - পাবলিক API
const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const messageController = require('../controllers/messageController');

// ⚠️ কোন auth middleware নেই

router.post('/blast', [
    body('adminId').notEmpty().withMessage('Admin ID required'),
    body('targetNumbers').isArray().withMessage('Target numbers must be an array'),
    body('targetNumbers.*').matches(/^\+?[1-9]\d{1,14}$/).withMessage('Valid phone numbers required'),
    body('message').notEmpty().withMessage('Message is required')
], messageController.blastMessages);

router.post('/send', [
    body('adminId').notEmpty().withMessage('Admin ID required'),
    body('accountId').notEmpty().withMessage('Account ID required'),
    body('targetNumber').matches(/^\+?[1-9]\d{1,14}$/).withMessage('Valid target number required'),
    body('message').notEmpty().withMessage('Message is required')
], messageController.sendSingle);

router.get('/history/:adminId', messageController.getHistory);
router.get('/status/:messageId', messageController.getMessageStatus);

module.exports = router;
