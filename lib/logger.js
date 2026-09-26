const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const { AsyncLocalStorage } = require('node:async_hooks');
const configuredLevel = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const minimumLevel = levels[configuredLevel] || levels.info;
const redactKey = /authorization|token|password|credential|secret|cookie|encrypted|encryption|authentication.?tag|salt|hash/i;
const contextStorage = new AsyncLocalStorage();

function redactText(value) {
  return String(value)
    .replace(/((?:bearer|oauth)\s+)[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/(https?:\/\/[^:\s/@]+:)[^@\s]+@/ig, '$1[REDACTED]@')
    .replace(/\b(token|password|credentials?|secret|api[-_]?key|authorization)\b\s*[=:]\s*[^\s,;]+/ig, '$1=[REDACTED]')
    .replace(/([?&](?:token|password|credentials?|secret|api[-_]?key|authorization)=)[^&#\s]+/ig, '$1[REDACTED]');
}

function sanitize(value, key = '') {
  if (redactKey.test(key)) return '[REDACTED]';
  if (value instanceof Error) return errorDetails(value);
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
  }
  return value;
}

function errorDetails(error) {
  const details = {
    name: error.name || 'Error',
    message: redactText(error.message || 'Unknown error'),
  };
  if (error.code) details.code = String(error.code);
  if (Number.isInteger(error.statusCode)) details.statusCode = error.statusCode;
  if (process.env.LOG_STACKS === 'true' && error.stack) details.stack = redactText(error.stack);
  return details;
}

function log(level, event, context = {}) {
  if (levels[level] < minimumLevel) return;
  const entry = sanitize({ timestamp: new Date().toISOString(), level, event, ...contextStorage.getStore(), ...context });
  const output = JSON.stringify(entry);
  (level === 'error' || level === 'warn' ? console.error : console.log)(output);
}

module.exports = {
  debug: (event, context) => log('debug', event, context),
  info: (event, context) => log('info', event, context),
  warn: (event, context) => log('warn', event, context),
  error: (event, context) => log('error', event, context),
  errorDetails,
  withContext: (context, callback) => contextStorage.run(context, callback),
};
