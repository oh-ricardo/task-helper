class TrackerConnectionError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'TrackerConnectionError';
    this.statusCode = statusCode;
  }
}

module.exports = {
  TrackerConnectionError,
};
