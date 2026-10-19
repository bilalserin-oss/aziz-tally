// Aziz Tally for Chromebook - the screen. Counting rules live in core.js, saving in store.js.

import {
  Tally, MemoryStorage, VERSION, addDays, parseStamp, fmtTime, fmtTimeShort, fmtDate,
  fmtDayLong, fmtDayShort, dayName, plural, summarize, restorePoints, toCsv,
} from './core.js';
import { IdbStorage } from './store.js';

const $ = id => document.getElementById(id);
const el = {
  surface: $('surface'), ripples: $('ripples'), count: $('count'), last: $('last'), date: $('date'), hint: $('hint'),
  resetBtn: $('resetBtn'), installBtn: $('installBtn'), fullBtn: $('fullBtn'), fullIcon: $('fullIcon'), settingsBtn: $('settingsBtn'),
  log: $('log'), logHandle: $('logHandle'), logPanel: $('logPanel'), logSub: $('logSub'), logClose: $('logClose'),
  logList: $('logList'), logEmpty: $('logEmpty'), undoBtn: $('undoBtn'),
  toast: $('toast'), saveBanner: $('saveBanner'),
  settings: $('settings'), settingsClose: $('settingsClose'), dayList: $('dayList'), dayTitle: $('dayTitle'), daySub: $('daySub'),
  restoreList: $('restoreList'), restoreEmpty: $('restoreEmpty'), csvBtn: $('csvBtn'), dayLog: $('dayLog'),
  keepOn: $('keepOn'), aboutText: $('aboutText'),
  dialog: $('dialog'), dialogTitle: $('dialogTitle'), dialogBody: $('dialogBody'), dialogCancel: $('dialogCancel'), dialogConfirm: $('dialogConfirm'),
  elsewhere: $('elsewhere'),
};

const LOG_AUTO_HIDE_MS = 45000;
// After a dialog or Settings closes, ignore screen presses briefly so the second half
// of a double-click on "Reset"/"Restore"/"Close" can't land on the counter.
const TAP_GUARD_MS = 450;
const NUMBER_FONT = 'system-ui, "Segoe UI", Roboto, sans-serif';
const SETTINGS_KEY = 'aziz-tally-settings';

let tally = null;
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
  el.aboutText.textContent = `Aziz Tally ${VERSION} for Chromebook   ·   Keys: Space or Enter = add 1,  Backspace = undo   ·   Counts are saved in this Chromebook's Chrome, under this Google account`;
  el.keepOn.checked = settings.keepOn;
  renderEmptyFrame();

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
  tally = new Tally(storage);
  tally.onSaveState = renderSaveState;
  await tally.open();
  renderAll();
  if (tally.count > 0) toast(`Welcome back. Carrying on from today's count of ${tally.count}.`, 4000);

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
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** Once a minute is plenty when hidden; once a second while showing. Notices midnight. */
async function tick() {
  if (!tally) return;
  const before = tally.day.key;
  if (await tally.ensureDay()) afterChange(before);
}

// ------------------------------------------------------------------ input

function wireInput() {
  el.surface.addEventListener('pointerdown', e => {
    // Count the first finger (or the mouse's left button) once; ignore extra fingers and other buttons.
    if (!e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    if (!tally || performance.now() < blockedUntil) return;
    doTap(e.clientX, e.clientY);
  });
  el.surface.addEventListener('contextmenu', e => e.preventDefault());

  // Buttons never keep keyboard focus after a click, so Space/Enter always count instead of re-pressing them.
  document.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });

  el.resetBtn.addEventListener('click', askReset);
  el.settingsBtn.addEventListener('click', openSettings);
  el.fullBtn.addEventListener('click', toggleFullscreen);
  el.logHandle.addEventListener('click', () => setLogOpen(!logOpen));
  el.logClose.addEventListener('click', () => setLogOpen(false));
  el.undoBtn.addEventListener('click', doUndo);
  el.settingsClose.addEventListener('click', closeSettings);
  el.dialogCancel.addEventListener('click', closeDialog);
  el.dialogConfirm.addEventListener('click', confirmDialog);
  el.csvBtn.addEventListener('click', saveCsv);
  el.keepOn.addEventListener('change', () => setKeepOn(el.keepOn.checked));
  for (const ev of ['pointermove', 'pointerdown', 'wheel']) el.logPanel.addEventListener(ev, keepLogOpen, { passive: true });
  window.addEventListener('resize', renderCount);
  document.addEventListener('fullscreenchange', renderFullscreenButton);
  if (!document.fullscreenEnabled) el.fullBtn.hidden = true;

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', e => {
    if ((e.key === ' ' || e.key === 'Enter') && el.settings.hidden) e.preventDefault();
  }, true);
}

