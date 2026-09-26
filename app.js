const profiles = [
  { id: 'infra', name: 'Инфраструктура', queue: 'INFRA', board: 'Платформа · Канбан', boardId: '42', timezone: 'Europe/Moscow', defaultPriority: 'normal' },
  { id: 'product', name: 'Продукт', queue: 'PRODUCT', board: 'Каталог услуг · Разработка', boardId: '16', timezone: 'Europe/Moscow', defaultPriority: 'normal' }
];
const sprints = [
  { id: 's-41', name: 'Спринт 41', startDate: '2026-09-21', endDate: '2026-10-04', archived: false },
  { id: 's-42', name: 'Спринт 42', startDate: '2026-10-05', endDate: '2026-10-18', archived: false },
  { id: 's-43', name: 'Спринт 43', startDate: '2026-10-19', endDate: '2026-11-01', archived: false }
];
let activeProfile = profiles[0];
let created = JSON.parse(localStorage.getItem('task-helper-history') || '[]');
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (v='') => v.replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

function iso(date) { return date.toISOString().slice(0, 10); }
function nextWeekday(day) { const now = new Date(); const delta = ((day - now.getDay() + 7) % 7) || 7; now.setDate(now.getDate() + delta); return iso(now); }
function parseDeadline(text) {
  const low = text.toLowerCase();
  if (/следующ(ую|ей) пятниц/.test(low) || /следующ.*пятниц/.test(low)) return nextWeekday(5);
  if (/к пятниц[еуы]/.test(low)) return nextWeekday(5);
  if (/завтра/.test(low)) { const d = new Date(); d.setDate(d.getDate()+1); return iso(d); }
  if (/сегодня/.test(low)) return iso(new Date());
  const m = low.match(/(?:до|к|deadline)\s*(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?/i);
  if (m) return `${m[3] ? (m[3].length===2?'20'+m[3]:m[3]) : new Date().getFullYear()}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return '';
}
function getSprint(text) {
  const low = text.toLowerCase(), today = iso(new Date());
  const sorted = sprints.filter(s => !s.archived).sort((a,b) => a.startDate.localeCompare(b.startDate));
  const current = sorted.find(s => s.startDate <= today && today <= s.endDate);
  const future = sorted.filter(s => s.startDate > (current?.endDate || today));
  if (/через один\s+спринт/.test(low)) return future[1] || null;
  if (/следующ.*спринт/.test(low)) return future[0] || null;
  if (/текущ.*спринт/.test(low)) return current || null;
  return current || null;
}
function generateDraft(text) {
  const clean = text.trim(); const low = clean.toLowerCase();
  const action = /согласовать/.test(low) ? 'Согласовать' : /проверить/.test(low) ? 'Проверить' : /обсудить/.test(low) ? 'Обсудить' : 'Выполнить';
  let object = clean.replace(/^(нужно|надо|прошу|пожалуйста)\s+/i, '').replace(/,?\s*(желательно|срок|дедлайн|до)\s+.*$/i, '').replace(/[.!]$/, '');
  if (object.length > 82) object = object.slice(0, 79).replace(/\s+\S*$/, '') + '…';
  const title = action === 'Выполнить' ? (object || 'Новая задача') : `${action} ${object.replace(new RegExp('^'+action,'i'),'').trim() || 'задачу'}`;
  const deadline = parseDeadline(clean); const sprint = getSprint(clean);
  const high = /срочно|критич|высок(ий|ая|ий приоритет)/.test(low);
  const priority = high ? 'critical' : activeProfile.defaultPriority;
  const assignee = /инфраструктур/.test(low) ? 'Инфраструктурная команда' : '';
  const andrey = /андре[йя]/.test(low) ? 'Андрей' : '';
  const sections = [
    `Контекст\n${clean}`,
    `Что нужно сделать\n${action} ${object || 'указанную работу'}`,
    `Результат / критерий готовности\nСогласованное решение и понятный следующий шаг.`,
    andrey ? `Участники\n${andrey}` : '',
    deadline ? `Срок\n${deadline}` : ''
  ].filter(Boolean);
  return { title, description: sections.join('\n\n'), deadline, priority, sprint, assignee, follower: andrey, confidence: clean.length > 25 ? 86 : 57, source: 'предложение ИИ' };
}
function formatDate(value) { return value ? new Intl.DateTimeFormat('ru-RU', { day:'numeric', month:'long', year:'numeric' }).format(new Date(value+'T12:00:00')) : 'Не указан'; }
function priorityName(v) { return ({blocker:'Блокер',critical:'Высокий',normal:'Обычный',minor:'Низкий'})[v] || 'Обычный'; }
function draftHtml(d) {
  const requiresSprint = !d.sprint;
  return `<section class="draft-card card">
    <div class="draft-header"><div><p class="eyebrow">Черновик задачи</p><h2>Проверьте данные перед созданием</h2><p>Поля с источником и уверенностью можно изменить.</p></div><span class="${requiresSprint?'needs-badge':'ready-badge'}">${requiresSprint?'Нужно уточнение':'Готов к подтверждению'}</span></div>
    <div class="draft-layout"><div>
      <div class="field"><div class="field-label"><label for="draft-title">Заголовок</label><span><i class="source-chip">${d.source}</i> <b class="confidence">${d.confidence}%</b></span></div><input id="draft-title" value="${escapeHtml(d.title)}"></div>
      <div class="field"><div class="field-label"><label for="draft-description">Описание</label><span><i class="source-chip">${d.source}</i></span></div><textarea id="draft-description">${escapeHtml(d.description)}</textarea></div>
      <div class="field-grid"><div class="field"><div class="field-label"><label for="draft-start">Дата начала</label><small>не указана</small></div><input id="draft-start" type="date"></div><div class="field"><div class="field-label"><label for="draft-deadline">Дедлайн</label><span><i class="source-chip">текст</i></span></div><input id="draft-deadline" type="date" value="${d.deadline}"></div></div>
      <div class="field-grid"><div class="field"><div class="field-label"><label for="draft-priority">Приоритет</label><span><i class="source-chip">${d.priority === activeProfile.defaultPriority ? 'профиль' : 'текст'}</i></span></div><select id="draft-priority"><option value="blocker">Блокер</option><option value="critical">Высокий</option><option value="normal">Обычный</option><option value="minor">Низкий</option></select></div><div class="field"><div class="field-label"><label for="draft-assignee">Исполнитель</label><small>${d.assignee ? 'сопоставлено' : 'не указан'}</small></div><input id="draft-assignee" value="${escapeHtml(d.assignee)}" placeholder="Выберите исполнителя"></div></div>
    </div><aside>
      ${requiresSprint ? `<div class="clarification"><strong>Выберите спринт</strong><p>Спринт — обязательное поле доски. Без него задачу создать нельзя.</p><select id="draft-sprint"><option value="">Выберите спринт</option>${sprints.filter(s=>!s.archived).map(s=>`<option value="${s.id}">${s.name} · ${s.startDate}</option>`).join('')}</select></div>` : ''}
      <div class="summary"><h3>Маршрутизация</h3><div class="summary-item"><span>Очередь</span><b>${activeProfile.queue}</b></div><div class="summary-item"><span>Доска</span><b>${activeProfile.board}</b></div><div class="summary-item"><span>Спринт</span><b>${d.sprint ? `${d.sprint.name} · ${formatDate(d.sprint.endDate)}` : 'Требует выбора'}</b></div><div class="summary-item"><span>Наблюдатель</span><b>${d.follower || '—'}</b></div></div>
    </aside></div>
    <div class="draft-actions"><button id="reset-button" class="secondary">Изменить описание</button><button id="create-button" class="primary" ${requiresSprint?'disabled':''}>Создать задачу <span>→</span></button></div>
  </section>`;
}
function showDraft() {
  const text = $('#source-text').value.trim();
  if (!text) return toast('Введите описание задачи.');
  const draft = generateDraft(text); window.currentDraft = draft;
  $('#empty-state').hidden = true; const area = $('#draft-area'); area.hidden = false; area.innerHTML = draftHtml(draft);
  $('#draft-priority').value = draft.priority;
  $('#reset-button').onclick = () => $('#source-text').focus();
  $('#create-button').onclick = createTask;
  const sprintSelect = $('#draft-sprint'); if (sprintSelect) sprintSelect.onchange = () => { if (sprintSelect.value) { draft.sprint = sprints.find(s => s.id === sprintSelect.value); area.innerHTML = draftHtml(draft); $('#draft-priority').value = draft.priority; $('#reset-button').onclick=()=>$('#source-text').focus(); $('#create-button').onclick=createTask; } };
}
function createTask() {
  const title = $('#draft-title').value.trim(); if (!title) return toast('Укажите заголовок задачи.');
  const task = { key: `${activeProfile.queue}-${100 + created.length + 1}`, title, queue: activeProfile.queue, createdAt: new Date().toISOString(), deadline: $('#draft-deadline').value, priority: $('#draft-priority').value, sprint: window.currentDraft.sprint?.name };
  created.unshift(task); localStorage.setItem('task-helper-history', JSON.stringify(created)); toast(`Задача ${task.key} создана в демонстрационном режиме.`); renderHistory();
  document.querySelectorAll('.workflow-step').forEach((e,i)=>{e.classList.toggle('current',i===2);});
}
function renderHistory() { const list=$('#history-list'); if(!created.length){list.innerHTML='<div class="empty-state"><div class="empty-icon">◷</div><h2>Пока нет созданных задач</h2><p>Здесь появится история после подтверждения черновика.</p></div>';return;} list.innerHTML=created.map(t=>`<article class="history-item card"><div><h3>${escapeHtml(t.title)}</h3><p>${t.queue} · ${t.sprint || 'спринт не указан'} · ${t.deadline ? 'до '+formatDate(t.deadline) : 'без дедлайна'}</p></div><span class="key">${t.key}</span></article>`).join(''); }
function renderProfiles() { $('#profiles-list').innerHTML=profiles.map(p=>`<article class="profile-item card ${p.id===activeProfile.id?'selected':''}" data-profile="${p.id}"><div><h3>${p.name} ${p.id===activeProfile.id?'<span class="ready-badge">По умолчанию</span>':''}</h3><p>Очередь ${p.queue} · обязательная доска: ${p.board}</p></div><div class="profile-meta"><span>${p.timezone}</span><span>›</span></div></article>`).join(''); document.querySelectorAll('[data-profile]').forEach(el=>el.onclick=()=>selectProfile(el.dataset.profile)); }
function selectProfile(id) { activeProfile=profiles.find(p=>p.id===id); $('#profile-name').textContent=activeProfile.name; $('#profile-queue').textContent=activeProfile.queue; $('#profile-board').textContent=activeProfile.board; $('#profile-button').innerHTML=`${activeProfile.name} <span>⌄</span>`; renderProfiles(); toast(`Выбран профиль «${activeProfile.name}».`); }
function switchView(view) { ['create','history','profiles'].forEach(v=>{$(`#${v}-view`).hidden=v!==view;}); $('#page-title').textContent=({create:'Новая задача',history:'Последние задачи',profiles:'Профили маршрутизации'})[view]; document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view)); if(view==='history')renderHistory();if(view==='profiles')renderProfiles(); }
let toastTimer; function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show-toast');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show-toast'),3400);}
async function api(path, body) { const response = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(body || {})}); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.'); return data; }
async function setupAuth() {
  const gate=$('#auth-gate'), setup=$('#setup-form'), login=$('#login-form');
  try { const state=await fetch('/api/auth/status',{credentials:'same-origin'}).then(r=>r.json()); if(state.authenticated){gate.hidden=true;return;} (state.needsSetup?setup:login).hidden=false; }
  catch { login.hidden=false; $('#login-error').textContent='Нет соединения с сервером.'; }
  setup.onsubmit=async(e)=>{e.preventDefault();const password=$('#setup-password').value,confirm=$('#setup-confirm').value;$('#setup-error').textContent='';if(password!==confirm){$('#setup-error').textContent='Пароли не совпадают.';return;}try{await api('/api/auth/setup',{password});gate.hidden=true;}catch(err){$('#setup-error').textContent=err.message;}};
  login.onsubmit=async(e)=>{e.preventDefault();$('#login-error').textContent='';try{await api('/api/auth/login',{password:$('#login-password').value});gate.hidden=true;}catch(err){$('#login-error').textContent=err.message;}};
}
function init() { $('#source-text').addEventListener('input', e=>$('#char-count').textContent=`${e.target.value.length} / 3000`); $('#generate-button').onclick=showDraft; document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>switchView(b.dataset.view)); $('#profile-button').onclick=()=>switchView('profiles'); $('#logout-button').onclick=async()=>{try{await api('/api/auth/logout');location.reload();}catch{toast('Не удалось завершить сессию.');}}; renderHistory(); setupAuth(); }
init();
