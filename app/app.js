// Aziz Tally for Chromebook - the screen. Counting rules live in core.js, saving in store.js.
// Products are boxes on the Card or Cash side; pressing one adds 1 to it and to the total.

import {
  Tally, MemoryStorage, VERSION, SIDES, SIDE_NAMES, addDays, parseStamp, fmtTime, fmtTimeShort, fmtDate,
  fmtDayLong, fmtDayShort, dayName, plural, summarize, restorePoints, toCsv, boxNames,
} from './core.js';
import { IdbStorage } from './store.js';

const $ = id => document.getElementById(id);
const el = {
  board: $('board'), center: $('center'), count: $('count'), last: $('last'), date: $('date'), hint: $('hint'),
  boxes: { card: $('boxes-card'), cash: $('boxes-cash') },
  resetBtn: $('resetBtn'), installBtn: $('installBtn'), logBtn: $('logBtn'), fullBtn: $('fullBtn'), fullIcon: $('fullIcon'),
  settingsBtn: $('settingsBtn'),
  log: $('log'), logSub: $('logSub'), logClose: $('logClose'), logList: $('logList'), logEmpty: $('logEmpty'), undoBtn: $('undoBtn'),
  toast: $('toast'), saveBanner: $('saveBanner'),
  settings: $('settings'), settingsClose: $('settingsClose'), tabHistory: $('tabHistory'), tabProducts: $('tabProducts'),
  setNote: $('setNote'), historyPane: $('historyPane'), productsPane: $('productsPane'),
  dayList: $('dayList'), dayTitle: $('dayTitle'), daySub: $('daySub'), dayBreakdown: $('dayBreakdown'),
  restoreList: $('restoreList'), restoreEmpty: $('restoreEmpty'), csvBtn: $('csvBtn'), dayLog: $('dayLog'),
  prodList: { card: $('prodList-card'), cash: $('prodList-cash') },
  addName: { card: $('addName-card'), cash: $('addName-cash') },
  keepOn: $('keepOn'), aboutText: $('aboutText'),
  dialog: $('dialog'), dialogTitle: $('dialogTitle'), dialogBody: $('dialogBody'), dialogCancel: $('dialogCancel'), dialogConfirm: $('dialogConfirm'),
  elsewhere: $('elsewhere'),
};

const LOG_AUTO_HIDE_MS = 45000;
// After a dialog or Settings closes, ignore presses briefly so the second half of a
// double-click on "Reset"/"Restore"/"Close" can't land on a product box.
const TAP_GUARD_MS = 450;
const NUMBER_FONT = 'system-ui, "Segoe UI", Roboto, sans-serif';
const SETTINGS_KEY = 'aziz-tally-settings';
const BOXES_KEY = 'aziz-tally-boxes';
const NOTE_HISTORY = 'Every press is saved straight away, so closing the app or a restart carries on from where it was. To bring back an older count, pick the day and press Restore.';
const NOTE_PRODUCTS = 'Each product gets its own box on its side of the counter. Renaming one keeps the presses it already has.';

let tally = null;
let products = loadProducts();   // [{ id, name, side }] in screen order
let boxEls = new Map();          // product id -> { root, count, time }
let logOpen = false;
let logHideTimer = 0;
let toastTimer = 0;
let blockedUntil = 0;
let dialogAction = null;
let installPrompt = null;
let wakeLock = null;
let selectedDay = null;
let logKey = null;
let logShown = 0;
let lastToast = '';
const settings = loadSettings();

const motion = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ start-up

start();

async function start() {
  wireInput();
  registerServiceWorker();
  watchInstall();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  el.aboutText.textContent = `Aziz Tally ${VERSION} for Chromebook   ·   Backspace = undo the last press   ·   Counts are saved in this Chromebook's Chrome, under this Google account`;
  el.keepOn.checked = settings.keepOn;
  buildBoxes();
  drawCount('0');

  // Only one window may count at a time, or two windows would each think they know the count.
  if (!(await takeWindow(true))) {
    el.elsewhere.hidden = false;
    await takeWindow(false);
    el.elsewhere.hidden = true;
  }

  let storage;
  try {
    storage = await IdbStorage.open();
  } catch (err) {
    storage = new MemoryStorage();
    el.saveBanner.textContent = "This browser won't let Aziz Tally save. Counting works, but closing it loses the count. Use Chrome while signed in (not Guest or Incognito).";
    el.saveBanner.hidden = false;
  }
  // Presses are only taken once today's records are fully loaded.
  const loaded = new Tally(storage);
  loaded.onSaveState = renderSaveState;
  await loaded.open();
  tally = loaded;
  recoverProducts();
  renderAll();
  if (tally.count > 0) toast(`Welcome back. Carrying on from today's total of ${tally.count}.`, 4000);

  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { tick(); applyWakeLock(); });
  applyWakeLock();
  document.documentElement.dataset.ready = 'true';
}

