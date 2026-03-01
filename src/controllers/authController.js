const firebaseService = require('../services/firebaseService');
const { HTTP_STATUS, MESSAGES } = require('../utils/constants');
const { validatePhoneNumber, sanitizePhoneNumber } = require('../utils/validators');
const logger = require('../utils/logger');

class AuthController {
  // Send OTP
  async sendOTP(req, res, next) {
    try {
      const { phoneNumber } = req.body;

      // Validate phone number
      if (!phoneNumber) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: MESSAGES.PHONE_REQUIRED
        });
      }

      const sanitizedPhone = sanitizePhoneNumber(phoneNumber);
      
      if (!validatePhoneNumber(sanitizedPhone)) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: MESSAGES.INVALID_PHONE
        });
      }

      // Check if user exists
      const userExists = await firebaseService.getUserByPhone(sanitizedPhone);

      logger.info(`OTP requested for phone: ${sanitizedPhone}`);

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        message: MESSAGES.OTP_SENT,
        data: {
          phoneNumber: sanitizedPhone,
          isExistingUser: userExists.exists,
          userData: userExists.exists ? userExists.user : null
        }
      });

    } catch (error) {
      logger.error('Send OTP error:', error);
      next(error);
    }
  }

  // Verify OTP
  async verifyOTP(req, res, next) {
    try {
      const { idToken, phoneNumber } = req.body;

      // Validate required fields
      if (!idToken) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: MESSAGES.TOKEN_REQUIRED
        });
      }

      if (!phoneNumber) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: MESSAGES.PHONE_REQUIRED
        });
      }

      const sanitizedPhone = sanitizePhoneNumber(phoneNumber);

      // Verify token
      const decodedToken = await firebaseService.verifyIdToken(idToken);

      // Verify phone number matches
      if (decodedToken.phone_number !== sanitizedPhone) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: MESSAGES.PHONE_MISMATCH
        });
      }

      // Get user data
      const user = await firebaseService.getUserByUID(decodedToken.uid);
      
      // Create custom token
      const customToken = await firebaseService.createCustomToken(decodedToken.uid);
      
      // Check if new user
      const isNewUser = firebaseService.isNewUser({
        metadata: {
          creationTime: user.createdAt,
          lastSignInTime: user.lastLoginAt
        }
      });

      logger.info(`OTP verified for user: ${user.uid}`);

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        message: MESSAGES.OTP_VERIFIED,
        data: {
          ...user,
          customToken,
          isNewUser
        }
      });

    } catch (error) {
      logger.error('Verify OTP error:', error);
      
      const fbError = firebaseService.handleFirebaseError(error);
      return res.status(fbError.status).json({
        success: false,
        message: fbError.message
      });
    }
  }

  // Get user data
  async getUserData(req, res, next) {
    try {
      const { uid } = req.params;

      if (!uid) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: MESSAGES.UID_REQUIRED
        });
      }

      const user = await firebaseService.getUserByUID(uid);

      logger.info(`User data fetched: ${uid}`);

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        message: MESSAGES.USER_FETCHED,
        data: user
      });

    } catch (error) {
      logger.error('Get user data error:', error);
      
      const fbError = firebaseService.handleFirebaseError(error);
      return res.status(fbError.status).json({
        success: false,
        message: fbError.message
      });
    }
  }

  // Update user profile
  async updateProfile(req, res, next) {
    try {
      const { uid, displayName, email, photoURL } = req.body;

      if (!uid) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: MESSAGES.UID_REQUIRED
        });
      }

      const updateData = {};
      if (displayName) updateData.displayName = displayName;
      if (email) updateData.email = email;
      if (photoURL) updateData.photoURL = photoURL;

      if (Object.keys(updateData).length === 0) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: MESSAGES.UPDATE_FIELDS_REQUIRED
        });
      }

      const updatedUser = await firebaseService.updateUserProfile(uid, updateData);

      logger.info(`Profile updated for user: ${uid}`);

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        message: MESSAGES.PROFILE_UPDATED,
        data: updatedUser
      });

    } catch (error) {
      logger.error('Update profile error:', error);
      
      const fbError = firebaseService.handleFirebaseError(error);
      return res.status(fbError.status).json({
        success: false,
        message: fbError.message
      });
    }
  }

  // Delete user
  async deleteUser(req, res, next) {
    try {
      const { uid } = req.params;

      if (!uid) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: MESSAGES.UID_REQUIRED
        });
      }

      await firebaseService.deleteUser(uid);

      logger.info(`User deleted: ${uid}`);

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        message: MESSAGES.USER_DELETED
      });

    } catch (error) {
      logger.error('Delete user error:', error);
      
      const fbError = firebaseService.handleFirebaseError(error);
      return res.status(fbError.status).json({
        success: false,
        message: fbError.message
      });
    }
  }
}

module.exports = new AuthController();
