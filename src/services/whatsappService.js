// src/services/whatsappService.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const Account = require('../models/Account');
const Message = require('../models/Message');
const fs = require('fs');
const path = require('path');

class WhatsAppService {
    constructor() {
        this.clients = new Map();
        this.qrResolvers = new Map();
        this.initializing = new Set();
    }

    // Ensure session directory exists
    ensureSessionDir(userId) {
        const sessionDir = path.join(__dirname, '../../sessions', userId);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        return sessionDir;
    }

    // Initialize WhatsApp client
    async initClient(accountId, userId, phoneNumber) {
        try {
            // Prevent multiple initializations
            if (this.initializing.has(accountId)) {
                console.log(`Already initializing ${accountId}`);
                return;
            }

            this.initializing.add(accountId);

            // Ensure session directory
            this.ensureSessionDir(userId);

            const client = new Client({
                authStrategy: new LocalAuth({ 
                    clientId: accountId,
                    dataPath: path.join(__dirname, '../../sessions', userId)
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu'
                    ]
                }
            });

            // Store client
            this.clients.set(accountId, {
                client,
                status: 'initializing',
                accountId,
                userId
            });

            // QR Code event
            client.on('qr', async (qr) => {
                console.log(`📱 QR generated for account: ${accountId}`);
                
                try {
                    const qrImage = await qrcode.toDataURL(qr);
                    
                    const account = await Account.getById(accountId);
                    if (account) {
                        await account.update({ 
                            qrCode: qrImage,
                            status: 'qr_ready',
                            lastQrGenerated: new Date().toISOString()
                        });
                    }

                    // Resolve any pending QR promise
                    if (this.qrResolvers.has(accountId)) {
                        this.qrResolvers.get(accountId).resolve(qrImage);
                        this.qrResolvers.delete(accountId);
                    }
                } catch (error) {
                    console.error('QR processing error:', error);
                }
            });

            // Ready event
            client.on('ready', async () => {
                console.log(`✅ Account ${accountId} connected`);
                
                try {
                    const account = await Account.getById(accountId);
                    if (account) {
                        await account.update({ 
                            status: 'connected',
                            qrCode: null,
                            platform: client.info?.platform || 'unknown'
                        });
                    }

                    const clientData = this.clients.get(accountId);
                    if (clientData) {
                        clientData.status = 'connected';
                        clientData.info = client.info;
                    }

                    this.initializing.delete(accountId);
                } catch (error) {
                    console.error('Ready handler error:', error);
                }
            });

            // Disconnected event
            client.on('disconnected', async (reason) => {
                console.log(`⚠️ Account ${accountId} disconnected:`, reason);
                
                try {
                    const account = await Account.getById(accountId);
                    if (account) {
                        await account.update({ 
                            status: 'disconnected',
                            qrCode: null
                        });
                    }

                    const clientData = this.clients.get(accountId);
                    if (clientData) {
                        clientData.status = 'disconnected';
                    }

                    this.initializing.delete(accountId);

                    // Auto reconnect if personal or rented
                    if (account) {
                        const shouldReconnect = account.rentStatus === 'personal' || 
                                              account.rentStatus === 'rented';
                        
                        if (shouldReconnect && account.settings?.autoReconnect !== false) {
                            setTimeout(() => {
                                this.reconnectClient(accountId);
                            }, 5000);
                        }
                    }
                } catch (error) {
                    console.error('Disconnect handler error:', error);
                }
            });

            // Auth failure event
            client.on('auth_failure', async (msg) => {
                console.error(`❌ Auth failure for ${accountId}:`, msg);
                
                try {
                    const account = await Account.getById(accountId);
                    if (account) {
                        await account.update({ 
                            status: 'banned',
                            qrCode: null
                        });
                    }

                    this.initializing.delete(accountId);
                } catch (error) {
                    console.error('Auth failure handler error:', error);
                }
            });

            // Initialize
            await client.initialize();
            
            return client;
        } catch (error) {
            console.error(`❌ Init error for ${accountId}:`, error);
            this.initializing.delete(accountId);
            throw error;
        }
    }

