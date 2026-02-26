// src/controllers/messageController.js - পাবলিক ভার্সন

// Blast messages (পাবলিক)
async blastMessages(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ 
                success: false, 
                errors: errors.array() 
            });
        }

        const { adminId, targetNumbers, message } = req.body; // adminId body থেকে

        if (!adminId) {
            return res.status(400).json({
                success: false,
                error: 'Admin ID is required'
            });
        }

        // Get admin's rented accounts
        const Account = require('../models/Account');
        const rentedAccounts = await Account.getRentedAccounts(adminId);
        
        if (rentedAccounts.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'No rented accounts available. Please rent accounts first.' 
            });
        }

        // Filter connected accounts only
        const connectedAccounts = rentedAccounts.filter(a => a.status === 'connected');
        
        if (connectedAccounts.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'No connected accounts available' 
            });
        }

        // Create message record
        const Message = require('../models/Message');
        const messageDoc = new Message({
            adminId,
            accountIds: connectedAccounts.map(a => a.id),
            targetNumbers,
            message,
            type: 'blast'
        });
        await messageDoc.save();

        // Calculate total messages
        const totalMessages = connectedAccounts.length * targetNumbers.length;
        
        // Start processing
        await messageDoc.start();

        // Send response immediately
        res.json({
            success: true,
            message: 'Blast started successfully',
            messageId: messageDoc.id,
            stats: {
                accounts: connectedAccounts.length,
                targets: targetNumbers.length,
                total: totalMessages
            }
        });

        // Process messages in background
        (async () => {
            const whatsappService = require('../services/whatsappService');
            for (const account of connectedAccounts) {
                for (const target of targetNumbers) {
                    try {
                        await whatsappService.sendMessage(
                            account.id,
                            target,
                            message,
                            messageDoc.id
                        );
                        
                        // Delay to avoid ban
                        await new Promise(resolve => 
                            setTimeout(resolve, parseInt(process.env.MESSAGE_DELAY) || 2000)
                        );
                    } catch (error) {
                        console.error(`Failed to send from ${account.phoneNumber}:`, error.message);
                    }
                }
            }
        })();

    } catch (error) {
        console.error('Blast error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to blast messages: ' + error.message 
        });
    }
},

// Get message status (পাবলিক)
async getMessageStatus(req, res) {
    try {
        const { messageId } = req.params;
        
        const Message = require('../models/Message');
        const message = await Message.getById(messageId);
        if (!message) {
            return res.status(404).json({ 
                success: false, 
                error: 'Message not found' 
            });
        }

        res.json({
            success: true,
            message: {
                id: message.id,
                status: message.status,
                stats: message.stats,
                results: message.results.slice(0, 100),
                startedAt: message.startedAt,
                completedAt: message.completedAt,
                createdAt: message.createdAt
            }
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to get message status' 
        });
    }
},

// Get history (পাবলিক)
async getHistory(req, res) {
    try {
        const { adminId } = req.params;
        const { limit = 50 } = req.query;
        
        if (!adminId) {
            return res.status(400).json({
                success: false,
                error: 'Admin ID is required'
            });
        }

        const Message = require('../models/Message');
        const messages = await Message.getByAdmin(adminId, parseInt(limit));
        
        res.json({
            success: true,
            count: messages.length,
            messages: messages.map(m => ({
                id: m.id,
                type: m.type,
                status: m.status,
                stats: m.stats,
                targetCount: m.targetNumbers.length,
                accountCount: m.accountIds.length,
                createdAt: m.createdAt,
                completedAt: m.completedAt
            }))
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to get history' 
        });
    }
},

// Send single message (পাবলিক)
async sendSingle(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ 
                success: false, 
                errors: errors.array() 
            });
        }

        const { adminId, accountId, targetNumber, message } = req.body;

        if (!adminId) {
            return res.status(400).json({
                success: false,
                error: 'Admin ID is required'
            });
        }

        // Check if account is rented by admin
        const Account = require('../models/Account');
        const account = await Account.getById(accountId);
        if (!account || account.rentedTo !== adminId) {
            return res.status(403).json({ 
                success: false, 
                error: 'Account not rented by you' 
            });
        }

        if (account.status !== 'connected') {
            return res.status(400).json({ 
                success: false, 
                error: 'Account is not connected' 
            });
        }

        // Create message record
        const Message = require('../models/Message');
        const messageDoc = new Message({
            adminId,
            accountIds: [accountId],
            targetNumbers: [targetNumber],
            message,
            type: 'single'
        });
        await messageDoc.save();
        await messageDoc.start();

        // Send message
        try {
            const whatsappService = require('../services/whatsappService');
            const result = await whatsappService.sendMessage(
                accountId,
                targetNumber,
                message,
                messageDoc.id
            );

            res.json({
                success: true,
                message: 'Message sent successfully',
                messageId: messageDoc.id,
                result
            });
        } catch (sendError) {
            await messageDoc.addResult({
                accountId,
                phoneNumber: targetNumber,
                status: 'failed',
                error: sendError.message
            });

            res.status(500).json({
                success: false,
                error: 'Failed to send message',
                details: sendError.message
            });
        }
    } catch (error) {
        console.error('Send single error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to send message' 
        });
    }
};