function takeWindow(ifAvailable) {
  return new Promise(resolve => {
    if (!navigator.locks) { resolve(true); return; }
    navigator.locks.request('aziz-tally-window', { ifAvailable }, lock => {
      if (!lock) { resolve(false); return undefined; }
      resolve(true);
      return new Promise(() => {}); // held until this window closes
    });
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { keepOn: s.keepOn !== false };
  } catch {
    return { keepOn: true };
  }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); return true; } catch { return false; }
}

function loadProducts() {
  try {
    const list = JSON.parse(localStorage.getItem(BOXES_KEY) || '[]');
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    return list.filter(p => p && typeof p.id === 'string' && p.id && !seen.has(p.id) && seen.add(p.id) &&
      typeof p.name === 'string' && p.name.trim() && SIDES.includes(p.side))
      .map(p => ({ id: p.id, name: p.name.trim().slice(0, 40), side: p.side }));
  } catch {
    return [];
  }
}

function saveProducts() {
  try { localStorage.setItem(BOXES_KEY, JSON.stringify(products)); return true; } catch { return false; }
}

/** If the product list was lost but today has presses for products, put those boxes back. */
function recoverProducts() {
  if (products.length) return;
  const names = boxNames(tally.day.events);
  const ids = Object.keys(names).filter(id => names[id].side);
  if (!ids.length) return;
  products = ids.map(id => ({ id, name: names[id].name, side: names[id].side }));
  saveProducts();
  buildBoxes();
}

function newId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Once a second while showing (Chrome slows it when hidden). Notices midnight. */
async function tick() {
  if (!tally) return;
  const before = tally.day.key;
  if (await tally.ensureDay()) afterChange(before);
}

// ------------------------------------------------------------------ input

function wireInput() {
  // A product box counts on finger-down / mouse-down: the first finger only, the left button only.
  el.board.addEventListener('pointerdown', e => {
    const box = e.target.closest('.box');
    if (!box || !e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    if (!tally || performance.now() < blockedUntil) return;
    pressBox(box.dataset.id, box);
  });
  // Keyboard users: Tab to a box, then Enter or Space (that "click" has no pointer, detail 0).
  el.board.addEventListener('click', e => {
    const box = e.target.closest('.box');
    if (box && e.detail === 0 && tally) pressBox(box.dataset.id, box);
  });
  el.board.addEventListener('contextmenu', e => e.preventDefault());
  el.board.addEventListener('click', e => {
    if (e.target.closest('[data-open-products]')) openSettings('products');
  });

  // Buttons never keep focus after a mouse click, so a later Space/Enter can't re-press them.
  document.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });

  el.resetBtn.addEventListener('click', askReset);
  el.settingsBtn.addEventListener('click', () => openSettings('history'));
  el.fullBtn.addEventListener('click', toggleFullscreen);
  el.logBtn.addEventListener('click', () => setLogOpen(!logOpen));
  el.logClose.addEventListener('click', () => setLogOpen(false));
  el.undoBtn.addEventListener('click', doUndo);
  el.settingsClose.addEventListener('click', closeSettings);
  el.tabHistory.addEventListener('click', () => setTab('history'));
  el.tabProducts.addEventListener('click', () => setTab('products'));
  el.dialogCancel.addEventListener('click', closeDialog);
  el.dialogConfirm.addEventListener('click', confirmDialog);
  el.csvBtn.addEventListener('click', saveCsv);
  el.keepOn.addEventListener('change', () => setKeepOn(el.keepOn.checked));
  for (const ev of ['pointermove', 'pointerdown', 'wheel']) el.log.addEventListener(ev, keepLogOpen, { passive: true });
  wireProductsEditor();
  window.addEventListener('resize', () => drawCount(String(tally ? tally.count : 0)));
  document.addEventListener('fullscreenchange', renderFullscreenButton);
  if (!document.fullscreenEnabled) el.fullBtn.hidden = true;
  window.addEventListener('keydown', onKey, true);
}

