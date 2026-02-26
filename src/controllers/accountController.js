// src/controllers/accountController.js - আপডেটেড (userId body থেকে নিবে)

// Add new account (পাবলিক)
async addAccount(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ 
                success: false, 
                errors: errors.array() 
            });
        }

        const { phoneNumber, name, userId } = req.body; // userId এখন body থেকে

        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }

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
        const User = require('../models/User');
        const user = await User.getById(userId);
        if (user) {
            user.myAccounts.push(account.id);
            await user.update({ myAccounts: user.myAccounts });
        }

        // Initialize WhatsApp client
        const whatsappService = require('../services/whatsappService');
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
            error: 'Failed to add account: ' + error.message 
        });
    }
},

// Get my accounts (পাবলিক - userId প্যারামিটার থেকে)
async getMyAccounts(req, res) {
    try {
        const { userId } = req.params;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }

        const accounts = await Account.getByOwner(userId);
        
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

// Get QR code (পাবলিক)
async getQRCode(req, res) {
    try {
        const { accountId } = req.params;

        const account = await Account.getById(accountId);
        if (!account) {
            return res.status(404).json({ 
                success: false, 
                error: 'Account not found' 
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
            const whatsappService = require('../services/whatsappService');
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
            const whatsappService = require('../services/whatsappService');
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

// Offer account for rent (পাবলিক)
async offerForRent(req, res) {
    try {
        const { accountId } = req.params;
        const { userId } = req.body; // userId body থেকে

        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }

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
                error: 'Access denied - you are not the owner' 
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

// Remove account (পাবলিক)
async removeAccount(req, res) {
    try {
        const { accountId } = req.params;
        const { userId } = req.body; // userId body থেকে

        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }

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
                error: 'Access denied - you are not the owner' 
            });
        }

        // Disconnect WhatsApp
        const whatsappService = require('../services/whatsappService');
        await whatsappService.disconnectClient(accountId);

        // Remove from user's list
        const User = require('../models/User');
        const user = await User.getById(account.ownerId);
        if (user) {
            user.myAccounts = user.myAccounts.filter(id => id !== accountId);
            await user.update({ myAccounts: user.myAccounts });
        }

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
}
