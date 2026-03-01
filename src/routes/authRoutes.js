const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/authMiddleware');
const { validate, phoneValidation, tokenValidation } = require('../middleware/validationMiddleware');

// Public routes
router.post(
  '/send-otp',
  validate([phoneValidation()]),
  authController.sendOTP.bind(authController)
);

router.post(
  '/verify-otp',
  validate([tokenValidation(), phoneValidation()]),
  authController.verifyOTP.bind(authController)
);

// Protected routes
router.get(
  '/user/:uid',
  authenticate,
  authController.getUserData.bind(authController)
);

router.put(
  '/update-profile',
  authenticate,
  authController.updateProfile.bind(authController)
);

router.delete(
  '/user/:uid',
  authenticate,
  authController.deleteUser.bind(authController)
);

module.exports = router;
