// src/models/Account.js
const { db, collections } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');

class Account {
    constructor(data = {}) {
        this.id = data.id || uuidv4();
        this.ownerId = data.ownerId || '';
        this.phoneNumber = data.phoneNumber || '';
        this.name = data.name || 'WhatsApp Account';
        this.status = data.status || 'initializing'; // initializing, qr_ready, connected, disconnected, banned
        this.rentStatus = data.rentStatus || 'personal'; // personal, pending, available, rented
        this.rentedTo = data.rentedTo || null;
        this.rentStart = data.rentStart || null;
        this.rentEnd = data.rentEnd || null;
        this.qrCode = data.qrCode || null;
        this.lastQrGenerated = data.lastQrGenerated || null;
        this.battery = data.battery || null;
        this.platform = data.platform || 'unknown';
        this.stats = data.stats || {
            messagesSent: 0,
            messagesFailed: 0,
            lastUsed: null
        };
        this.createdAt = data.createdAt || new Date().toISOString();
        this.updatedAt = data.updatedAt || new Date().toISOString();
    }

    async save() {
        const accountRef = db.collection(collections.ACCOUNTS).doc(this.id);
        await accountRef.set({
            ownerId: this.ownerId,
            phoneNumber: this.phoneNumber,
            name: this.name,
            status: this.status,
            rentStatus: this.rentStatus,
            rentedTo: this.rentedTo,
            rentStart: this.rentStart,
            rentEnd: this.rentEnd,
            qrCode: this.qrCode,
            lastQrGenerated: this.lastQrGenerated,
            battery: this.battery,
            platform: this.platform,
            stats: this.stats,
            createdAt: this.createdAt,
            updatedAt: new Date().toISOString()
        });
        return this;
    }

    static async getById(id) {
        const doc = await db.collection(collections.ACCOUNTS).doc(id).get();
        if (!doc.exists) return null;
        return new Account({ id: doc.id, ...doc.data() });
    }

    static async getByOwner(ownerId) {
        const snapshot = await db.collection(collections.ACCOUNTS)
            .where('ownerId', '==', ownerId)
            .orderBy('createdAt', 'desc')
            .get();
        return snapshot.docs.map(doc => new Account({ id: doc.id, ...doc.data() }));
    }

    static async getAvailableAccounts() {
        const snapshot = await db.collection(collections.ACCOUNTS)
            .where('rentStatus', '==', 'available')
            .where('status', '==', 'connected')
            .get();
        return snapshot.docs.map(doc => new Account({ id: doc.id, ...doc.data() }));
    }

    static async getRentedAccounts(userId) {
        const snapshot = await db.collection(collections.ACCOUNTS)
            .where('rentedTo', '==', userId)
            .get();
        return snapshot.docs.map(doc => new Account({ id: doc.id, ...doc.data() }));
    }

    static async getPendingRentals() {
        const snapshot = await db.collection(collections.ACCOUNTS)
            .where('rentStatus', '==', 'pending')
            .get();
        return snapshot.docs.map(doc => new Account({ id: doc.id, ...doc.data() }));
    }

    async update(data) {
        const accountRef = db.collection(collections.ACCOUNTS).doc(this.id);
        await accountRef.update({
            ...data,
            updatedAt: new Date().toISOString()
        });
        Object.assign(this, data);
        return this;
    }

    async updateStats(sent = 0, failed = 0) {
        this.stats.messagesSent += sent;
        this.stats.messagesFailed += failed;
        if (sent > 0) {
            this.stats.lastUsed = new Date().toISOString();
        }
        await this.update({ stats: this.stats });
    }

    async delete() {
        await db.collection(collections.ACCOUNTS).doc(this.id).delete();
    }
}

module.exports = Account;
