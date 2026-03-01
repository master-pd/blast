const { admin, auth } = require('../config/firebase');
const logger = require('../utils/logger');
const { HTTP_STATUS, MESSAGES } = require('../utils/constants');

class FirebaseService {
  // Get user by phone number
  async getUserByPhone(phoneNumber) {
    try {
      const user = await auth.getUserByPhoneNumber(phoneNumber);
      return {
        exists: true,
        user: this.formatUserData(user)
      };
    } catch (error) {
      if (error.code === 'auth/user-not-found') {
        return { exists: false, user: null };
      }
      throw error;
    }
  }

  // Get user by UID
  async getUserByUID(uid) {
    try {
      const user = await auth.getUser(uid);
      return this.formatUserData(user);
    } catch (error) {
      logger.error('Get user by UID error:', error);
      throw error;
    }
  }

  // Verify ID token
  async verifyIdToken(idToken) {
    try {
      const decodedToken = await auth.verifyIdToken(idToken);
      return decodedToken;
    } catch (error) {
      logger.error('Verify token error:', error);
      throw error;
    }
  }

  // Create custom token
  async createCustomToken(uid) {
    try {
      const customToken = await auth.createCustomToken(uid);
      return customToken;
    } catch (error) {
      logger.error('Create custom token error:', error);
      throw error;
    }
  }

  // Update user profile
  async updateUserProfile(uid, updateData) {
    try {
      const updatedUser = await auth.updateUser(uid, updateData);
      return this.formatUserData(updatedUser);
    } catch (error) {
      logger.error('Update user error:', error);
      throw error;
    }
  }

  // Delete user
  async deleteUser(uid) {
    try {
      await auth.deleteUser(uid);
      return true;
    } catch (error) {
      logger.error('Delete user error:', error);
      throw error;
    }
  }

  // Format user data
  formatUserData(user) {
    return {
      uid: user.uid,
      phoneNumber: user.phoneNumber,
      email: user.email || null,
      displayName: user.displayName || null,
      photoURL: user.photoURL || null,
      emailVerified: user.emailVerified || false,
      disabled: user.disabled || false,
      createdAt: user.metadata.creationTime,
      lastLoginAt: user.metadata.lastSignInTime,
      providerData: user.providerData
    };
  }

  // Check if user is new
  isNewUser(user) {
    return user.metadata.creationTime === user.metadata.lastSignInTime;
  }

  // Handle Firebase errors
  handleFirebaseError(error) {
    const errorMap = {
      'auth/invalid-phone-number': {
        status: HTTP_STATUS.BAD_REQUEST,
        message: MESSAGES.INVALID_PHONE
      },
      'auth/user-not-found': {
        status: HTTP_STATUS.NOT_FOUND,
        message: MESSAGES.USER_NOT_FOUND
      },
      'auth/id-token-expired': {
        status: HTTP_STATUS.UNAUTHORIZED,
        message: MESSAGES.TOKEN_EXPIRED
      },
      'auth/argument-error': {
        status: HTTP_STATUS.UNAUTHORIZED,
        message: MESSAGES.INVALID_TOKEN
      },
      'auth/too-many-requests': {
        status: HTTP_STATUS.TOO_MANY_REQUESTS,
        message: MESSAGES.TOO_MANY_REQUESTS
      },
      'auth/email-already-exists': {
        status: HTTP_STATUS.CONFLICT,
        message: MESSAGES.EMAIL_EXISTS
      }
    };

    return errorMap[error.code] || {
      status: HTTP_STATUS.INTERNAL_SERVER,
      message: 'Internal server error'
    };
  }
}

module.exports = new FirebaseService();
