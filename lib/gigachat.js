const fs = require('node:fs');
const path = require('node:path');
const { Agent } = require('node:https');
const { GigaChat } = require('gigachat');
const { buildTaskDraftPrompt } = require('../prompts/task-draft');
const logger = require('./logger');

const certificatePath = path.join(__dirname, '..', 'certs', 'russian_trusted_root_ca_pem.crt');
const supportedPriorities = new Set(['blocker', 'critical', 'normal', 'minor']);

class GigaChatError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.statusCode = statusCode;
  }
}

function getClient() {
  if (!process.env.GIGACHAT_CREDENTIALS) {
    throw new GigaChatError('GigaChat не настроен: отсутствует ключ авторизации.', 503);
  }
  if (!fs.existsSync(certificatePath)) {
    throw new GigaChatError('Не найден сертификат НУЦ Минцифры для GigaChat.', 503);
  }

  return new GigaChat({
    credentials: process.env.GIGACHAT_CREDENTIALS,
    scope: process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS',
    model: process.env.GIGACHAT_MODEL || 'GigaChat-2-Pro',
    baseUrl: process.env.GIGACHAT_BASE_URL || 'https://gigachat.devices.sberbank.ru/api/v1',
    timeout: 30,
    httpsAgent: new Agent({ ca: fs.readFileSync(certificatePath) }),
  });
}

function readJson(content) {
  const source = String(content || '').trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(source);
  } catch {
    throw new GigaChatError('GigaChat вернул ответ в неверном формате.', 502);
  }
}

function optionalText(value, limit = 500) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function validateDraft(value, defaultPriority = 'normal') {
  const deadline = optionalText(value.deadline, 10);
  return {
    title: optionalText(value.title, 180) || 'Новая задача',
    description: optionalText(value.description, 5000),
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : '',
    priority: supportedPriorities.has(value.priority) ? value.priority : (supportedPriorities.has(defaultPriority) ? defaultPriority : 'normal'),
    assignee: optionalText(value.assignee, 120),
    follower: optionalText(value.follower, 120),
    confidence: Number.isFinite(value.confidence) ? Math.max(0, Math.min(100, Math.round(value.confidence))) : 0,
  };
}

function dateInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function resolveRelativeDeadline(text, timeZone = 'Europe/Moscow') {
  if (!/до\s+конца\s+недел[ьи]/i.test(text)) return '';
  const today = dateInTimeZone(timeZone);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDays(today, (5 - weekday + 7) % 7);
}

async function generateTaskDraft(text, profile) {
  const client = getClient();
  const timeZone = profile.timezone || 'Europe/Moscow';
  const normalizedDeadline = resolveRelativeDeadline(text, timeZone);
  const prompt = buildTaskDraftPrompt({ text, profile, today: dateInTimeZone(timeZone), normalizedDeadline });

  try {
    const response = await client.chat({ messages: [{ role: 'user', content: prompt }], temperature: 0.2 });
    const draft = validateDraft(readJson(response.choices?.[0]?.message?.content), profile.defaultPriority);
    if (normalizedDeadline) draft.deadline = normalizedDeadline;
    return draft;
  } catch (error) {
    if (error instanceof GigaChatError) throw error;
    const status = error.response?.status;
    logger.error('gigachat.request_failed', { status: status || null, error });
    if (status === 429) {
      throw new GigaChatError('GigaChat временно ограничил число запросов. Подождите немного и повторите попытку.', 429);
    }
    throw new GigaChatError('Не удалось сформировать черновик через GigaChat. Повторите попытку позже.');
  }
}

module.exports = { generateTaskDraft, GigaChatError, resolveRelativeDeadline };
