'use strict';

/* ---------- storage ---------- */

const STORAGE_KEY = 'espresso-shot-log-v1';

const TASTE_ATTRS = [
  { key: 'acidity',    label: 'Acidity',    low: 'flat',    high: 'sour' },
  { key: 'sweetness',  label: 'Sweetness',  low: 'none',    high: 'very sweet' },
  { key: 'bitterness', label: 'Bitterness', low: 'none',    high: 'harsh' },
  { key: 'body',       label: 'Body',       low: 'watery',  high: 'syrupy' },
  { key: 'aftertaste', label: 'Aftertaste', low: 'short',   high: 'long & clean' },
];

const DEFAULT_FLAVORS = [
  'chocolate', 'caramel', 'nutty', 'fruity', 'berry', 'citrus', 'stone fruit',
  'floral', 'honey', 'spicy', 'earthy', 'smoky', 'astringent', 'burnt', 'grassy',
];

const emptyState = () => ({
  beans: [],
  shots: [],
  recipes: [],
  settings: { machine: '', grinder: '', defaultDose: 18, defaultRatio: 2, targetMin: 25, targetMax: 32, updatedAt: '' },
  customFlavors: [],
  // tombstones for deleted beans/shots: { id: deletedAt }, so deletions sync too
  deleted: {},
});

const nowIso = () => new Date().toISOString();
const touch = (obj) => { obj.updatedAt = nowIso(); return obj; };

// Fill in defaults and give legacy records an updatedAt so they can be merged.
function normalize(data) {
  const base = emptyState();
  const withStamp = (r) => ({ ...r, updatedAt: r.updatedAt || r.createdAt || '1970-01-01T00:00:00.000Z' });
  return {
    ...base,
    ...data,
    beans: (data.beans || []).map(withStamp),
    shots: (data.shots || []).map(withStamp),
    recipes: (data.recipes || []).map(withStamp),
    settings: { ...base.settings, ...data.settings },
    customFlavors: data.customFlavors || [],
    deleted: data.deleted || {},
  };
}

// Last-write-wins merge per record; must match merge() in server.py.
function mergeStates(a, b) {
  const deleted = { ...a.deleted };
  for (const [id, t] of Object.entries(b.deleted || {})) {
    if (!deleted[id] || t > deleted[id]) deleted[id] = t;
  }
  const mergeList = (x = [], y = []) => {
    const byId = new Map();
    for (const r of [...x, ...y]) {
      const cur = byId.get(r.id);
      if (!cur || (r.updatedAt || '') > (cur.updatedAt || '')) byId.set(r.id, r);
    }
    return [...byId.values()].filter((r) => {
      const t = deleted[r.id];
      if (t && t >= (r.updatedAt || '')) return false;
      if (t) delete deleted[r.id]; // edited after deletion: record wins
      return true;
    });
  };
  const beans = mergeList(a.beans, b.beans);
  const shots = mergeList(a.shots, b.shots);
  const recipes = mergeList(a.recipes, b.recipes);
  const settings = (b.settings?.updatedAt || '') > (a.settings?.updatedAt || '') ? b.settings : a.settings;
  const customFlavors = [...new Set([...(a.customFlavors || []), ...(b.customFlavors || [])])];
  return { ...a, beans, shots, recipes, settings, customFlavors, deleted };
}

function markDeleted(id) {
  state.deleted[id] = nowIso();
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : emptyState();
  } catch (e) {
    console.error('Could not load data', e);
    return emptyState();
  }
}

function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('Could not save — storage unavailable');
  }
}

function save() {
  saveLocal();
  scheduleSync();
}

/* ---------- sync ---------- */

const SYNC_KEY = 'espresso-shot-log-sync';
let syncCfg = loadSyncCfg();
let syncing = false;
let syncAgain = false;
let syncTimer = null;
let syncState = { status: 'off', message: '' };

function loadSyncCfg() {
  try {
    return { url: '', token: '', lastSync: null, ...JSON.parse(localStorage.getItem(SYNC_KEY) || '{}') };
  } catch {
    return { url: '', token: '', lastSync: null };
  }
}

function saveSyncCfg() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg)); } catch { /* ignore */ }
}

const syncEnabled = () => !!syncCfg.token;

function apiUrl(path) {
  const base = (syncCfg.url || '').trim().replace(/\/+$/, '');
  return base ? base + path : new URL('.' + path, location.href).href;
}

function scheduleSync(delay = 1200) {
  if (!syncEnabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

async function sync() {
  if (!syncEnabled()) return false;
  if (syncing) { syncAgain = true; return false; }
  syncing = true;
  setSyncStatus('syncing');
  let ok = false;
  try {
    if (!navigator.onLine) throw Object.assign(new Error('Offline — will sync when back online'), { offline: true });
    const res = await fetch(apiUrl('/api/sync'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + syncCfg.token },
      body: JSON.stringify({ beans: state.beans, shots: state.shots, recipes: state.recipes, settings: state.settings,
        customFlavors: state.customFlavors, deleted: state.deleted }),
    });
    if (res.status === 401) throw new Error('Sync token rejected by server');
    if (!res.ok) throw new Error('Server error ' + res.status);
    const remote = normalize(await res.json());
    // merge again in case something changed locally while the request was in flight
    state = mergeStates(state, remote);
    saveLocal();
    syncCfg.lastSync = nowIso();
    saveSyncCfg();
    setSyncStatus('ok');
    refreshAfterSync();
    ok = true;
  } catch (e) {
    setSyncStatus(e.offline ? 'offline' : 'error', e.offline ? e.message : (e.message || 'Could not reach server'));
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(200); }
  }
  return ok;
}

function setSyncStatus(status, message = '') {
  syncState = { status, message };
  const el = $('#sync-status');
  if (!el) return;
  const labels = { off: '', syncing: 'Syncing…', ok: 'Synced', offline: 'Offline', error: 'Sync error' };
  el.textContent = labels[status];
  el.className = 'sync-status ' + status;
  el.title = message || (syncCfg.lastSync ? 'Last sync: ' + fmtDate(syncCfg.lastSync) : '');
  el.hidden = status === 'off';
  renderSyncInfo();
}

function refreshAfterSync() {
  renderHeader();
  const active = $('.view.active')?.id;
  if (active === 'view-shots') renderShots();
  if (active === 'view-beans') renderBeans();
  if (active === 'view-recipes' && poForm.hidden) renderRecipes();
  if (active === 'view-new') renderRecipePicker();
  if (active === 'view-new' && !shotForm.id.value) {
    // only refresh the bean picker; keep whatever the user is typing
    const cur = shotForm.beanId.value;
    $('#no-beans-hint').hidden = fillBeanSelect(shotForm.beanId) > 0;
    if (cur) shotForm.beanId.value = cur;
  }
}

window.addEventListener('online', () => scheduleSync(200));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { scheduleSync(200); refreshPower(); }
});

/* ---------- helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 1) => (n == null ? '–' : (+n).toFixed(d).replace(/\.0+$/, ''));
const ratio = (dose, out) => (dose && out ? out / dose : null);
const beanById = (id) => state.beans.find((b) => b.id === id);

function toLocalInput(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function fmtDate(iso, withTime = true) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) +
    (withTime ? ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function stars(n) {
  let s = '';
  for (let i = 1; i <= 5; i++) s += i <= n ? '★' : '<span class="off">★</span>';
  return `<span class="stars-static" aria-label="${n} of 5">${s}</span>`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- navigation ---------- */

function show(view) {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  if (view === 'shots') renderShots();
  if (view === 'beans') renderBeans();
  if (view === 'new' && !$('#shot-form [name=id]').value) resetShotForm();
  if (view === 'settings') { fillSettings(); fillSyncForm(); }
  if (view === 'machine') { renderPower(); refreshPower(); }
  if (view === 'recipes') renderRecipes();
  if (view !== 'brew' && typeof pauseBrew === 'function') pauseBrew();
  window.scrollTo({ top: 0 });
}

$$('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-goto]');
  if (link) { e.preventDefault(); show(link.dataset.goto); }
});

/* ---------- shot form ---------- */

const shotForm = $('#shot-form');
let currentRating = 0;
let selectedFlavors = new Set();

function buildTasteSliders() {
  $('#taste-sliders').innerHTML = TASTE_ATTRS.map((a) => `
    <div>
      <div class="slider-row" title="${a.low} → ${a.high}">
        <span>${a.label}</span>
        <input type="range" min="0" max="5" step="1" value="0" name="taste-${a.key}" aria-label="${a.label}">
        <span class="val" data-val="${a.key}">0</span>
      </div>
    </div>`).join('');
  $$('#taste-sliders input').forEach((inp) => inp.addEventListener('input', () => {
    $(`[data-val="${inp.name.slice(6)}"]`).textContent = inp.value;
    updateDialIn();
  }));
}

function renderFlavorTags() {
  const all = [...new Set([...DEFAULT_FLAVORS, ...state.customFlavors, ...selectedFlavors])];
  $('#flavor-tags').innerHTML = all.map((f) =>
    `<button type="button" class="tag ${selectedFlavors.has(f) ? 'on' : ''}" data-flavor="${esc(f)}">${esc(f)}</button>`).join('');
}

$('#flavor-tags').addEventListener('click', (e) => {
  const t = e.target.closest('[data-flavor]');
  if (!t) return;
  const f = t.dataset.flavor;
  selectedFlavors.has(f) ? selectedFlavors.delete(f) : selectedFlavors.add(f);
  t.classList.toggle('on');
});

