const profiles = [
  { id: 'infra', name: 'Инфраструктура', queue: 'INFRA', board: 'Платформа · Канбан', boardId: '42', timezone: 'Europe/Moscow', defaultPriority: 'normal' },
  { id: 'product', name: 'Продукт', queue: 'PRODUCT', board: 'Каталог услуг · Разработка', boardId: '16', timezone: 'Europe/Moscow', defaultPriority: 'normal' }
];
let sprints = [
  { id: 's-41', name: 'Спринт 41', startDate: '2026-09-21', endDate: '2026-10-04', archived: false },
  { id: 's-42', name: 'Спринт 42', startDate: '2026-10-05', endDate: '2026-10-18', archived: false },
  { id: 's-43', name: 'Спринт 43', startDate: '2026-10-19', endDate: '2026-11-01', archived: false }
];
let activeProfile = { ...profiles[0], queue: '', board: 'Не выбрана', boardId: '' };
let trackerCatalog = null;
let trackerSprints = [];
let trackerDefaults = { queueKey: '', projectId: '', boardId: '', sprintId: '' };
let trackerRoutingError = '';
let created = JSON.parse(localStorage.getItem('task-helper-history') || '[]');
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (v='') => v.replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

function iso(date) { return date.toISOString().slice(0, 10); }
function nextWeekday(day) { const now = new Date(); const delta = ((day - now.getDay() + 7) % 7) || 7; now.setDate(now.getDate() + delta); return iso(now); }
function parseDeadline(text) {
  const low = text.toLowerCase();
  if (/до\s+конца\s+недел[ьи]/.test(low)) { const now = new Date(); const delta = (5 - now.getDay() + 7) % 7; now.setDate(now.getDate() + delta); return iso(now); }
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
  return current || trackerSprints.find(s => s.id === trackerDefaults.sprintId) || null;
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
  const requiresQueue = !trackerDefaults.queueKey;
  const needsSetup = requiresSprint || requiresQueue;
  return `<section class="draft-card card">
    <div class="draft-header"><div><p class="eyebrow">Черновик задачи</p><h2>Проверьте данные перед созданием</h2><p>Поля с источником и уверенностью можно изменить.</p></div><span class="${needsSetup?'needs-badge':'ready-badge'}">${needsSetup?'Нужно уточнение':'Готов к созданию'}</span></div>
    <div class="draft-layout"><div>
      <div class="field"><div class="field-label"><label for="draft-title">Заголовок</label><span><i class="source-chip">${d.source}</i> <b class="confidence">${d.confidence}%</b></span></div><input id="draft-title" value="${escapeHtml(d.title)}"></div>
      <div class="field"><div class="field-label"><label for="draft-description">Описание</label><span><i class="source-chip">${d.source}</i></span></div><textarea id="draft-description">${escapeHtml(d.description)}</textarea></div>
      <div class="field-grid"><div class="field"><div class="field-label"><label for="draft-start">Дата начала</label><small>не указана</small></div><input id="draft-start" type="date"></div><div class="field"><div class="field-label"><label for="draft-deadline">Дедлайн</label><span><i class="source-chip">текст</i></span></div><input id="draft-deadline" type="date" value="${d.deadline}"></div></div>
      <div class="field-grid"><div class="field"><div class="field-label"><label for="draft-priority">Приоритет</label><span><i class="source-chip">${d.priority === activeProfile.defaultPriority ? 'профиль' : 'текст'}</i></span></div><select id="draft-priority"><option value="blocker">Блокер</option><option value="critical">Высокий</option><option value="normal">Обычный</option><option value="minor">Низкий</option></select></div><div class="field"><div class="field-label"><label for="draft-assignee">Исполнитель</label><small>${d.assignee ? 'сопоставлено' : 'не указан'}</small></div><input id="draft-assignee" value="${escapeHtml(d.assignee)}" placeholder="Выберите исполнителя"></div></div>
    </div><aside>
      ${requiresQueue ? `<div class="clarification"><strong>Выберите очередь</strong><p>Очередь обязательна для создания задачи. Укажите её в настройках по умолчанию.</p></div>` : ''}
      ${requiresSprint ? `<div class="clarification"><strong>Выберите спринт</strong><p>Выберите доску и спринт в настройках по умолчанию или укажите его в черновике.</p><select id="draft-sprint"><option value="">Выберите спринт</option>${sprints.filter(s=>!s.archived).map(s=>`<option value="${s.id}">${s.name} · ${s.startDate}</option>`).join('')}</select></div>` : ''}
      <div class="summary"><h3>Маршрутизация</h3><div class="summary-item"><span>Очередь</span><b>${activeProfile.queue || 'Требует выбора'}</b></div><div class="summary-item"><span>Доска</span><b>${activeProfile.board}</b></div><div class="summary-item"><span>Спринт</span><b>${d.sprint ? `${d.sprint.name} · ${formatDate(d.sprint.endDate)}` : 'Требует выбора'}</b></div><div class="summary-item"><span>Наблюдатель</span><b>${d.follower || '—'}</b></div></div>
    </aside></div>
    <div class="draft-actions"><button id="reset-button" class="secondary">Изменить описание</button><button id="create-button" class="primary" ${needsSetup?'disabled':''}>Создать в Tracker <span>→</span></button></div>
  </section>`;
}
async function showDraft() {
  const text = $('#source-text').value.trim();
  if (!text) return toast('Введите описание задачи.');
  const button = $('#generate-button'); const label = button.innerHTML; button.disabled = true; button.textContent = 'Формируем черновик…';
  let generated;
  try { generated = await api('/api/drafts/generate', { text, profile: activeProfile }); }
  catch (error) { toast(error.message); return; }
  finally { button.disabled = false; button.innerHTML = label; }
  const draft = { ...generated, sprint: getSprint(text), deadline: generated.deadline || parseDeadline(text), source: 'GigaChat' }; window.currentDraft = draft;
  $('#empty-state').hidden = true; const area = $('#draft-area'); area.hidden = false; area.innerHTML = draftHtml(draft);
  $('#draft-priority').value = draft.priority;
  $('#reset-button').onclick = () => $('#source-text').focus();
  $('#create-button').onclick = createTask;
  const sprintSelect = $('#draft-sprint'); if (sprintSelect) sprintSelect.onchange = () => { if (sprintSelect.value) { draft.sprint = sprints.find(s => s.id === sprintSelect.value); area.innerHTML = draftHtml(draft); $('#draft-priority').value = draft.priority; $('#reset-button').onclick=()=>$('#source-text').focus(); $('#create-button').onclick=createTask; } };
}
async function createTask() {
  const title = $('#draft-title').value.trim(); if (!title) return toast('Укажите заголовок задачи.');
  const button = $('#create-button'); const label = button.innerHTML; button.disabled = true; button.textContent = 'Создаём в Tracker…';
  try {
    const unique = window.currentDraft.unique || (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.random().toString(36).slice(2)}`);
    window.currentDraft.unique = unique;
    const result = await api('/api/tracker/issues', {
      summary: title, description: $('#draft-description').value, queueKey: trackerDefaults.queueKey,
      projectId: trackerDefaults.projectId, sprintId: window.currentDraft.sprint?.id || '',
      start: $('#draft-start').value, deadline: $('#draft-deadline').value, priority: $('#draft-priority').value, unique,
    });
    const task = { key: result.key, url: result.url, title, queue: trackerDefaults.queueKey, createdAt: new Date().toISOString(), deadline: $('#draft-deadline').value, priority: $('#draft-priority').value, sprint: window.currentDraft.sprint?.name };
    created.unshift(task); localStorage.setItem('task-helper-history', JSON.stringify(created)); toast(`Задача ${task.key} создана в Tracker.`); renderHistory();
    document.querySelectorAll('.workflow-step').forEach((e,i)=>{e.classList.toggle('current',i===2);});
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false; button.innerHTML = label;
  }
}
function renderHistory() { const list=$('#history-list'); if(!created.length){list.innerHTML='<div class="empty-state"><div class="empty-icon">◷</div><h2>Пока нет созданных задач</h2><p>Здесь появится история после подтверждения черновика.</p></div>';return;} list.innerHTML=created.map(t=>`<article class="history-item card"><div><h3>${escapeHtml(t.title)}</h3><p>${t.queue} · ${t.sprint || 'спринт не указан'} · ${t.deadline ? 'до '+formatDate(t.deadline) : 'без дедлайна'}</p></div>${t.url?`<a class="key" href="${escapeHtml(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.key)}</a>`:`<span class="key">${escapeHtml(t.key)}</span>`}</article>`).join(''); }
function trackerOption(items, selectedId, placeholder) { return `<option value="">${placeholder}</option>${items.map(item=>`<option value="${escapeHtml(String(item.id))}" ${String(item.id)===String(selectedId)?'selected':''}>${escapeHtml(item.name)}</option>`).join('')}`; }
function renderProfiles() {
  const list = $('#profiles-list');
  if (!trackerCatalog) {
    list.innerHTML = `<section class="settings-card card"><h3>Данные из Tracker</h3><p class="settings-description">${trackerRoutingError ? escapeHtml(trackerRoutingError) : 'Загружаем доступные проекты и доски…'}</p><button id="refresh-tracker-defaults" class="secondary">Обновить</button></section>`;
    $('#refresh-tracker-defaults').onclick = () => loadTrackerRouting(true);
    if (!trackerRoutingError) loadTrackerRouting();
    return;
  }
  const selectedBoard = trackerCatalog.boards.find(board => board.id === trackerDefaults.boardId);
  list.innerHTML = `<section class="settings-card card">
    <div class="settings-heading"><div><h3>Маршрутизация новых задач</h3><p>Справочники загружаются из подключённого Яндекс Трекера.</p></div><button id="refresh-tracker-defaults" class="secondary" type="button">Обновить</button></div>
    <div class="settings-field"><label for="default-queue">Очередь</label><select id="default-queue">${trackerOption(trackerCatalog.queues,trackerDefaults.queueKey,'Выберите очередь по умолчанию')}</select><small>Очередь обязательна для создания задач.</small></div>
    <div class="settings-field"><label for="default-project">Проект</label><select id="default-project">${trackerOption(trackerCatalog.projects,trackerDefaults.projectId,'Не назначать проект по умолчанию')}</select></div>
    <div class="settings-field"><label for="default-board">Доска</label><select id="default-board">${trackerOption(trackerCatalog.boards,trackerDefaults.boardId,'Не назначать доску по умолчанию')}</select></div>
    <div class="settings-field"><label for="default-sprint">Спринт</label><select id="default-sprint" ${selectedBoard?'':'disabled'}>${trackerOption(trackerSprints,trackerDefaults.sprintId,selectedBoard?'Не назначать спринт по умолчанию':'Сначала выберите доску')}</select>${selectedBoard?'<small>Показаны только неархивные спринты выбранной доски.</small>':''}</div>
    <div class="settings-actions"><button id="save-tracker-defaults" class="primary" type="button">Сохранить настройки</button></div>
    <p id="tracker-defaults-error" class="form-error"></p><p id="tracker-defaults-result" class="connection-result" aria-live="polite"></p>
  </section>`;
  $('#refresh-tracker-defaults').onclick = () => loadTrackerRouting(true);
  $('#default-board').onchange = async () => {
    trackerDefaults.boardId = $('#default-board').value;
    trackerDefaults.sprintId = '';
    trackerSprints = [];
    renderProfiles();
    if (trackerDefaults.boardId) await loadTrackerSprints(trackerDefaults.boardId);
  };
  $('#save-tracker-defaults').onclick = saveTrackerDefaults;
}
function applyTrackerDefaults() {
  const board = trackerCatalog?.boards.find(item => item.id === trackerDefaults.boardId);
  const queue = trackerCatalog?.queues.find(item => item.key === trackerDefaults.queueKey);
  if (board || queue) activeProfile = { ...activeProfile, name:'Tracker', queue: queue?.key || '', board: board?.name || 'Не выбрана', boardId: board?.id || '' };
  sprints = trackerSprints;
  $('#profile-name').textContent = activeProfile.name;
  $('#profile-queue').textContent = queue?.key || 'Не выбрана';
  $('#profile-board').textContent = board?.name || 'Не выбрана';
  $('#profile-button').innerHTML = `${activeProfile.name} <span>⌄</span>`;
}
async function loadTrackerSprints(boardId) {
  try {
    const response = await api(`/api/tracker/boards/${encodeURIComponent(boardId)}/sprints`, undefined, 'GET');
    trackerSprints = response.sprints || [];
    applyTrackerDefaults();
    if (!$('#profiles-view').hidden) renderProfiles();
  } catch (error) {
    trackerRoutingError = error.message;
    if (!$('#profiles-view').hidden) renderProfiles();
  }
}
async function loadTrackerRouting(force = false) {
  if (force) { trackerCatalog = null; trackerRoutingError = ''; }
  try {
    const [catalogResponse, defaultsResponse] = await Promise.all([
      api('/api/tracker/catalog', undefined, 'GET'),
      api('/api/tracker/defaults', undefined, 'GET'),
    ]);
    trackerCatalog = catalogResponse;
    const saved = defaultsResponse.defaults || {};
    trackerDefaults = { queueKey: saved.queue_key || '', projectId: saved.project_id || '', boardId: saved.board_id || '', sprintId: saved.sprint_id || '' };
    trackerRoutingError = '';
    if (trackerDefaults.boardId) await loadTrackerSprints(trackerDefaults.boardId);
    else { trackerSprints = []; applyTrackerDefaults(); }
    if (!$('#profiles-view').hidden) renderProfiles();
  } catch (error) {
    trackerCatalog = null;
    trackerRoutingError = error.message;
    if (!$('#profiles-view').hidden) renderProfiles();
  }
}
async function saveTrackerDefaults() {
  const error = $('#tracker-defaults-error'); const result = $('#tracker-defaults-result'); const button = $('#save-tracker-defaults');
  error.textContent = ''; result.textContent = ''; button.disabled = true;
  try {
    trackerDefaults = { queueKey: $('#default-queue').value, projectId: $('#default-project').value, boardId: $('#default-board').value, sprintId: $('#default-sprint').value };
    await api('/api/tracker/defaults', trackerDefaults);
    applyTrackerDefaults();
    result.textContent = 'Настройки по умолчанию сохранены.';
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally { button.disabled = false; }
}
function selectProfile(id) { activeProfile=profiles.find(p=>p.id===id); $('#profile-name').textContent=activeProfile.name; $('#profile-queue').textContent=activeProfile.queue; $('#profile-board').textContent=activeProfile.board; $('#profile-button').innerHTML=`${activeProfile.name} <span>⌄</span>`; renderProfiles(); toast(`Выбран профиль «${activeProfile.name}».`); }
function switchView(view) { ['create','history','profiles','tracker-settings'].forEach(v=>{$(`#${v}-view`).hidden=v!==view;}); $('#page-title').textContent=({create:'Новая задача',history:'Последние задачи',profiles:'Настройки по умолчанию','tracker-settings':'Подключение Tracker'})[view]; document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view)); if(view==='history')renderHistory();if(view==='profiles')renderProfiles();if(view==='tracker-settings')refreshTrackerConnection(true); }
let toastTimer; function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show-toast');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show-toast'),3400);}
async function api(path, body, method = 'POST') { const response = await fetch(path, {method,headers:{'Content-Type':'application/json'},credentials:'same-origin',body:method === 'GET' ? undefined : JSON.stringify(body || {})}); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.'); return data; }
function renderTrackerConnectionStatus(status) {
  const configured = Boolean(status?.configured);
  $('#tracker-status').textContent = configured ? '● Tracker настроен' : '● Tracker не настроен';
  $('#disconnect-tracker-button').hidden = !configured;
}
async function refreshTrackerConnection(showError = false) {
  try {
    const status = await api('/api/tracker/connection', undefined, 'GET');
    renderTrackerConnectionStatus(status);
    return status;
  } catch (error) {
    $('#tracker-status').textContent = '● Tracker недоступен';
    if (showError) $('#tracker-connection-error').textContent = error.message;
    return null;
  }
}
function setupTrackerConnection() {
  const form = $('#tracker-connection-form');
  form.onsubmit = async (event) => {
    event.preventDefault();
    const error = $('#tracker-connection-error');
    $('#tracker-connection-result').textContent = '';
    const submit = form.querySelector('button[type="submit"]');
    error.textContent = '';
    submit.disabled = true;
    try {
      await api('/api/tracker/connection', {
        token: $('#tracker-token').value,
        orgId: $('#tracker-org-id').value,
        orgHeader: $('#tracker-org-header').value,
      });
      $('#tracker-token').value = '';
      $('#tracker-org-id').value = '';
      await refreshTrackerConnection();
      toast('Параметры подключения к Tracker сохранены.');
    } catch (requestError) {
      error.textContent = requestError.message;
    } finally {
      submit.disabled = false;
    }
  };
  $('#test-tracker-button').onclick = async () => {
    const button = $('#test-tracker-button');
    const error = $('#tracker-connection-error');
    const result = $('#tracker-connection-result');
    error.textContent = '';
    result.textContent = '';
    button.disabled = true;
    button.textContent = 'Проверяем…';
    try {
      const status = await api('/api/tracker/connection/test');
      result.textContent = status.accountName ? `Подключение подтверждено: ${status.accountName}.` : 'Подключение подтверждено.';
    } catch (requestError) {
      error.textContent = requestError.message;
    } finally {
      button.disabled = false;
      button.textContent = 'Проверить подключение';
    }
  };
  $('#disconnect-tracker-button').onclick = async () => {
    if (!window.confirm('Удалить сохранённое подключение к Яндекс Трекеру?')) return;
    const error = $('#tracker-connection-error');
    error.textContent = '';
    $('#tracker-connection-result').textContent = '';
    try {
      await api('/api/tracker/connection', undefined, 'DELETE');
      await refreshTrackerConnection();
      toast('Подключение к Tracker удалено.');
    } catch (requestError) {
      error.textContent = requestError.message;
    }
  };
}
async function setupAuth() {
  const gate=$('#auth-gate'), setup=$('#setup-form'), login=$('#login-form');
  try { const state=await fetch('/api/auth/status',{credentials:'same-origin'}).then(r=>r.json()); if(state.authenticated){gate.hidden=true;refreshTrackerConnection();return;} (state.needsSetup?setup:login).hidden=false; }
  catch { login.hidden=false; $('#login-error').textContent='Нет соединения с сервером.'; }
  setup.onsubmit=async(e)=>{e.preventDefault();const password=$('#setup-password').value,confirm=$('#setup-confirm').value;$('#setup-error').textContent='';if(password!==confirm){$('#setup-error').textContent='Пароли не совпадают.';return;}try{await api('/api/auth/setup',{password});gate.hidden=true;refreshTrackerConnection();}catch(err){$('#setup-error').textContent=err.message;}};
  login.onsubmit=async(e)=>{e.preventDefault();$('#login-error').textContent='';try{await api('/api/auth/login',{password:$('#login-password').value});gate.hidden=true;refreshTrackerConnection();}catch(err){$('#login-error').textContent=err.message;}};
}
function init() { $('#source-text').addEventListener('input', e=>$('#char-count').textContent=`${e.target.value.length} / 3000`); $('#generate-button').onclick=()=>showDraft(); document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>switchView(b.dataset.view)); $('#profile-button').onclick=()=>switchView('profiles'); $('#logout-button').onclick=async()=>{try{await api('/api/auth/logout');location.reload();}catch{toast('Не удалось завершить сессию.');}}; renderHistory(); setupTrackerConnection(); setupAuth(); }
init();
