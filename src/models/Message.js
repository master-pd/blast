// src/models/Message.js
const { db, collections } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');

class Message {
    constructor(data = {}) {
        this.id = data.id || uuidv4();
        this.adminId = data.adminId || '';
        this.accountIds = data.accountIds || [];
        this.type = data.type || 'blast'; // blast, single
        this.targetNumbers = data.targetNumbers || [];
        this.message = data.message || '';
        this.status = data.status || 'pending'; // pending, processing, completed, partial
        this.results = data.results || [];
        this.stats = data.stats || {
            total: (this.targetNumbers.length || 0) * (this.accountIds.length || 1),
            success: 0,
            failed: 0
        };
        this.startedAt = data.startedAt || null;
        this.completedAt = data.completedAt || null;
        this.createdAt = data.createdAt || new Date().toISOString();
    }

    async save() {
        const messageRef = db.collection(collections.MESSAGES).doc(this.id);
        await messageRef.set({
            adminId: this.adminId,
            accountIds: this.accountIds,
            type: this.type,
            targetNumbers: this.targetNumbers,
            message: this.message,
            status: this.status,
            results: this.results,
            stats: this.stats,
            startedAt: this.startedAt,
            completedAt: this.completedAt,
            createdAt: this.createdAt
        });
        return this;
    }

    static async getById(id) {
        const doc = await db.collection(collections.MESSAGES).doc(id).get();
        if (!doc.exists) return null;
        return new Message({ id: doc.id, ...doc.data() });
    }

    static async getByAdmin(adminId, limit = 50) {
        const snapshot = await db.collection(collections.MESSAGES)
            .where('adminId', '==', adminId)
            .orderBy('createdAt', 'desc')
            .limit(limit)
            .get();
        return snapshot.docs.map(doc => new Message({ id: doc.id, ...doc.data() }));
    }

    async start() {
        this.status = 'processing';
        this.startedAt = new Date().toISOString();
        await this.update({ status: this.status, startedAt: this.startedAt });
    }

    async addResult(result) {
        this.results.push({
            ...result,
            timestamp: new Date().toISOString()
        });
        
        if (result.status === 'success') this.stats.success++;
        else if (result.status === 'failed') this.stats.failed++;
        
        if (this.results.length === this.stats.total) {
            this.status = this.stats.failed === 0 ? 'completed' : 'partial';
            this.completedAt = new Date().toISOString();
        }
        
        await this.update({
            results: this.results,
            stats: this.stats,
            status: this.status,
            completedAt: this.completedAt
        });
    }

    async update(data) {
        const messageRef = db.collection(collections.MESSAGES).doc(this.id);
        await messageRef.update(data);
        Object.assign(this, data);
        return this;
    }
}

module.exports = Message;
