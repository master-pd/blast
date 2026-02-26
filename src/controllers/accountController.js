// src/controllers/accountController.js
const Account = require('../models/Account');
const User = require('../models/User');
const whatsappService = require('../services/whatsappService');
const { validationResult } = require('express-validator');
const { db, collections } = require('../config/firebase');

const accountController = {
    // Add new account
    async addAccount(req, res) {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ 
                    success: false, 
                    errors: errors.array() 
                });
            }

            const { phoneNumber, name } = req.body;
            const userId = req.user.id;

            // Check account limit
            const userAccounts = await Account.getByOwner(userId);
            if (userAccounts.length >= parseInt(process.env.MAX_ACCOUNTS_PER_USER)) {
                return res.status(400).json({ 
                    success: false, 
                    error: `Maximum ${process.env.MAX_ACCOUNTS_PER_USER} accounts allowed` 
                });
            }

            // Create account
            const account = new Account({
                ownerId: userId,
                phoneNumber,
                name: name || `WhatsApp ${phoneNumber}`
            });

            await account.save();

            // Update user's account list
            const user = await User.getById(userId);
            user.myAccounts.push(account.id);
            await user.update({ myAccounts: user.myAccounts });

            // Initialize WhatsApp client
            await whatsappService.initClient(account.id, userId, phoneNumber);

            res.status(201).json({
                success: true,
                message: 'Account added successfully',
                account: {
                    id: account.id,
                    phoneNumber: account.phoneNumber,
                    name: account.name,
                    status: account.status,
                    rentStatus: account.rentStatus
                }
            });
        } catch (error) {
            console.error('Add account error:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to add account' 
            });
        }
    },

    // Get QR code
    async getQRCode(req, res) {
        try {
            const { accountId } = req.params;
            const userId = req.user.id;

            const account = await Account.getById(accountId);
            if (!account) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Account not found' 
                });
            }

            // Check ownership
            if (account.ownerId !== userId && req.user.role !== 'admin') {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Access denied' 
                });
            }

            if (account.status === 'connected') {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Account already connected' 
                });
            }

            // Get QR code
            try {
                const qrCode = await whatsappService.getQRCode(accountId);
                
                await account.update({ 
                    qrCode, 
                    status: 'qr_ready',
                    lastQrGenerated: new Date().toISOString()
                });

                res.json({
                    success: true,
                    qrCode,
                    expiresIn: 60
                });
            } catch (qrError) {
                await whatsappService.reconnectClient(accountId);
                res.status(408).json({
                    success: false,
                    error: 'QR code generation timeout. Please try again.'
                });
            }
        } catch (error) {
            console.error('Get QR error:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to get QR code' 
            });
        }
    },

    // Get my accounts
    async getMyAccounts(req, res) {
        try {
            const accounts = await Account.getByOwner(req.user.id);
            
            res.json({
                success: true,
                count: accounts.length,
                accounts: accounts.map(a => ({
                    id: a.id,
                    phoneNumber: a.phoneNumber,
                    name: a.name,
                    status: a.status,
                    rentStatus: a.rentStatus,
                    stats: a.stats,
                    createdAt: a.createdAt
                }))
            });
        } catch (error) {
            res.status(500).json({ 
                success: false, 
                error: 'Failed to get accounts' 
            });
        }
    },

    // Offer account for rent
    async offerForRent(req, res) {
        try {
            const { accountId } = req.params;
            const userId = req.user.id;

            const account = await Account.getById(accountId);
            if (!account) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Account not found' 
                });
            }

            // Check ownership
            if (account.ownerId !== userId) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Access denied' 
                });
            }

            if (account.status !== 'connected') {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Account must be connected first' 
                });
            }

            if (account.rentStatus !== 'personal') {
                return res.status(400).json({ 
                    success: false, 
                    error: `Account is already ${account.rentStatus}` 
                });
            }

            await account.update({ rentStatus: 'pending' });

            res.json({
                success: true,
                message: 'Rent request sent to admin'
            });
        } catch (error) {
            console.error('Offer for rent error:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to offer for rent' 
            });
        }
    },

    // Remove account
    async removeAccount(req, res) {
        try {
            const { accountId } = req.params;
            const userId = req.user.id;

            const account = await Account.getById(accountId);
            if (!account) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Account not found' 
                });
            }

            // Check ownership
            if (account.ownerId !== userId && req.user.role !== 'admin') {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Access denied' 
                });
            }

            // Disconnect WhatsApp
            await whatsappService.disconnectClient(accountId);

            // Remove from user's list
            const user = await User.getById(account.ownerId);
            user.myAccounts = user.myAccounts.filter(id => id !== accountId);
            await user.update({ myAccounts: user.myAccounts });

            // Delete account
            await account.delete();

            res.json({
                success: true,
                message: 'Account removed successfully'
            });
        } catch (error) {
            console.error('Remove account error:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to remove account' 
            });
        }
    },

    // Admin: Get pending rentals
    async getPendingRentals(req, res) {
        try {
            const accounts = await Account.getPendingRentals();
            
            res.json({
                success: true,
                count: accounts.length,
                accounts: accounts.map(a => ({
                    id: a.id,
                    phoneNumber: a.phoneNumber,
                    name: a.name,
                    ownerId: a.ownerId,
                    status: a.status,
                    createdAt: a.createdAt
                }))
            });
        } catch (error) {
            res.status(500).json({ 
                success: false, 
                error: 'Failed to get pending rentals' 
            });
        }
    },

    // Admin: Get available accounts
    async getAvailableAccounts(req, res) {
        try {
            const accounts = await Account.getAvailableAccounts();
            
            res.json({
                success: true,
                count: accounts.length,
                accounts: accounts.map(a => ({
                    id: a.id,
                    phoneNumber: a.phoneNumber,
                    name: a.name,
                    ownerId: a.ownerId,
                    stats: a.stats
                }))
            });
        } catch (error) {
            res.status(500).json({ 
                success: false, 
                error: 'Failed to get available accounts' 
            });
        }
    },

    // Admin: Get rented accounts
    async getRentedAccounts(req, res) {
        try {
            const accounts = await Account.getRentedAccounts(req.user.id);
            
            res.json({
                success: true,
                count: accounts.length,
                accounts: accounts.map(a => ({
                    id: a.id,
                    phoneNumber: a.phoneNumber,
                    name: a.name,
                    ownerId: a.ownerId,
                    rentStart: a.rentStart,
                    stats: a.stats
                }))
            });
        } catch (error) {
            res.status(500).json({ 
                success: false, 
                error: 'Failed to get rented accounts' 
            });
        }
    },

    // Admin: Approve account for rent
    async approveForRent(req, res) {
        try {
            const { accountId } = req.params;

            const account = await Account.getById(accountId);
            if (!account) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Account not found' 
                });
            }

            if (account.rentStatus !== 'pending') {
                return res.status(400).json({ 
                    success: false, 
                    error: `Account is ${account.rentStatus}, not pending` 
                });
            }

            await account.update({ rentStatus: 'available' });

            res.json({
                success: true,
                message: 'Account approved for rent'
            });
        } catch (error) {
            console.error('Approve rent error:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to approve account' 
            });
        }
    },

    // Admin: Rent account
    async rentAccount(req, res) {
        try {
            const { accountId } = req.params;
            const adminId = req.user.id;

            const account = await Account.getById(accountId);
            if (!account) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Account not found' 
                });
            }

            if (account.rentStatus !== 'available') {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Account is not available for rent' 
                });
            }

            // Rent the account
            await account.update({
                rentStatus: 'rented',
                rentedTo: adminId,
                rentStart: new Date().toISOString()
            });

            // Update owner's rented accounts list
            const owner = await User.getById(account.ownerId);
            owner.rentedAccounts.push(account.id);
            await owner.update({ rentedAccounts: owner.rentedAccounts });

            res.json({
                success: true,
                message: 'Account rented successfully'
            });
        } catch (error) {
            console.error('Rent account error:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to rent account' 
            });
        }
    },

    // Admin: Return account
    async returnAccount(req, res) {
        try {
            const { accountId } = req.params;

            const account = await Account.getById(accountId);
            if (!account) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Account not found' 
                });
            }

            if (account.rentStatus !== 'rented') {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Account is not rented' 
                });
            }

            // Return the account
            await account.update({
                rentStatus: 'available',
                rentedTo: null,
                rentStart: null
            });

            res.json({
                success: true,
                message: 'Account returned successfully'
            });
        } catch (error) {
            console.error('Return account error:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to return account' 
            });
        }
    }
};

module.exports = accountController;
