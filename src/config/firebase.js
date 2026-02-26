// src/config/firebase.js
const admin = require('firebase-admin');
const dotenv = require('dotenv');

dotenv.config();

let firebaseApp;

try {
    const serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL
    };

    firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
    
    console.log('✅ Firebase Initialized');
} catch (error) {
    console.error('❌ Firebase Initialization Error:', error.message);
}

const db = admin.firestore();
const auth = admin.auth();

// Collections
const collections = {
    USERS: 'users',
    ACCOUNTS: 'accounts',
    MESSAGES: 'messages',
    RENTALS: 'rentals',
    SESSIONS: 'sessions',
    LOGS: 'logs'
};

// Firestore Settings
db.settings({
    timestampsInSnapshots: true,
    ignoreUndefinedProperties: true
});

module.exports = { admin, db, auth, collections };
