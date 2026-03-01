module.exports = {
  // HTTP Status Codes
  HTTP_STATUS: {
    OK: 200,
    CREATED: 201,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER: 500
  },

  // Error Messages
  MESSAGES: {
    // Success
    OTP_SENT: 'OTP sent successfully',
    OTP_VERIFIED: 'OTP verified successfully',
    PROFILE_UPDATED: 'Profile updated successfully',
    USER_FETCHED: 'User data fetched successfully',
    USER_DELETED: 'User deleted successfully',

    // Errors
    PHONE_REQUIRED: 'Phone number is required',
    TOKEN_REQUIRED: 'ID token is required',
    UID_REQUIRED: 'User ID is required',
    INVALID_PHONE: 'Invalid phone number format',
    INVALID_TOKEN: 'Invalid or expired token',
    TOKEN_EXPIRED: 'Token expired. Please request new OTP',
    PHONE_MISMATCH: 'Phone number mismatch',
    USER_NOT_FOUND: 'User not found',
    TOO_MANY_REQUESTS: 'Too many requests. Please try again later',
    UNAUTHORIZED: 'Unauthorized access',
    FORBIDDEN: 'Forbidden access',
    EMAIL_EXISTS: 'Email already exists',
    UPDATE_FIELDS_REQUIRED: 'At least one field to update is required'
  },

  // Phone Regex (E.164 format)
  PHONE_REGEX: /^\+[1-9]\d{1,14}$/,

  // Rate Limiting
  RATE_LIMIT: {
    WINDOW_MS: 15 * 60 * 1000, // 15 minutes
    MAX: 100 // 100 requests per window
  }
};
