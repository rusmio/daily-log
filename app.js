'use strict';

const APP_VERSION = '1.0.0';

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
const DAY_FIELDS = [['sleep', 'Сон'], ['mood', 'Настроение'], ['energy', 'Энергия']];
const CHART_DAYS = 14;
const STORES = ['meals', 'days', 'weights'];
const EXPORT_KEY = 'daily-log:last-export';

const state = { meals: [], days: {}, weights: [] };
let db;
let currentTab = 'today';
let draft = null;

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
function lastDays(n) {
  const now = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  return out;
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

// ---------- storage (IndexedDB) ----------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('daily-log', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('meals', { keyPath: 'id' });
      d.createObjectStore('days', { keyPath: 'date' });
      d.createObjectStore('weights', { keyPath: 'id' });
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
    data.days.forEach((d) => t.objectStore('days').put(d));
    data.weights.forEach((w) => t.objectStore('weights').put(w));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function load() {
  const [meals, days, weights] = await Promise.all(STORES.map(getAll));
  state.meals = meals.sort((a, b) => a.ts - b.ts);
  state.days = Object.fromEntries(days.map((d) => [d.date, d]));
  state.weights = weights.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- views ----------

function render() {
  if (currentTab === 'today') renderToday();
  else if (currentTab === 'trends') renderTrends();
  else renderData();
}

function exportOverdue() {
  if (!state.meals.length) return false;
  const last = Number(lsGet(EXPORT_KEY));
  const since = last || state.meals[0].ts;
  return Date.now() - since > 7 * 864e5;
}

function mealRow(m) {
  const tags = [];
  if (m.mindful) tags.push('осознанно');
  tags.push(...(m.ctx || []));
  if (m.note) tags.push(`«${m.note}»`);
  const after = m.after == null
    ? '<span class="pending">оценить сытость</span>'
    : `сытость <b>${m.after}</b>`;
  return `<button type="button" class="meal" data-act="edit-meal" data-id="${esc(m.id)}">
    <span class="row"><span class="time">${timeStr(new Date(m.ts))}</span>
    <span>голод <b>${m.before}</b> → ${after}</span></span>
    ${tags.length ? `<span class="tags">${esc(tags.join(' · '))}</span>` : ''}
  </button>`;
}

function renderToday() {
  const today = dateKey(new Date());
  $('#subtitle').textContent = humanDate(today);
  const meals = mealsOn(today);
  const rated = meals.filter((m) => m.after != null);
  const stopped = rated.filter((m) => m.after <= 7).length;
  const pending = state.meals.filter((m) => m.after == null && Date.now() - m.ts < 2 * 864e5);
  const day = state.days[today] || {};

  let html = '';
  if (isIos() && !isStandalone()) {
    html += `<div class="card note"><p><b>Установите на экран «Домой»</b>: кнопка «Поделиться» → «На экран „Домой“».</p>
      <p class="muted">Данные во вкладке Safari и в установленном приложении хранятся раздельно, поэтому записывайте только через иконку.</p></div>`;
  }
  if (exportOverdue()) {
    html += `<div class="card note"><p><b>Пора сделать резервную копию.</b> Данные хранятся только в этом телефоне.</p>
      <button type="button" class="secondary" data-act="go-data">Перейти в «Данные»</button></div>`;
  }

  html += '<button type="button" class="primary big" data-act="new-meal">+ Записать приём пищи</button>';

  html += `<div class="tiles">
    <div class="tile"><b>${meals.length}</b><span>приёмов сегодня</span></div>
    <div class="tile"><b>${fmt1(avg(meals.map((m) => m.before)))}</b><span>средний голод до еды</span></div>
    <div class="tile"><b>${rated.length ? `${stopped}/${rated.length}` : '—'}</b><span>остановилась на&nbsp;7 и&nbsp;ниже</span></div>
  </div>`;

  if (pending.length) {
    html += `<div class="card"><h2>Оценить сытость</h2>${pending.map(mealRow).join('')}</div>`;
  }

  const done = meals.filter((m) => m.after != null);
  html += `<div class="card"><h2>Записи за сегодня</h2>${
    done.length ? done.map(mealRow).join('') : '<p class="muted">Пока пусто. Перед едой нажмите большую кнопку и отметьте голод.</p>'
  }</div>`;

  html += `<div class="card"><h2>Как день</h2>${DAY_FIELDS.map(([f, label]) => `
    <div class="rate"><span>${label}</span><div class="opts">${[1, 2, 3, 4, 5].map((v) =>
      `<button type="button" class="opt" data-act="day" data-field="${f}" data-val="${v}" aria-pressed="${day[f] === v}">${v}</button>`).join('')}
    </div></div>`).join('')}
    <p class="hint">1 — очень плохо, 5 — отлично</p></div>`;

  html += `<div class="card"><h2>Спринт 1: наблюдение</h2>
    <p>Ничего не меняем, просто отмечаем голод до еды и сытость после. Цель — хотя бы половина приёмов пищи.</p>
    <p class="muted">Ориентиры: 3–4 — хорошее время поесть, 6–7 — хорошее время остановиться.</p></div>`;

  $('#view-today').innerHTML = html;
}

function dayStats(key) {
  const ms = mealsOn(key);
  const after = ms.filter((m) => m.after != null).map((m) => m.after);
  return {
    key,
    n: ms.length,
    before: avg(ms.map((m) => m.before)),
    after: avg(after),
    mindful: ms.filter((m) => m.mindful).length,
    day: state.days[key] || {},
  };
}

function renderTrends() {
  $('#subtitle').textContent = '';
  const stats = lastDays(CHART_DAYS).map(dayStats);
  const last = state.weights[state.weights.length - 1];
  const first = state.weights[0];

  let html = `<div class="card"><h2>Голод и сытость, ${CHART_DAYS} дней</h2>
    <div class="legend"><span><i style="background:var(--s1)"></i>голод до еды</span><span><i style="background:var(--s2)"></i>сытость после</span></div>
    <div class="chart" id="hunger-chart"></div>
    <p class="hint">Средние за день. Голубая полоса (3–4) — хорошее время поесть, оранжевая (6–7) — хорошее время остановиться. Нажмите на день, чтобы увидеть значения.</p></div>`;

  html += `<div class="card"><h2>Вес</h2>`;
  if (last) {
    const diff = last.kg - first.kg;
    html += `<div class="hero"><b>${fmt1(last.kg)} кг</b><span class="muted">${
      state.weights.length > 1 ? `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${fmt1(Math.abs(diff))} кг с ${shortDate(first.date)}` : 'первая запись'
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

  html += `<div class="card"><h2>По дням</h2><div class="table-wrap"><table>
    <thead><tr><th>День</th><th>Приёмы</th><th>Голод</th><th>Сытость</th><th>Осозн.</th><th>Сон</th><th>Настр.</th><th>Энергия</th></tr></thead>
    <tbody>${stats.slice().reverse().map((s) => `<tr>
      <td>${shortDate(s.key)} ${DOW[parseKey(s.key).getDay()]}</td><td>${s.n || '—'}</td><td>${fmt1(s.before)}</td><td>${fmt1(s.after)}</td>
      <td>${s.n ? s.mindful : '—'}</td><td>${s.day.sleep || '—'}</td><td>${s.day.mood || '—'}</td><td>${s.day.energy || '—'}</td></tr>`).join('')}
    </tbody></table></div></div>`;

  $('#view-trends').innerHTML = html;
  drawCharts();
}

function drawCharts() {
  const hc = $('#hunger-chart');
  if (hc) hungerChart(hc, lastDays(CHART_DAYS).map(dayStats));
  const wc = $('#weight-chart');
  if (wc) weightChart(wc);
}

function renderData() {
  $('#subtitle').textContent = '';
  const last = Number(lsGet(EXPORT_KEY));
  const filledDays = Object.keys(state.days).length;
  $('#view-data').innerHTML = `
    <div class="card"><h2>Что сохранено</h2>
      <p>Приёмов пищи: <b>${state.meals.length}</b> · отметок дня: <b>${filledDays}</b> · взвешиваний: <b>${state.weights.length}</b></p>
      <p class="muted">Последняя резервная копия: ${last ? new Date(last).toLocaleDateString('ru-RU') : 'ещё не было'}</p>
      <p class="muted" id="persist-status"></p>
    </div>
    <div class="card stack"><h2>Резервная копия</h2>
      <button type="button" class="primary" data-act="export-json">Сохранить копию (JSON)</button>
      <button type="button" class="secondary" data-act="export-csv">Выгрузить таблицу (CSV)</button>
      <button type="button" class="secondary" data-act="import">Восстановить из копии</button>
      <p class="hint">JSON — полная копия для восстановления. CSV — таблица приёмов пищи с отметками дня, её удобно открыть в Excel или отправить на разбор.</p>
    </div>
    <div class="card"><h2>Важно</h2>
      <p>Все данные хранятся только в этом телефоне и никуда не отправляются.</p>
      <p class="muted">Если удалить иконку с экрана «Домой», данные удалятся вместе с ней. Делайте копию раз в неделю и сохраняйте её в «Файлы» или в «Избранное» Telegram.</p>
    </div>
    <p class="hint" style="text-align:center">Daily Log ${APP_VERSION}</p>`;

  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then((p) => {
      const el = $('#persist-status');
      if (el) el.textContent = p ? 'Хранилище защищено от автоочистки.' : '';
    }).catch(() => {});
  }
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

function hungerChart(el, stats) {
  const W = el.clientWidth || 320;
  const H = 210;
  const m = { l: 22, r: 8, t: 12, b: 24 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const n = stats.length;
  const x = (i) => m.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (v) => m.t + ih - ((v - 1) / 9) * ih;
  const xs = stats.map((_, i) => x(i));

  let s = '';
  s += `<rect x="${m.l}" y="${y(4)}" width="${iw}" height="${y(3) - y(4)}" fill="var(--band-start)"/>`;
  s += `<rect x="${m.l}" y="${y(7)}" width="${iw}" height="${y(6) - y(7)}" fill="var(--band-stop)"/>`;
  [2, 4, 6, 8, 10].forEach((v) => {
    s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  });
  s += `<line class="base" x1="${m.l}" x2="${W - m.r}" y1="${y(1)}" y2="${y(1)}"/>`;
  stats.forEach((st, i) => {
    if ((n - 1 - i) % 3 === 0) {
      s += `<text x="${xs[i]}" y="${H - 6}" text-anchor="middle">${shortDate(st.key)}</text>`;
    }
  });
  s += `<line class="cross" y1="${m.t}" y2="${y(1)}" x1="0" x2="0"/>`;

  [['before', 'var(--s1)'], ['after', 'var(--s2)']].forEach(([k, color]) => {
    const pts = stats.map((st, i) => (st[k] == null ? null : [xs[i], y(st[k])]));
    s += `<path class="line" stroke="${color}" d="${linePath(pts)}"/>`;
    pts.forEach((p) => { if (p) s += `<circle class="dot" cx="${p[0]}" cy="${p[1]}" r="4" fill="${color}"/>`; });
  });

  const svg = svgEl(W, H);
  svg.setAttribute('aria-label', 'Средний голод до еды и сытость после по дням');
  svg.innerHTML = s;
  el.innerHTML = '';
  el.appendChild(svg);

  attachTip(el, svg, xs, (i) => {
    const st = stats[i];
    if (!st.n) return `<b>${humanDate(st.key)}</b><br>нет записей`;
    return `<b>${humanDate(st.key)}</b> · приёмов: ${st.n}<br>
      <i style="background:var(--s1)"></i>голод до: ${fmt1(st.before)}<br>
      <i style="background:var(--s2)"></i>сытость после: ${fmt1(st.after)}`;
  }, 0);
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
  $('#meal-title').textContent = m ? 'Запись' : 'Новый приём пищи';
  $('[data-act="delete-meal"]').hidden = !m;
  syncSheet();
  $('#meal-dialog').showModal();
  form.scrollTop = 0;
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

// ---------- day & weight ----------

async function setDay(field, val) {
  const key = dateKey(new Date());
  const day = Object.assign({ date: key }, state.days[key]);
  day[field] = day[field] === val ? null : val;
  await put('days', day);
  state.days[key] = day;
  render();
}

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
    version: 1,
    exportedAt: new Date().toISOString(),
    meals: state.meals,
    days: Object.values(state.days),
    weights: state.weights,
  };
  const ok = await shareFile(`daily-log-${dateKey(new Date())}.json`, JSON.stringify(data, null, 1), 'application/json');
  if (ok) {
    lsSet(EXPORT_KEY, String(Date.now()));
    toast('Копия готова');
    render();
  }
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCsv() {
  const head = ['дата', 'время', 'голод_до', 'сытость_после', 'осознанно', 'контекст', 'заметка', 'сон', 'настроение', 'энергия'];
  const rows = state.meals.map((m) => {
    const d = new Date(m.ts);
    const day = state.days[dateKey(d)] || {};
    return [dateKey(d), timeStr(d), m.before, m.after, m.mindful ? 1 : 0, (m.ctx || []).join(', '), m.note, day.sleep, day.mood, day.energy];
  });
  // ";" и BOM — чтобы Excel с русской локалью открыл файл корректно
  const csv = '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\n');
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
    days: data.days.filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date)),
    weights: data.weights.filter((w) => w && w.id && /^\d{4}-\d{2}-\d{2}$/.test(w.date) && Number.isFinite(w.kg)),
  };
  const msg = `Заменить текущие данные копией?\n\nВ копии: приёмов пищи ${clean.meals.length}, отметок дня ${clean.days.length}, взвешиваний ${clean.weights.length}.\nСейчас в телефоне: ${state.meals.length} / ${Object.keys(state.days).length} / ${state.weights.length}.`;
  if (!confirm(msg)) return;
  await replaceAll(clean);
  await load();
  toast('Данные восстановлены');
  render();
}

// ---------- wiring ----------

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${tab}`; });
  $('#title').textContent = { today: 'Сегодня', trends: 'Динамика', data: 'Данные' }[tab];
  render();
  window.scrollTo(0, 0);
}

function onClick(e) {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { switchTab(tabBtn.dataset.tab); return; }

  const dialog = $('#meal-dialog');
  if (e.target === dialog) { dialog.close(); return; }

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act } = el.dataset;
  const run = (p) => Promise.resolve(p).catch((err) => { console.error(err); toast('Ошибка сохранения'); });

  if (act === 'new-meal') openMeal(null);
  else if (act === 'edit-meal') openMeal(el.dataset.id);
  else if (act === 'close-meal') dialog.close();
  else if (act === 'delete-meal') run(deleteMeal());
  else if (act === 'scale') {
    const v = Number(el.dataset.val);
    draft[el.dataset.kind] = draft[el.dataset.kind] === v ? null : v;
    syncSheet();
  } else if (act === 'chip') {
    const v = el.dataset.val;
    if (draft.ctx.has(v)) draft.ctx.delete(v); else draft.ctx.add(v);
    syncSheet();
  } else if (act === 'day') run(setDay(el.dataset.field, Number(el.dataset.val)));
  else if (act === 'del-weight') run(deleteWeight(el.dataset.id));
  else if (act === 'go-data') switchTab('data');
  else if (act === 'export-json') run(exportJson());
  else if (act === 'export-csv') run(exportCsv());
  else if (act === 'import') $('#import-file').click();
}

function init() {
  $('[data-scale="before"]').innerHTML = scaleButtons('before');
  $('[data-scale="after"]').innerHTML = scaleButtons('after');
  $('#ctx-chips').innerHTML = CONTEXTS.map((c) => `<button type="button" class="chip" data-act="chip" data-val="${esc(c)}">${esc(c)}</button>`).join('');

  document.addEventListener('click', onClick);
  $('#meal-form').addEventListener('submit', (e) => saveMeal(e).catch((err) => { console.error(err); toast('Ошибка сохранения'); }));
  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'weight-form') return;
    e.preventDefault();
    saveWeight(e.target).catch((err) => { console.error(err); toast('Ошибка сохранения'); });
  });
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importFile(file).catch((err) => { console.error(err); toast('Не удалось восстановить'); });
  });

  // приложение может долго висеть в фоне — при возврате перерисовываем «сегодня»
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#meal-dialog').open) render(); });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (currentTab === 'trends') drawCharts(); }, 150);
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
