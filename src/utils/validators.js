const { PHONE_REGEX } = require('./constants');

const validatePhoneNumber = (phone) => {
  return PHONE_REGEX.test(phone);
};

const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const sanitizePhoneNumber = (phone) => {
  // Remove all non-digit characters except +
  return phone.replace(/[^\d+]/g, '');
};

module.exports = {
  validatePhoneNumber,
  validateEmail,
  sanitizePhoneNumber
};
