// src/routes/accountRoutes.js - পাবলিক API (কোনো auth নেই)
const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const accountController = require('../controllers/accountController');

// ⚠️ কোন auth middleware ব্যবহার করা হয়নি - সবাই ব্যবহার করতে পারবে

// পাবলিক অ্যাকাউন্ট রাউটস
router.post('/add', [
    body('phoneNumber').matches(/^\+?[1-9]\d{1,14}$/).withMessage('Valid phone number required'),
    body('name').optional().trim(),
    body('userId').notEmpty().withMessage('User ID is required') // ইউজার আইডি এখন body থেকে নিব
], accountController.addAccount);

router.get('/my/:userId', accountController.getMyAccounts); // ইউজার আইডি প্যারামিটার হিসেবে
router.get('/qr/:accountId', accountController.getQRCode);
router.post('/offer/:accountId', accountController.offerForRent);
router.delete('/:accountId', accountController.removeAccount);

// এডমিন রাউটস (শুধু সিম্পল API key চেক)
router.get('/pending', accountController.getPendingRentals);
router.get('/available', accountController.getAvailableAccounts);
router.get('/rented/:adminId', accountController.getRentedAccounts); // এডমিন আইডি প্যারামিটার হিসেবে
router.post('/approve/:accountId', accountController.approveForRent);
router.post('/rent/:accountId', accountController.rentAccount);
router.post('/return/:accountId', accountController.returnAccount);

module.exports = router;