$('#custom-flavor').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const f = e.target.value.trim().toLowerCase();
  if (!f) return;
  if (!DEFAULT_FLAVORS.includes(f) && !state.customFlavors.includes(f)) {
    state.customFlavors.push(f);
    save();
  }
  selectedFlavors.add(f);
  e.target.value = '';
  renderFlavorTags();
});

function renderRatingInput() {
  $('#rating-input').innerHTML = [1, 2, 3, 4, 5].map((i) =>
    `<button type="button" role="radio" aria-checked="${i === currentRating}" aria-label="${i} stars" data-r="${i}" class="${i <= currentRating ? 'on' : ''}">★</button>`).join('');
}
$('#rating-input').addEventListener('click', (e) => {
  const b = e.target.closest('[data-r]');
  if (!b) return;
  const r = +b.dataset.r;
  currentRating = currentRating === r ? 0 : r;
  renderRatingInput();
});

function fillBeanSelect(select, includeArchivedId) {
  const beans = state.beans.filter((b) => !b.archived || b.id === includeArchivedId);
  select.innerHTML = beans.map((b) =>
    `<option value="${b.id}">${esc(b.name)}${b.roaster ? ' — ' + esc(b.roaster) : ''}</option>`).join('');
  return beans.length;
}

function updateRatio() {
  const r = ratio(num(shotForm.dose.value), num(shotForm.yield.value));
  $('#ratio-out').textContent = r ? '1 : ' + r.toFixed(2) : '–';
}

shotForm.dose.addEventListener('input', () => { updateRatio(); updateDialIn(); });
shotForm.yield.addEventListener('input', () => { updateRatio(); updateDialIn(); });
shotForm.time.addEventListener('input', updateDialIn);
shotForm.beanId.addEventListener('change', () => {
  if (!shotForm.id.value) prefillFromLastShot(shotForm.beanId.value);
  renderRecipePicker();
});

function prefillFromLastShot(beanId) {
  const last = state.shots
    .filter((s) => s.beanId === beanId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const st = state.settings;
  $('#recipe-loaded').hidden = true;
  shotForm.time.placeholder = '28';
  const startRecipe = !last && recipeById(beanById(beanId)?.recipeId);
  if (startRecipe) {
    applyRecipe(startRecipe);
  } else if (last) {
    shotForm.grind.value = last.grind ?? '';
    shotForm.dose.value = last.dose ?? '';
    shotForm.temp.value = last.temp ?? '';
    shotForm.preinfusion.value = last.preinfusion ?? '';
    shotForm.basket.value = last.basket ?? '';
    shotForm.yield.value = '';
    shotForm.yield.placeholder = last.yield ?? '';
  } else {
    shotForm.grind.value = '';
    shotForm.dose.value = st.defaultDose ?? '';
    shotForm.yield.value = '';
    shotForm.yield.placeholder = st.defaultDose && st.defaultRatio ? fmt(st.defaultDose * st.defaultRatio) : '36';
  }
  updateRatio();
}

function resetShotForm(template) {
  shotForm.reset();
  $('#recipe-loaded').hidden = true;
  shotForm.time.placeholder = '28';
  stopTimer(true);
  shotForm.id.value = '';
  $('#shot-form-title').textContent = 'New shot';
  $('#shot-delete').hidden = true;
  const n = fillBeanSelect(shotForm.beanId);
  $('#no-beans-hint').hidden = n > 0;
  shotForm.createdAt.value = toLocalInput(new Date());
  selectedFlavors = new Set();
  currentRating = 0;
  currentCompass = null;

  if (template) {
    setShotFields(template);
    shotForm.id.value = '';
    shotForm.createdAt.value = toLocalInput(new Date());
    $('#shot-form-title').textContent = 'New shot (based on previous)';
  } else {
    const lastBean = [...state.shots].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.beanId;
    if (lastBean && beanById(lastBean) && !beanById(lastBean).archived) shotForm.beanId.value = lastBean;
    if (shotForm.beanId.value) prefillFromLastShot(shotForm.beanId.value);
    TASTE_ATTRS.forEach((a) => { $(`[data-val="${a.key}"]`).textContent = '0'; });
  }
  renderFlavorTags();
  renderRatingInput();
  renderCompassInput();
  renderRecipePicker();
  updateRatio();
  updateDialIn();
}

function setShotFields(s) {
  fillBeanSelect(shotForm.beanId, s.beanId);
  shotForm.id.value = s.id;
  shotForm.beanId.value = s.beanId;
  shotForm.createdAt.value = toLocalInput(s.createdAt);
  ['grind', 'dose', 'yield', 'time', 'temp', 'preinfusion', 'basket', 'notes']
    .forEach((k) => { shotForm[k].value = s[k] ?? ''; });
  TASTE_ATTRS.forEach((a) => {
    const v = s.taste?.[a.key] ?? 0;
    shotForm['taste-' + a.key].value = v;
    $(`[data-val="${a.key}"]`).textContent = v;
  });
  selectedFlavors = new Set(s.flavors || []);
  currentCompass = s.compass || null;
  currentRating = s.rating || 0;
}

function editShot(id) {
  const s = state.shots.find((x) => x.id === id);
  if (!s) return;
  show('new');
  resetShotForm();
  setShotFields(s);
  $('#shot-form-title').textContent = 'Edit shot';
  $('#shot-delete').hidden = false;
  $('#shot-delete').dataset.id = s.id;
  renderFlavorTags();
  renderRatingInput();
  renderCompassInput();
  renderRecipePicker();
  updateRatio();
  updateDialIn();
}

function repeatShot(id) {
  const s = state.shots.find((x) => x.id === id);
  if (!s) return;
  show('new');
  resetShotForm({ ...s, notes: '', taste: {}, flavors: [], rating: 0, compass: null, time: '', yield: s.yield });
}

shotForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!shotForm.beanId.value) { toast('Add beans first'); return; }
  const id = shotForm.id.value || uid();
  const taste = {};
  TASTE_ATTRS.forEach((a) => { taste[a.key] = +shotForm['taste-' + a.key].value; });
  const shot = {
    id,
    beanId: shotForm.beanId.value,
    createdAt: new Date(shotForm.createdAt.value).toISOString(),
    grind: shotForm.grind.value.trim(),
    dose: num(shotForm.dose.value),
    yield: num(shotForm.yield.value),
    time: num(shotForm.time.value),
    temp: num(shotForm.temp.value),
    preinfusion: num(shotForm.preinfusion.value),
    basket: shotForm.basket.value.trim(),
    taste,
    flavors: [...selectedFlavors],
    rating: currentRating,
    compass: currentCompass,
    notes: shotForm.notes.value.trim(),
    updatedAt: nowIso(),
  };
  const idx = state.shots.findIndex((s) => s.id === id);
  if (idx >= 0) state.shots[idx] = shot; else state.shots.push(shot);
  save();
  shotForm.id.value = '';
  toast(idx >= 0 ? 'Shot updated' : 'Shot saved');
  show('shots');
});

$('#shot-cancel').addEventListener('click', () => { shotForm.id.value = ''; show('shots'); });

/* ---------- barista compass ---------- */

// Barista Hustle's coffee compass: x = extraction (-1 sour/under … +1 bitter/over),
// y = strength (-1 weak … +1 strong). The centre is the balanced sweet spot.
const COMPASS_ZONE = 0.25;
const COMPASS_ADVICE = {
  '0,0':   ['Balanced', 'Right in the sweet spot — keep this recipe.'],
  '-1,0':  ['Sour', 'Under-extracted → grind <b>finer</b>.'],
  '1,0':   ['Bitter', 'Over-extracted → grind <b>coarser</b>.'],
  '0,1':   ['Too strong', 'Too intense → <b>increase the yield</b> (longer ratio).'],
  '0,-1':  ['Too weak', 'Thin / watery → <b>decrease the yield</b> (shorter ratio).'],
  '-1,1':  ['Sour & strong', '<b>Increase the yield</b> — extracts more and dilutes.'],
  '-1,-1': ['Sour & weak', 'Grind <b>finer</b> — raises extraction and strength.'],
  '1,1':   ['Bitter & strong', 'Grind <b>coarser</b> — lowers extraction and strength.'],
  '1,-1':  ['Bitter & weak', '<b>Decrease the yield</b> — less extraction, more strength.'],
};

function compassAdvice(c) {
  if (!c) return null;
  const band = (v) => (v < -COMPASS_ZONE ? -1 : v > COMPASS_ZONE ? 1 : 0);
  const [label, tip] = COMPASS_ADVICE[`${band(c.x)},${band(c.y)}`];
  return { label, tip };
}

// plot area: 30..210 in a 240×240 viewBox
const C_MID = 120;
const C_HALF = 90;
const cx = (x) => C_MID + x * C_HALF;
const cy = (y) => C_MID - y * C_HALF;

