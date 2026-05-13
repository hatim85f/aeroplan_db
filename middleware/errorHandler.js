const errorHandler = (error, req, res, next) => {
  const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;

  res.status(statusCode).json({
    success: false,
    message: error.message || 'Server error',
    stack: process.env.NODE_ENV === 'production' ? undefined : error.stack
  });
};

module.exports = errorHandler;
