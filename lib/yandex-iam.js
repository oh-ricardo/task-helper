const crypto = require('node:crypto');
const { TrackerConnectionError } = require('./tracker-connection');

const IAM_TOKEN_URL = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';
const DEFAULT_ORG_ID = 'bpf7jl9ghb35o2idt8iq';
const CACHE_SAFETY_WINDOW_MS = 5 * 60 * 1000;

let cachedToken = null;
let tokenRequest = null;

function readServiceAccountKey() {
  const value = process.env.YANDEX_TRACKER_SERVICE_ACCOUNT_KEY;
  if (!value) {
    throw new TrackerConnectionError('Tracker не настроен: отсутствует ключ сервисного аккаунта.', 503);
  }
  try {
    const json = value.trim().startsWith('{') ? value : Buffer.from(value, 'base64').toString('utf8');
    const key = JSON.parse(json);
    if (!key || typeof key.id !== 'string' || typeof key.service_account_id !== 'string' || typeof key.private_key !== 'string') throw new Error('Missing fields');
    return key;
  } catch {
    throw new TrackerConnectionError('Ключ сервисного аккаунта Tracker имеет неверный формат.', 503);
  }
}

function createJwt(key) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ typ: 'JWT', alg: 'PS256', kid: key.id });
  const payload = encode({ iss: key.service_account_id, aud: IAM_TOKEN_URL, iat: now, exp: now + 3600 });
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), {
    key: key.private_key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

async function requestIamToken() {
  const key = readServiceAccountKey();
  let response;
  try {
    response = await fetch(IAM_TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt: createJwt(key) }), signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new TrackerConnectionError('Yandex IAM не ответил за 10 секунд.', 504);
    throw new TrackerConnectionError('Не удалось получить IAM-токен для Tracker.', 502);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || typeof payload?.iamToken !== 'string') {
    throw new TrackerConnectionError('Yandex IAM отклонил JWT сервисного аккаунта. Проверьте ключ и права аккаунта.', 502);
  }
  const expiresAt = Date.parse(payload.expiresAt || '');
  const expiresAtMs = Number.isFinite(expiresAt) ? expiresAt - CACHE_SAFETY_WINDOW_MS : Date.now() + 10 * 60 * 1000;
  cachedToken = { value: payload.iamToken, expiresAt: Math.max(expiresAtMs, Date.now()) };
  return cachedToken.value;
}

async function getIamToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  if (!tokenRequest) tokenRequest = requestIamToken().finally(() => { tokenRequest = null; });
  return tokenRequest;
}

function trackerConnectionStatus() {
  try {
    const key = readServiceAccountKey();
    return { configured: true, serviceAccountId: key.service_account_id, orgId: process.env.YANDEX_TRACKER_ORG_ID || DEFAULT_ORG_ID };
  } catch (error) {
    if (error instanceof TrackerConnectionError) return { configured: false, error: error.message };
    throw error;
  }
}

async function trackerHeaders() {
  return {
    Authorization: `Bearer ${await getIamToken()}`,
    'X-Cloud-Org-Id': process.env.YANDEX_TRACKER_ORG_ID || DEFAULT_ORG_ID,
  };
}

module.exports = { trackerConnectionStatus, trackerHeaders };
