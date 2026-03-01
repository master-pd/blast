const logger = require('../utils/logger');
const { HTTP_STATUS } = require('../utils/constants');

const errorHandler = (err, req, res, next) => {
  logger.error('Unhandled error:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip
  });

  // Default error
  const status = err.status || HTTP_STATUS.INTERNAL_SERVER;
  const message = err.message || 'Internal server error';

  // Don't expose error details in production
  const response = {
    success: false,
    message
  };

  if (process.env.NODE_ENV === 'development') {
    response.stack = err.stack;
    response.details = err;
  }

  res.status(status).json(response);
};

const notFound = (req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found`
  });
};

module.exports = {
  errorHandler,
  notFound
};
