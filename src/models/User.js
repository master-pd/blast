// src/models/User.js
const { db, collections } = require('../config/firebase');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

class User {
    constructor(data = {}) {
        this.id = data.id || uuidv4();
        this.name = data.name || '';
        this.email = data.email || '';
        this.password = data.password || '';
        this.role = data.role || 'user'; // user, admin
        this.myAccounts = data.myAccounts || [];
        this.rentedAccounts = data.rentedAccounts || [];
        this.createdAt = data.createdAt || new Date().toISOString();
        this.updatedAt = data.updatedAt || new Date().toISOString();
    }

    async hashPassword() {
        if (this.password) {
            const salt = await bcrypt.genSalt(10);
            this.password = await bcrypt.hash(this.password, salt);
        }
    }

    async comparePassword(candidatePassword) {
        return await bcrypt.compare(candidatePassword, this.password);
    }

    async save() {
        await this.hashPassword();
        const userRef = db.collection(collections.USERS).doc(this.id);
        await userRef.set({
            name: this.name,
            email: this.email,
            password: this.password,
            role: this.role,
            myAccounts: this.myAccounts,
            rentedAccounts: this.rentedAccounts,
            createdAt: this.createdAt,
            updatedAt: new Date().toISOString()
        });
        return this;
    }

    static async getByEmail(email) {
        const snapshot = await db.collection(collections.USERS)
            .where('email', '==', email)
            .limit(1)
            .get();
        
        if (snapshot.empty) return null;
        const doc = snapshot.docs[0];
        return new User({ id: doc.id, ...doc.data() });
    }

    static async getById(id) {
        const doc = await db.collection(collections.USERS).doc(id).get();
        if (!doc.exists) return null;
        return new User({ id: doc.id, ...doc.data() });
    }

    static async getAllUsers() {
        const snapshot = await db.collection(collections.USERS).get();
        return snapshot.docs.map(doc => new User({ id: doc.id, ...doc.data() }));
    }

    async update(data) {
        const userRef = db.collection(collections.USERS).doc(this.id);
        await userRef.update({
            ...data,
            updatedAt: new Date().toISOString()
        });
        Object.assign(this, data);
        return this;
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            email: this.email,
            role: this.role,
            myAccounts: this.myAccounts,
            rentedAccounts: this.rentedAccounts,
            createdAt: this.createdAt
        };
    }
}

module.exports = User;