function onKey(e) {
  if (!tally || !el.elsewhere.hidden) return;
  if (!el.dialog.hidden) {
    // Enter/Space never confirm by accident; Esc cancels.
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && !el.dialog.contains(e.target)) e.preventDefault();
    return;
  }
  if (!el.settings.hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeSettings(); }
    return;
  }
  if (e.key === 'Escape') { if (logOpen) setLogOpen(false); return; }
  if ((e.ctrlKey && (e.key === 'z' || e.key === 'Z')) ||
      (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'Backspace' || e.key === '-' || e.code === 'NumpadSubtract'))) {
    e.preventDefault();
    if (!e.repeat) doUndo();
  }
}

// ------------------------------------------------------------------ counting

async function pressBox(id, boxEl) {
  const product = products.find(p => p.id === id);
  if (!product) return;
  const before = tally.day.key;
  flash(boxEl);
  await tally.tap(product);
  afterChange(before);
  pulse();
}

async function doUndo() {
  if (!tally) return;
  const before = tally.day.key;
  const e = await tally.undo();
  afterChange(before);
  if (!e) { toast(tally.count === 0 ? 'Nothing to undo. The total is 0.' : 'Nothing to undo since the last reset or restore.'); return; }
  const what = e.box ? `${nameOf(e.box, e.boxName)} (${SIDE_NAMES[e.side] || ''})` : 'the last press';
  toast(`Undone: ${what}. The total is now ${tally.count}.`);
}

async function askReset() {
  if (!tally) return;
  await tick();
  if (tally.count === 0) { toast('Everything is already at 0.'); return; }
  showDialog('Reset everything to 0?',
    `Today's total of ${tally.count} and every product's count are kept in Settings, so you can bring them back if this was a mistake.`,
    'Reset to 0', true,
    async () => {
      const before = tally.day.key;
      await tally.reset();
      afterChange(before);
      toast('Reset. Counting from 0.');
    });
}

/** Re-renders after any change, and announces a new day if one started during it. */
function afterChange(dayBefore) {
  if (tally.day.key !== dayBefore) announceNewDay(dayBefore);
  renderAll();
}

async function announceNewDay(prevKey) {
  logKey = null;
  const prev = await tally.readDay(prevKey);
  const ended = prev.length ? prev[prev.length - 1].count : 0;
  const when = prevKey === addDays(tally.day.key, -1) ? 'Yesterday' : fmtDayShort(prevKey);
  toast(ended > 0
    ? `New day. Everything starts from 0. ${when} ended at ${ended} (saved in Settings).`
    : 'New day. Everything starts from 0.', 7000);
  if (!el.settings.hidden) refreshHistory();
}

function nameOf(id, fallback) {
  const p = products.find(x => x.id === id);
  return p ? p.name : (fallback || 'Removed product');
}

// ------------------------------------------------------------------ rendering

function renderAll() {
  renderBoxValues();
  drawCount(String(tally.count));
  renderStatus();
  syncLog(false);
  renderSaveState();
}

/** Builds the product boxes from the product list (after start-up or a change in Settings). */
function buildBoxes() {
  boxEls = new Map();
  for (const side of SIDES) {
    const list = products.filter(p => p.side === side);
    const wrap = el.boxes[side];
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'side-empty';
      const text = document.createElement('span');
      text.textContent = `No ${SIDE_NAMES[side].toLowerCase()} products yet.`;
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'link';
      add.dataset.openProducts = side;
      add.textContent = 'Add products';
      empty.append(text, add);
      wrap.replaceChildren(empty);
      continue;
    }
    wrap.replaceChildren(...list.map(p => {
      const root = document.createElement('button');
      root.type = 'button';
      root.className = 'box';
      root.dataset.id = p.id;
      const name = document.createElement('span');
      name.className = 'box-name';
      name.textContent = p.name;
      const count = document.createElement('span');
      count.className = 'box-count';
      count.textContent = '0';
      const time = document.createElement('span');
      time.className = 'box-time';
      root.append(name, count, time);
      root.setAttribute('aria-label', `${p.name}, ${SIDE_NAMES[side]}`);
      boxEls.set(p.id, { root, count, time });
      return root;
    }));
  }
  if (tally) renderBoxValues();
}

