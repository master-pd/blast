const { body, validationResult } = require('express-validator');
const { HTTP_STATUS } = require('../utils/constants');

const validate = (validations) => {
  return async (req, res, next) => {
    await Promise.all(validations.map(validation => validation.run(req)));

    const errors = validationResult(req);
    if (errors.isEmpty()) {
      return next();
    }

    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map(err => ({
        field: err.path,
        message: err.msg
      }))
    });
  };
};

// Validation rules
const phoneValidation = () => 
  body('phoneNumber')
    .notEmpty().withMessage('Phone number is required')
    .matches(/^\+[1-9]\d{1,14}$/).withMessage('Invalid phone number format');

const tokenValidation = () =>
  body('idToken')
    .notEmpty().withMessage('ID token is required')
    .isString().withMessage('ID token must be a string');

const uidValidation = () =>
  body('uid')
    .notEmpty().withMessage('User ID is required')
    .isString().withMessage('User ID must be a string');

module.exports = {
  validate,
  phoneValidation,
  tokenValidation,
  uidValidation
};
