const firebaseService = require('../services/firebaseService');
const { HTTP_STATUS, MESSAGES } = require('../utils/constants');
const logger = require('../utils/logger');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: MESSAGES.UNAUTHORIZED
      });
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: MESSAGES.TOKEN_REQUIRED
      });
    }

    const decodedToken = await firebaseService.verifyIdToken(token);
    
    // Add user info to request
    req.user = {
      uid: decodedToken.uid,
      phoneNumber: decodedToken.phone_number,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified
    };

    logger.debug(`User authenticated: ${decodedToken.uid}`);
    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    
    const fbError = firebaseService.handleFirebaseError(error);
    return res.status(fbError.status).json({
      success: false,
      message: fbError.message
    });
  }
};

module.exports = { authenticate };
