require('dotenv').config();

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { generateTaskDraft, GigaChatError } = require('./lib/gigachat');
const {
  TrackerConnectionError,
  decryptConnectionSettings,
  encryptConnectionSettings,
  validateConnectionSettings,
} = require('./lib/tracker-connection');

const root = __dirname;
const stateDir = process.env.DATA_DIR || path.join(root, '.data');
const authFile = path.join(stateDir, 'auth.json');
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    })
  : null;
const sessions = new Map();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const secureCookie = process.env.COOKIE_SECURE === 'true';

function readFileAuth() { try { return JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return null; } }
function writeFileAuth(value) { fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(authFile, JSON.stringify(value), { mode: 0o600 }); }
async function readAuth() {
  if (!pool) return readFileAuth();
  const { rows } = await pool.query('SELECT id, password_hash AS hash, password_salt AS salt FROM users ORDER BY id ASC LIMIT 1');
  return rows[0] || null;
}
async function writeAuth(value) {
  if (!pool) {
    writeFileAuth(value);
    return { ...value, id: 1 };
  }
  const { rows } = await pool.query('INSERT INTO users (password_hash, password_salt) VALUES ($1, $2) RETURNING id', [value.hash, value.salt]);
  return { ...value, id: rows[0].id };
}
function hash(password, salt = crypto.randomBytes(16).toString('base64url')) { return new Promise((resolve, reject) => crypto.pbkdf2(password, salt, 600000, 64, 'sha512', (err, key) => err ? reject(err) : resolve({ salt, hash: key.toString('base64url') }))); }
function parseCookies(request) { return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map(part => { const i=part.indexOf('='); return [part.slice(0,i).trim(), decodeURIComponent(part.slice(i+1))]; })); }
function currentSession(request) { const sid = parseCookies(request).task_helper_session; const value = sid && sessions.get(sid); return value && value.expiresAt > Date.now() ? value : null; }
function authenticated(request) { return Boolean(currentSession(request)); }
function authenticatedUserId(request) { return currentSession(request)?.userId || null; }
function send(response, code, body, headers = {}) { response.writeHead(code, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers }); response.end(JSON.stringify(body)); }
function session(response, userId) { const id=crypto.randomBytes(32).toString('base64url'); sessions.set(id,{userId,expiresAt:Date.now()+8*60*60*1000}); response.setHeader('Set-Cookie', `task_helper_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie?'; Secure':''}`); }
function clearSession(request, response) { const id=parseCookies(request).task_helper_session; if(id) sessions.delete(id); response.setHeader('Set-Cookie', `task_helper_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie?'; Secure':''}`); }
function body(request) { return new Promise((resolve,reject)=>{let raw='';request.on('data',chunk=>{raw+=chunk;if(raw.length>16384)request.destroy();});request.on('end',()=>{try{resolve(JSON.parse(raw||'{}'));}catch{reject(new Error('Некорректный запрос.'));}});request.on('error',reject);}); }
function staticFile(request, response) { const url = new URL(request.url, `http://${request.headers.host}`); const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); if (!/^[a-zA-Z0-9._-]+$/.test(file)) return send(response,404,{error:'Не найдено'}); const full = path.join(root,file); if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(response,404,{error:'Не найдено'}); const type = ({html:'text/html; charset=utf-8',js:'application/javascript; charset=utf-8',css:'text/css; charset=utf-8'})[path.extname(full).slice(1)] || 'application/octet-stream'; response.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff'});fs.createReadStream(full).pipe(response); }
async function trackerSettings(userId) {
  if (!pool) throw new TrackerConnectionError('Для работы с Tracker требуется PostgreSQL.', 503);
  const { rows } = await pool.query(
    'SELECT encrypted_payload, encryption_iv, authentication_tag FROM tracker_connections WHERE user_id = $1',
    [userId],
  );
  if (!rows[0]) throw new TrackerConnectionError('Сначала сохраните параметры подключения к Tracker.', 409);
  return decryptConnectionSettings(rows[0]);
}
async function trackerGet(settings, path) {
  let response;
  try {
    response = await fetch(`https://api.tracker.yandex.net/v3${path}`, {
      headers: { Authorization: `OAuth ${settings.token}`, [settings.orgHeader]: settings.orgId },
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new TrackerConnectionError('Tracker не ответил за 10 секунд. Повторите попытку позже.', 504);
    throw new TrackerConnectionError('Не удалось получить данные из Tracker.', 502);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = response.status === 401
      ? 'Tracker отклонил токен. Сохраните подключение с новым токеном.'
      : response.status === 403
        ? 'У пользователя нет прав получить эти данные из Tracker.'
        : `Tracker вернул ошибку ${response.status}.`;
    throw new TrackerConnectionError(message, response.status);
  }
  return payload;
}
async function trackerPost(settings, path, payload) {
  let response;
  try {
    response = await fetch(`https://api.tracker.yandex.net/v3${path}`, {
      method: 'POST',
      headers: { Authorization: `OAuth ${settings.token}`, [settings.orgHeader]: settings.orgId, 'Content-Type':'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new TrackerConnectionError('Tracker не подтвердил создание задачи за 15 секунд. Проверьте Tracker перед повторной отправкой.', 504);
    throw new TrackerConnectionError('Не удалось отправить задачу в Tracker.', 502);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const message = response.status === 401
      ? 'Tracker отклонил токен. Сохраните подключение с новым токеном.'
      : response.status === 403
        ? 'У пользователя нет права создавать задачи в выбранной очереди.'
        : response.status === 409
          ? 'Такая задача уже была отправлена. Проверьте список задач в Tracker.'
          : response.status === 422
            ? 'Tracker отклонил поля задачи. В очереди могут быть обязательные поля, которые ещё не поддержаны приложением.'
            : `Tracker вернул ошибку ${response.status} при создании задачи.`;
    throw new TrackerConnectionError(message, response.status);
  }
  return result;
}
function defaultId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new TrackerConnectionError('Некорректное значение настройки по умолчанию.', 400);
  const id = String(value).trim();
  if (!id || id.length > 128) throw new TrackerConnectionError('Некорректное значение настройки по умолчанию.', 400);
  return id;
}

http.createServer(async (request,response)=>{
  if (request.method === 'GET' && request.url === '/api/auth/status') return send(response,200,{authenticated:authenticated(request),needsSetup:!(await readAuth())});
  if (request.method === 'GET' && request.url === '/api/tracker/connection') {
    const userId = authenticatedUserId(request);
    if (!userId) return send(response,401,{error:'Требуется вход.'});
    if (!pool) return send(response,503,{error:'Для хранения подключения к Tracker требуется PostgreSQL.'});
    try {
      const { rows } = await pool.query('SELECT updated_at FROM tracker_connections WHERE user_id = $1', [userId]);
      return send(response,200,{configured:Boolean(rows[0]),updatedAt:rows[0]?.updated_at || null});
    } catch (error) {
      console.error('Tracker connection status failed:', error.message);
      return send(response,500,{error:'Не удалось получить состояние подключения к Tracker.'});
    }
  }
  if (request.method === 'POST' && request.url === '/api/tracker/connection') {
    const userId = authenticatedUserId(request);
    if (!userId) return send(response,401,{error:'Требуется вход.'});
    if (!pool) return send(response,503,{error:'Для хранения подключения к Tracker требуется PostgreSQL.'});
    try {
      const settings = validateConnectionSettings(await body(request));
      const encrypted = encryptConnectionSettings(settings);
      await pool.query(
        `INSERT INTO tracker_connections (user_id, encrypted_payload, encryption_iv, authentication_tag)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           encrypted_payload = EXCLUDED.encrypted_payload,
           encryption_iv = EXCLUDED.encryption_iv,
           authentication_tag = EXCLUDED.authentication_tag,
           updated_at = now()`,
        [userId, encrypted.encryptedPayload, encrypted.encryptionIv, encrypted.authenticationTag],
      );
      return send(response,200,{configured:true});
    } catch (error) {
      const status = error instanceof TrackerConnectionError ? error.statusCode : 500;
      console.error('Tracker connection save failed:', error.message);
      return send(response,status,{error:error.message || 'Не удалось сохранить подключение к Tracker.'});
    }
  }
  if (request.method === 'POST' && request.url === '/api/tracker/connection/test') {
    const userId = authenticatedUserId(request);
    if (!userId) return send(response,401,{error:'Требуется вход.'});
    if (!pool) return send(response,503,{error:'Для хранения подключения к Tracker требуется PostgreSQL.'});
    try {
      const { rows } = await pool.query(
        'SELECT encrypted_payload, encryption_iv, authentication_tag FROM tracker_connections WHERE user_id = $1',
        [userId],
      );
      if (!rows[0]) return send(response,409,{error:'Сначала сохраните параметры подключения к Tracker.'});
      const settings = decryptConnectionSettings(rows[0]);
      const trackerResponse = await fetch('https://api.tracker.yandex.net/v3/myself', {
        headers: {
          Authorization: `OAuth ${settings.token}`,
          [settings.orgHeader]: settings.orgId,
        },
        signal: AbortSignal.timeout(10000),
      });
      const trackerUser = await trackerResponse.json().catch(() => null);
      if (!trackerResponse.ok) {
        const message = trackerResponse.status === 401
          ? 'Tracker отклонил токен. Проверьте его и сохраните подключение заново.'
          : trackerResponse.status === 403
            ? 'У этого пользователя нет прав на доступ к Tracker.'
            : trackerResponse.status === 429
              ? 'Tracker временно ограничил запросы. Повторите проверку позже.'
              : `Tracker вернул ошибку ${trackerResponse.status}.`;
        throw new TrackerConnectionError(message, 502);
      }
      const accountName = typeof trackerUser?.display === 'string' ? trackerUser.display.slice(0, 120) : null;
      return send(response,200,{connected:true,accountName});
    } catch (error) {
      const isConnectionError = error instanceof TrackerConnectionError;
      const message = error.name === 'TimeoutError'
        ? 'Tracker не ответил за 10 секунд. Повторите попытку позже.'
        : isConnectionError ? error.message : 'Не удалось проверить подключение к Tracker.';
      const status = isConnectionError ? error.statusCode : 502;
      console.error('Tracker connection test failed:', error.message);
      return send(response,status,{error:message});
    }
  }
  if (request.method === 'GET' && request.url === '/api/tracker/catalog') {
    const userId = authenticatedUserId(request);
    if (!userId) return send(response,401,{error:'Требуется вход.'});
    try {
      const settings = await trackerSettings(userId);
      const [projects, boards, queues] = await Promise.all([
        trackerGet(settings, '/projects?expand=queues'),
        trackerGet(settings, '/boards'),
        trackerGet(settings, '/queues?perPage=50'),
      ]);
      return send(response,200,{
        queues: Array.isArray(queues) ? queues.map((queue) => ({
          id: queue.key || String(queue.id), key: queue.key || String(queue.id), name: queue.name || queue.display || queue.key || `Очередь ${queue.id}`,
        })) : [],
        projects: Array.isArray(projects) ? projects.map((project) => ({
          id: String(project.id), name: project.name || project.key || `Проект ${project.id}`, key: project.key || '',
        })) : [],
        boards: Array.isArray(boards) ? boards.map((board) => ({
          id: String(board.id), name: board.name || `Доска ${board.id}`,
        })) : [],
      });
    } catch (error) {
      const status = error instanceof TrackerConnectionError ? error.statusCode : 500;
      console.error('Tracker catalog request failed:', error.message);
      return send(response,status,{error:error.message || 'Не удалось получить справочники Tracker.'});
    }
  }
  const sprintMatch = request.method === 'GET' && new URL(request.url, `http://${request.headers.host}`).pathname.match(/^\/api\/tracker\/boards\/([^/]+)\/sprints$/);
  if (sprintMatch) {
    const userId = authenticatedUserId(request);
    if (!userId) return send(response,401,{error:'Требуется вход.'});
    try {
      const settings = await trackerSettings(userId);
      const sprints = await trackerGet(settings, `/boards/${encodeURIComponent(sprintMatch[1])}/sprints`);
      return send(response,200,{sprints: Array.isArray(sprints) ? sprints.filter((sprint) => !sprint.archived).map((sprint) => ({
        id: String(sprint.id), name: sprint.name || `Спринт ${sprint.id}`, status: sprint.status || '',
        startDate: sprint.startDate || '', endDate: sprint.endDate || '',
      })) : []});
    } catch (error) {
      const status = error instanceof TrackerConnectionError ? error.statusCode : 500;
      console.error('Tracker sprints request failed:', error.message);
      return send(response,status,{error:error.message || 'Не удалось получить спринты Tracker.'});
    }
  }
  if (request.method === 'GET' && request.url === '/api/tracker/defaults') {
    const userId = authenticatedUserId(request);
    if (!userId) return send(response,401,{error:'Требуется вход.'});
    if (!pool) return send(response,503,{error:'Для хранения настроек Tracker требуется PostgreSQL.'});
    try {
      const { rows } = await pool.query('SELECT queue_key, project_id, board_id, sprint_id, updated_at FROM tracker_defaults WHERE user_id = $1', [userId]);
      return send(response,200,{defaults: rows[0] || { queue_key:null, project_id:null, board_id:null, sprint_id:null }});
    } catch (error) {
      console.error('Tracker defaults read failed:', error.message);
      return send(response,500,{error:'Не удалось получить настройки по умолчанию.'});
    }
  }
  if (request.method === 'POST' && request.url === '/api/tracker/defaults') {
    const userId = authenticatedUserId(request);
    if (!userId) return send(response,401,{error:'Требуется вход.'});
    if (!pool) return send(response,503,{error:'Для хранения настроек Tracker требуется PostgreSQL.'});
    try {
      const value = await body(request);
      const queueKey = defaultId(value.queueKey);
      const projectId = defaultId(value.projectId);
      const boardId = defaultId(value.boardId);
      const sprintId = defaultId(value.sprintId);
      await pool.query(
        `INSERT INTO tracker_defaults (user_id, queue_key, project_id, board_id, sprint_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE SET
           queue_key = EXCLUDED.queue_key, project_id = EXCLUDED.project_id, board_id = EXCLUDED.board_id, sprint_id = EXCLUDED.sprint_id, updated_at = now()`,
        [userId, queueKey, projectId, boardId, sprintId],
      );
      return send(response,200,{defaults:{queue_key:queueKey,project_id:projectId,board_id:boardId,sprint_id:sprintId}});
    } catch (error) {
      const status = error instanceof TrackerConnectionError ? error.statusCode : 500;
      console.error('Tracker defaults save failed:', error.message);
      return send(response,status,{error:error.message || 'Не удалось сохранить настройки по умолчанию.'});
    }
  }
  if (request.method === 'POST' && request.url === '/api/tracker/issues') {
    const userId = authenticatedUserId(request);
    if (!userId) return send(response,401,{error:'Требуется вход.'});
    try {
      const value = await body(request);
      const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
      const description = typeof value.description === 'string' ? value.description.trim() : '';
      const queueKey = defaultId(value.queueKey);
      const projectId = defaultId(value.projectId);
      const sprintId = defaultId(value.sprintId);
      const start = typeof value.start === 'string' ? value.start : '';
      const deadline = typeof value.deadline === 'string' ? value.deadline : '';
      const priority = typeof value.priority === 'string' ? value.priority : '';
      const unique = typeof value.unique === 'string' ? value.unique.trim() : '';
      if (!summary || summary.length > 255) throw new TrackerConnectionError('Заголовок задачи должен содержать от 1 до 255 символов.', 400);
      if (!queueKey) throw new TrackerConnectionError('Выберите очередь по умолчанию перед созданием задачи.', 400);
      if (description.length > 12000) throw new TrackerConnectionError('Описание задачи слишком длинное.', 400);
      if ((start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) || (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline))) throw new TrackerConnectionError('Дата должна быть в формате ГГГГ-ММ-ДД.', 400);
      if (!['blocker','critical','normal','minor'].includes(priority)) throw new TrackerConnectionError('Выберите корректный приоритет.', 400);
      if (!/^[a-zA-Z0-9_-]{16,128}$/.test(unique)) throw new TrackerConnectionError('Не удалось подготовить уникальный идентификатор задачи. Обновите черновик и повторите попытку.', 400);
      const issue = { summary, queue: queueKey, description, markupType:'md', priority, unique };
      if (start) issue.start = start;
      if (deadline) issue.deadline = deadline;
      if (sprintId) issue.sprint = [sprintId];
      if (projectId) {
        const numericProjectId = Number(projectId);
        if (!Number.isSafeInteger(numericProjectId)) throw new TrackerConnectionError('Некорректный проект по умолчанию. Выберите его заново.', 400);
        issue.project = { primary: numericProjectId };
      }
      const settings = await trackerSettings(userId);
      const trackerIssue = await trackerPost(settings, '/issues', issue);
      const created = Array.isArray(trackerIssue) ? trackerIssue[0] : trackerIssue;
      if (!created?.key) throw new TrackerConnectionError('Tracker не вернул ключ созданной задачи.', 502);
      return send(response,201,{key:created.key,url:`https://tracker.yandex.ru/${encodeURIComponent(created.key)}`});
    } catch (error) {
      const status = error instanceof TrackerConnectionError ? error.statusCode : 500;
      console.error('Tracker issue creation failed:', error.message);
      return send(response,status,{error:error.message || 'Не удалось создать задачу в Tracker.'});
    }
  }
  if (request.method === 'DELETE' && request.url === '/api/tracker/connection') {
    const userId = authenticatedUserId(request);
    if (!userId) return send(response,401,{error:'Требуется вход.'});
    if (!pool) return send(response,503,{error:'Для хранения подключения к Tracker требуется PostgreSQL.'});
    try {
      await pool.query('DELETE FROM tracker_connections WHERE user_id = $1', [userId]);
      return send(response,200,{configured:false});
    } catch (error) {
      console.error('Tracker connection deletion failed:', error.message);
      return send(response,500,{error:'Не удалось удалить подключение к Tracker.'});
    }
  }
  if (request.method === 'POST' && request.url === '/api/drafts/generate') { if (!authenticated(request)) return send(response,401,{error:'Требуется вход.'}); try { const {text, profile}=await body(request); if(typeof text!=='string'||!text.trim()) return send(response,400,{error:'Введите описание задачи.'}); const draft=await generateTaskDraft(text.trim(), profile || {}); return send(response,200,draft); } catch (error) { const status=error instanceof GigaChatError ? error.statusCode : 500; console.error('Draft generation failed:', error.message); return send(response,status,{error:error.message || 'Не удалось сформировать черновик.'}); } }
  if (request.method === 'POST' && request.url === '/api/auth/setup') { const existing=await readAuth(); if(existing) return send(response,409,{error:'Пароль уже установлен.'}); try { const {password}=await body(request); if(typeof password!=='string'||password.length<12) return send(response,400,{error:'Пароль должен содержать не менее 12 символов.'}); const value=await hash(password);const saved=await writeAuth(value);session(response,saved.id);return send(response,201,{ok:true}); } catch (error) { console.error('Auth setup failed:', error); return send(response,400,{error:'Не удалось установить пароль.'}); } }
  if (request.method === 'POST' && request.url === '/api/auth/login') { try { const saved=await readAuth(); if(!saved)return send(response,409,{error:'Сначала установите пароль.'}); const {password}=await body(request);const candidate=await hash(password,saved.salt);if(typeof password!=='string'||!crypto.timingSafeEqual(Buffer.from(candidate.hash),Buffer.from(saved.hash))) return send(response,401,{error:'Неверный пароль.'});session(response,saved.id);return send(response,200,{ok:true}); } catch (error) { console.error('Auth login failed:', error); return send(response,400,{error:'Не удалось выполнить вход.'}); } }
  if (request.method === 'POST' && request.url === '/api/auth/logout') { clearSession(request,response);return send(response,200,{ok:true}); }
  if (request.method === 'GET') return staticFile(request,response);
  return send(response,405,{error:'Метод не поддерживается'});
}).listen(port,host,()=>console.log(`Task Helper слушает http://${host}:${port} (${pool ? 'PostgreSQL' : 'файловое хранилище'})`));