    // Reconnect client
    async reconnectClient(accountId) {
        try {
            const clientData = this.clients.get(accountId);
            if (clientData) {
                try {
                    await clientData.client.destroy();
                } catch (e) {
                    // Ignore destroy errors
                }
                this.clients.delete(accountId);
            }

            const account = await Account.getById(accountId);
            if (account) {
                await this.initClient(accountId, account.ownerId, account.phoneNumber);
            }
        } catch (error) {
            console.error(`Reconnect error for ${accountId}:`, error);
        }
    }

    // Get QR code with promise
    async getQRCode(accountId) {
        return new Promise(async (resolve, reject) => {
            const clientData = this.clients.get(accountId);
            
            if (!clientData) {
                return reject(new Error('Client not found'));
            }

            // Check if already connected
            if (clientData.status === 'connected') {
                return reject(new Error('Already connected'));
            }

            // Set timeout
            const timeout = setTimeout(() => {
                if (this.qrResolvers.has(accountId)) {
                    this.qrResolvers.delete(accountId);
                    reject(new Error('QR code timeout'));
                }
            }, 60000);

            // Store resolver
            this.qrResolvers.set(accountId, { resolve, reject, timeout });

            // Check if QR already exists
            const account = await Account.getById(accountId);
            if (account && account.qrCode) {
                clearTimeout(timeout);
                this.qrResolvers.delete(accountId);
                resolve(account.qrCode);
            }
        });
    }

    // Send message
    async sendMessage(accountId, targetNumber, message, messageId = null) {
        const clientData = this.clients.get(accountId);
        
        if (!clientData || clientData.status !== 'connected') {
            throw new Error('WhatsApp client not connected');
        }

        try {
            // Format phone number
            const formattedNumber = `${targetNumber.replace(/\D/g, '')}@c.us`;
            
            // Send message
            const response = await clientData.client.sendMessage(formattedNumber, message);
            
            // Update account stats
            const account = await Account.getById(accountId);
            if (account) {
                account.stats.messagesSent++;
                account.stats.lastUsed = new Date().toISOString();
                await account.update({ stats: account.stats });
            }

            // Update message result
            if (messageId) {
                const messageDoc = await Message.getById(messageId);
                if (messageDoc) {
                    await messageDoc.addResult({
                        accountId,
                        phoneNumber: targetNumber,
                        status: 'success',
                        messageId: response.id?.id
                    });
                }
            }

            return {
                success: true,
                messageId: response.id?.id,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error(`Send error from ${accountId}:`, error);
            
            // Update account stats
            const account = await Account.getById(accountId);
            if (account) {
                account.stats.messagesFailed++;
                await account.update({ stats: account.stats });
            }

            // Update message result
            if (messageId) {
                const messageDoc = await Message.getById(messageId);
                if (messageDoc) {
                    await messageDoc.addResult({
                        accountId,
                        phoneNumber: targetNumber,
                        status: 'failed',
                        error: error.message
                    });
                }
            }

            throw error;
        }
    }

    // Disconnect client
    async disconnectClient(accountId) {
        const clientData = this.clients.get(accountId);
        if (clientData) {
            try {
                await clientData.client.destroy();
                this.clients.delete(accountId);
                
                const account = await Account.getById(accountId);
                if (account) {
                    await account.update({ status: 'disconnected' });
                }
                
                return true;
            } catch (error) {
                console.error(`Disconnect error for ${accountId}:`, error);
            }
        }
        return false;
    }

    // Get client status
    getClientStatus(accountId) {
        const clientData = this.clients.get(accountId);
        return clientData ? clientData.status : 'not_found';
    }

    // Get all connected clients
    getConnectedClients() {
        const connected = [];
        for (const [accountId, data] of this.clients.entries()) {
            if (data.status === 'connected') {
                connected.push({
                    accountId,
                    userId: data.userId,
                    info: data.info
                });
            }
        }
        return connected;
    }
}

module.exports = new WhatsAppService();
