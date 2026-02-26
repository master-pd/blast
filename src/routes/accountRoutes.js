// src/routes/accountRoutes.js
const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const accountController = require('../controllers/accountController');
const { auth, adminOnly } = require('../middleware/auth');

// All routes require authentication
router.use(auth);

// User routes
router.post('/add', [
    body('phoneNumber').matches(/^\+?[1-9]\d{1,14}$/).withMessage('Valid phone number required'),
    body('name').optional().trim()
], accountController.addAccount);

router.get('/my', accountController.getMyAccounts);
router.get('/qr/:accountId', accountController.getQRCode);
router.post('/offer/:accountId', accountController.offerForRent);
router.delete('/:accountId', accountController.removeAccount);

// Admin routes
router.get('/pending', adminOnly, accountController.getPendingRentals);
router.get('/available', adminOnly, accountController.getAvailableAccounts);
router.get('/rented', adminOnly, accountController.getRentedAccounts);
router.post('/approve/:accountId', adminOnly, accountController.approveForRent);
router.post('/rent/:accountId', adminOnly, accountController.rentAccount);
router.post('/return/:accountId', adminOnly, accountController.returnAccount);

module.exports = router;