function renderBoxValues() {
  for (const [id, b] of boxEls) {
    const n = tally ? tally.day.boxCount(id) : 0;
    const t = tally ? tally.day.boxLastTime(id) : null;
    b.count.textContent = String(n);
    b.time.textContent = t ? `Last ${fmtTime(t)}` : n > 0 ? 'Restored' : 'No presses yet';
  }
}

/** Draws the total so the digits fill about 42% of the middle column's height, never wider than 90% of it. */
function drawCount(text) {
  const box = el.center.getBoundingClientRect();
  const w = box.width, h = box.height;
  if (!w || !h) return;
  const canvas = el.count;
  const ctx = canvas.getContext('2d');
  ctx.font = `600 100px ${NUMBER_FONT}`;
  const m = ctx.measureText(text);
  const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  if (!inkW || !inkH) return;
  const scale = Math.min(h * (h < 520 ? 0.36 : 0.42) / inkH, w * 0.9 / inkW);
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.ceil(inkW * scale) + 2, cssH = Math.ceil(inkH * scale) + 2;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr, dpr);
  ctx.font = `600 100px ${NUMBER_FONT}`;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#F4F3EF';
  ctx.fillText(text, m.actualBoundingBoxLeft, m.actualBoundingBoxAscent);
  canvas.setAttribute('aria-label', `Total ${text}`);
  el.last.style.fontSize = `${Math.max(16, Math.min(28, window.innerHeight * 0.03))}px`;
  el.last.style.marginTop = `${Math.max(16, h * 0.05)}px`;
}

function renderStatus() {
  const lastTap = tally.day.lastTapTime;
  const last = tally.day.last;
  if (lastTap) el.last.textContent = `Last press  ${fmtTime(lastTap)}`;
  else if (!last) el.last.textContent = 'No presses yet today';
  else if (last.action === 'RESET') el.last.textContent = `Reset at ${fmtTime(parseStamp(last.time))}`;
  else if (last.action === 'RESTORE') el.last.textContent = `Restored at ${fmtTime(parseStamp(last.time))}`;
  else el.last.textContent = `Changed at ${fmtTime(parseStamp(last.time))}`;
  el.date.textContent = fmtDayLong(tally.day.key);
  el.hint.textContent = !products.length ? 'Add your products in Settings to start counting'
    : tally.day.events.length === 0 ? 'Tap a product to count it' : '';
  el.hint.hidden = !el.hint.textContent;
}

function renderSaveState() {
  if (tally && !(tally.storage instanceof MemoryStorage)) el.saveBanner.hidden = !tally.saveFailing;
}

function flash(boxEl) {
  if (!boxEl || !motion()) return;
  boxEl.classList.remove('hit');
  void boxEl.offsetWidth;
  boxEl.classList.add('hit');
}