function compassSvg({ point = null, trail = [], interactive = false, size = '' } = {}) {
  const r0 = COMPASS_ZONE * C_HALF;
  let marks = '';

  if (trail.length) {
    const pts = trail.map((t) => `${cx(t.compass.x)},${cy(t.compass.y)}`).join(' ');
    if (trail.length > 1) marks += `<polyline class="c-trail" points="${pts}"/>`;
    trail.forEach((t, i) => {
      const last = i === trail.length - 1;
      marks += `<circle class="${last ? 'c-point' : 'c-dot'}" cx="${cx(t.compass.x)}" cy="${cy(t.compass.y)}" r="${last ? 7 : 5}">
        <title>${esc(t.title)}</title></circle>`;
    });
  }

  if (point) {
    const px = cx(point.x), py = cy(point.y);
    const dx = C_MID - px, dy = C_MID - py;
    const dist = Math.hypot(dx, dy);
    // arrow from the shot towards the sweet spot, stopping at its edge
    if (dist > r0 + 12) {
      const ux = dx / dist, uy = dy / dist;
      const sx = px + ux * 12, sy = py + uy * 12;
      const ex = C_MID - ux * (r0 + 3), ey = C_MID - uy * (r0 + 3);
      marks += `<line class="c-arrow" x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" marker-end="url(#c-head)"/>`;
    }
    marks += `<circle class="c-point" cx="${px}" cy="${py}" r="8"/>`;
  }

  return `
  <svg class="compass ${interactive ? 'interactive' : ''} ${size}" viewBox="0 0 240 240" role="img"
       aria-label="Barista compass: extraction from sour to bitter, strength from weak to strong">
    <defs>
      <marker id="c-head" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" class="c-arrow-head"/>
      </marker>
    </defs>
    <rect class="c-bg" x="30" y="30" width="180" height="180" rx="12"/>
    <line class="c-axis" x1="30" y1="120" x2="210" y2="120"/>
    <line class="c-axis" x1="120" y1="30" x2="120" y2="210"/>
    <circle class="c-zone" cx="120" cy="120" r="${r0}"/>
    <text class="c-label" x="120" y="20" text-anchor="middle">Strong</text>
    <text class="c-label" x="120" y="230" text-anchor="middle">Weak</text>
    <text class="c-label" x="16" y="120" text-anchor="middle" transform="rotate(-90 16 120)">Sour · under</text>
    <text class="c-label" x="224" y="120" text-anchor="middle" transform="rotate(90 224 120)">Bitter · over</text>
    ${marks}
  </svg>`;
}

function compassAdviceHtml(c) {
  const a = compassAdvice(c);
  if (!a) return '<span class="hint-inline">Tap where this shot landed.</span>';
  return `<b>${a.label}:</b> ${a.tip}`;
}

let currentCompass = null;

function renderCompassInput() {
  $('#compass-pad').innerHTML = compassSvg({ point: currentCompass, interactive: true });
  $('#compass-advice').innerHTML = compassAdviceHtml(currentCompass);
  $('#compass-clear').hidden = !currentCompass;
}

function setCompassFromEvent(e) {
  const svg = $('#compass-pad svg');
  const rect = svg.getBoundingClientRect();
  const scale = 240 / rect.width;
  const vx = (e.clientX - rect.left) * scale;
  const vy = (e.clientY - rect.top) * scale;
  const clamp = (v) => Math.max(-1, Math.min(1, Math.round(v * 20) / 20));
  currentCompass = { x: clamp((vx - C_MID) / C_HALF), y: clamp((C_MID - vy) / C_HALF) };
  renderCompassInput();
  updateDialIn();
}

function setupCompassInput() {
  const pad = $('#compass-pad');
  let dragging = false;
  pad.addEventListener('pointerdown', (e) => {
    dragging = true;
    pad.setPointerCapture(e.pointerId);
    setCompassFromEvent(e);
  });
  pad.addEventListener('pointermove', (e) => { if (dragging) setCompassFromEvent(e); });
  pad.addEventListener('pointerup', () => { dragging = false; });
  pad.addEventListener('pointercancel', () => { dragging = false; });
  pad.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: [-0.1, 0], ArrowRight: [0.1, 0], ArrowUp: [0, 0.1], ArrowDown: [0, -0.1] }[e.key];
    if (!step) return;
    e.preventDefault();
    const c = currentCompass || { x: 0, y: 0 };
    const clamp = (v) => Math.max(-1, Math.min(1, Math.round(v * 20) / 20));
    currentCompass = { x: clamp(c.x + step[0]), y: clamp(c.y + step[1]) };
    renderCompassInput();
    updateDialIn();
  });
  $('#compass-clear').addEventListener('click', () => {
    currentCompass = null;
    renderCompassInput();
    updateDialIn();
  });
}

// chronological path of the last shots of one bean that have a compass reading
function compassTrail(beanId, limit = 8) {
  return state.shots
    .filter((s) => s.beanId === beanId && s.compass)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-limit)
    .map((s) => ({
      compass: s.compass,
      title: `${fmtDate(s.createdAt)} — grind ${s.grind || '–'}, ${fmt(s.dose)} → ${fmt(s.yield)} g, ${fmt(s.time, 0)} s` +
        `${s.rating ? `, ${s.rating}★` : ''} (${compassAdvice(s.compass).label})`,
    }));
}

/* ---------- dial-in suggestions ---------- */

function dialInAdvice({ time, dose, yield: out, taste, compass }) {
  const tips = [];
  const { targetMin = 25, targetMax = 32 } = state.settings;
  const r = ratio(dose, out);
  const sour = taste?.acidity >= 4;
  const bitter = taste?.bitterness >= 4;
  const thin = taste?.body != null && taste.body > 0 && taste.body <= 1;

  if (time != null && time > 0) {
    if (time < targetMin) tips.push(`Ran fast (${time} s, target ${targetMin}–${targetMax} s) → grind <b>finer</b>.`);
    else if (time > targetMax) tips.push(`Ran slow (${time} s, target ${targetMin}–${targetMax} s) → grind <b>coarser</b>.`);
  }
  const c = compassAdvice(compass);
  if (c) {
    tips.push(`Compass — ${c.label.toLowerCase()}: ${c.tip}`);
    return tips;
  }
  if (sour && bitter) tips.push('Sour <i>and</i> bitter usually means channeling → check puck prep / distribution.');
  else if (sour) tips.push('Sour / sharp → under-extracted: grind finer, raise temp, or pull a longer ratio.');
  else if (bitter) tips.push('Bitter / harsh → over-extracted: grind coarser, lower temp, or pull a shorter ratio.');
  if (thin && r && r > 2.2) tips.push('Thin body → try a shorter ratio (less yield).');
  return tips;
}

function updateDialIn() {
  const taste = {};
  TASTE_ATTRS.forEach((a) => { taste[a.key] = +shotForm['taste-' + a.key].value; });
  const tips = dialInAdvice({
    compass: currentCompass,
    time: num(shotForm.time.value),
    dose: num(shotForm.dose.value),
    yield: num(shotForm.yield.value),
    taste,
  }).filter((t) => !t.startsWith('Compass')); // shown under the compass already
  const box = $('#dial-in');
  box.hidden = tips.length === 0;
  box.innerHTML = '<b>Dial-in tip</b><ul>' + tips.map((t) => `<li>${t}</li>`).join('') + '</ul>';
}

/* ---------- shot timer ---------- */

let timerStart = null;
let timerRaf = null;

function tick() {
  const s = (performance.now() - timerStart) / 1000;
  $('#timer-btn').textContent = '■ ' + s.toFixed(1) + ' s';
  timerRaf = requestAnimationFrame(tick);
}

function stopTimer(reset) {
  cancelAnimationFrame(timerRaf);
  if (timerStart != null && !reset) {
    const s = Math.round((performance.now() - timerStart) / 1000);
    shotForm.time.value = s;
    updateDialIn();
  }
  timerStart = null;
  $('#timer-btn').textContent = '▶ Timer';
}

$('#timer-btn').addEventListener('click', () => {
  if (timerStart == null) {
    timerStart = performance.now();
    tick();
  } else {
    stopTimer(false);
  }
});

/* ---------- shot list ---------- */

function renderShotFilters() {
  const sel = $('#filter-bean');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All beans</option>' + state.beans.map((b) =>
    `<option value="${b.id}">${esc(b.name)}${b.archived ? ' (finished)' : ''}</option>`).join('');
  sel.value = state.beans.some((b) => b.id === cur) ? cur : '';
}

function profileMeters(taste) {
  return '<div class="profile">' + TASTE_ATTRS.map((a) => {
    const v = taste?.[a.key] ?? 0;
    return `<div class="meter"><span>${a.label}</span><div class="meter-bar"><i style="width:${v * 20}%"></i></div><b>${v}</b></div>`;
  }).join('') + '</div>';
}

function recipeLine(s) {
  const { targetMin, targetMax } = state.settings;
  const timeCls = s.time == null ? '' : (s.time >= targetMin && s.time <= targetMax ? 'time-ok' : 'time-off');
  return `<span class="recipe">${esc(s.grind || '–')}<i>·</i>${fmt(s.dose)} → ${fmt(s.yield)} g<i>·</i><span class="${timeCls}">${fmt(s.time, 0)} s</span></span>`;
}

