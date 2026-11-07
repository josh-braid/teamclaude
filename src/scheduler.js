// The priority scheduler: when a held request may go upstream.
//
// The fleet has a pace, the rate of spend that brings it to its quota limit
// exactly when the window resets (`fleetPace`). Requests are admitted against
// a token bucket refilled at that pace, by priority:
//
//   P1  realtime. Admitted at once, whatever the bucket holds. P1 may spend
//       faster than the pace; the bucket then goes negative and the scheduler
//       is in OVERDRIVE.
//   P2  admitted when the bucket covers it and no P2 ahead of it waits.
//   P3  admitted only when no P2 waits. Starves while P2 has work.
//
// Debt left by overdrive is repaid at once: P2 and P3 wait until the refill
// has covered it. The pause does not strand quota: the pace is recomputed from
// what is left over the time left, so time spent paused raises it afterwards.
//
// Costs are unknown when a request is admitted, so each admission reserves an
// estimate; `meter` charges as the response streams past the reservation, and
// `settle` corrects to the actual cost. Within one level, sessions share by
// the cost each has been charged, so one agent with many parallel requests
// does not crowd out another with one.
//
// Nothing here reads a clock, a config or an account. Units are whatever the
// caller's pace and costs are in, as long as both agree.

/** @typedef {1 | 2 | 3} Level */
/** @typedef {'passthrough' | 'paced' | 'overdrive' | 'recovering'} Mode */

export const LEVELS = /** @type {const} */ ([1, 2, 3]);
/** @type {Level} */
export const DEFAULT_LEVEL = 2;
export const DEFAULT_DEPTH_MS = 5 * 60_000;
// A session's share history is forgotten after this long idle.
const SESSION_IDLE_MS = 60 * 60_000;

/**
 * A priority level from a header or a request body, or null when it is not one.
 * @param {unknown} value
 * @returns {Level | null}
 */
export function parseLevel(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : null;
  if (text === '1') return 1;
  if (text === '2') return 2;
  if (text === '3') return 3;
  return null;
}

/**
 * @typedef {{ utilization: number | null | undefined, resetAt: number | null | undefined, limit?: number | null }} PaceWindow
 * @typedef {{ weight: number | null | undefined, windows: PaceWindow[] }} PaceAccount
 * @typedef {{ rate: number | null, headroom: number, horizonMs: number | null }} Pace
 */

/**
 * The fleet's pace: the spend rate, in tier-weighted quota per ms, that brings
 * every account to its limit when its binding window resets.
 *
 * Per account, each window with a reading allows `weight × (limit − used) /
 * (reset − now)`; the account's rate is the lowest of these, and its headroom
 * is that window's. The fleet's rate is the sum. `horizonMs` is `H / rate`,
 * the headroom-weighted time to reset. `rate` is null when no account has a
 * usable reading, which the scheduler treats as "pass everything through".
 *
 * @param {{ accounts: PaceAccount[], now: number }} input
 * @returns {Pace}
 */
export function fleetPace({ accounts, now }) {
  let rate = 0;
  let headroom = 0;
  let known = 0;
  for (const account of accounts) {
    const weight = account.weight;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) continue;
    /** @type {{ rate: number, headroom: number } | null} */
    let binding = null;
    for (const w of account.windows) {
      const used = w.utilization;
      const reset = w.resetAt;
      if (typeof used !== 'number' || !Number.isFinite(used)) continue;
      if (typeof reset !== 'number' || !Number.isFinite(reset) || reset <= now) continue;
      const limit = typeof w.limit === 'number' && Number.isFinite(w.limit) ? w.limit : 1;
      const room = weight * Math.max(0, limit - used);
      const r = room / (reset - now);
      if (binding == null || r < binding.rate) binding = { rate: r, headroom: room };
    }
    if (!binding) continue;
    known++;
    rate += binding.rate;
    headroom += binding.headroom;
  }
  if (known === 0) return { rate: null, headroom: 0, horizonMs: null };
  if (rate <= 0 || headroom <= 0) return { rate: 0, headroom, horizonMs: null };
  return { rate, headroom, horizonMs: headroom / rate };
}

