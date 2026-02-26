// src/controllers/authController.js - রেজিস্টার ফাংশন ফিক্স
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

        // Create new user - পাসওয়ার্ড হ্যাশ হবে save() method-এ
        const user = new User({ 
            name, 
            email, 
            password,  // এইটা save() method এ হ্যাশ হবে
            role: 'user' 
        });
        
        await user.save(); // এখানে hashPassword() কল হবে

        // Generate token
        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRE || '7d' }
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
            error: 'Registration failed: ' + error.message 
        });
    }
}