function shotCard(s) {
  const bean = beanById(s.beanId);
  const r = ratio(s.dose, s.yield);
  const age = bean?.roastDate ? daysBetween(bean.roastDate, s.createdAt) : null;
  const hasTaste = s.taste && Object.values(s.taste).some((v) => v > 0);
  // the compass advice is shown next to the compass itself
  const tips = dialInAdvice(s).filter((t) => !t.startsWith('Compass'));
  const details = [
    ['Grind', esc(s.grind || '–')],
    ['Dose', fmt(s.dose) + ' g'],
    ['Yield', fmt(s.yield) + ' g'],
    ['Ratio', r ? '1 : ' + r.toFixed(1) : '–'],
    ['Time', fmt(s.time, 0) + ' s'],
    s.temp != null && ['Temp', fmt(s.temp) + ' °C'],
    s.preinfusion && ['Pre-infusion', fmt(s.preinfusion, 0) + ' s'],
    s.basket && ['Basket', esc(s.basket)],
  ].filter(Boolean);
  return `
  <details class="item shot">
    <summary>
      <div class="item-head">
        <span class="item-title">${esc(bean?.name ?? 'Unknown beans')}</span>
        ${s.rating ? stars(s.rating) : ''}
      </div>
      ${recipeLine(s)}
      <div class="item-sub">${fmtDate(s.createdAt)}${age != null && age >= 0 ? ` · ${age} d off roast` : ''}</div>
    </summary>
    <div class="shot-body">
      <dl class="kv">${details.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
      ${s.compass ? `<div class="compass-detail">${compassSvg({ point: s.compass, size: 'small' })}<p>${compassAdviceHtml(s.compass)}</p></div>` : ''}
      ${hasTaste ? profileMeters(s.taste) : ''}
      ${s.flavors?.length ? `<p class="flavors">${s.flavors.map(esc).join(', ')}</p>` : ''}
      ${s.notes ? `<p class="shot-notes">${esc(s.notes)}</p>` : ''}
      ${tips.length ? `<div class="dial-in"><b>Next time</b><ul>${tips.map((t) => `<li>${t}</li>`).join('')}</ul></div>` : ''}
      <div class="item-actions">
        <button class="secondary small" data-act="repeat" data-id="${s.id}">↻ Pull again</button>
        <button class="secondary small" data-act="edit" data-id="${s.id}">Edit</button>
        ${state.recipes.some((r) => r.fromShotId === s.id)
          ? '<span class="saved-note">✓ Saved as recipe</span>'
          : `<button class="link small" data-act="save-recipe" data-id="${s.id}">Save as recipe</button>`}
      </div>
    </div>
  </details>`;
}

function beanSummary(beanId) {
  const bean = beanById(beanId);
  const shots = state.shots.filter((s) => s.beanId === beanId);
  if (!bean || !shots.length) return '';
  const rated = shots.filter((s) => s.rating);
  const best = [...rated].sort((a, b) => b.rating - a.rating || b.createdAt.localeCompare(a.createdAt))[0];
  const avg = rated.length ? rated.reduce((t, s) => t + s.rating, 0) / rated.length : null;
  const trail = compassTrail(beanId);
  return `
  <div class="card summary">
    <div class="item-sub">${shots.length} shot${shots.length === 1 ? '' : 's'}${avg ? ` · ${avg.toFixed(1)} ★ average` : ''}</div>
    ${best ? `
      <div class="field-label">Best recipe so far</div>
      <div class="summary-row">
        ${recipeLine(best)}
        <button class="secondary small" data-act="repeat" data-id="${best.id}">↻ Pull again</button>
      </div>` : ''}
    ${trail.length ? `
      <div class="field-label">Dial-in path <span class="hint-inline">last ${trail.length} shot${trail.length === 1 ? '' : 's'} · newest is the large dot</span></div>
      ${compassSvg({ trail, size: 'medium' })}` : ''}
  </div>`;
}

function renderShots() {
  renderShotFilters();
  const beanId = $('#filter-bean').value;
  const sort = $('#sort-shots').value;
  let shots = state.shots.filter((s) => !beanId || s.beanId === beanId);
  shots.sort((a, b) => {
    if (sort === 'old') return a.createdAt.localeCompare(b.createdAt);
    if (sort === 'rating') return (b.rating || 0) - (a.rating || 0) || b.createdAt.localeCompare(a.createdAt);
    return b.createdAt.localeCompare(a.createdAt);
  });
  $('#bean-summary').innerHTML = beanId ? beanSummary(beanId) : '';
  $('#shot-list').innerHTML = shots.length
    ? shots.map(shotCard).join('')
    : `<div class="empty">${state.shots.length ? 'No shots match these filters.' :
        state.beans.length ? 'No shots yet. <a href="#" data-goto="new">Log your first shot →</a>' :
        'Start by adding the beans you are using. <a href="#" data-goto="beans">Add beans →</a>'}</div>`;
}

['#filter-bean', '#sort-shots'].forEach((s) => $(s).addEventListener('change', renderShots));

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const { act, id } = b.dataset;
  if (act === 'edit') editShot(id);
  if (act === 'repeat') repeatShot(id);
  if (act === 'del-shot' && confirm('Delete this shot?')) {
    state.shots = state.shots.filter((s) => s.id !== id);
    markDeleted(id);
    save(); shotForm.id.value = ''; show('shots'); toast('Shot deleted');
  }
  if (act === 'edit-bean') editBean(id);
  if (act === 'archive-bean') {
    const bean = beanById(id);
    bean.archived = !bean.archived;
    touch(bean);
    save(); renderBeans();
  }
  if (act === 'shots-of-bean') {
    show('shots');
    $('#filter-bean').value = id;
    renderShots();
  }
  if (act === 'del-bean') {
    const count = state.shots.filter((s) => s.beanId === id).length;
    if (!confirm(count ? `Delete these beans and their ${count} shot(s)?` : 'Delete these beans?')) return;
    markDeleted(id);
    state.shots.filter((s) => s.beanId === id).forEach((s) => markDeleted(s.id));
    state.beans = state.beans.filter((x) => x.id !== id);
    state.shots = state.shots.filter((s) => s.beanId !== id);
    save(); resetBeanForm(); renderBeans(); toast('Beans deleted');
  }
});

/* ---------- beans ---------- */

const beanForm = $('#bean-form');
const BEAN_FIELDS = ['name', 'roaster', 'origin', 'process', 'roast', 'variety', 'type', 'roastDate', 'openDate', 'notes'];

beanForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = beanForm.id.value || uid();
  const existing = beanById(id);
  const bean = { id, archived: existing?.archived || false, createdAt: existing?.createdAt || new Date().toISOString() };
  BEAN_FIELDS.forEach((k) => { bean[k] = beanForm[k].value.trim(); });
  bean.recipeId = beanForm.recipeId.value || null;
  touch(bean);
  if (existing) Object.assign(existing, bean); else state.beans.push(bean);
  save();
  const startRecipe = recipeById(bean.recipeId);
  toast(existing ? 'Beans updated' : startRecipe ? `Beans added — first shot starts from "${startRecipe.name}"` : 'Beans added');
  resetBeanForm();
  renderBeans();
});

function resetBeanForm() {
  beanForm.reset();
  beanForm.id.value = '';
  beanForm.hidden = true;
  $('#bean-add').hidden = false;
  $('#bean-delete').hidden = true;
}

function openBeanForm(title) {
  $('#bean-form-title').textContent = title;
  beanForm.hidden = false;
  $('#bean-add').hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  beanForm.name.focus({ preventScroll: true });
}

$('#bean-add').addEventListener('click', () => { resetBeanForm(); renderBeanRecipePicker(); openBeanForm('Add beans'); });

function editBean(id) {
  const b = beanById(id);
  if (!b) return;
  beanForm.id.value = b.id;
  BEAN_FIELDS.forEach((k) => { beanForm[k].value = b[k] ?? ''; });
  beanForm.recipeId.value = '';
  renderBeanRecipePicker(b);
  beanForm.recipeId.value = recipeById(b.recipeId) ? b.recipeId : '';
  $('#bean-delete').hidden = false;
  $('#bean-delete').dataset.id = b.id;
  beanForm.querySelector('details.more').open = !!(b.variety || b.type || b.notes);
  openBeanForm('Edit beans');
}

$('#bean-cancel').addEventListener('click', resetBeanForm);
$('#show-archived').addEventListener('change', renderBeans);

