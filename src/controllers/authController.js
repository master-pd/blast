// src/controllers/authController.js
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');

const authController = {
    async register(req, res) {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ 
                    success: false, 
                    errors: errors.array() 
                });
            }

            const { name, email, password } = req.body;

            // Check if user exists
            const existingUser = await User.getByEmail(email);
            if (existingUser) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Email already registered' 
                });
            }

            // Create new user
            const user = new User({ name, email, password });
            await user.save();

            // Generate token
            const token = jwt.sign(
                { id: user.id, email: user.email, role: user.role },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRE }
            );

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
                error: 'Registration failed' 
            });
        }
    },

    async login(req, res) {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ 
                    success: false, 
                    errors: errors.array() 
                });
            }

            const { email, password } = req.body;

            // Find user
            const user = await User.getByEmail(email);
            if (!user) {
                return res.status(401).json({ 
                    success: false, 
                    error: 'Invalid email or password' 
                });
            }

            // Check password
            const isMatch = await user.comparePassword(password);
            if (!isMatch) {
                return res.status(401).json({ 
                    success: false, 
                    error: 'Invalid email or password' 
                });
            }

            // Generate token
            const token = jwt.sign(
                { id: user.id, email: user.email, role: user.role },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRE }
            );

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
                error: 'Login failed' 
            });
        }
    },

    async getProfile(req, res) {
        try {
            res.json({
                success: true,
                user: req.user.toJSON()
            });
        } catch (error) {
            res.status(500).json({ 
                success: false, 
                error: 'Failed to get profile' 
            });
        }
    },

    async getAllUsers(req, res) {
        try {
            const users = await User.getAllUsers();
            res.json({
                success: true,
                count: users.length,
                users: users.map(u => u.toJSON())
            });
        } catch (error) {
            res.status(500).json({ 
                success: false, 
                error: 'Failed to get users' 
            });
        }
    }
};

module.exports = authController;
