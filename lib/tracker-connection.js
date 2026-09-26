const crypto = require('node:crypto');

class TrackerConnectionError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'TrackerConnectionError';
    this.statusCode = statusCode;
  }
}

function encryptionKey() {
  const value = process.env.TRACKER_ENCRYPTION_KEY;
  if (!value) {
    throw new TrackerConnectionError('Хранилище подключений не настроено: отсутствует ключ шифрования.', 503);
  }

  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new TrackerConnectionError('Ключ шифрования подключений имеет неверный формат.', 503);
  }
  return key;
}

function encryptConnectionSettings(settings) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const plaintext = JSON.stringify(settings);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    encryptedPayload: encrypted.toString('base64url'),
    encryptionIv: iv.toString('base64url'),
    authenticationTag: cipher.getAuthTag().toString('base64url'),
  };
}

function decryptConnectionSettings(record) {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(record.encryption_iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(record.authentication_tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.encrypted_payload, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch (error) {
    if (error instanceof TrackerConnectionError) throw error;
    throw new TrackerConnectionError('Не удалось прочитать сохранённое подключение к Tracker.', 500);
  }
}

function validateConnectionSettings(value) {
  const token = typeof value.token === 'string' ? value.token.trim() : '';
  const orgId = typeof value.orgId === 'string' ? value.orgId.trim() : '';
  const orgHeader = value.orgHeader === 'X-Cloud-Org-ID' ? 'X-Cloud-Org-ID' : value.orgHeader;

  if (!token || token.length > 4096) {
    throw new TrackerConnectionError('Укажите OAuth-токен Яндекс Трекера.', 400);
  }
  if (!orgId || orgId.length > 256) {
    throw new TrackerConnectionError('Укажите идентификатор организации Tracker.', 400);
  }
  if (!['X-Org-ID', 'X-Cloud-Org-ID'].includes(orgHeader)) {
    throw new TrackerConnectionError('Укажите тип организации Tracker.', 400);
  }

  return { token, orgId, orgHeader };
}

module.exports = {
  TrackerConnectionError,
  decryptConnectionSettings,
  encryptConnectionSettings,
  validateConnectionSettings,
};