function renderBeans() {
  const showArchived = $('#show-archived').checked;
  const beans = state.beans
    .filter((b) => showArchived || !b.archived)
    .sort((a, b) => (a.archived - b.archived) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  const today = new Date().toISOString().slice(0, 10);
  $('#bean-list').innerHTML = beans.length ? beans.map((b) => {
    const shots = state.shots.filter((s) => s.beanId === b.id);
    const rated = shots.filter((s) => s.rating);
    const avg = rated.length ? (rated.reduce((t, s) => t + s.rating, 0) / rated.length).toFixed(1) : null;
    const age = b.roastDate ? daysBetween(b.roastDate, today) : null;
    const meta = [b.roaster, b.origin, b.process, b.roast].filter(Boolean).map(esc).join(' · ');
    return `
    <article class="item ${b.archived ? 'archived' : ''}">
      <div class="item-head">
        <span class="item-title">${esc(b.name)}</span>
        ${avg ? `<span class="stars-static">${avg} ★</span>` : ''}
      </div>
      ${meta ? `<div class="item-meta">${meta}</div>` : ''}
      <div class="item-sub">${[
        `${shots.length} shot${shots.length === 1 ? '' : 's'}`,
        recipeCount(b.id) && `${recipeCount(b.id)} recipe${recipeCount(b.id) === 1 ? '' : 's'}`,
        b.roastDate && (!b.archived && age >= 0 ? `roasted ${age} d ago` : `roasted ${fmtDate(b.roastDate, false)}`),
        b.archived && 'finished',
      ].filter(Boolean).join(' · ')}</div>
      ${b.notes ? `<p class="flavors">${esc(b.notes)}</p>` : ''}
      <div class="item-actions">
        ${shots.length ? `<button class="secondary small" data-act="shots-of-bean" data-id="${b.id}">Shots</button>` : ''}
        <button class="secondary small" data-act="edit-bean" data-id="${b.id}">Edit</button>
        <button class="link small" data-act="archive-bean" data-id="${b.id}">${b.archived ? 'Restore' : 'Mark finished'}</button>
      </div>
    </article>`;
  }).join('') : '<div class="empty">No beans yet — add your current bag above.</div>';
}

const recipeCount = (beanId) => state.recipes.filter((r) => r.beanId === beanId).length;

/* ---------- recipes ---------- */

const RECIPE_FIELDS = ['grind', 'dose', 'yield', 'time', 'temp', 'preinfusion', 'basket'];
const recipeById = (id) => state.recipes.find((r) => r.id === id);

function createRecipeFromShot(shot) {
  const bean = beanById(shot.beanId) || {};
  const r = ratio(shot.dose, shot.yield);
  const suggested = `${bean.name || 'Recipe'} · ${fmt(shot.dose)} g → 1:${r ? r.toFixed(1) : '?'}`;
  const name = prompt('Name this recipe', suggested);
  if (name == null) return;
  const recipe = {
    id: uid(),
    name: name.trim() || suggested,
    beanId: shot.beanId,
    // snapshot of the bean, so the recipe stays useful after the bag is gone
    beanName: bean.name || '', roaster: bean.roaster || '', origin: bean.origin || '',
    process: bean.process || '', roast: bean.roast || '',
    notes: shot.notes || '',
    fromShotId: shot.id,
    createdAt: nowIso(),
  };
  RECIPE_FIELDS.forEach((k) => { recipe[k] = shot[k] ?? null; });
  state.recipes.push(touch(recipe));
  save();
  toast(`Recipe "${recipe.name}" saved`);
}

// how alike a recipe's original bean is to another bean (0 = unrelated)
function recipeSimilarity(recipe, bean) {
  if (!bean) return 0;
  const same = (a, b) => a && b && a.trim().toLowerCase() === b.trim().toLowerCase();
  return (same(recipe.beanName, bean.name) ? 4 : 0) + (same(recipe.origin, bean.origin) ? 2 : 0) +
    (same(recipe.roaster, bean.roaster) ? 1 : 0) + (same(recipe.process, bean.process) ? 1 : 0) +
    (same(recipe.roast, bean.roast) ? 1 : 0);
}

function recipeOptionLabel(r) {
  const ratioTxt = ratio(r.dose, r.yield) ? ` · 1:${ratio(r.dose, r.yield).toFixed(1)}` : '';
  return `${r.name} (grind ${r.grind || '–'}, ${fmt(r.dose)} g${ratioTxt})`;
}

// <option>s grouped into this bag / similar beans / everything else
function recipeOptions(bean, placeholder) {
  const own = [], similar = [], other = [];
  for (const r of state.recipes.filter((x) => !isPourover(x))) {
    if (bean && (r.beanId === bean.id || r.id === bean.recipeId)) own.push(r);
    else if (recipeSimilarity(r, bean) > 0) similar.push(r);
    else other.push(r);
  }
  similar.sort((a, b) => recipeSimilarity(b, bean) - recipeSimilarity(a, bean));
  other.sort((a, b) => a.name.localeCompare(b.name));
  const group = (label, list) => list.length
    ? `<optgroup label="${label}">${list.map((r) => `<option value="${r.id}">${esc(recipeOptionLabel(r))}</option>`).join('')}</optgroup>` : '';
  return `<option value="">${placeholder}</option>` + group('This bag', own) + group('Similar beans', similar) +
    group(own.length || similar.length ? 'Other recipes' : 'All recipes', other);
}

function applyRecipe(recipe) {
  ['grind', 'dose', 'temp', 'preinfusion', 'basket'].forEach((k) => { shotForm[k].value = recipe[k] ?? ''; });
  shotForm.yield.value = recipe.yield ?? '';
  // time is the result of the shot; show the recipe's time as the target
  shotForm.time.value = '';
  shotForm.time.placeholder = recipe.time != null ? `${fmt(recipe.time, 0)} (target)` : '28';
  $('#recipe-loaded').hidden = false;
  $('#recipe-loaded').textContent = `Loaded "${recipe.name}"${recipe.notes ? ' — ' + recipe.notes : ''}`;
  updateRatio();
  updateDialIn();
}

function renderRecipePicker() {
  const has = state.recipes.some((r) => !isPourover(r));
  $('#recipe-picker-row').hidden = !has;
  if (has) $('#recipe-picker').innerHTML = recipeOptions(beanById(shotForm.beanId.value), 'Load a saved recipe…');
}

function renderBeanRecipePicker(bean) {
  const has = state.recipes.some((r) => !isPourover(r));
  $('#bean-recipe-row').hidden = !has;
  if (!has) return;
  // while adding, suggest by what has been typed so far
  const probe = bean || { name: beanForm.name.value, origin: beanForm.origin.value, roaster: beanForm.roaster.value,
    process: beanForm.process.value, roast: beanForm.roast.value };
  const sel = beanForm.recipeId;
  const cur = sel.value;
  sel.innerHTML = recipeOptions(probe, 'None — start fresh');
  sel.value = cur && recipeById(cur) ? cur : '';
}

function useRecipe(id) {
  const recipe = recipeById(id);
  if (!recipe) return;
  show('new');
  const bean = beanById(recipe.beanId);
  if (bean && !bean.archived) shotForm.beanId.value = bean.id;
  renderRecipePicker();
  applyRecipe(recipe);
}

function renderRecipes() {
  const filter = $('#recipe-filter').value;
  const list = state.recipes
    .filter((r) => !filter || recipeMethod(r) === filter)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  $('#recipe-list').innerHTML = list.length ? list.map((r) => (isPourover(r) ? pourOverCard(r) : espressoRecipeCard(r))).join('')
    : `<div class="empty">${state.recipes.length ? 'No recipes of this kind yet.'
      : 'No recipes yet.<br>Save an espresso recipe from a shot (open the shot → "Save as recipe"),<br>or add a pour-over recipe above.'}</div>`;
}

function recipeBeanLine(r) {
  const bean = beanById(r.beanId);
  const origin = [r.beanName, r.roaster].filter(Boolean).map(esc).join(' · ');
  if (!origin) return '';
  return `<div class="item-sub">${origin}${bean ? (bean.archived ? ' · bag finished' : '') : ' · bag deleted'}</div>`;
}

function espressoRecipeCard(r) {
  return `
    <article class="item">
      <div class="item-head"><span class="item-title">${esc(r.name)}</span><span class="badge">Espresso</span></div>
      ${recipeLine(r)}
      ${recipeBeanLine(r)}
      ${r.notes ? `<p class="shot-notes">${esc(r.notes)}</p>` : ''}
      <div class="item-actions">
        <button class="secondary small" data-act="use-recipe" data-id="${r.id}">Use</button>
        <button class="link small" data-act="rename-recipe" data-id="${r.id}">Rename</button>
        <button class="link small del" data-act="del-recipe" data-id="${r.id}">Delete</button>
      </div>
    </article>`;
}

/* ---------- pour-over recipes ---------- */

const recipeMethod = (r) => r.method || 'espresso';
const isPourover = (r) => recipeMethod(r) === 'pourover';

function fmtClock(sec) {
  if (sec == null || isNaN(sec)) return '–';
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// "3:00", "3", "180s" or "180" -> seconds
function parseClock(v) {
  const str = String(v ?? '').trim();
  if (!str) return null;
  const m = str.match(/^(\d+):([0-5]?\d)$/);
  if (m) return +m[1] * 60 + +m[2];
  const n = parseFloat(str);
  if (isNaN(n)) return null;
  return n < 15 ? Math.round(n * 60) : Math.round(n); // small numbers are minutes
}

function pourSummary(r) {
  const parts = [];
  if (r.bloomWater) parts.push(`bloom ${fmt(r.bloomWater, 0)} g`);
  (r.pours || []).forEach((p) => parts.push(`${fmt(p.to, 0)} g @ ${fmtClock(p.at)}`));
  return parts.join(' → ');
}

function pourOverCard(r) {
  const rt = ratio(r.dose, r.water);
  return `
    <article class="item">
      <div class="item-head"><span class="item-title">${esc(r.name)}</span>
        <span class="badge pourover">${esc(r.brewer || 'Pour-over')}</span></div>
      <span class="recipe">${fmt(r.dose)} g<i>·</i>${fmt(r.water, 0)} g${rt ? `<i>·</i>1:${rt.toFixed(1)}` : ''}${r.time ? `<i>·</i>${fmtClock(r.time)}` : ''}</span>
      <div class="item-sub">${[r.grind && `grind ${esc(r.grind)}`, r.temp && `${fmt(r.temp)} °C`, r.filter && esc(r.filter)].filter(Boolean).join(' · ')}</div>
      ${recipeBeanLine(r)}
      ${pourSummary(r) ? `<p class="flavors">${pourSummary(r)}</p>` : ''}
      ${r.notes ? `<p class="shot-notes">${esc(r.notes)}</p>` : ''}
      <div class="item-actions">
        <button class="primary small" data-act="brew-recipe" data-id="${r.id}">▶ Brew</button>
        <button class="secondary small" data-act="edit-po" data-id="${r.id}">Edit</button>
      </div>
    </article>`;
}

const poForm = $('#po-form');
const PO_FIELDS = ['name', 'brewer', 'filter', 'beanId', 'dose', 'water', 'grind', 'temp', 'bloomWater', 'bloomTime', 'notes'];

function pourRow(p = {}) {
  return `<div class="pour-row">
    <input class="po-at" inputmode="numeric" placeholder="0:45" value="${p.at != null ? fmtClock(p.at) : ''}" aria-label="Start time">
    <input class="po-to" type="number" step="1" min="0" placeholder="150" value="${p.to ?? ''}" aria-label="Pour up to (g)">
    <span class="unit">g</span>
    <button type="button" class="link del small" data-pour-del aria-label="Remove pour">✕</button>
  </div>`;
}

function setPours(pours) {
  $('#po-pours').innerHTML = pours.map(pourRow).join('');
}

function readPours() {
  return $$('#po-pours .pour-row')
    .map((row) => ({ at: parseClock($('.po-at', row).value), to: num($('.po-to', row).value) }))
    .filter((p) => p.at != null && p.to != null)
    .sort((a, b) => a.at - b.at);
}

function updatePoRatio() {
  const r = ratio(num(poForm.dose.value), num(poForm.water.value));
  $('#po-ratio').textContent = r ? '1 : ' + r.toFixed(1) : '–';
}

function fillPoBeanSelect(current) {
  const beans = state.beans.filter((b) => !b.archived || b.id === current);
  poForm.beanId.innerHTML = '<option value="">Any beans</option>' +
    beans.map((b) => `<option value="${b.id}">${esc(b.name)}${b.roaster ? ' — ' + esc(b.roaster) : ''}</option>`).join('');
  poForm.beanId.value = current && beans.some((b) => b.id === current) ? current : '';
}

function openPoForm(recipe) {
  poForm.reset();
  poForm.id.value = recipe?.id || '';
  fillPoBeanSelect(recipe?.beanId);
  if (recipe) {
    PO_FIELDS.forEach((k) => { if (k !== 'beanId') poForm[k].value = recipe[k] ?? ''; });
    poForm.time.value = recipe.time ? fmtClock(recipe.time) : '';
  }
  setPours(recipe?.pours?.length ? recipe.pours : [{}, {}]);
  $('#po-form-title').textContent = recipe ? 'Edit pour-over recipe' : 'New pour-over recipe';
  $('#po-delete').hidden = !recipe;
  poForm.hidden = false;
  $('#po-add').hidden = true;
  updatePoRatio();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closePoForm() {
  poForm.hidden = true;
  $('#po-add').hidden = false;
}

// a common two-pour schedule: bloom with 3× coffee, then 60 % and 100 % of the water
function suggestSchedule() {
  const dose = num(poForm.dose.value);
  const water = num(poForm.water.value);
  if (!dose || !water) { toast('Enter coffee and water first'); return; }
  const bloomTime = num(poForm.bloomTime.value) || 45;
  poForm.bloomWater.value = Math.round(dose * 3);
  poForm.bloomTime.value = bloomTime;
  setPours([{ at: bloomTime, to: Math.round(water * 0.6) }, { at: bloomTime + 30, to: Math.round(water) }]);
  if (!poForm.time.value) poForm.time.value = fmtClock(bloomTime + 135);
}

poForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const dose = num(poForm.dose.value);
  const water = num(poForm.water.value);
  const pours = readPours();
  if (pours.some((p, i) => i > 0 && p.to < pours[i - 1].to)) { toast('Each pour should go up to a higher total weight'); return; }
  if (pours.length && water && pours[pours.length - 1].to > water) { toast(`The last pour goes past ${fmt(water, 0)} g of water`); return; }

  const id = poForm.id.value || uid();
  const existing = recipeById(id);
  const bean = beanById(poForm.beanId.value) || {};
  const recipe = {
    ...existing,
    id,
    method: 'pourover',
    name: poForm.name.value.trim() || `${poForm.brewer.value.trim() || 'Pour-over'} ${fmt(dose)} g : ${fmt(water, 0)} g`,
    brewer: poForm.brewer.value.trim(),
    filter: poForm.filter.value.trim(),
    beanId: poForm.beanId.value || null,
    beanName: bean.name || '', roaster: bean.roaster || '', origin: bean.origin || '',
    process: bean.process || '', roast: bean.roast || '',
    dose, water,
    grind: poForm.grind.value.trim(),
    temp: num(poForm.temp.value),
    time: parseClock(poForm.time.value),
    bloomWater: num(poForm.bloomWater.value),
    bloomTime: num(poForm.bloomTime.value),
    pours,
    notes: poForm.notes.value.trim(),
    createdAt: existing?.createdAt || nowIso(),
  };
  touch(recipe);
  if (existing) Object.assign(existing, recipe); else state.recipes.push(recipe);
  save();
  closePoForm();
  renderRecipes();
  toast(existing ? 'Recipe updated' : 'Pour-over recipe saved');
});

$('#po-add').addEventListener('click', () => openPoForm(null));
$('#po-cancel').addEventListener('click', closePoForm);
$('#po-suggest').addEventListener('click', suggestSchedule);
$('#po-add-pour').addEventListener('click', () => {
  $('#po-pours').insertAdjacentHTML('beforeend', pourRow());
  $('#po-pours .pour-row:last-child .po-at').focus();
});
$('#po-pours').addEventListener('click', (e) => {
  if (e.target.closest('[data-pour-del]')) e.target.closest('.pour-row').remove();
});
$('#po-delete').addEventListener('click', () => {
  const r = recipeById(poForm.id.value);
  if (!r || !confirm(`Delete recipe "${r.name}"?`)) return;
  state.recipes = state.recipes.filter((x) => x.id !== r.id);
  markDeleted(r.id);
  save(); closePoForm(); renderRecipes(); toast('Recipe deleted');
});
poForm.dose.addEventListener('input', updatePoRatio);
poForm.water.addEventListener('input', updatePoRatio);
$('#recipe-filter').addEventListener('change', renderRecipes);

/* ---------- brew guide ---------- */

let brew = { recipe: null, steps: [], elapsed: 0, startedAt: null, timer: null, stepIdx: -1, wakeLock: null };

function brewSteps(r) {
  const steps = [];
  if (r.bloomWater) steps.push({ at: 0, text: `Bloom — pour to ${fmt(r.bloomWater, 0)} g`, to: r.bloomWater });
  (r.pours || []).forEach((p) => steps.push({ at: p.at, text: `Pour to ${fmt(p.to, 0)} g`, to: p.to }));
  if (!steps.length) steps.push({ at: 0, text: `Pour to ${fmt(r.water, 0)} g`, to: r.water });
  if (steps[0].at > 0) steps.unshift({ at: 0, text: 'Get ready' });
  const lastAt = steps[steps.length - 1].at;
  const end = r.time && r.time > lastAt ? r.time : lastAt + 60;
  steps.push({ at: end, text: 'Done — drawdown should be finished', final: true });
  return steps;
}

function openBrew(id) {
  const r = recipeById(id);
  if (!r) return;
  resetBrew();
  brew.recipe = r;
  brew.steps = brewSteps(r);
  $('#brew-title').textContent = r.name;
  const rt = ratio(r.dose, r.water);
  $('#brew-meta').textContent = [
    `${fmt(r.dose)} g coffee`, `${fmt(r.water, 0)} g water`, rt && `1:${rt.toFixed(1)}`,
    r.grind && `grind ${r.grind}`, r.temp && `${fmt(r.temp)} °C`, r.brewer,
  ].filter(Boolean).join(' · ');
  $('#brew-notes').textContent = r.notes || '';
  show('brew');
  renderBrew();
}

function brewElapsed() {
  return brew.elapsed + (brew.startedAt != null ? (performance.now() - brew.startedAt) / 1000 : 0);
}

function renderBrew() {
  const t = brewElapsed();
  const steps = brew.steps;
  let idx = -1;
  steps.forEach((s, i) => { if (t >= s.at && (brew.startedAt != null || brew.elapsed > 0)) idx = i; });
  const cur = steps[idx];
  const next = steps[idx + 1];

  if (idx !== brew.stepIdx && idx >= 0 && brew.startedAt != null) navigator.vibrate?.(cur.final ? [200, 100, 200] : 150);
  brew.stepIdx = idx;

  $('#brew-clock').textContent = fmtClock(t);
  $('#brew-step').textContent = cur ? cur.text : 'Ready when you are';
  const pct = cur && next ? Math.min(100, ((t - cur.at) / (next.at - cur.at)) * 100) : cur?.final ? 100 : 0;
  $('#brew-bar').style.width = pct + '%';
  $('#brew-next').textContent = next ? `Next: ${next.text.toLowerCase()} at ${fmtClock(next.at)} (in ${fmtClock(next.at - t)})`
    : cur?.final ? 'Enjoy your coffee ☕' : '';
  $('#brew-steps').innerHTML = steps.map((s, i) =>
    `<li class="${i === idx ? 'current' : i < idx ? 'done' : ''}"><span>${fmtClock(s.at)}</span>${esc(s.text)}</li>`).join('');

  if (cur?.final && brew.startedAt != null) pauseBrew();
  $('#brew-start').textContent = brew.startedAt != null ? 'Pause' : brew.elapsed > 0 && !cur?.final ? 'Resume' : 'Start';
}

async function startBrew() {
  if (brew.steps[brew.stepIdx]?.final) resetBrew();
  brew.startedAt = performance.now();
  brew.timer = setInterval(renderBrew, 200);
  try { brew.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
  renderBrew();
}

function pauseBrew() {
  if (brew.startedAt == null) return;
  brew.elapsed = brewElapsed();
  brew.startedAt = null;
  clearInterval(brew.timer);
  brew.wakeLock?.release().catch(() => {});
  brew.wakeLock = null;
}

function resetBrew() {
  pauseBrew();
  brew.elapsed = 0;
  brew.stepIdx = -1;
  if (brew.recipe) renderBrew();
}

$('#brew-start').addEventListener('click', () => {
  if (brew.startedAt != null) { pauseBrew(); renderBrew(); } else startBrew();
});
$('#brew-reset').addEventListener('click', resetBrew);

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'brew-recipe') openBrew(b.dataset.id);
  if (b.dataset.act === 'edit-po') openPoForm(recipeById(b.dataset.id));
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const { act, id } = b.dataset;
  if (act === 'save-recipe') {
    const shot = state.shots.find((s) => s.id === id);
    if (shot) { createRecipeFromShot(shot); renderShots(); }
  }
  if (act === 'use-recipe') useRecipe(id);
  if (act === 'rename-recipe') {
    const r = recipeById(id);
    const name = r && prompt('Rename recipe', r.name);
    if (name && name.trim()) { r.name = name.trim(); touch(r); save(); renderRecipes(); }
  }
  if (act === 'del-recipe') {
    const r = recipeById(id);
    if (!r || !confirm(`Delete recipe "${r.name}"?`)) return;
    state.recipes = state.recipes.filter((x) => x.id !== id);
    markDeleted(id);
    save(); renderRecipes(); toast('Recipe deleted');
  }
});

