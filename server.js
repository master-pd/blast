// server.js
const app = require('./src/app');
const dotenv = require('dotenv');
const { db } = require('./src/config/firebase');
const User = require('./src/models/User');
const bcrypt = require('bcryptjs');

dotenv.config();

const PORT = process.env.PORT || 3000;

// Test Firebase Connection
const testFirebase = async () => {
    try {
        const testRef = db.collection('test').doc('connection');
        await testRef.set({ 
            timestamp: new Date().toISOString(),
            status: 'connected' 
        });
        console.log('✅ Firebase Connected Successfully');
    } catch (error) {
        console.error('❌ Firebase Connection Failed:', error.message);
    }
};

// Create Default Admin
const createDefaultAdmin = async () => {
    try {
        const adminEmail = process.env.ADMIN_EMAIL;
        const existingAdmin = await User.getByEmail(adminEmail);
        
        if (!existingAdmin) {
            const admin = new User({
                name: 'Super Admin',
                email: adminEmail,
                password: process.env.ADMIN_PASSWORD,
                role: 'admin'
            });
            await admin.save();
            console.log('✅ Default Admin Created');
        } else {
            console.log('✅ Admin Already Exists');
        }
    } catch (error) {
        console.error('❌ Admin Creation Failed:', error.message);
    }
};

// Initialize
const initialize = async () => {
    await testFirebase();
    await createDefaultAdmin();
};

initialize();

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔════════════════════════════════════╗
    ║         BLASTER API v1.0           ║
    ╠════════════════════════════════════╣
    ║  🚀 Server: http://localhost:${PORT}   ║
    ║  📡 Status: RUNNING                  ║
    ║  🔥 Firebase: CONNECTED               ║
    ║  👤 Admin: ${process.env.ADMIN_EMAIL}     ║
    ║  📊 Environment: ${process.env.NODE_ENV}  ║
    ╚════════════════════════════════════╝
    `);
});

// Graceful Shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Closing server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});