function pulse() {
  if (!motion()) return;
  el.count.animate([{ transform: 'scale(1.05)' }, { transform: 'scale(1)' }],
    { duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
}

function toast(message, ms = 2800) {
  lastToast = message;
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

// ------------------------------------------------------------------ log panel

function setLogOpen(open) {
  const wasOpen = logOpen;
  logOpen = open;
  if (open && !wasOpen) syncLog(true);
  el.log.classList.toggle('open', open);
  el.logBtn.setAttribute('aria-expanded', String(open));
  clearTimeout(logHideTimer);
  if (open) logHideTimer = setTimeout(() => setLogOpen(false), LOG_AUTO_HIDE_MS);
}

function keepLogOpen() {
  if (!logOpen) return;
  clearTimeout(logHideTimer);
  logHideTimer = setTimeout(() => setLogOpen(false), LOG_AUTO_HIDE_MS);
}

/** Keeps the log in step with today's events (newest first). Cheap when only new presses arrived. */
function syncLog(rebuild) {
  el.undoBtn.disabled = !tally.day.lastLive;
  if (!logOpen && !rebuild) return;
  const evs = tally.day.events;
  if (rebuild || logKey !== tally.day.key || logShown > evs.length) {
    const rows = [];
    for (let i = evs.length - 1; i >= 0; i--) rows.push(rowFor(evs[i]));
    el.logList.replaceChildren(...rows);
  } else {
    for (let i = logShown; i < evs.length; i++) el.logList.prepend(rowFor(evs[i]));
  }
  logKey = tally.day.key;
  logShown = evs.length;
  el.logSub.textContent = `${fmtDayLong(tally.day.key)}  ·  ${plural(summarize(tally.day.key, evs).presses, 'press', 'presses')}`;
  el.logEmpty.hidden = evs.length > 0;
}

/** One line of a log: the total after it, the time, and what happened. */
function rowFor(e) {
  const li = document.createElement('li');
  const badge = document.createElement('span');
  const time = document.createElement('span');
  const kind = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = String(e.count);
  time.className = 'time';
  time.textContent = fmtTime(parseStamp(e.time));
  kind.className = 'kind';
  const product = e.box ? `${nameOf(e.box, e.boxName)} · ${SIDE_NAMES[e.side] || ''}` : '';
  if (e.action === 'TAP') {
    kind.textContent = product;
    if (e.side) kind.classList.add(e.side);
  } else if (e.action === 'UNDO') {
    kind.textContent = product ? `Undo ${product}` : 'Undo';
    badge.classList.add('undo');
  } else if (e.action === 'RESET') {
    const was = parseInt(e.note, 10);
    kind.textContent = Number.isInteger(was) ? `Reset (was ${was})` : 'Reset';
    badge.classList.add('reset');
  } else {
    const from = parseStamp(e.note);
    kind.textContent = !from ? 'Restored'
      : e.note.startsWith(e.day) ? `Restored (${fmtTimeShort(from)})` : `Restored from ${fmtDayShort(e.note.slice(0, 10))}`;
    badge.classList.add('restore');
  }
  kind.title = kind.textContent;
  li.append(badge, time, kind);
  return li;
}

// ------------------------------------------------------------------ settings

async function openSettings(tab) {
  if (!tally) return;
  await tick();
  setLogOpen(false);
  selectedDay = tally.day.key;
  await setTab(tab === 'products' ? 'products' : 'history');
  el.settings.hidden = false;
  if (tab === 'products' && !products.length) el.addName.card.focus();
}

/** Fills the page before showing it, so it never flashes old content. */
async function setTab(tab) {
  const showProducts = tab === 'products';
  if (showProducts) renderProductsEditor();
  else await refreshHistory();
  el.tabHistory.setAttribute('aria-selected', String(!showProducts));
  el.tabProducts.setAttribute('aria-selected', String(showProducts));
  el.historyPane.hidden = showProducts;
  el.productsPane.hidden = !showProducts;
  el.setNote.textContent = showProducts ? NOTE_PRODUCTS : NOTE_HISTORY;
}

function closeSettings() {
  if (document.activeElement && el.settings.contains(document.activeElement)) document.activeElement.blur();
  el.settings.hidden = true;
  guardTaps();
}

// ---- history and restore

async function refreshHistory() {
  const days = await tally.listDays();
  if (!days.some(d => d.day === selectedDay)) selectedDay = tally.day.key;
  el.dayList.replaceChildren(...days.map(d => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day';
    btn.dataset.day = d.day;
    btn.setAttribute('aria-pressed', String(d.day === selectedDay));
    const text = document.createElement('span');
    const title = document.createElement('b');
    const sub = document.createElement('small');
    title.textContent = d.day === tally.day.key ? 'Today'
      : d.day === addDays(tally.day.key, -1) ? 'Yesterday' : dayName(d.day);
    sub.textContent = `${fmtDate(d.day)}  ·  ${d.lastTapTime ? `last press ${fmtTimeShort(d.lastTapTime)}`
      : d.lastTime ? `changed ${fmtTimeShort(d.lastTime)}` : 'no presses'}`;
    text.append(title, sub);
    const count = document.createElement('b');
    count.className = 'dcount';
    count.textContent = String(d.finalCount);
    btn.append(text, count);
    btn.addEventListener('click', () => { selectedDay = d.day; markSelectedDay(); showDay(d.day); });
    li.append(btn);
    return li;
  }));
  await showDay(selectedDay);
}

function markSelectedDay() {
  for (const b of el.dayList.querySelectorAll('.day')) b.setAttribute('aria-pressed', String(b.dataset.day === selectedDay));
}

/** "gIet 1 · auber 2" chips per side for a set of box counts. */
function breakdownChips(boxes, names) {
  const chips = [];
  for (const side of SIDES) {
    const parts = Object.entries(boxes)
      .filter(([id, n]) => n > 0 && ((products.find(p => p.id === id) || names[id] || {}).side === side))
      .sort((a, b) => {
        const ia = products.findIndex(p => p.id === a[0]), ib = products.findIndex(p => p.id === b[0]);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
      })
      .map(([id, n]) => [nameOf(id, names[id] && names[id].name), n]);
    if (!parts.length) continue;
    const chip = document.createElement('span');
    chip.className = `chip ${side}-side`;
    chip.append(`${SIDE_NAMES[side]}: `);
    parts.forEach(([name, n], i) => {
      if (i) chip.append(' · ');
      chip.append(`${name} `);
      const b = document.createElement('b');
      b.textContent = String(n);
      chip.append(b);
    });
    chips.push(chip);
  }
  return chips;
}

function breakdownText(boxes, names) {
  return breakdownChips(boxes, names).map(c => c.textContent).join('   ');
}

async function showDay(key) {
  const isToday = key === tally.day.key;
  const evs = await tally.readDay(key);
  const s = summarize(key, evs);
  el.dayTitle.textContent = `${isToday ? 'Today, ' : ''}${fmtDayLong(key)}`;
  el.daySub.textContent = !evs.length
    ? (isToday ? 'No presses yet today.' : 'No presses on this day.')
    : `${isToday ? 'Total now' : 'Ended at'} ${s.finalCount}  ·  ${plural(s.presses, 'press', 'presses')}` +
      (s.lastTapTime ? `  ·  last press ${fmtTime(s.lastTapTime)}` : '');
  el.dayBreakdown.replaceChildren(...breakdownChips(s.boxes, s.names));

  const rows = [];
  for (const p of restorePoints(evs)) {
    const isLatest = p.resetAt === null;
    if (isToday && isLatest) continue; // already on screen
    const showing = p.count === tally.count && JSON.stringify(sorted(p.boxes)) === JSON.stringify(sorted(tally.day.boxes));
    const row = document.createElement('div');
    row.className = 'restore-row';
    const num = document.createElement('span');
    num.className = 'rcount';
    num.textContent = String(p.count);
    const text = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = isLatest ? 'Last count of the day' : `Count before the reset at ${fmtTimeShort(parseStamp(p.resetAt))}`;
    const sub = document.createElement('small');
    const split = breakdownText(p.boxes, s.names);
    sub.textContent = `Reached at ${fmtTime(parseStamp(p.time))}${split ? `   ·   ${split}` : ''}`;
    text.append(title, sub);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.disabled = showing;
    btn.textContent = showing ? 'Showing now' : `Restore ${p.count}`;
    btn.addEventListener('click', () => askRestore(key, p, split));
    row.append(num, text, btn);
    rows.push(row);
  }
  el.restoreList.replaceChildren(...rows);
  el.restoreEmpty.textContent = isToday
    ? "Today's count is already on screen. If Reset is pressed by mistake, the count from before it appears here."
    : 'Nothing to restore from this day.';
  el.restoreEmpty.hidden = rows.length > 0;

  const presses = [];
  for (let i = evs.length - 1; i >= 0; i--) presses.push(rowFor(evs[i]));
  el.dayLog.replaceChildren(...presses);
  el.csvBtn.hidden = evs.length === 0;
}

function sorted(boxes) {
  return Object.keys(boxes).filter(k => boxes[k] > 0).sort().map(k => [k, boxes[k]]);
}

function askRestore(key, point, split) {
  const from = key === tally.day.key ? 'earlier today' : fmtDayLong(key);
  const body = (tally.count === 0
    ? `The total will show ${point.count} (from ${from}) and carry on counting from there.`
    : `The total shows ${tally.count} now. It will change to ${point.count} (from ${from}).`) +
    (split ? ` Each product gets its count back too: ${split}.` : '') + ' Nothing is deleted: every press stays in the log.';
  showDialog(`Restore ${point.count}?`, body, `Restore ${point.count}`, false, async () => {
    const before = tally.day.key;
    await tally.restore(point.count, point.time, point.boxes);
    closeSettings();
    afterChange(before);
    toast(`Restored ${point.count} from ${from}.`, 4000);
  });
}

async function saveCsv() {
  const evs = await tally.readDay(selectedDay);
  const blob = new Blob([toCsv(evs)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Aziz Tally ${fmtDate(selectedDay).replace(/\//g, '-')}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('Saved a copy to the Downloads folder.');
}

// ---- products

function wireProductsEditor() {
  for (const form of el.productsPane.querySelectorAll('.prod-add')) {
    form.addEventListener('submit', e => {
      e.preventDefault();
      addProduct(form.dataset.side, el.addName[form.dataset.side].value);
    });
  }
  el.productsPane.addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('.prod-row').dataset.id;
    if (btn.dataset.act === 'up') moveProduct(id, -1);
    else if (btn.dataset.act === 'down') moveProduct(id, 1);
    else if (btn.dataset.act === 'switch') switchSide(id);
    else if (btn.dataset.act === 'remove') askRemove(id);
  });
  el.productsPane.addEventListener('change', e => {
    if (e.target.classList.contains('prod-name')) renameProduct(e.target.closest('.prod-row').dataset.id, e.target);
  });
  el.productsPane.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.classList.contains('prod-name')) e.target.blur();
  });
}

function renderProductsEditor() {
  for (const side of SIDES) {
    const list = products.filter(p => p.side === side);
    const other = side === 'card' ? 'cash' : 'card';
    if (!list.length) {
      const empty = document.createElement('li');
      empty.className = 'prod-empty';
      empty.textContent = `No ${SIDE_NAMES[side].toLowerCase()} products yet. Type a name below and press Add.`;
      el.prodList[side].replaceChildren(empty);
      continue;
    }
    el.prodList[side].replaceChildren(...list.map((p, i) => {
      const li = document.createElement('li');
      li.className = 'prod-row';
      li.dataset.id = p.id;
      const input = document.createElement('input');
      input.className = 'prod-name';
      input.type = 'text';
      input.maxLength = 40;
      input.value = p.name;
      input.setAttribute('aria-label', `Name of ${p.name} (${SIDE_NAMES[side]})`);
      li.append(input,
        actionButton('up', 'Move up', '<path d="M10 15V5M5.5 9.5 10 5l4.5 4.5"/>', i === 0),
        actionButton('down', 'Move down', '<path d="M10 5v10M5.5 10.5 10 15l4.5-4.5"/>', i === list.length - 1),
        actionButton('switch', `Move to the ${SIDE_NAMES[other]} side`, null, false, `To ${SIDE_NAMES[other]}`),
        actionButton('remove', `Remove ${p.name}`, '<path d="M5 5l10 10M15 5 5 15"/>', false));
      return li;
    }));
  }
}

function actionButton(act, title, svgPath, disabled, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.act = act;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.className = label ? 'soft' : `soft icon small${act === 'remove' ? ' remove' : ''}`;
  b.disabled = disabled;
  if (svgPath) b.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${svgPath}</svg>`;
  else b.textContent = label;
  return b;
}

function cleanName(raw) { return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 40); }

function productsChanged(message) {
  const saved = saveProducts();
  buildBoxes();
  renderProductsEditor();
  renderStatus();
  toast(saved ? message : "Couldn't save the product list. It works until Aziz Tally is closed.");
}

function addProduct(side, raw) {
  const name = cleanName(raw);
  const input = el.addName[side];
  if (!name) { input.focus(); toast('Type the product name first.'); return; }
  if (products.some(p => p.side === side && p.name.toLowerCase() === name.toLowerCase())) {
    toast(`There's already a ${name} on the ${SIDE_NAMES[side]} side.`);
    return;
  }
  products.push({ id: newId(), name, side });
  input.value = '';
  productsChanged(`Added ${name} to ${SIDE_NAMES[side]}.`);
  input.focus();
}