$('#recipe-picker').addEventListener('change', (e) => {
  const recipe = recipeById(e.target.value);
  if (recipe) applyRecipe(recipe);
  e.target.value = '';
});

['name', 'origin', 'roaster', 'process', 'roast'].forEach((k) =>
  beanForm[k].addEventListener('change', () => { if (!beanForm.id.value) renderBeanRecipePicker(); }));

/* ---------- settings & data ---------- */

const settingsForm = $('#settings-form');

function fillSettings() {
  Object.entries(state.settings).forEach(([k, v]) => { if (settingsForm[k]) settingsForm[k].value = v ?? ''; });
}

settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const s = state.settings;
  s.machine = settingsForm.machine.value.trim();
  s.grinder = settingsForm.grinder.value.trim();
  ['defaultDose', 'defaultRatio', 'targetMin', 'targetMax'].forEach((k) => { s[k] = num(settingsForm[k].value); });
  if (s.targetMin == null) s.targetMin = 25;
  if (s.targetMax == null) s.targetMax = 32;
  touch(s);
  save();
  renderHeader();
  toast('Setup saved');
});

function renderHeader() {
  const { machine, grinder } = state.settings;
  const setup = [machine, grinder].filter(Boolean).join(' + ');
  $('.topbar h1').innerHTML = '☕ Shot Log' + (setup ? ` <small class="item-sub">${esc(setup)}</small>` : '');
}