function onKey(e) {
  if (!tally || !el.elsewhere.hidden) return;
  const tapKey = e.key === ' ' || e.key === 'Enter' || e.key === '+' || e.key === '=' || e.key === 'ArrowUp' || e.code === 'NumpadAdd';
  if (!el.dialog.hidden) {
    // Enter/Space never confirm, so fast counting can't reset by accident.
    if (e.key === 'Escape') closeDialog();
    if (tapKey || e.key === 'Escape') e.preventDefault();
    return;
  }
  if (!el.settings.hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeSettings(); }
    return;
  }
  if (e.key === 'Escape') { if (logOpen) setLogOpen(false); return; }
  if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (!e.repeat) doUndo();
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (tapKey) {
    e.preventDefault();
    if (!e.repeat) doTap(null, null); // holding a key down counts once
    return;
  }
  if (e.key === 'Backspace' || e.key === '-' || e.code === 'NumpadSubtract') {
    e.preventDefault();
    if (!e.repeat) doUndo();
  }
}

// ------------------------------------------------------------------ counting

async function doTap(x, y) {
  const before = tally.day.key;
  if (x !== null) ripple(x, y);
  await tally.tap();
  afterChange(before);
  pulse();
}

async function doUndo() {
  if (!tally) return;
  const before = tally.day.key;
  const e = await tally.undo();
  afterChange(before);
  toast(e ? `Undone. The count is now ${tally.count}.` : 'Nothing to undo. The count is 0.');
}

async function askReset() {
  if (!tally) return;
  await tick();
  if (tally.count === 0) { toast('The count is already 0.'); return; }
  showDialog('Reset the count to 0?',
    `Today's count of ${tally.count} is kept in Settings, so you can bring it back if this was a mistake.`,
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
    ? `New day. Counting from 0. ${when} ended at ${ended} (saved in Settings).`
    : 'New day. Counting from 0.', 7000);
  if (!el.settings.hidden) refreshSettings();
}

// ------------------------------------------------------------------ rendering

function renderEmptyFrame() {
  drawCount('0');
  el.last.textContent = '';
  el.hint.hidden = true;
}

function renderAll() {
  renderCount();
  renderStatus();
  syncLog(false);
  renderSaveState();
}

function renderCount() { drawCount(String(tally ? tally.count : 0)); }

/** Draws the number so the digits fill about 42% of the height (less on short screens), never wider than 84%. */
function drawCount(text) {
  const w = window.innerWidth, h = window.innerHeight;
  if (!w || !h) return;
  const canvas = el.count;
  const ctx = canvas.getContext('2d');
  ctx.font = `600 100px ${NUMBER_FONT}`;
  const m = ctx.measureText(text);
  const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  if (!inkW || !inkH) return;
  const scale = Math.min(h * (h < 640 ? 0.36 : 0.42) / inkH, w * 0.84 / inkW);
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
  canvas.setAttribute('aria-label', `Count ${text}`);
  el.last.style.fontSize = `${Math.max(17, Math.min(30, h * 0.032))}px`;
  el.last.style.marginTop = `${Math.max(18, h * 0.05)}px`;
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
  el.hint.hidden = tally.day.events.length > 0;
}

function renderSaveState() {
  if (tally && !(tally.storage instanceof MemoryStorage)) el.saveBanner.hidden = !tally.saveFailing;
}

