// Aziz Tally for Chromebook - counting logic shared by the app and the tests.
// No screen code and no browser storage in here: storage is passed in, so the
// same logic runs against IndexedDB in the app and an in-memory store in tests.
//
// Every change is one event { day, time, action, count, note } where `count` is
// the count AFTER the event, exactly like the Windows app's day logs.

export const VERSION = '1.0.0';
export const ACTIONS = ['TAP', 'UNDO', 'RESET', 'RESTORE'];

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

export function makeEvent(action, count, now, note = '') {
  return { day: dayKey(now), time: stamp(now), action, count, note: String(note) };
}

/** Anything that isn't a complete, sensible event is ignored when loading. */
export function validEvent(e) {
  return !!e && typeof e === 'object' &&
    ACTIONS.includes(e.action) &&
    Number.isInteger(e.count) && e.count >= 0 &&
    typeof e.day === 'string' && typeof e.time === 'string' &&
    parseStamp(e.time) !== null && e.time.startsWith(e.day);
}

/** One day's events replayed: the count, and the presses not cancelled by undo/reset/restore. */
export class DayState {
  constructor(key, events = []) {
    this.key = key;
    this.events = [];
    this.count = 0;
    this.live = [];
    for (const e of events) this.apply(e);
  }
  apply(e) {
    this.events.push(e);
    this.count = e.count;
    if (e.action === 'TAP') this.live.push(e.time);
    else if (e.action === 'UNDO') this.live.pop();
    else this.live.length = 0;
  }
  get lastTapTime() { return this.live.length ? parseStamp(this.live[this.live.length - 1]) : null; }
  get last() { return this.events.length ? this.events[this.events.length - 1] : null; }
}

export function summarize(key, events) {
  const s = { day: key, finalCount: 0, presses: 0, lastTime: null, lastTapTime: null };
  for (const e of events) {
    if (e.action === 'TAP') { s.presses++; s.lastTapTime = parseStamp(e.time); }
  }
  if (events.length) {
    s.finalCount = events[events.length - 1].count;
    s.lastTime = parseStamp(events[events.length - 1].time);
  }
  return s;
}

/**
 * Counts worth bringing back from a day: the last count of the day, plus any count
 * wiped by a reset. Newest first; zero counts and repeats of a number left out.
 */
export function restorePoints(events) {
  const points = [];
  events.forEach((e, i) => {
    if (e.action !== 'RESET') return;
    const before = i > 0 ? events[i - 1].count : parseInt(e.note, 10);
    const when = i > 0 ? events[i - 1].time : e.time;
    if (before > 0) points.push({ count: before, time: when, resetAt: e.time });
  });
  if (events.length) {
    const last = events[events.length - 1];
    if (last.count > 0) points.push({ count: last.count, time: last.time, resetAt: null });
  }
  points.reverse();
  const seen = new Set();
  return points.filter(p => !seen.has(p.count) && seen.add(p.count));
}

export function toCsv(events) {
  const rows = ['Date,Time,Action,Count,Note'];
  for (const e of events) {
    const t = parseStamp(e.time);
    rows.push([fmtDate(e.day), fmtTime(t), e.action, e.count, `"${String(e.note || '').replace(/"/g, '""')}"`].join(','));
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

  tap() {
    return this.run(async () => {
      const now = this.clock();
      await this.ensureDayFor(now);
      return this.commit('TAP', this.day.count + 1, '', now);
    });
  }

  /** Takes one off. Resolves null (and saves nothing) at 0. */
  undo() {
    return this.run(async () => {
      const now = this.clock();
      await this.ensureDayFor(now);
      return this.day.count > 0 ? this.commit('UNDO', this.day.count - 1, '', now) : null;
    });
  }

  reset() {
    return this.run(async () => {
      const now = this.clock();
      await this.ensureDayFor(now);
      return this.commit('RESET', 0, String(this.day.count), now);
    });
  }

  /** Sets today's count to a value recorded earlier (sourceTime = when it was recorded). */
  restore(value, sourceTime) {
    if (!Number.isInteger(value) || value < 0) throw new Error('bad restore value');
    return this.run(async () => {
      const now = this.clock();
      await this.ensureDayFor(now);
      return this.commit('RESTORE', value, sourceTime, now);
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

  commit(action, count, note, now) {
    const e = makeEvent(action, count, now, note);
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