$('#export-json').addEventListener('click', () => {
  download(`shot-log-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state, null, 2), 'application/json');
});

$('#export-csv').addEventListener('click', () => {
  const cols = ['date', 'beans', 'roaster', 'origin', 'process', 'roast', 'roast_date', 'grind', 'dose_g', 'yield_g', 'ratio', 'time_s',
    'temp_c', 'preinfusion_s', 'basket', ...TASTE_ATTRS.map((a) => a.key), 'flavors', 'compass_extraction', 'compass_strength', 'rating', 'notes',
    'machine', 'grinder'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = state.shots.map((s) => {
    const b = beanById(s.beanId) || {};
    const r = ratio(s.dose, s.yield);
    return [s.createdAt, b.name, b.roaster, b.origin, b.process, b.roast, b.roastDate, s.grind, s.dose, s.yield,
      r ? r.toFixed(2) : '', s.time, s.temp, s.preinfusion, s.basket, ...TASTE_ATTRS.map((a) => s.taste?.[a.key]),
      (s.flavors || []).join('; '), s.compass?.x, s.compass?.y, s.rating, s.notes, state.settings.machine, state.settings.grinder].map(q).join(',');
  });
  download(`shots-${new Date().toISOString().slice(0, 10)}.csv`, [cols.join(','), ...rows].join('\n'), 'text/csv');
});

$('#import-json').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.beans) || !Array.isArray(data.shots)) throw new Error('Not a shot log backup');
    if (!confirm(`Merge ${data.beans.length} beans and ${data.shots.length} shots from the file into your log?`)) return;
    state = mergeStates(state, normalize(data));
    save(); renderHeader(); fillSettings(); toast('Backup imported');
  } catch (err) {
    alert('Import failed: ' + err.message);
  } finally {
    e.target.value = '';
  }
});

$('#wipe').addEventListener('click', () => {
  const msg = syncEnabled()
    ? 'Delete ALL beans and shots on every synced device? This cannot be undone.'
    : 'Delete ALL beans, shots and settings? This cannot be undone.';
  if (!confirm(msg)) return;
  const deleted = { ...state.deleted };
  [...state.beans, ...state.shots, ...state.recipes].forEach((r) => { deleted[r.id] = nowIso(); });
  state = { ...emptyState(), deleted };
  touch(state.settings);
  save(); renderHeader(); fillSettings(); toast('All data deleted');
});

$('#load-demo').addEventListener('click', () => {
  if (state.shots.length && !confirm('Add demo beans and shots to your existing data?')) return;
  const day = 86400000;
  const now = Date.now();
  const b1 = { id: uid(), name: 'Ethiopia Guji Hambela', roaster: 'Local Roasters', origin: 'Ethiopia, Guji', process: 'Natural',
    roast: 'Light', variety: 'Heirloom', type: 'Single origin', roastDate: new Date(now - 14 * day).toISOString().slice(0, 10),
    openDate: new Date(now - 5 * day).toISOString().slice(0, 10), notes: 'blueberry, jasmine, dark chocolate', archived: false, createdAt: new Date(now - 6 * day).toISOString(), updatedAt: nowIso() };
  const b2 = { id: uid(), name: 'House Espresso Blend', roaster: 'Local Roasters', origin: 'Brazil / Colombia', process: 'Washed',
    roast: 'Medium-dark', variety: '', type: 'Blend', roastDate: new Date(now - 20 * day).toISOString().slice(0, 10),
    openDate: '', notes: 'cocoa, hazelnut, caramel', archived: false, createdAt: new Date(now - 10 * day).toISOString(), updatedAt: nowIso() };
  const mk = (bean, daysAgo, grind, dose, out, time, temp, taste, flavors, rating, notes, compass) => ({
    id: uid(), beanId: bean.id, createdAt: new Date(now - daysAgo * day).toISOString(), grind, dose, yield: out, time, temp,
    preinfusion: 5, basket: 'Double', taste, flavors, rating, notes, compass, updatedAt: nowIso() });
  state.beans.push(b1, b2);
  state.shots.push(
    mk(b1, 5, '14', 18, 40, 21, 93, { acidity: 5, sweetness: 1, bitterness: 0, body: 1, aftertaste: 1 }, ['citrus', 'grassy'], 2, 'Way too fast and sour.', { x: -0.75, y: -0.5 }),
    mk(b1, 4, '12', 18, 40, 27, 94, { acidity: 3, sweetness: 3, bitterness: 1, body: 3, aftertaste: 3 }, ['berry', 'floral'], 4, 'Much better, slight sharpness.', { x: -0.35, y: 0.1 }),
    mk(b1, 3, '11.5', 18, 42, 29, 94, { acidity: 3, sweetness: 4, bitterness: 1, body: 3, aftertaste: 4 }, ['berry', 'floral', 'chocolate'], 5, 'Sweet spot!', { x: -0.05, y: 0.05 }),
    mk(b2, 2, '16', 18, 36, 35, 92, { acidity: 1, sweetness: 2, bitterness: 4, body: 4, aftertaste: 2 }, ['burnt', 'chocolate'], 2, 'Choked a bit, bitter finish.', { x: 0.7, y: 0.55 }),
    mk(b2, 1, '17', 18, 36, 28, 91, { acidity: 1, sweetness: 4, bitterness: 2, body: 4, aftertaste: 3 }, ['chocolate', 'nutty', 'caramel'], 4, 'Great with milk.', { x: 0.15, y: 0.35 }),
  );
  const best = state.shots.find((s) => s.beanId === b1.id && s.rating === 5);
  state.recipes.push({ id: uid(), name: 'Guji sweet spot', beanId: b1.id, beanName: b1.name, roaster: b1.roaster,
    origin: b1.origin, process: b1.process, roast: b1.roast, grind: best.grind, dose: best.dose, yield: best.yield,
    time: best.time, temp: best.temp, preinfusion: best.preinfusion, basket: best.basket,
    notes: 'Light naturals like a long ratio and high temp.', fromShotId: best.id, createdAt: nowIso(), updatedAt: nowIso() });
  state.recipes.push({ id: uid(), method: 'pourover', name: 'V60 everyday', brewer: 'V60', filter: 'Paper',
    beanId: b1.id, beanName: b1.name, roaster: b1.roaster, origin: b1.origin, process: b1.process, roast: b1.roast,
    dose: 15, water: 250, grind: '22', temp: 94, time: 180, bloomWater: 45, bloomTime: 45,
    pours: [{ at: 45, to: 150 }, { at: 75, to: 250 }], notes: 'Swirl after bloom and after the last pour.',
    createdAt: nowIso(), updatedAt: nowIso() });
  save(); toast('Demo data loaded'); show('shots');
});

/* ---------- sync settings ---------- */

const syncForm = $('#sync-form');

function fillSyncForm() {
  syncForm.url.value = syncCfg.url || '';
  syncForm.token.value = syncCfg.token || '';
  renderSyncInfo();
}

function renderSyncInfo() {
  const el = $('#sync-info');
  if (!el) return;
  $('#sync-now').hidden = $('#sync-disconnect').hidden = !syncEnabled();
  if (!syncEnabled()) { el.textContent = 'Not connected — data stays on this device only.'; return; }
  const last = syncCfg.lastSync ? 'Last synced ' + fmtDate(syncCfg.lastSync) + '.' : 'Not synced yet.';
  el.textContent = syncState.message ? `${syncState.message}. ${last}` : last;
}

syncForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  syncCfg.url = syncForm.url.value.trim();
  syncCfg.token = syncForm.token.value.trim();
  saveSyncCfg();
  if (!syncCfg.token) { toast('Enter the sync token'); return; }
  if (await sync()) toast('Connected — data synced');
  startPowerPolling();
});

$('#sync-now').addEventListener('click', async () => {
  if (!syncEnabled()) { toast('Set up sync first'); return; }
  if (await sync()) toast('Synced');
});

$('#sync-disconnect').addEventListener('click', () => {
  if (!syncEnabled() || !confirm('Stop syncing this device? Your data stays on this device.')) return;
  syncCfg = { url: '', token: '', lastSync: null };
  saveSyncCfg();
  fillSyncForm();
  setSyncStatus('off');
  power = null;
  renderPower();
  toast('Sync disconnected');
});

/* ---------- machine power (via server + Home Assistant) ---------- */

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // index = server weekday (0 = Monday)
let power = null;          // last status from the server
let powerBusy = false;
let powerPoll = null;
let schedDays = new Set([0, 1, 2, 3, 4]);

async function powerApi(path, body) {
  const res = await fetch(apiUrl(path), {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + syncCfg.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Server error ' + res.status);
  return data;
}

async function refreshPower() {
  if (!syncEnabled() || !navigator.onLine) { renderPower(); return; }
  try {
    power = await powerApi('/api/power');
  } catch (e) {
    power = power ? { ...power, state: 'unavailable', error: e.message } : null;
  }
  renderPower();
}

async function powerAction(fn, okMsg) {
  if (powerBusy) return;
  powerBusy = true;
  renderPower();
  try {
    power = await fn();
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message);
    await refreshPower();
  } finally {
    powerBusy = false;
    renderPower();
  }
}

const saveSchedule = (weekly, timers, msg) =>
  powerAction(() => powerApi('/api/power/schedule', { weekly, timers }), msg);

function formatDays(days) {
  const key = days.join('');
  if (key === '0123456') return 'Every day';
  if (key === '01234') return 'Weekdays';
  if (key === '56') return 'Weekends';
  return days.map((d) => DAY_NAMES[d]).join(', ');
}

function relativeTime(iso) {
  const mins = Math.round((new Date(iso) - Date.now()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `in ${h} h ${mins % 60} min` : `in ${Math.round(h / 24)} days`;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + time;
}

function renderPower() {
  const configured = !!power?.configured;
  const on = power?.state === 'on';
  const unavailable = !power || power.state === 'unavailable' || power.state === 'unknown';

  const pill = $('#power-pill');
  pill.hidden = !configured;
  pill.className = 'pill power-pill' + (on ? ' on' : '');
  pill.textContent = '⏻ ' + (unavailable ? '?' : on ? 'On' : 'Off');

  if (!$('#view-machine').classList.contains('active')) return;

  if (!configured) {
    $('#power-name').textContent = 'Espresso machine';
    $('#power-state').textContent = syncEnabled() ? 'Not configured on the server' : 'Connect to your sync server first (Setup)';
    $('#power-toggle').hidden = true;
    return;
  }
  $('#power-toggle').hidden = false;
  $('#power-name').textContent = power.name || 'Espresso machine';
  $('#power-state').textContent = unavailable ? 'Unavailable' : on ? 'On — heating up / ready' : 'Off';
  $('#power-dot').className = 'power-dot' + (on ? ' on' : unavailable ? ' unavailable' : '');
  const toggle = $('#power-toggle');
  toggle.textContent = on ? 'Turn off' : 'Turn on';
  toggle.className = on ? 'secondary' : 'primary';
  toggle.disabled = powerBusy;

  const err = power.error || (power.lastEvent && !power.lastEvent.ok && power.lastEvent.error
    ? `Last ${power.lastEvent.source} failed: ${power.lastEvent.error}` : '');
  $('#power-error').hidden = !err;
  $('#power-error').textContent = err;
  $('#power-autooff').hidden = !(on && power.autoOffAt);
  if (on && power.autoOffAt) {
    $('#power-autooff').textContent = `Turns off automatically at ${fmtWhen(power.autoOffAt).replace(/^Today /, '')} (${relativeTime(power.autoOffAt)})`;
  }
  $('#power-next').hidden = !power.nextRun;
  if (power.nextRun) $('#power-next').textContent = `Next automatic power-on: ${fmtWhen(power.nextRun)} (${relativeTime(power.nextRun)})`;

  $('#timer-list').innerHTML = power.timers.map((t) => `
    <div class="mini-row">
      <span class="when">${fmtWhen(t.at)}</span>
      <span class="what">${relativeTime(t.at)}</span>
      <button type="button" class="link del small" data-timer-del="${esc(t.id)}">Cancel</button>
    </div>`).join('');

  $('#schedule-list').innerHTML = power.weekly
    .slice()
    .sort((a, b) => a.time.localeCompare(b.time))
    .map((w) => `
    <div class="mini-row ${w.enabled ? '' : 'disabled'}">
      <input type="checkbox" ${w.enabled ? 'checked' : ''} data-sched-toggle="${esc(w.id)}" aria-label="Enabled">
      <span class="when">${esc(w.time)}</span>
      <span class="what">${formatDays(w.days)}</span>
      <button type="button" class="link del small" data-sched-del="${esc(w.id)}">Remove</button>
    </div>`).join('');

  const browserOffset = -new Date().getTimezoneOffset();
  $('#power-tz').hidden = power.serverUtcOffset === browserOffset;
  $('#power-tz').textContent = `Schedule times use the server's time zone (${power.serverTimeZone}).`;
}

function renderDayPicker() {
  $('#sched-days').innerHTML = DAY_NAMES.map((d, i) =>
    `<button type="button" class="${schedDays.has(i) ? 'on' : ''}" data-day="${i}" aria-pressed="${schedDays.has(i)}">${d.slice(0, 2)}</button>`).join('');
}

function defaultTimerValue() {
  const d = new Date(Date.now() + 30 * 60000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return toLocalInput(d);
}

function setupPower() {
  renderDayPicker();
  $('#timer-at').value = defaultTimerValue();

  $('#power-toggle').addEventListener('click', () => {
    const turnOn = power?.state !== 'on';
    powerAction(() => powerApi('/api/power', { action: turnOn ? 'on' : 'off' }), turnOn ? 'Machine on' : 'Machine off');
  });

  const addTimer = (date) => {
    if (!power?.configured) return;
    if (!(date > new Date())) { toast('Pick a time in the future'); return; }
    saveSchedule(power.weekly, [...power.timers, { id: uid(), at: date.toISOString() }], `Machine turns on ${fmtWhen(date)}`);
  };
  $$('[data-in]').forEach((b) => b.addEventListener('click', () => addTimer(new Date(Date.now() + b.dataset.in * 60000))));
  $('#timer-add').addEventListener('click', () => addTimer(new Date($('#timer-at').value)));

  $('#sched-days').addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]');
    if (!b) return;
    const d = +b.dataset.day;
    schedDays.has(d) ? schedDays.delete(d) : schedDays.add(d);
    renderDayPicker();
  });
  $('#sched-add').addEventListener('click', () => {
    if (!power?.configured) return;
    const time = $('#sched-time').value;
    if (!time || !schedDays.size) { toast('Pick a time and at least one day'); return; }
    const entry = { id: uid(), time, days: [...schedDays].sort(), enabled: true };
    saveSchedule([...power.weekly, entry], power.timers, `Added: ${formatDays(entry.days)} at ${time}`);
  });

  $('#view-machine').addEventListener('click', (e) => {
    const del = e.target.closest('[data-timer-del]');
    if (del) saveSchedule(power.weekly, power.timers.filter((t) => t.id !== del.dataset.timerDel), 'Timer cancelled');
    const rm = e.target.closest('[data-sched-del]');
    if (rm) saveSchedule(power.weekly.filter((w) => w.id !== rm.dataset.schedDel), power.timers, 'Schedule removed');
  });
  $('#view-machine').addEventListener('change', (e) => {
    const id = e.target.dataset.schedToggle;
    if (!id) return;
    const weekly = power.weekly.map((w) => (w.id === id ? { ...w, enabled: e.target.checked } : w));
    saveSchedule(weekly, power.timers, e.target.checked ? 'Schedule enabled' : 'Schedule paused');
  });
}