function renameProduct(id, input) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  const name = cleanName(input.value);
  if (!name) { input.value = p.name; toast('A product needs a name.'); return; }
  if (name === p.name) { input.value = name; return; }
  if (products.some(x => x.id !== id && x.side === p.side && x.name.toLowerCase() === name.toLowerCase())) {
    input.value = p.name;
    toast(`There's already a ${name} on the ${SIDE_NAMES[p.side]} side.`);
    return;
  }
  const old = p.name;
  p.name = name;
  productsChanged(`Renamed ${old} to ${name}. Its count stays the same.`);
}

function moveProduct(id, dir) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  const same = products.filter(x => x.side === p.side);
  const j = same.indexOf(p) + dir;
  if (j < 0 || j >= same.length) return;
  const a = products.indexOf(p), b = products.indexOf(same[j]);
  [products[a], products[b]] = [products[b], products[a]];
  productsChanged(`Moved ${p.name} ${dir < 0 ? 'up' : 'down'}.`);
}

function switchSide(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  const to = p.side === 'card' ? 'cash' : 'card';
  if (products.some(x => x.side === to && x.name.toLowerCase() === p.name.toLowerCase())) {
    toast(`There's already a ${p.name} on the ${SIDE_NAMES[to]} side.`);
    return;
  }
  // Presses already counted stay with the product, so its count moves with it.
  products.splice(products.indexOf(p), 1);
  p.side = to;
  products.push(p);
  productsChanged(`Moved ${p.name} to the ${SIDE_NAMES[to]} side.`);
}

