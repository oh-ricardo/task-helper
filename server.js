const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const stateDir = process.env.DATA_DIR || path.join(root, '.data');
const authFile = path.join(stateDir, 'auth.json');
const sessions = new Map();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const secureCookie = process.env.COOKIE_SECURE === 'true';

function readAuth() { try { return JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return null; } }
function writeAuth(value) { fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(authFile, JSON.stringify(value), { mode: 0o600 }); }
function hash(password, salt = crypto.randomBytes(16).toString('base64url')) { return new Promise((resolve, reject) => crypto.pbkdf2(password, salt, 600000, 64, 'sha512', (err, key) => err ? reject(err) : resolve({ salt, hash: key.toString('base64url') }))); }
function parseCookies(request) { return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map(part => { const i=part.indexOf('='); return [part.slice(0,i).trim(), decodeURIComponent(part.slice(i+1))]; })); }
function authenticated(request) { const sid = parseCookies(request).task_helper_session; const session = sid && sessions.get(sid); return Boolean(session && session.expiresAt > Date.now()); }
function send(response, code, body, headers = {}) { response.writeHead(code, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers }); response.end(JSON.stringify(body)); }
function session(response) { const id=crypto.randomBytes(32).toString('base64url'); sessions.set(id,{expiresAt:Date.now()+8*60*60*1000}); response.setHeader('Set-Cookie', `task_helper_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie?'; Secure':''}`); }
function clearSession(request, response) { const id=parseCookies(request).task_helper_session; if(id) sessions.delete(id); response.setHeader('Set-Cookie', `task_helper_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie?'; Secure':''}`); }
function body(request) { return new Promise((resolve,reject)=>{let raw='';request.on('data',chunk=>{raw+=chunk;if(raw.length>16384)request.destroy();});request.on('end',()=>{try{resolve(JSON.parse(raw||'{}'));}catch{reject(new Error('Некорректный запрос.'));}});request.on('error',reject);}); }
function staticFile(request, response) { const url = new URL(request.url, `http://${request.headers.host}`); const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); if (!/^[a-zA-Z0-9._-]+$/.test(file)) return send(response,404,{error:'Не найдено'}); const full = path.join(root,file); if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(response,404,{error:'Не найдено'}); const type = ({html:'text/html; charset=utf-8',js:'application/javascript; charset=utf-8',css:'text/css; charset=utf-8'})[path.extname(full).slice(1)] || 'application/octet-stream'; response.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff'});fs.createReadStream(full).pipe(response); }

http.createServer(async (request,response)=>{
  if (request.method === 'GET' && request.url === '/api/auth/status') return send(response,200,{authenticated:authenticated(request),needsSetup:!readAuth()});
  if (request.method === 'POST' && request.url === '/api/auth/setup') { const existing=readAuth(); if(existing) return send(response,409,{error:'Пароль уже установлен.'}); try { const {password}=await body(request); if(typeof password!=='string'||password.length<12) return send(response,400,{error:'Пароль должен содержать не менее 12 символов.'}); const value=await hash(password);writeAuth(value);session(response);return send(response,201,{ok:true}); } catch { return send(response,400,{error:'Не удалось установить пароль.'}); } }
  if (request.method === 'POST' && request.url === '/api/auth/login') { const saved=readAuth(); if(!saved)return send(response,409,{error:'Сначала установите пароль.'}); try { const {password}=await body(request);const candidate=await hash(password,saved.salt);if(typeof password!=='string'||!crypto.timingSafeEqual(Buffer.from(candidate.hash),Buffer.from(saved.hash))) return send(response,401,{error:'Неверный пароль.'});session(response);return send(response,200,{ok:true}); } catch { return send(response,400,{error:'Не удалось выполнить вход.'}); } }
  if (request.method === 'POST' && request.url === '/api/auth/logout') { clearSession(request,response);return send(response,200,{ok:true}); }
  if (request.method === 'GET') return staticFile(request,response);
  return send(response,405,{error:'Метод не поддерживается'});
}).listen(port,host,()=>console.log(`Task Helper слушает http://${host}:${port}`));