/**
 * @typedef {{ set: (fn: () => void, ms: number) => unknown, clear: (id: unknown) => void }} Timers
 * @typedef {{ level: Level, session: string, estimate: number, signal?: AbortSignal }} RequestInput
 * @typedef {{ level: Level, session: string, estimate: number, at: number, seq: number,
 *             resolve: (t: Ticket | null) => void, cancel: () => void }} Waiter
 * @typedef {{ usage: number, open: number, lastSeen: number }} SessionShare
 */

/** @type {Timers} */
const REAL_TIMERS = {
  set: (fn, ms) => {
    const id = setTimeout(fn, ms);
    id.unref?.();
    return id;
  },
  clear: id => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (id)),
};

export class Ticket {
  /**
   * @param {Scheduler} scheduler
   * @param {Level} level
   * @param {string} session
   * @param {number} reserved
   */
  constructor(scheduler, level, session, reserved) {
    this.scheduler = scheduler;
    this.level = level;
    this.session = session;
    this.reserved = reserved;
    // What the bucket has been charged for this request so far.
    this.charged = reserved;
    this.settled = false;
  }

  /**
   * The cost so far, as a running total. Charges only what passes the
   * reservation; a total that goes down is ignored.
   * @param {number} total
   */
  meter(total) {
    if (this.settled || !Number.isFinite(total) || total <= this.charged) return;
    this.scheduler._charge(this, total - this.charged);
    this.charged = total;
  }

  /**
   * The actual cost, once. The bucket and the session's share are corrected to
   * it; a later call is ignored.
   * @param {number} actual
   */
  settle(actual) {
    if (this.settled) return;
    this.settled = true;
    const cost = Number.isFinite(actual) && actual > 0 ? actual : 0;
    this.scheduler._charge(this, cost - this.charged);
    this.charged = cost;
    this.scheduler._close(this);
  }
}

export class Scheduler {
  /**
   * @param {{ now?: () => number, timers?: Timers, depthMs?: number,
   *           onModeChange?: (mode: Mode, previous: Mode) => void }} [opts]
   */
  constructor({ now = Date.now, timers = REAL_TIMERS, depthMs = DEFAULT_DEPTH_MS, onModeChange } = {}) {
    this.now = now;
    this.timers = timers;
    this.depthMs = depthMs > 0 ? depthMs : DEFAULT_DEPTH_MS;
    this.onModeChange = onModeChange;
    /** @type {number | null} */
    this.rate = null;
    this.bucket = 0;
    this.refilledAt = now();
    // Everything charged to the bucket: settled costs plus open reservations.
    this.committed = 0;
    /** @type {Record<Level, Waiter[]>} */
    this.queues = { 1: [], 2: [], 3: [] };
    /** @type {Record<Level, number>} */
    this.open = { 1: 0, 2: 0, 3: 0 };
    /** @type {Map<string, SessionShare>} */
    this.sessions = new Map();
    // The share a session joining a level starts at: the least any waiter
    // there had when the last one was admitted. Monotone, per level.
    /** @type {Record<Level, number>} */
    this.floor = { 1: 0, 2: 0, 3: 0 };
    /** @type {Set<string>} */
    this.overdriveSessions = new Set();
    this.seq = 0;
    /** @type {unknown} */
    this.timer = null;
    /** @type {Mode} */
    this.mode = 'passthrough';
  }

  /** Bucket capacity: `depthMs` of the current pace. */
  get depth() {
    return this.rate == null ? 0 : this.rate * this.depthMs;
  }

  get debt() {
    return this.rate == null ? 0 : Math.max(0, -this.bucket);
  }