function pulse() {
  if (!motion()) return;
  el.count.animate([{ transform: 'scale(1.05)' }, { transform: 'scale(1)' }],
    { duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
}

function ripple(x, y) {
  if (!motion()) return;
  while (el.ripples.childElementCount > 10) el.ripples.firstElementChild.remove();
  const dot = document.createElement('div');
  dot.className = 'ripple';
  dot.style.left = `${x}px`;
  dot.style.top = `${y}px`;
  el.ripples.append(dot);
  dot.animate([{ transform: 'scale(0.15)', opacity: 1 }, { transform: 'scale(1)', opacity: 0 }],
    { duration: 520, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' }).onfinish = () => dot.remove();
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
  el.logHandle.setAttribute('aria-expanded', String(open));
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
  el.undoBtn.disabled = tally.count <= 0;
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
  if (e.action === 'UNDO') { kind.textContent = 'Undo'; badge.classList.add('undo'); }
  else if (e.action === 'RESET') {
    const was = parseInt(e.note, 10);
    kind.textContent = Number.isInteger(was) ? `Reset (was ${was})` : 'Reset';
    badge.classList.add('reset');
  } else if (e.action === 'RESTORE') {
    const from = parseStamp(e.note);
    kind.textContent = !from ? 'Restored'
      : e.note.startsWith(e.day) ? `Restored (${fmtTimeShort(from)})` : `Restored from ${fmtDayShort(e.note.slice(0, 10))}`;
    badge.classList.add('restore');
  }
  li.append(badge, time, kind);
  return li;
}

// ------------------------------------------------------------------ settings / restore

async function openSettings() {
  if (!tally) return;
  await tick();
  setLogOpen(false);
  selectedDay = tally.day.key;
  await refreshSettings();
  el.settings.hidden = false;
}

async function refreshSettings() {
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

async function showDay(key) {
  const isToday = key === tally.day.key;
  const evs = await tally.readDay(key);
  const s = summarize(key, evs);
  el.dayTitle.textContent = `${isToday ? 'Today, ' : ''}${fmtDayLong(key)}`;
  el.daySub.textContent = !evs.length
    ? (isToday ? 'No presses yet today.' : 'No presses on this day.')
    : `${isToday ? 'Count now' : 'Ended at'} ${s.finalCount}  ·  ${plural(s.presses, 'press', 'presses')}` +
      (s.lastTapTime ? `  ·  last press ${fmtTime(s.lastTapTime)}` : '');

  const rows = [];
  for (const p of restorePoints(evs)) {
    const isLatest = p.resetAt === null;
    if (isToday && isLatest) continue; // that number is already on screen
    const showing = p.count === tally.count;
    const row = document.createElement('div');
    row.className = 'restore-row';
    const num = document.createElement('span');
    num.className = 'rcount';
    num.textContent = String(p.count);
    const text = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = isLatest ? 'Last count of the day' : `Count before the reset at ${fmtTimeShort(parseStamp(p.resetAt))}`;
    const sub = document.createElement('small');
    sub.textContent = `Reached at ${fmtTime(parseStamp(p.time))}`;
    text.append(title, sub);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.disabled = showing;
    btn.textContent = showing ? 'Showing now' : `Restore ${p.count}`;
    btn.addEventListener('click', () => askRestore(key, p));
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

function askRestore(key, point) {
  const from = key === tally.day.key ? 'earlier today' : fmtDayLong(key);
  const body = tally.count === 0
    ? `The counter will show ${point.count} (from ${from}) and carry on counting from there.`
    : `The counter shows ${tally.count} now. It will change to ${point.count} (from ${from}). Nothing is deleted: every press stays in the log.`;
  showDialog(`Restore ${point.count}?`, body, `Restore ${point.count}`, false, async () => {
    const before = tally.day.key;
    await tally.restore(point.count, point.time);
    closeSettings();
    afterChange(before);
    toast(`Restored ${point.count} from ${from}.`, 4000);
  });
}

function closeSettings() {
  el.settings.hidden = true;
  guardTaps();
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

function setKeepOn(on) {
  settings.keepOn = on;
  const saved = saveSettings();
  applyWakeLock();
  toast(!saved ? "Couldn't save that setting. It works until Aziz Tally is closed."
    : on ? 'The screen will stay on while Aziz Tally is open.' : 'The screen can turn off as normal now.');
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
  get logOpen() { return logOpen; },
  get toast() { return lastToast; },
  get wakeLock() { return !!(wakeLock && !wakeLock.released); },
  get installOffered() { return !el.installBtn.hidden; },
  saved() { return tally ? tally.whenSaved() : Promise.resolve(); },
};
