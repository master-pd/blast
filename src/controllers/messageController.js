// src/controllers/messageController.js
const Message = require('../models/Message');
const Account = require('../models/Account');
const User = require('../models/User');
const whatsappService = require('../services/whatsappService');
const { validationResult } = require('express-validator');

const messageController = {
    // Blast messages using rented accounts
    async blastMessages(req, res) {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ 
                    success: false, 
                    errors: errors.array() 
                });
            }

            const { targetNumbers, message } = req.body;
            const adminId = req.user.id;

            // Get admin's rented accounts
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
                error: 'Failed to blast messages' 
            });
        }
    },

    // Get message status
    async getMessageStatus(req, res) {
        try {
            const { messageId } = req.params;
            
            const message = await Message.getById(messageId);
            if (!message) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Message not found' 
                });
            }

            // Check permission
            if (message.adminId !== req.user.id && req.user.role !== 'admin') {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Access denied' 
                });
            }

            res.json({
                success: true,
                message: {
                    id: message.id,
                    status: message.status,
                    stats: message.stats,
                    results: message.results.slice(0, 100), // Last 100 results
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

    // Get message history
    async getHistory(req, res) {
        try {
            const { limit = 50 } = req.query;
            
            const messages = await Message.getByAdmin(req.user.id, parseInt(limit));
            
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

    // Send single message (admin only)
    async sendSingle(req, res) {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ 
                    success: false, 
                    errors: errors.array() 
                });
            }

            const { accountId, targetNumber, message } = req.body;
            const adminId = req.user.id;

            // Check if account is rented by admin
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
    }
};

module.exports = messageController;