function askRemove(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  const n = tally.day.boxCount(id);
  showDialog(`Remove ${p.name} (${SIDE_NAMES[p.side]})?`,
    n > 0
      ? `Its box disappears from the counter. Today's ${n} ${n === 1 ? 'press stays' : 'presses stay'} in the total and in the history.`
      : 'Its box disappears from the counter. Past presses stay in the history.',
    'Remove', true,
    () => {
      products = products.filter(x => x.id !== id);
      productsChanged(`Removed ${p.name}.`);
    });
}

// ------------------------------------------------------------------ dialog

function showDialog(title, body, confirmText, danger, onConfirm) {
  el.dialogTitle.textContent = title;
  el.dialogBody.textContent = body;
  el.dialogConfirm.textContent = confirmText;
  el.dialogConfirm.className = danger ? 'danger' : 'primary';
  dialogAction = onConfirm;
  el.dialog.hidden = false;
}

function closeDialog() {
  dialogAction = null;
  el.dialog.hidden = true;
  guardTaps();
}

function confirmDialog() {
  const action = dialogAction;
  closeDialog();
  if (action) action();
}

function guardTaps() { blockedUntil = performance.now() + TAP_GUARD_MS; }

// ------------------------------------------------------------------ window, install, screen-on

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { /* not allowed here; nothing to do */ }
}

