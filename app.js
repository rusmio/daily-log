'use strict';

const APP_VERSION = '2.0.0';

const SCALE = {
  1: 'истощение, слабость',
  2: 'очень голодна, раздражение',
  3: 'голодна, пора есть',
  4: 'лёгкий голод',
  5: 'нейтрально',
  6: 'приятная сытость',
  7: 'сыта, достаточно',
  8: 'чуть переела',
  9: 'тяжесть',
  10: 'переела, дискомфорт',
};
const CONTEXTS = ['усталость', 'скука', 'стресс', 'награда', 'на ходу', 'за ребёнком', 'за компанией', 'перед экраном'];
const STORES = ['meals', 'notes', 'days', 'focus', 'weights'];
const LS_DEFAULT_WAKE = 'daily-log:default-wake';
const TABLE_DAYS = 30;

const state = { meals: [], notes: [], days: {}, focus: {}, weights: [] };
let db;
let currentTab = 'today';
let draft = null;       // черновик приёма пищи (шкалы, теги)
let noteDraftId = null;
let diaryFilter = 'all';

// ---------- utils ----------

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStr = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const fmt1 = (n) => (n == null ? '—' : n.toFixed(1).replace('.', ','));
const mealDay = (m) => dateKey(new Date(m.ts));
const mealsOn = (key) => state.meals.filter((m) => mealDay(m) === key);

const DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function humanDate(key) {
  const d = parseKey(key);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${DOW[d.getDay()]}`;
}
function shortDate(key) {
  const d = parseKey(key);
  return `${d.getDate()}.${pad(d.getMonth() + 1)}`;
}
// "YYYY-MM-DDTHH:MM" → local Date (не полагаемся на разбор строки браузером)
function parseLocal(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : null;
}
function parseNum(v) {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function lsGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, val); } catch (e) { /* storage unavailable */ }
}

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// ---------- неделя и подъём ----------

// ключ недели — дата её понедельника
function mondayKey(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return dateKey(x);
}
function defaultWakeTime() {
  const v = lsGet(LS_DEFAULT_WAKE);
  return /^\d{2}:\d{2}$/.test(v || '') ? v : '07:00';
}
function defaultWakeDate(base = new Date()) {
  const m = /^(\d{2}):(\d{2})$/.exec(defaultWakeTime());
  return m ? new Date(base.getFullYear(), base.getMonth(), base.getDate(), +m[1], +m[2]) : null;
}

// от чего считать таймер: от последнего приёма, иначе от подъёма (записанного или дефолтного)
function timerState() {
  const today = dateKey(new Date());
  const meals = mealsOn(today);
  const last = meals[meals.length - 1];
  if (last) return { base: last.ts, cap: 'с последнего приёма пищи' };
  const rec = state.days[today];
  if (rec && rec.wake) return { base: rec.wake, cap: 'с подъёма' };
  const d = defaultWakeDate();
  if (d && d.getTime() <= Date.now()) return { base: d.getTime(), cap: 'с подъёма' };
  return null;
}
function fmtPassed(ms) {
  const min = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(min / 60);
  return h ? `${h}:${pad(min % 60)}` : `${min} мин`;
}
function updateTimer() {
  const timeEl = $('#timer-time');
  const capEl = $('#timer-cap');
  if (!timeEl) return;
  const t = timerState();
  timeEl.textContent = t ? fmtPassed(Date.now() - t.base) : '—';
  capEl.textContent = t ? t.cap : 'подъём не записан';
}

// ---------- storage (IndexedDB) ----------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('daily-log', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('meals')) d.createObjectStore('meals', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('days')) d.createObjectStore('days', { keyPath: 'date' });
      if (!d.objectStoreNames.contains('focus')) d.createObjectStore('focus', { keyPath: 'week' });
      if (!d.objectStoreNames.contains('weights')) d.createObjectStore('weights', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
const put = (store, val) => tx(store, 'readwrite', (s) => s.put(val));
const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

function replaceAll(data) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORES, 'readwrite');
    STORES.forEach((s) => t.objectStore(s).clear());
    data.meals.forEach((m) => t.objectStore('meals').put(m));
    data.notes.forEach((n) => t.objectStore('notes').put(n));
    data.days.forEach((d) => t.objectStore('days').put(d));
    (data.focus || []).forEach((f) => t.objectStore('focus').put(f));
    data.weights.forEach((w) => t.objectStore('weights').put(w));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function load() {
  const [meals, notes, days, focus, weights] = await Promise.all(STORES.map(getAll));
  state.meals = meals.sort((a, b) => a.ts - b.ts);
  state.notes = notes.sort((a, b) => a.ts - b.ts);
  state.days = Object.fromEntries(days.map((d) => [d.date, d]));
  state.focus = Object.fromEntries(focus.map((f) => [f.week, f]));
  state.weights = weights.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- views ----------

function render() {
  if (currentTab === 'today') renderToday();
  else if (currentTab === 'diary') renderDiary();
  else if (currentTab === 'dynamics') renderDynamics();
  else renderSettings();
}

function renderToday() {
  const today = dateKey(new Date());
  $('#subtitle').textContent = humanDate(today);
  const meals = mealsOn(today);
  const rated = meals.filter((m) => m.after != null);
  const day = state.days[today] || {};
  const focus = state.focus[mondayKey()];

  let html = '';
  if (isIos() && !isStandalone()) {
    html += `<div class="card note"><p><b>Установите на экран «Домой»</b>: кнопка «Поделиться» → «На экран „Домой“».</p>
      <p class="muted">Данные во вкладке Safari и в установленном приложении хранятся раздельно, поэтому записывайте только через иконку.</p></div>`;
  }

  html += '<div class="card timer" role="timer"><b id="timer-time">—</b><span id="timer-cap"></span></div>';

  html += `<button type="button" class="card asbtn" data-act="open-focus">
    <h2>Фокус недели</h2>
    ${focus && focus.text ? `<p class="focus-text">${esc(focus.text)}</p>` : '<p class="focus-empty">Какой фокус на этой неделе? Нажмите, чтобы записать.</p>'}
  </button>`;

  html += '<button type="button" class="primary big" data-act="new-meal">+ Записать приём пищи</button>';
  html += '<button type="button" class="secondary big" data-act="new-note">+ Запись: эмоции, ощущения</button>';

  const defWake = defaultWakeDate();
  if (day.wake) {
    html += `<button type="button" class="wake" data-act="open-wake">
      <span class="wlabel">Подъём</span>
      <span><b>${timeStr(new Date(day.wake))}</b> <span class="edit">изменить</span></span>
    </button>`;
  } else if (defWake && defWake.getTime() <= Date.now()) {
    html += `<button type="button" class="wake" data-act="open-wake">
      <span class="wlabel">Подъём</span>
      <span><b>${timeStr(defWake)}</b> <span class="def">по умолчанию</span> <span class="edit">изменить</span></span>
    </button>`;
  } else {
    html += `<button type="button" class="wake" data-act="open-wake">
      <span class="wlabel">Подъём</span>
      <span><span class="def">не записан</span> <span class="edit">записать</span></span>
    </button>`;
  }

  html += `<div class="tiles">
    <div class="tile"><b>${meals.length}</b><span>приёмов сегодня</span></div>
    <div class="tile"><b>${fmt1(avg(meals.map((m) => m.before)))}</b><span>средний голод до еды</span></div>
    <div class="tile"><b>${rated.length ? fmt1(avg(rated.map((m) => m.after))) : '—'}</b><span>средняя сытость после еды</span></div>
  </div>`;

  $('#view-today').innerHTML = html;
  updateTimer();
}

function diaryRow(it) {
  const t = timeStr(new Date(it.ts));
  if (it.kind === 'meal') {
    const m = it.ref;
    const tags = [];
    if (m.mindful) tags.push('осознанно');
    tags.push(...(m.ctx || []));
    const after = m.after == null
      ? '<span class="pending">оценить сытость</span>'
      : `сытость <b>${m.after}</b>`;
    const tail = m.note ? ` · «${esc(m.note)}»` : '';
    return `<button type="button" class="entry" data-act="edit-meal" data-id="${esc(m.id)}">
      <span class="row"><span class="time">${t}</span><span>🍽 голод <b>${m.before}</b> → ${after}</span></span>
      ${tags.length ? `<span class="tags">${esc(tags.join(' · '))}${tail}</span>` : m.note ? `<span class="tags">«${esc(m.note)}»</span>` : ''}
    </button>`;
  }
  if (it.kind === 'note') {
    return `<button type="button" class="entry" data-act="edit-note" data-id="${esc(it.ref.id)}">
      <span class="row"><span class="time">${t}</span><span>✎ ${esc(it.ref.text)}</span></span>
    </button>`;
  }
  return `<button type="button" class="entry focus" data-act="goto-focus">
    <span class="row"><span class="time">${t}</span><span>📌 Фокус недели: ${esc(it.ref.text)}</span></span>
  </button>`;
}

function renderDiary() {
  $('#subtitle').textContent = '';
  const items = [];
  if (diaryFilter !== 'notes') state.meals.forEach((m) => items.push({ ts: m.ts, kind: 'meal', ref: m }));
  if (diaryFilter !== 'meals') state.notes.forEach((n) => items.push({ ts: n.ts, kind: 'note', ref: n }));
  if (diaryFilter === 'all') Object.values(state.focus).forEach((f) => items.push({ ts: f.ts, kind: 'focus', ref: f }));

  const groups = new Map();
  items.forEach((it) => {
    const k = dateKey(new Date(it.ts));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  });
  const keys = [...groups.keys()].sort().reverse();
  const today = dateKey(new Date());
  const yd = new Date();
  yd.setDate(yd.getDate() - 1);
  const ykey = dateKey(yd);

  let html = `<div class="chips">${[['all', 'Все'], ['meals', 'Приёмы'], ['notes', 'Записи']].map(([v, l]) =>
    `<button type="button" class="chip" data-act="diary-filter" data-val="${v}" aria-pressed="${diaryFilter === v}">${l}</button>`).join('')}</div>`;

  if (!keys.length) html += '<div class="card"><p class="muted">Пока пусто. Записи появятся здесь.</p></div>';

  keys.forEach((k) => {
    const label = k === today ? `Сегодня, ${humanDate(k)}` : k === ykey ? `Вчера, ${humanDate(k)}` : humanDate(k);
    const rows = groups.get(k).sort((a, b) => a.ts - b.ts).map(diaryRow).join('');
    html += `<div class="day-group" id="day-${k}"><p class="day-head">${label}</p>${rows}</div>`;
  });

  $('#view-diary').innerHTML = html;
}

function dayStats(key) {
  const ms = mealsOn(key);
  const rated = ms.filter((m) => m.after != null);
  return {
    key,
    n: ms.length,
    before: avg(ms.map((m) => m.before)),
    after: rated.length ? avg(rated.map((m) => m.after)) : null,
    mindful: ms.filter((m) => m.mindful).length,
    wake: state.days[key] && state.days[key].wake,
  };
}

function renderDynamics() {
  $('#subtitle').textContent = '';
  const last = state.weights[state.weights.length - 1];
  const first = state.weights[0];

  let html = `<div class="card"><h2>Вес</h2>`;
  if (last) {
    const diff = last.kg - first.kg;
    html += `<div class="hero"><b>${fmt1(last.kg)} кг</b><span class="muted">${
      state.weights.length > 1
        ? diff === 0 ? 'без изменений' : `${diff > 0 ? '+' : '−'}${fmt1(Math.abs(diff))} кг с ${shortDate(first.date)}`
        : 'первая запись'
    }</span></div><div class="chart" id="weight-chart"></div>`;
  } else {
    html += '<p class="muted">Взвешивайтесь раз в неделю, в одно и то же время. Это тренд, а не оценка.</p>';
  }
  html += `<form class="wform" id="weight-form">
      <label class="field"><span>Дата</span><input type="date" name="date" value="${dateKey(new Date())}" required></label>
      <label class="field"><span>Вес, кг</span><input name="kg" inputmode="decimal" placeholder="0,0" required></label>
      <label class="field"><span>Талия, см</span><input name="waist" inputmode="decimal" placeholder="—"></label>
      <button type="submit" class="secondary">Добавить</button>
    </form>`;
  if (state.weights.length) {
    html += `<div class="wlist">${state.weights.slice(-5).reverse().map((w) => `
      <div class="row"><span>${shortDate(w.date)} · <b>${fmt1(w.kg)}</b> кг${w.waist ? ` · талия ${fmt1(w.waist)}` : ''}</span>
      <button type="button" class="ghost danger" data-act="del-weight" data-id="${esc(w.id)}">Удалить</button></div>`).join('')}</div>`;
  }
  html += '</div>';

  const keys = new Set();
  state.meals.forEach((m) => keys.add(mealDay(m)));
  Object.keys(state.days).forEach((k) => { if (state.days[k].wake) keys.add(k); });
  const stats = [...keys].sort().reverse().slice(0, TABLE_DAYS).map(dayStats);

  html += `<div class="card"><h2>По дням</h2><div class="table-wrap"><table>
    <thead><tr><th>День</th><th>Подъём</th><th>Приёмы</th><th>Голод</th><th>Сытость</th><th>Осозн.</th></tr></thead>
    <tbody>${stats.map((s) => `<tr data-act="diary-day" data-day="${s.key}">
      <td>${shortDate(s.key)} ${DOW[parseKey(s.key).getDay()]}</td>
      <td>${s.wake ? timeStr(new Date(s.wake)) : '—'}</td>
      <td>${s.n || '—'}</td>
      <td>${fmt1(s.before)}</td>
      <td>${s.after == null ? '—' : fmt1(s.after)}</td>
      <td>${s.n ? `${s.mindful}/${s.n}` : '—'}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="hint">Тап по строке — открыть день во «Дневнике». Голод и сытость — средние за день.</p></div>`;

  $('#view-dynamics').innerHTML = html;
  const wc = $('#weight-chart');
  if (wc) weightChart(wc);
}

function renderSettings() {
  $('#subtitle').textContent = '';
  $('#view-settings').innerHTML = `
    <div class="card"><h2>Подъём по умолчанию</h2>
      <label class="field"><span>Время</span><input type="time" id="default-wake" value="${esc(defaultWakeTime())}"></label>
      <p class="hint">Используется для таймера, пока сегодняшний подъём не записан.</p>
    </div>
    <div class="card stack"><h2>Резервная копия</h2>
      <button type="button" class="primary" data-act="export-json">Сохранить копию (JSON)</button>
      <button type="button" class="secondary" data-act="export-csv">Выгрузить таблицу (CSV)</button>
      <button type="button" class="secondary" data-act="import">Восстановить из копии</button>
      <p class="hint">JSON — полная копия для восстановления. CSV — таблица для анализа.</p>
    </div>
    <div class="card"><h2>Важно</h2>
      <p>Все данные хранятся только в этом телефоне и никуда не отправляются.</p>
      <p class="muted">Если удалить иконку с экрана «Домой», данные удалятся вместе с ней. Делайте копию раз в неделю и сохраняйте её в «Файлы» или в «Избранное» Telegram.</p>
    </div>
    <p class="hint" style="text-align:center">Daily Log ${APP_VERSION}</p>`;
}

// ---------- charts (inline SVG) ----------

const SVG_NS = 'http://www.w3.org/2000/svg';

function linePath(points) {
  // разрывы в линии там, где нет данных
  let d = '';
  let open = false;
  points.forEach((p) => {
    if (p == null) { open = false; return; }
    d += `${open ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    open = true;
  });
  return d;
}

function attachTip(el, svg, xs, contentFn, top) {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  el.appendChild(tip);
  const cross = svg.querySelector('.cross');
  let active = -1;

  function show(i) {
    if (i === active) return;
    active = i;
    const html = contentFn(i);
    if (!html) { hide(); return; }
    tip.innerHTML = html;
    tip.hidden = false;
    const x = xs[i];
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.style.display = '';
    const w = tip.offsetWidth;
    const left = Math.min(Math.max(x - w / 2, 0), el.clientWidth - w);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  function hide() {
    active = -1;
    tip.hidden = true;
    cross.style.display = 'none';
  }
  function pick(e) {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    let best = 0;
    xs.forEach((x, i) => { if (Math.abs(x - px) < Math.abs(xs[best] - px)) best = i; });
    show(best);
  }
  svg.addEventListener('pointerdown', pick);
  svg.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') pick(e); });
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  hide();
}

function svgEl(W, H) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  svg.setAttribute('role', 'img');
  return svg;
}

function weightChart(el) {
  const ws = state.weights;
  const W = el.clientWidth || 320;
  const H = 170;
  const m = { l: 34, r: 10, t: 10, b: 24 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const ts = ws.map((w) => parseKey(w.date).getTime());
  const t0 = ts[0];
  const t1 = ts[ts.length - 1];
  const kgs = ws.map((w) => w.kg);
  let lo = Math.min(...kgs);
  let hi = Math.max(...kgs);
  const range = Math.max(hi - lo, 1);
  const step = range <= 2 ? 0.5 : range <= 5 ? 1 : range <= 10 ? 2 : 5;
  lo = Math.floor((lo - step / 2) / step) * step;
  hi = Math.ceil((hi + step / 2) / step) * step;

  const x = (t) => m.l + (t1 === t0 ? iw / 2 : ((t - t0) / (t1 - t0)) * iw);
  const y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
  const xs = ts.map(x);

  let s = '';
  for (let v = lo; v <= hi + 1e-9; v += step) {
    s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmt1(v).replace(',0', '')}</text>`;
  }
  s += `<line class="base" x1="${m.l}" x2="${W - m.r}" y1="${y(lo)}" y2="${y(lo)}"/>`;
  s += `<text x="${xs[0]}" y="${H - 6}" text-anchor="${ws.length > 1 ? 'start' : 'middle'}">${shortDate(ws[0].date)}</text>`;
  if (ws.length > 1) s += `<text x="${xs[xs.length - 1]}" y="${H - 6}" text-anchor="end">${shortDate(ws[ws.length - 1].date)}</text>`;
  s += `<line class="cross" y1="${m.t}" y2="${y(lo)}" x1="0" x2="0"/>`;
  s += `<path class="line" stroke="var(--s1)" d="${linePath(ws.map((w, i) => [xs[i], y(w.kg)]))}"/>`;
  ws.forEach((w, i) => { s += `<circle class="dot" cx="${xs[i]}" cy="${y(w.kg)}" r="4" fill="var(--s1)"/>`; });

  const svg = svgEl(W, H);
  svg.setAttribute('aria-label', 'Вес по датам');
  svg.innerHTML = s;
  el.innerHTML = '';
  el.appendChild(svg);

  attachTip(el, svg, xs, (i) => {
    const w = ws[i];
    return `<b>${humanDate(w.date)}</b><br>${fmt1(w.kg)} кг${w.waist ? ` · талия ${fmt1(w.waist)} см` : ''}`;
  }, 0);
}

// ---------- meal sheet ----------

function scaleButtons(kind) {
  return Array.from({ length: 10 }, (_, i) => i + 1)
    .map((v) => `<button type="button" class="opt" data-act="scale" data-kind="${kind}" data-val="${v}" aria-label="${v}: ${SCALE[v]}">${v}</button>`)
    .join('');
}

function syncSheet() {
  const form = $('#meal-form');
  ['before', 'after'].forEach((kind) => {
    form.querySelectorAll(`[data-kind="${kind}"]`).forEach((b) => b.setAttribute('aria-pressed', String(draft[kind] === Number(b.dataset.val))));
    $(`#${kind}-label`).textContent = draft[kind] ? `${draft[kind]} — ${SCALE[draft[kind]]}` : '';
  });
  form.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(draft.ctx.has(c.dataset.val))));
}

function openMeal(id) {
  const m = id ? state.meals.find((x) => x.id === id) : null;
  draft = {
    id: m ? m.id : null,
    before: m ? m.before : null,
    after: m ? m.after : null,
    ctx: new Set(m ? m.ctx || [] : []),
  };
  const form = $('#meal-form');
  const d = m ? new Date(m.ts) : new Date();
  form.ts.value = `${dateKey(d)}T${timeStr(d)}`;
  form.mindful.checked = m ? !!m.mindful : false;
  form.note.value = m ? m.note || '' : '';
  $('#meal-title').textContent = m ? 'Приём пищи' : 'Новый приём пищи';
  $('[data-act="delete-meal"]').hidden = !m;
  syncSheet();
  $('#meal-dialog').showModal();
  $('#meal-dialog').scrollTop = 0;
}

async function saveMeal(e) {
  e.preventDefault();
  const form = $('#meal-form');
  if (!draft.before) { toast('Отметьте голод до еды'); return; }
  const d = parseLocal(form.ts.value);
  if (!d) { toast('Укажите время'); return; }
  const meal = {
    id: draft.id || uid(),
    ts: d.getTime(),
    before: draft.before,
    after: draft.after,
    mindful: form.mindful.checked,
    ctx: [...draft.ctx],
    note: form.note.value.trim(),
  };
  await put('meals', meal);
  state.meals = state.meals.filter((x) => x.id !== meal.id).concat(meal).sort((a, b) => a.ts - b.ts);
  $('#meal-dialog').close();
  toast(meal.after == null ? 'Сохранено. Сытость можно оценить позже' : 'Сохранено');
  render();
}

async function deleteMeal() {
  if (!draft.id || !confirm('Удалить эту запись?')) return;
  await del('meals', draft.id);
  state.meals = state.meals.filter((x) => x.id !== draft.id);
  $('#meal-dialog').close();
  toast('Удалено');
  render();
}

// ---------- note sheet ----------

function openNote(id) {
  const n = id ? state.notes.find((x) => x.id === id) : null;
  noteDraftId = n ? n.id : null;
  const form = $('#note-form');
  const d = n ? new Date(n.ts) : new Date();
  form.ts.value = `${dateKey(d)}T${timeStr(d)}`;
  form.text.value = n ? n.text : '';
  $('#note-title').textContent = n ? 'Запись' : 'Новая запись';
  $('[data-act="delete-note"]').hidden = !n;
  $('#note-dialog').showModal();
  $('#note-dialog').scrollTop = 0;
}

async function saveNote(e) {
  e.preventDefault();
  const form = $('#note-form');
  const d = parseLocal(form.ts.value);
  const text = form.text.value.trim();
  if (!d) { toast('Укажите время'); return; }
  if (!text) { toast('Введите текст'); return; }
  const note = { id: noteDraftId || uid(), ts: d.getTime(), text };
  await put('notes', note);
  state.notes = state.notes.filter((x) => x.id !== note.id).concat(note).sort((a, b) => a.ts - b.ts);
  $('#note-dialog').close();
  toast('Сохранено');
  render();
}

async function deleteNote() {
  if (!noteDraftId || !confirm('Удалить эту запись?')) return;
  await del('notes', noteDraftId);
  state.notes = state.notes.filter((x) => x.id !== noteDraftId);
  $('#note-dialog').close();
  toast('Удалено');
  render();
}

// ---------- wake & focus ----------

function openWake() {
  const form = $('#wake-form');
  const today = dateKey(new Date());
  const rec = state.days[today];
  let d;
  if (rec && rec.wake) d = new Date(rec.wake);
  else {
    d = defaultWakeDate();
    if (!d || d.getTime() > Date.now()) d = new Date();
  }
  form.ts.value = `${dateKey(d)}T${timeStr(d)}`;
  $('#wake-dialog').showModal();
}

async function saveWake(e) {
  e.preventDefault();
  const form = $('#wake-form');
  const d = parseLocal(form.ts.value);
  if (!d) { toast('Укажите время'); return; }
  const key = dateKey(d);
  const day = Object.assign({}, state.days[key], { date: key, wake: d.getTime() });
  await put('days', day);
  state.days[key] = day;
  $('#wake-dialog').close();
  toast('Подъём записан');
  render();
}

function openFocus() {
  const f = state.focus[mondayKey()];
  $('#focus-form').text.value = f && f.text ? f.text : '';
  $('#focus-dialog').showModal();
}

async function saveFocus(e) {
  e.preventDefault();
  const text = $('#focus-form').text.value.trim();
  if (!text) { toast('Введите фокус'); return; }
  const rec = { week: mondayKey(), ts: Date.now(), text };
  await put('focus', rec);
  state.focus[rec.week] = rec;
  $('#focus-dialog').close();
  toast('Фокус сохранён');
  render();
}

function gotoDiaryDay(key) {
  switchTab('diary');
  setTimeout(() => {
    const el = document.getElementById(`day-${key}`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, 60);
}

// ---------- weight ----------

async function saveWeight(form) {
  const kg = parseNum(form.kg.value);
  const waist = parseNum(form.waist.value);
  if (!kg || kg < 20 || kg > 400) { toast('Проверьте вес'); return; }
  const w = { id: uid(), date: form.date.value || dateKey(new Date()), kg, waist: waist || null };
  await put('weights', w);
  state.weights = state.weights.concat(w).sort((a, b) => a.date.localeCompare(b.date));
  toast('Вес записан');
  render();
}

async function deleteWeight(id) {
  if (!confirm('Удалить это взвешивание?')) return;
  await del('weights', id);
  state.weights = state.weights.filter((w) => w.id !== id);
  render();
}

// ---------- export / import ----------

async function shareFile(name, text, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return true;
}

async function exportJson() {
  const data = {
    app: 'daily-log',
    version: 2,
    exportedAt: new Date().toISOString(),
    meals: state.meals,
    notes: state.notes,
    days: Object.values(state.days),
    focus: Object.values(state.focus),
    weights: state.weights,
  };
  const ok = await shareFile(`daily-log-${dateKey(new Date())}.json`, JSON.stringify(data, null, 1), 'application/json');
  if (ok) {
    toast('Копия готова');
    render();
  }
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCsv() {
  const head = ['дата', 'время', 'тип', 'голод_до', 'сытость_после', 'осознанно', 'контекст', 'текст', 'кг', 'талия'];
  const rows = [];
  Object.values(state.days).forEach((d) => {
    if (d.wake) rows.push([d.date, timeStr(new Date(d.wake)), 'подъём', '', '', '', '', '', '', '']);
  });
  state.meals.forEach((m) => {
    const d = new Date(m.ts);
    rows.push([dateKey(d), timeStr(d), 'приём', m.before, m.after == null ? '' : m.after, m.mindful ? 1 : 0, (m.ctx || []).join(', '), m.note || '', '', '']);
  });
  state.notes.forEach((n) => {
    const d = new Date(n.ts);
    rows.push([dateKey(d), timeStr(d), 'запись', '', '', '', '', n.text, '', '']);
  });
  Object.values(state.focus).forEach((f) => {
    const d = new Date(f.ts);
    rows.push([dateKey(d), timeStr(d), 'фокус', '', '', '', '', f.text, '', '']);
  });
  state.weights.forEach((w) => {
    rows.push([w.date, '', 'вес', '', '', '', '', '', fmt1(w.kg), w.waist ? fmt1(w.waist) : '']);
  });
  rows.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  // ";" и BOM — чтобы Excel с русской локалью открыл файл корректно
  const csv = '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\n'); // '﻿' = BOM для Excel
  await shareFile(`daily-log-${dateKey(new Date())}.csv`, csv, 'text/csv');
}

function validBackup(data) {
  return data && data.app === 'daily-log' && Array.isArray(data.meals) && Array.isArray(data.days) && Array.isArray(data.weights);
}

async function importFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    toast('Не удалось прочитать файл');
    return;
  }
  if (!validBackup(data)) { toast('Это не копия Daily Log'); return; }
  const clean = {
    meals: data.meals.filter((m) => m && m.id && Number.isFinite(m.ts) && m.before >= 1 && m.before <= 10),
    notes: (data.notes || []).filter((n) => n && n.id && Number.isFinite(n.ts) && typeof n.text === 'string'),
    days: data.days
      .filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
      .map((d) => (Number.isFinite(d.wake) ? d : Object.assign({}, d, { wake: undefined }))),
    focus: (data.focus || []).filter((f) => f && /^\d{4}-\d{2}-\d{2}$/.test(f.week) && typeof f.text === 'string'),
    weights: data.weights.filter((w) => w && w.id && /^\d{4}-\d{2}-\d{2}$/.test(w.date) && Number.isFinite(w.kg)),
  };
  const msg = `Заменить текущие данные копией?\n\nВ копии: приёмов пищи ${clean.meals.length}, записей ${clean.notes.length}, дней с данными ${clean.days.length}, взвешиваний ${clean.weights.length}.`;
  if (!confirm(msg)) return;
  await replaceAll(clean);
  await load();
  toast('Данные восстановлены');
  render();
}

// ---------- wiring ----------

const TITLES = { today: 'Сегодня', diary: 'Дневник', dynamics: 'Динамика', settings: 'Настройки' };

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${tab}`; });
  $('#title').textContent = TITLES[tab];
  render();
  window.scrollTo(0, 0);
}

function onClick(e) {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { switchTab(tabBtn.dataset.tab); return; }

  if (e.target.tagName === 'DIALOG') { e.target.close(); return; }

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act } = el.dataset;
  const run = (p) => Promise.resolve(p).catch((err) => { console.error(err); toast('Ошибка сохранения'); });

  if (act === 'new-meal') openMeal(null);
  else if (act === 'edit-meal') openMeal(el.dataset.id);
  else if (act === 'close-meal') $('#meal-dialog').close();
  else if (act === 'delete-meal') run(deleteMeal());
  else if (act === 'scale') {
    const v = Number(el.dataset.val);
    draft[el.dataset.kind] = draft[el.dataset.kind] === v ? null : v;
    syncSheet();
  } else if (act === 'chip') {
    const v = el.dataset.val;
    if (draft.ctx.has(v)) draft.ctx.delete(v); else draft.ctx.add(v);
    syncSheet();
  } else if (act === 'new-note') openNote(null);
  else if (act === 'edit-note') openNote(el.dataset.id);
  else if (act === 'close-note') $('#note-dialog').close();
  else if (act === 'delete-note') run(deleteNote());
  else if (act === 'open-wake') openWake();
  else if (act === 'close-wake') $('#wake-dialog').close();
  else if (act === 'open-focus') openFocus();
  else if (act === 'goto-focus') { switchTab('today'); openFocus(); }
  else if (act === 'close-focus') $('#focus-dialog').close();
  else if (act === 'diary-filter') { diaryFilter = el.dataset.val; render(); }
  else if (act === 'diary-day') gotoDiaryDay(el.dataset.day);
  else if (act === 'del-weight') run(deleteWeight(el.dataset.id));
  else if (act === 'export-json') run(exportJson());
  else if (act === 'export-csv') run(exportCsv());
  else if (act === 'import') $('#import-file').click();
}

function init() {
  $('[data-scale="before"]').innerHTML = scaleButtons('before');
  $('[data-scale="after"]').innerHTML = scaleButtons('after');
  $('#ctx-chips').innerHTML = CONTEXTS.map((c) => `<button type="button" class="chip" data-act="chip" data-val="${esc(c)}">${esc(c)}</button>`).join('');

  document.addEventListener('click', onClick);

  const catchSave = (fn) => (e) => fn(e).catch((err) => { console.error(err); toast('Ошибка сохранения'); });
  $('#meal-form').addEventListener('submit', catchSave(saveMeal));
  $('#note-form').addEventListener('submit', catchSave(saveNote));
  $('#wake-form').addEventListener('submit', catchSave(saveWake));
  $('#focus-form').addEventListener('submit', catchSave(saveFocus));

  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'weight-form') return;
    e.preventDefault();
    saveWeight(e.target).catch((err) => { console.error(err); toast('Ошибка сохранения'); });
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'default-wake' && e.target.value) {
      lsSet(LS_DEFAULT_WAKE, e.target.value);
      toast('Сохранено');
    }
  });

  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importFile(file).catch((err) => { console.error(err); toast('Не удалось восстановить'); });
  });

  // таймер на «Сегодня» идёт сам; приложение может долго висеть в фоне —
  // при возврате перерисовываем текущую вкладку
  setInterval(() => { if (currentTab === 'today') updateTimer(); }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ![...document.querySelectorAll('dialog')].some((d) => d.open)) render();
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (currentTab === 'dynamics') { const wc = $('#weight-chart'); if (wc) weightChart(wc); } }, 150);
  });
}

async function start() {
  init();
  try {
    db = await openDb();
    await load();
  } catch (err) {
    console.error(err);
    $('#view-today').innerHTML = '<div class="card"><p>Не удалось открыть хранилище. Возможно, включён режим «Частный доступ» в Safari.</p></div>';
    return;
  }
  render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();
