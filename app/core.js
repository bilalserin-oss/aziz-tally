// Aziz Tally for Chromebook - counting logic shared by the app and the tests.
// No screen code and no browser storage in here: storage is passed in, so the
// same logic runs against IndexedDB in the app and an in-memory store in tests.
//
// Every change is one event { day, time, action, count, note } where `count` is
// the total AFTER the event, exactly like the Windows app's day logs.
// Since 1.1 a press is for a product box, so TAP and UNDO also carry
// { box, boxName, side, boxCount } (boxCount = that box AFTER the event) and RESTORE
// carries { boxes: { boxId: count } }. Events saved before 1.1 have none of these
// and still load: they count toward the total only.

export const VERSION = '1.1.0';
export const ACTIONS = ['TAP', 'UNDO', 'RESET', 'RESTORE'];
export const SIDES = ['card', 'cash'];
export const SIDE_NAMES = { card: 'Card', cash: 'Cash' };

const pad = (n, w = 2) => String(n).padStart(w, '0');
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------------------------------------------------------------- dates (local time only)

export function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function stamp(d) {
  return `${dayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function parseStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?$/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0)) : null;
}

export function dayFromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, n) {
  const d = dayFromKey(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

// ---------------------------------------------------------------- formatting (Australian dates)

export function fmtTime(d) {
  return `${d.getHours() % 12 || 12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
export function fmtTimeShort(d) {
  return `${d.getHours() % 12 || 12}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
export function fmtDate(key) {
  const [y, m, d] = key.split('-');
  return `${d}/${m}/${y}`;
}
export function fmtDayLong(key) { return `${DAY_NAMES[dayFromKey(key).getDay()]} ${fmtDate(key)}`; }
export function fmtDayShort(key) {
  const [, m, d] = key.split('-');
  return `${DAY_NAMES[dayFromKey(key).getDay()].slice(0, 3)} ${d}/${m}`;
}
export function dayName(key) { return DAY_NAMES[dayFromKey(key).getDay()]; }
export function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

// ---------------------------------------------------------------- events

export function makeEvent(action, count, now, note = '', extra = null) {
  const e = { day: dayKey(now), time: stamp(now), action, count, note: String(note) };
  return extra ? Object.assign(e, extra) : e;
}

const isCount = n => Number.isInteger(n) && n >= 0;

/** Box counts from a RESTORE event (or anything else): only sensible entries survive. */
export function cleanBoxes(boxes) {
  const out = {};
  if (boxes && typeof boxes === 'object') {
    for (const [id, n] of Object.entries(boxes)) if (typeof id === 'string' && id && isCount(n) && n > 0) out[id] = n;
  }
  return out;
}

/** Anything that isn't a complete, sensible event is ignored when loading. */
export function validEvent(e) {
  return !!e && typeof e === 'object' &&
    ACTIONS.includes(e.action) &&
    isCount(e.count) &&
    typeof e.day === 'string' && typeof e.time === 'string' &&
    parseStamp(e.time) !== null && e.time.startsWith(e.day) &&
    (e.box === undefined || (typeof e.box === 'string' && e.box !== '')) &&
    (e.boxCount === undefined || isCount(e.boxCount));
}

/**
 * One day's events replayed: the total, each box's count, and the presses not cancelled
 * by undo/reset/restore (newest last; Undo takes back the newest).
 */
export class DayState {
  constructor(key, events = []) {
    this.key = key;
    this.events = [];
    this.count = 0;
    this.live = [];
    this.boxes = {};
    for (const e of events) this.apply(e);
  }
  apply(e) {
    this.events.push(e);
    this.count = e.count;
    if (e.action === 'TAP') {
      this.live.push({ time: e.time, box: e.box || null, name: e.boxName || '', side: e.side || '' });
      if (e.box) this.boxes[e.box] = isCount(e.boxCount) ? e.boxCount : (this.boxes[e.box] || 0) + 1;
    } else if (e.action === 'UNDO') {
      const undone = this.live.pop();
      const box = e.box || (undone && undone.box);
      if (box) this.boxes[box] = isCount(e.boxCount) ? e.boxCount : Math.max(0, (this.boxes[box] || 0) - 1);
    } else if (e.action === 'RESET') {
      this.live.length = 0;
      this.boxes = {};
    } else {
      this.live.length = 0;
      this.boxes = cleanBoxes(e.boxes);
    }
  }
  get lastTapTime() { return this.live.length ? parseStamp(this.live[this.live.length - 1].time) : null; }
  get lastLive() { return this.live.length ? this.live[this.live.length - 1] : null; }
  get last() { return this.events.length ? this.events[this.events.length - 1] : null; }
  boxCount(id) { return this.boxes[id] || 0; }
  boxLastTime(id) {
    for (let i = this.live.length - 1; i >= 0; i--) if (this.live[i].box === id) return parseStamp(this.live[i].time);
    return null;
  }
}

/** The name and side each box had in a day's events (latest wins), for history that outlives renames. */
export function boxNames(events) {
  const names = {};
  for (const e of events) if (e.box && e.boxName) names[e.box] = { name: e.boxName, side: SIDES.includes(e.side) ? e.side : '' };
  return names;
}

export function summarize(key, events) {
  const s = { day: key, finalCount: 0, presses: 0, lastTime: null, lastTapTime: null, boxes: {}, names: boxNames(events) };
  for (const e of events) {
    if (e.action === 'TAP') { s.presses++; s.lastTapTime = parseStamp(e.time); }
  }
  if (events.length) {
    s.finalCount = events[events.length - 1].count;
    s.lastTime = parseStamp(events[events.length - 1].time);
    s.boxes = { ...new DayState(key, events).boxes };
  }
  return s;
}

/**
 * Counts worth bringing back from a day: the last count of the day, plus any count wiped by
 * a reset, each with its box breakdown. Newest first; zero totals and exact repeats left out.
 */
export function restorePoints(events) {
  const points = [];
  const d = new DayState('');
  for (const e of events) {
    if (e.action === 'RESET') {
      const before = d.events.length ? d.count : parseInt(e.note, 10);
      const when = d.events.length ? d.events[d.events.length - 1].time : e.time;
      if (before > 0) points.push({ count: before, time: when, resetAt: e.time, boxes: { ...d.boxes } });
    }
    d.apply(e);
  }
  if (events.length && d.count > 0) {
    points.push({ count: d.count, time: events[events.length - 1].time, resetAt: null, boxes: { ...d.boxes } });
  }
  points.reverse();
  const seen = new Set();
  return points.filter(p => {
    const sig = `${p.count}|${Object.keys(p.boxes).sort().map(k => `${k}:${p.boxes[k]}`).join(',')}`;
    return !seen.has(sig) && seen.add(sig);
  });
}

const csvText = s => `"${String(s || '').replace(/"/g, '""')}"`;

export function toCsv(events) {
  const rows = ['Date,Time,Action,Product,Paid by,Product count,Total,Note'];
  for (const e of events) {
    const t = parseStamp(e.time);
    rows.push([
      fmtDate(e.day), fmtTime(t), e.action, csvText(e.boxName), SIDE_NAMES[e.side] || '',
      isCount(e.boxCount) ? e.boxCount : '', e.count, csvText(e.note),
    ].join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- the counter

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * The counter. `storage` provides loadDay(key) -> events, listDays() -> keys, append(event).
 * Actions run one at a time, in order, so fast presses can never overtake each other.
 * The screen updates straight away; saving runs behind it and retries until it works.
 */
export class Tally {
  constructor(storage, clock = () => new Date(), retryMs = 2000) {
    this.storage = storage;
    this.clock = clock;
    this.retryMs = retryMs;
    this.chain = Promise.resolve();
    this.pending = [];
    this.flushing = null;
    this.saveError = null;
    this.knownDays = new Set();
    this.onSaveState = null;
    this.day = new DayState(dayKey(clock()));
  }

  async open() {
    this.knownDays = new Set(await this.storage.listDays());
    this.day = new DayState(dayKey(this.clock()), await this.readStored(dayKey(this.clock())));
    return this;
  }

  get count() { return this.day.count; }
  get saveFailing() { return this.pending.length > 0 && this.saveError !== null; }

  /** Moves to a new day if the date has changed. Resolves true when it did. */
  ensureDay() { return this.run(() => this.ensureDayFor(this.clock())); }

  /** One press for a product box {id, name, side}: that box and the total both go up by 1. */
  tap(box = null) {
    return this.run(async () => {
      const now = this.clock();
      await this.ensureDayFor(now);
      const extra = box
        ? { box: box.id, boxName: box.name, side: box.side, boxCount: this.day.boxCount(box.id) + 1 }
        : null;
      return this.commit('TAP', this.day.count + 1, '', now, extra);
    });
  }

  /** Takes back the newest press (from its box too). Resolves null, saving nothing, if there is none. */
  undo() {
    return this.run(async () => {
      const now = this.clock();
      await this.ensureDayFor(now);
      const last = this.day.lastLive;
      if (!last || this.day.count <= 0) return null;
      const extra = last.box
        ? { box: last.box, boxName: last.name, side: last.side, boxCount: Math.max(0, this.day.boxCount(last.box) - 1) }
        : null;
      return this.commit('UNDO', this.day.count - 1, '', now, extra);
    });
  }

  reset() {
    return this.run(async () => {
      const now = this.clock();
      await this.ensureDayFor(now);
      return this.commit('RESET', 0, String(this.day.count), now);
    });
  }

  /** Sets today's total and box counts to ones recorded earlier (sourceTime = when they were recorded). */
  restore(value, sourceTime, boxes = {}) {
    if (!Number.isInteger(value) || value < 0) throw new Error('bad restore value');
    return this.run(async () => {
      const now = this.clock();
      await this.ensureDayFor(now);
      return this.commit('RESTORE', value, sourceTime, now, { boxes: cleanBoxes(boxes) });
    });
  }

  /** All events for a day, oldest first, including any still waiting to be saved. */
  async readDay(key) {
    if (key === this.day.key) return this.day.events.slice();
    return this.readStored(key);
  }

  /** Every day with records (plus today), newest first, with summaries. */
  async listDays() {
    const keys = new Set([...(await this.storage.listDays()), ...this.knownDays, this.day.key]);
    const out = [];
    for (const k of keys) out.push(summarize(k, await this.readDay(k)));
    return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  }

  /** Resolves once everything is saved (or right away if nothing is waiting). */
  whenSaved() { return this.flushing || Promise.resolve(); }

  // ------------------------------------------------------------ internals

  run(fn) {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  async ensureDayFor(now) {
    const key = dayKey(now);
    if (key === this.day.key) return false;
    this.day = new DayState(key, this.knownDays.has(key) ? await this.readStored(key) : []);
    return true;
  }

  async readStored(key) {
    let stored = [];
    try { stored = (await this.storage.loadDay(key)).filter(validEvent); }
    catch (err) { this.loadError = err; }
    return stored.concat(this.pending.filter(e => e.day === key));
  }

  commit(action, count, note, now, extra = null) {
    const e = makeEvent(action, count, now, note, extra);
    this.day.apply(e);
    this.knownDays.add(e.day);
    this.pending.push(e);
    this.flush();
    return e;
  }

  flush() {
    if (this.flushing) return this.flushing;
    if (!this.pending.length) return Promise.resolve();
    this.flushing = (async () => {
      while (this.pending.length) {
        try {
          await this.storage.append(this.pending[0]);
          this.pending.shift();
          if (this.saveError) { this.saveError = null; this.onSaveState && this.onSaveState(); }
        } catch (err) {
          this.saveError = err;
          this.onSaveState && this.onSaveState();
          await sleep(this.retryMs);
        }
      }
      this.flushing = null;
    })();
    return this.flushing;
  }
}

/** In-memory storage, used by the tests (and as a stand-in if the browser blocks storage). */
export class MemoryStorage {
  constructor() { this.rows = []; this.failing = false; }
  async loadDay(key) { return this.rows.filter(r => r && r.day === key).map(r => ({ ...r })); }
  async listDays() { return [...new Set(this.rows.filter(r => r && typeof r.day === 'string').map(r => r.day))]; }
  async append(e) {
    if (this.failing) throw new Error('disk full');
    this.rows.push({ ...e });
  }
}
