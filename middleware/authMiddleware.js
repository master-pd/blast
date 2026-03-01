const admin = require('../config/firebase');

// Firebase Token ভেরিফাই করার মিডলওয়্যার
exports.verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }

    // টোকেন ভেরিফাই করা
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    // ডিকোডেড টোকেন রিকোয়েস্টে সংরক্ষণ করা
    req.user = decodedToken;
    
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({
        success: false,
        message: 'Token expired'
      });
    }
    
    return res.status(401).json({
      success: false,
      message: 'Invalid token'
    });
  }
};