  /**
   * A new pace, or null for "unknown: pass everything". The bucket is refilled
   * at the old pace up to now first. The first known pace starts it full.
   * @param {number | null} rate
   */
  setRate(rate) {
    const next = typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? rate : null;
    this._refill();
    const first = this.rate == null && next != null;
    this.rate = next;
    if (first) this.bucket = this.depth;
    else if (next != null) this.bucket = Math.min(this.bucket, this.depth);
    this._dispatch();
  }

  /**
   * Wait for admission. Resolves a Ticket, or null when `signal` aborted first.
   * @param {RequestInput} input
   * @returns {Promise<Ticket | null>}
   */
  request({ level, session, estimate, signal }) {
    if (signal?.aborted) return Promise.resolve(null);
    const cost = Number.isFinite(estimate) && estimate > 0 ? estimate : 0;
    const share = this._share(session, level);
    if (level === 1 || this.rate == null) {
      const ticket = this._admit(level, session, cost, share);
      this._dispatch();
      return Promise.resolve(ticket);
    }
    return new Promise(resolve => {
      /** @type {Waiter} */
      const waiter = {
        level, session, estimate: cost, at: this.now(), seq: this.seq++,
        resolve: t => {
          signal?.removeEventListener('abort', waiter.cancel);
          resolve(t);
        },
        cancel: () => {
          const q = this.queues[level];
          const i = q.indexOf(waiter);
          if (i === -1) return;
          q.splice(i, 1);
          waiter.resolve(null);
          this._dispatch();
        },
      };
      signal?.addEventListener('abort', waiter.cancel, { once: true });
      this.queues[level].push(waiter);
      this._dispatch();
    });
  }

  status() {
    this._refill();
    const now = this.now();
    const debt = this.debt;
    /** @param {Level} level */
    const oldest = level => {
      const q = this.queues[level];
      return q.length ? now - Math.min(...q.map(w => w.at)) : null;
    };
    return {
      mode: this._mode(),
      ratePerMs: this.rate,
      bucket: this.bucket,
      depth: this.depth,
      debt,
      debtClearsAt: debt > 0 && this.rate ? now + debt / this.rate : null,
      committed: this.committed,
      queued: { 1: 0, 2: this.queues[2].length, 3: this.queues[3].length },
      oldestWaitMs: { 2: oldest(2), 3: oldest(3) },
      open: { ...this.open },
      overdriveSessions: [...this.overdriveSessions],
    };
  }