function renderFullscreenButton() {
  const full = !!document.fullscreenElement;
  el.fullIcon.innerHTML = full
    ? '<path d="M7.5 3.5v4h-4M12.5 3.5v4h4M7.5 16.5v-4h-4M12.5 16.5v-4h4"/>'
    : '<path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4"/>';
  el.fullBtn.title = full ? 'Leave full screen (Esc)' : 'Full screen';
}

function watchInstall() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    el.installBtn.hidden = false;
  });
  el.installBtn.addEventListener('click', async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    prompt.prompt();
    const choice = await prompt.userChoice.catch(() => ({ outcome: 'dismissed' }));
    el.installBtn.hidden = choice.outcome === 'accepted';
    if (choice.outcome !== 'accepted') installPrompt = prompt;
  });
  window.addEventListener('appinstalled', () => {
    el.installBtn.hidden = true;
    toast('Installed. Aziz Tally is now in the launcher, and it works without internet.', 6000);
  });
}

function setKeepOn(on) {
  settings.keepOn = on;
  const saved = saveSettings();
  applyWakeLock();
  toast(!saved ? "Couldn't save that setting. It works until Aziz Tally is closed."
    : on ? 'The screen will stay on while Aziz Tally is open.' : 'The screen can turn off as normal now.');
}

/** Asks Chrome to keep the screen on while the app is showing (like a video player does). */
async function applyWakeLock() {
  if (!settings.keepOn || document.visibilityState !== 'visible') {
    if (wakeLock && !settings.keepOn) { try { await wakeLock.release(); } catch { /* already gone */ } }
    if (!settings.keepOn) wakeLock = null;
    return;
  }
  if (!('wakeLock' in navigator) || (wakeLock && !wakeLock.released)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { if (wakeLock && wakeLock.released) wakeLock = null; });
  } catch {
    wakeLock = null;
  }
}

// Read-only view of the app's state, used by the automated tests.
window.azizTally = {
  get ready() { return tally !== null; },
  get count() { return tally ? tally.count : null; },
  get day() { return tally ? tally.day.key : null; },
  get events() { return tally ? tally.day.events.length : null; },
  get products() { return products.map(p => ({ ...p })); },
  boxCount(id) { return tally ? tally.day.boxCount(id) : null; },
  get logOpen() { return logOpen; },
  get toast() { return lastToast; },
  get wakeLock() { return !!(wakeLock && !wakeLock.released); },
  get installOffered() { return !el.installBtn.hidden; },
  saved() { return tally ? tally.whenSaved() : Promise.resolve(); },
};
