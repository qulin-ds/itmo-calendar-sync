// Private project. Enter ITMO_USERNAME and ITMO_PASSWORD in Script Properties.
// Run previewItmo first, then startItmoSync after reviewing the result.
const ITMO = {
  auth: 'https://id.itmo.ru/auth/realms/itmo',
  callback: 'https://my.itmo.ru/login/callback',
  api: 'https://my.itmo.ru/api/schedule/schedule/personal',
  name: 'Учёба ИТМО', days: 28
};

function properties_() { return PropertiesService.getScriptProperties(); }
function query_(obj) {
  return Object.keys(obj).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])).join('&');
}
function response_(url, options) {
  const r = UrlFetchApp.fetch(url, Object.assign({muteHttpExceptions:true, followRedirects:false}, options || {}));
  return r;
}
function header_(r, name) {
  const h = r.getAllHeaders();
  const key = Object.keys(h).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : '';
}
function decodeHtml_(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function loginItmo_() {
  const p = properties_();
  const username = p.getProperty('ITMO_USERNAME');
  const password = p.getProperty('ITMO_PASSWORD');
  if (!username || !password) throw new Error('Добавь ITMO_USERNAME и ITMO_PASSWORD в свойства скрипта.');
  const verifier = Utilities.getUuid().replace(/-/g,'') + Utilities.getUuid().replace(/-/g,'');
  const challenge = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, verifier)).replace(/=+$/,'');
  const state = Utilities.getUuid();
  const params = {client_id:'student-personal-cabinet', redirect_uri:ITMO.callback,
    response_type:'code', scope:'openid', state:state, code_challenge_method:'S256', code_challenge:challenge};
  const page = response_(ITMO.auth + '/protocol/openid-connect/auth?' + query_(params));
  if (page.getResponseCode() !== 200) throw new Error('ИТМО: страница входа недоступна.');
  const html = page.getContentText();
  const match = html.match(/"loginAction"\s*:\s*"([^"]+)"/) || html.match(/<form\b[^>]*\baction=["']([^"']+)["']/i);
  if (!match) throw new Error('ИТМО изменил форму входа. Обновление остановлено.');
  const action = decodeHtml_(match[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/'));
  if (!action.startsWith(ITMO.auth + '/login-actions/')) throw new Error('Неожиданный адрес входа.');
  const rawCookies = header_(page, 'set-cookie');
  const cookies = (Array.isArray(rawCookies) ? rawCookies : [rawCookies]).filter(Boolean).map(c => String(c).split(';')[0]).join('; ');
  const signed = response_(action, {method:'post', payload:{username:username, password:password}, headers:{Cookie:cookies}});
  if (signed.getResponseCode() !== 302 && signed.getResponseCode() !== 303) throw new Error('Вход ИТМО не завершён: проверь данные или дополнительные требования входа.');
  const location = String(header_(signed, 'location'));
  if (!location.startsWith(ITMO.callback + '?')) throw new Error('Неожиданный ответ после входа.');
  const values = {};
  location.split('?')[1].split('&').forEach(part => {
    const at = part.indexOf('=');
    values[decodeURIComponent(part.slice(0,at))] = decodeURIComponent(part.slice(at+1));
  });
  if (!values.code || values.state !== state) throw new Error('Ответ входа не прошёл проверку.');
  const tokenResponse = response_(ITMO.auth + '/protocol/openid-connect/token', {method:'post', payload:{
    grant_type:'authorization_code', client_id:'student-personal-cabinet', redirect_uri:ITMO.callback,
    code:values.code, code_verifier:verifier}});
  if (tokenResponse.getResponseCode() !== 200) throw new Error('ИТМО не выдал доступ к расписанию.');
  let token;
  try { token = JSON.parse(tokenResponse.getContentText()).access_token; }
  catch(e) { throw new Error('Неожиданный формат ответа при входе.'); }
  if (!token) throw new Error('Ответ ИТМО не содержит токен доступа.');
  return token;
}
function window_() {
  const date = Utilities.formatDate(new Date(), 'Europe/Moscow','yyyy-MM-dd');
  const start = new Date(date + 'T00:00:00+03:00');
  const end = new Date(start.getTime() + ITMO.days * 86400000);
  return {start:start, end:end, from:date, through:Utilities.formatDate(new Date(end.getTime()-1),'Europe/Moscow','yyyy-MM-dd')};
}
function normalize_(days, w) {
  if (!Array.isArray(days)) throw new Error('Неожиданный формат расписания.');
  const result = new Map();
  days.forEach(day => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Array.isArray(day.lessons)) throw new Error('Неполный ответ расписания.');
    day.lessons.forEach(l => {
      const validTime = t => /^\d{2}:\d{2}(:\d{2})?$/.test(t || '');
      if (!l.subject || !validTime(l.time_start) || !validTime(l.time_end)) throw new Error('Неполные данные занятия.');
      const start = new Date(day.date + 'T' + l.time_start.slice(0,5) + ':00+03:00');
      const end = new Date(day.date + 'T' + l.time_end.slice(0,5) + ':00+03:00');
      if (!Number.isFinite(+start) || !Number.isFinite(+end) || end <= start) throw new Error('Неверное время занятия.');
      if (start < w.start || start >= w.end) return;
      const teacher = l.teacher_name || l.teacher_fio || '';
      const key = JSON.stringify([day.date,l.time_start,l.subject,l.type || '',l.group || '',teacher]);
      const description = ['Источник: My ITMO', l.type, teacher && 'Преподаватель: ' + teacher,
        l.group && 'Группа: ' + l.group, l.note, l.zoom_url].filter(Boolean).join('\n');
      const item = {key:key,title:l.subject,start:start,end:end,
        location:[l.room,l.building].filter(Boolean).join(', '), description:description};
      const previous = result.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('Неоднозначные занятия: требуется проверка.');
      result.set(key,item);
    });
  });
  // An empty response must never wipe the calendar.
  if (!result.size) throw new Error('Расписание пустое. Календарь оставлен без изменений.');
  return Array.from(result.values());
}
function readItmo_(w) {
  const token = loginItmo_();
  const r = response_(ITMO.api + '?' + query_({date_start:w.from,date_end:w.through}), {headers:{Authorization:'Bearer ' + token}});
  if (r.getResponseCode() !== 200) throw new Error('Ошибка получения расписания: HTTP ' + r.getResponseCode());
  let data;
  try { data = JSON.parse(r.getContentText()); } catch(e) { throw new Error('ИТМО вернул неожиданный ответ.'); }
  return normalize_(data.data,w);
}
function previewItmo() {
  const w = window_();
  const items = readItmo_(w);
  console.log('Занятий на ближайшие 28 дней: ' + items.length);
  items.forEach(i => console.log(Utilities.formatDate(i.start,'Europe/Moscow','dd.MM HH:mm') + ' — ' + i.title + ' | ' + i.location));
  properties_().setProperty('PREVIEW_OK_AT',String(Date.now()));
  console.log('Календарь не изменён. После проверки списка можно запустить startItmoSync.');
}
function startItmoSync() {
  const p = properties_();
  const checked = Number(p.getProperty('PREVIEW_OK_AT'));
  if (!checked || Date.now()-checked > 3600000) throw new Error('Сначала выполни previewItmo и проверь список занятий.');
  syncItmo();
  const exists = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'syncItmo');
  if (!exists) ScriptApp.newTrigger('syncItmo').timeBased().everyHours(1).create();
  console.log('Автообновление раз в час включено.');
}
function syncItmo() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  const p = properties_();
  try {
    const w = window_();
    const items = readItmo_(w); // Fetch and validate EVERYTHING before writing.
    let id = p.getProperty('ITMO_CALENDAR_ID');
    let cal;
    if (id) {
      cal = CalendarApp.getCalendarById(id);
      if (!cal || !cal.isOwnedByMe() || cal.getDescription() !== 'Managed by private ITMO sync v1') throw new Error('Календарь синхронизации недоступен или изменён.');
    } else {
      cal = CalendarApp.createCalendar(ITMO.name,{timeZone:'Europe/Moscow',description:'Managed by private ITMO sync v1'});
      id = cal.getId(); p.setProperty('ITMO_CALENDAR_ID',id);
    }
    const existing = cal.getEvents(w.start,w.end).filter(e => e.getTag('itmo_owner') === 'v1');
    const active = existing.filter(e => !e.getTitle().startsWith('[Отменено] '));
    if (active.length >= 10 && items.length < active.length / 2) throw new Error('Резко уменьшилось число занятий. Требуется ручная проверка, календарь не изменён.');
    const byKey = new Map();
    existing.forEach(e => {
      const key = e.getTag('itmo_key');
      if (byKey.has(key)) throw new Error('Обнаружен дубликат, требуется проверка.');
      byKey.set(key,e);
    });
    const seen = new Set();
    let created = 0, updated = 0, cancelled = 0;
    items.forEach(i => {
      const key = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,i.key)).replace(/=+$/,'');
      seen.add(key);
      let e = byKey.get(key);
      if (!e) {
        e = cal.createEvent(i.title,i.start,i.end,{description:i.description,location:i.location});
        e.setTag('itmo_owner','v1'); e.setTag('itmo_key',key); created++;
      } else if (e.getTitle() !== i.title || +e.getStartTime() !== +i.start || +e.getEndTime() !== +i.end || e.getLocation() !== i.location || e.getDescription() !== i.description) {
        e.setTitle(i.title); e.setTime(i.start,i.end); e.setLocation(i.location); e.setDescription(i.description);
        e.setColor(CalendarApp.EventColor.BLUE); updated++;
      }
      e.deleteTag('itmo_missing_at');
    });
    existing.forEach(e => {
      if (seen.has(e.getTag('itmo_key')) || e.getStartTime() < new Date()) return;
      const absentSince = Number(e.getTag('itmo_missing_at'));
      if (!absentSince) e.setTag('itmo_missing_at',String(Date.now()));
      else if (Date.now()-absentSince >= 30*60000 && !e.getTitle().startsWith('[Отменено] ')) {
        // Keep a recoverable record rather than deleting an event.
        e.setTitle('[Отменено] ' + e.getTitle());
        e.setDescription('Занятие отсутствует в двух проверках My ITMO.\n' + e.getDescription());
        e.removeAllReminders(); e.setColor(CalendarApp.EventColor.GRAY); cancelled++;
      }
    });
    p.setProperty('LAST_SUCCESS',new Date().toISOString());
    p.deleteProperty('LAST_ERROR');
    console.log('Создано: ' + created + '; обновлено: ' + updated + '; отмечено отменёнными: ' + cancelled);
  } catch(e) {
    // Never log a raw HTTP body, cookies, password, or token.
    p.setProperty('LAST_ERROR','Синхронизация остановлена; проверь журнал выполнения.');
    throw e;
  } finally { lock.releaseLock(); }
}
function stopItmoSync() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncItmo').forEach(t => ScriptApp.deleteTrigger(t));
  console.log('Автообновление выключено. Календарь сохранён.');
}