function startPowerPolling() {
  clearInterval(powerPoll);
  refreshPower();
  powerPoll = setInterval(() => {
    if (document.visibilityState === 'visible' && $('#view-machine').classList.contains('active')) refreshPower();
  }, 20000);
}

/* ---------- PWA ---------- */

let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#install-btn').hidden = false;
});

$('#install-btn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('#install-btn').hidden = true;
});

window.addEventListener('appinstalled', () => { $('#install-card').hidden = true; toast('Shot Log installed'); });

function setupInstallHint() {
  if (isStandalone()) { $('#install-card').hidden = true; return; }
  const hint = $('#install-hint');
  if (!window.isSecureContext) {
    hint.textContent = 'Installing needs HTTPS (or localhost). Open this app through an https:// address to install it.';
  } else if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
    hint.textContent = 'On iPhone/iPad: open in Safari, tap the Share button, then "Add to Home Screen".';
  } else {
    hint.textContent += ' If no button appears, use your browser menu → "Install app" / "Add to Home screen".';
  }
}

if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker failed', e));
}
// ask the browser not to evict our offline data
navigator.storage?.persist?.().catch(() => {});

/* ---------- init ---------- */

buildTasteSliders();
setupCompassInput();
setupPower();
renderHeader();
renderShots();
fillSyncForm();
setupInstallHint();
if (syncEnabled()) { setSyncStatus('syncing'); scheduleSync(300); startPowerPolling(); }
