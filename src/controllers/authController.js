// src/controllers/authController.js
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');

console.log('✅ authController loaded');

const authController = {
    // রেজিস্টার
    async register(req, res) {
        console.log('📝 Register function called');
        console.log('Request body:', req.body);
        
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                console.log('Validation errors:', errors.array());
                return res.status(400).json({ 
                    success: false, 
                    errors: errors.array() 
                });
            }

            const { name, email, password } = req.body;
            console.log('Processing registration for:', email);

            // Check if user exists
            const existingUser = await User.getByEmail(email);
            if (existingUser) {
                console.log('User already exists:', email);
                return res.status(400).json({ 
                    success: false, 
                    error: 'Email already registered' 
                });
            }

            // Create new user
            console.log('Creating new user...');
            const user = new User({ 
                name, 
                email, 
                password,
                role: 'user' 
            });
            
            await user.save();
            console.log('User saved with ID:', user.id);

            // Generate token
            const token = jwt.sign(
                { id: user.id, email: user.email, role: user.role },
                process.env.JWT_SECRET || 'fallback_secret',
                { expiresIn: process.env.JWT_EXPIRE || '7d' }
            );

            console.log('Registration successful for:', email);
            res.status(201).json({
                success: true,
                message: 'Registration successful',
                token,
                user: user.toJSON()
            });
        } catch (error) {
            console.error('Registration error:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Registration failed: ' + error.message 
            });
        }
    },

    // লগইন
    async login(req, res) {
        console.log('🔑 Login function called');
        console.log('Request body:', req.body);
        
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                console.log('Validation errors:', errors.array());
                return res.status(400).json({ 
                    success: false, 
                    errors: errors.array() 
                });
            }

            const { email, password } = req.body;
            console.log('Processing login for:', email);

            // Find user
            const user = await User.getByEmail(email);
            if (!user) {
                console.log('User not found:', email);
                return res.status(401).json({ 
                    success: false, 
                    error: 'Invalid email or password' 
                });
            }

            // Check password
            console.log('Checking password...');
            const isMatch = await user.comparePassword(password);
            if (!isMatch) {
                console.log('Password mismatch for:', email);
                return res.status(401).json({ 
                    success: false, 
                    error: 'Invalid email or password' 
                });
            }

            // Generate token
            const token = jwt.sign(
                { id: user.id, email: user.email, role: user.role },
                process.env.JWT_SECRET || 'fallback_secret',
                { expiresIn: process.env.JWT_EXPIRE || '7d' }
            );

            console.log('Login successful for:', email);
            res.json({
                success: true,
                message: 'Login successful',
                token,
                user: user.toJSON()
            });
        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Login failed: ' + error.message 
            });
        }
    },

    // প্রোফাইল
    async getProfile(req, res) {
        console.log('👤 Profile function called');
        console.log('Params:', req.params);
        
        try {
            const { userId } = req.params;
            
            if (!userId) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'User ID is required' 
                });
            }

            const user = await User.getById(userId);
            if (!user) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'User not found' 
                });
            }

            res.json({
                success: true,
                user: user.toJSON()
            });
        } catch (error) {
            console.error('Profile error:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to get profile' 
            });
        }
    },

    // সব ইউজার (এডমিনের জন্য)
    async getAllUsers(req, res) {
        console.log('📋 GetAllUsers function called');
        
        try {
            const users = await User.getAllUsers();
            res.json({
                success: true,
                count: users.length,
                users: users.map(u => u.toJSON())
            });
        } catch (error) {
            console.error('Get all users error:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to get users' 
            });
        }
    }
};

module.exports = authController;