  /** How many requests each session has waiting. */
  waitingBySession() {
    /** @type {Map<string, number>} */
    const out = new Map();
    for (const level of /** @type {const} */ ([2, 3])) {
      for (const w of this.queues[level]) out.set(w.session, (out.get(w.session) ?? 0) + 1);
    }
    return out;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** @returns {Mode} */
  _mode() {
    if (this.rate == null) return 'passthrough';
    if (this.bucket >= 0) return 'paced';
    return this.open[1] > 0 ? 'overdrive' : 'recovering';
  }

  _refill() {
    const now = this.now();
    if (this.rate != null && now > this.refilledAt) {
      this.bucket = Math.min(this.depth, this.bucket + this.rate * (now - this.refilledAt));
    }
    this.refilledAt = now;
  }

  /**
   * @param {string} session
   * @param {Level} level
   */
  _share(session, level) {
    const now = this.now();
    let share = this.sessions.get(session);
    if (share && share.open === 0 && now - share.lastSeen > SESSION_IDLE_MS) share = undefined;
    if (!share) {
      share = { usage: 0, open: 0, lastSeen: now };
      this.sessions.set(session, share);
    }
    share.usage = Math.max(share.usage, this.floor[level]);
    share.lastSeen = now;
    return share;
  }

  /**
   * @param {Level} level
   * @param {string} session
   * @param {number} cost
   * @param {SessionShare} share
   */
  _admit(level, session, cost, share) {
    const ticket = new Ticket(this, level, session, cost);
    this.open[level]++;
    share.open++;
    this._charge(ticket, cost);
    if (level === 1 && this.rate != null && this.bucket < 0) this.overdriveSessions.add(session);
    return ticket;
  }

  /**
   * @param {Ticket} ticket
   * @param {number} delta
   */
  _charge(ticket, delta) {
    if (delta === 0) return;
    this._refill();
    this.committed += delta;
    if (this.rate != null) this.bucket -= delta;
    const share = this.sessions.get(ticket.session);
    if (share) share.usage += delta;
    if (ticket.level === 1 && this.rate != null && this.bucket < 0) this.overdriveSessions.add(ticket.session);
    if (delta < 0) this._dispatch();
    else this._noteMode();
  }

  /** @param {Ticket} ticket */
  _close(ticket) {
    this.open[ticket.level]--;
    const share = this.sessions.get(ticket.session);
    if (share) {
      share.open--;
      share.lastSeen = this.now();
    }
    this._prune();
    this._dispatch();
  }

  _prune() {
    const now = this.now();
    if (this.sessions.size < 256) return;
    for (const [id, share] of this.sessions) {
      if (share.open === 0 && now - share.lastSeen > SESSION_IDLE_MS) this.sessions.delete(id);
    }
  }

  /**
   * The next waiter at `level`: the session charged least so far, then the
   * longest waiting.
   * @param {Level} level
   */
  _next(level) {
    const q = this.queues[level];
    let best = -1;
    let bestUsage = Infinity;
    let bestSeq = Infinity;
    for (let i = 0; i < q.length; i++) {
      const usage = this.sessions.get(q[i].session)?.usage ?? 0;
      if (usage < bestUsage || (usage === bestUsage && q[i].seq < bestSeq)) {
        best = i;
        bestUsage = usage;
        bestSeq = q[i].seq;
      }
    }
    return best;
  }

  _dispatch() {
    this._refill();
    if (this.timer != null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    /** @type {number | null} */
    let shortfall = null;
    for (const level of /** @type {Level[]} */ ([2, 3])) {
      const q = this.queues[level];
      while (q.length) {
        const i = this._next(level);
        const waiter = q[i];
        // A pace of zero is a fleet at its limit: nothing paced may go.
        if (this.rate === 0) break;
        const need = Math.min(waiter.estimate, this.depth);
        // Floating-point slack, so a timer that lands exactly on the refill
        // admits rather than re-arming for a vanishing remainder.
        if (this.rate != null && this.bucket < need - 1e-9 * Math.max(1, need)) {
          shortfall = need - this.bucket;
          break;
        }
        q.splice(i, 1);
        const share = this._share(waiter.session, level);
        const waiting = q.map(w => this.sessions.get(w.session)?.usage ?? 0);
        if (waiting.length) this.floor[level] = Math.max(this.floor[level], Math.min(...waiting));
        waiter.resolve(this._admit(level, waiter.session, waiter.estimate, share));
      }
      // Strict priority: P3 never goes while a P2 waits.
      if (q.length) break;
    }
    if (this.rate != null && this.rate > 0) {
      if (shortfall != null) {
        this.timer = this.timers.set(() => { this.timer = null; this._dispatch(); }, Math.ceil(shortfall / this.rate));
      } else if (this.bucket < 0) {
        // Nothing waits, but the end of the debt is a mode change to report.
        this.timer = this.timers.set(() => { this.timer = null; this._dispatch(); }, Math.ceil(-this.bucket / this.rate));
      }
    }
    this._noteMode();
  }

  _noteMode() {
    const mode = this._mode();
    if (mode === 'paced' || mode === 'passthrough') this.overdriveSessions.clear();
    if (mode === this.mode) return;
    const previous = this.mode;
    this.mode = mode;
    this.onModeChange?.(mode, previous);
  }
}
