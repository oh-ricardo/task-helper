function buildTaskDraftPrompt({ text, profile, today, normalizedDeadline }) {
  return [
    'Ты формируешь черновик задачи для Яндекс Трекера.',
    'Верни только JSON без Markdown и пояснений.',
    'Схема: {"title":"string","description":"string","deadline":"YYYY-MM-DD или пустая строка","priority":"blocker|critical|normal|minor","assignee":"string или пустая строка","follower":"string или пустая строка","confidence":0..100}.',
    'Не выдумывай факты. Не меняй нормализованный дедлайн, переданный ниже.',
    `Текущая дата в часовом поясе профиля: ${today}.`,
    `Нормализованный дедлайн: ${normalizedDeadline || 'не определён'}.`,
    `Профиль маршрутизации: очередь ${profile.queue || 'не указана'}, доска ${profile.board || 'не указана'}, часовой пояс ${profile.timezone || 'Europe/Moscow'}, приоритет по умолчанию ${profile.defaultPriority || 'normal'}.`,
    `Текст пользователя: ${text}`,
  ].join('\n');
}

module.exports = { buildTaskDraftPrompt };
