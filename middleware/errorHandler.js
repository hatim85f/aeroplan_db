const errorHandler = (error, req, res, next) => {
  let statusCode = error.statusCode || (res.statusCode && res.statusCode !== 200 ? res.statusCode : 500);
  let message = error.message || 'Server error';
  let errors;

  if (error.name === 'ValidationError') {
    statusCode = 400;
    errors = Object.values(error.errors).map((validationError) => validationError.message);
    message = 'Validation failed';
  }

  if (error.code === 11000) {
    statusCode = 409;
    const fields = Object.keys(error.keyValue || {});
    message = fields.includes('email')
      ? 'Email already exists'
      : `${fields.join(', ') || 'Field'} already exists`;
  }

  res.status(statusCode).json({
    success: false,
    message,
    errors,
    stack: process.env.NODE_ENV === 'production' ? undefined : error.stack
  });
};

module.exports = errorHandler;
