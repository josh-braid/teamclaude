// The scheduler as the proxy runs it: the pure core in scheduler.js, fed from
// the fleet's live quota readings and the token counts responses report.
//
// The core's pace is in quota (tier-weighted fractions of a window) per ms; a
// request's cost is in tokens. Two things join them:
//
//   - weightedTokens prices one usage report in input-token equivalents, using
//     the API's relative prices: a cache read costs a tenth of an input token, a
//     cache write five quarters, an output token five.
//   - ExchangeLearner learns how much weekly quota one weighted token moves,
//     from the fleet's own readings: utilization gained over tokens spent, per
//     window of at least five minutes.
//
// The bucket is kept in weighted tokens, refilled at pace / quotaPerToken.
// Until a rate is learned the scheduler passes everything through, the same as
// with no quota reading at all.
//
// A request's cost is estimated when it is admitted (CostEstimator) and settled
// on the usage upstream reported. The estimate only decides when to admit; the
// settlement is what the bucket keeps.

import { Scheduler, fleetPace, parseLevel, DEFAULT_LEVEL } from './scheduler.js';
import { quotaTier } from './quota-summary.js';
import { providerOf, DEFAULT_PROVIDER } from './provider.js';
import { SessionGraph, requestClaims, MAX_GRAPH_SESSIONS } from './session-graph.js';
import { peerProcess } from './peer-process.js';

/** @typedef {import('./scheduler.js').Level} Level */
/** @typedef {import('./scheduler.js').Ticket} Ticket */
/** @typedef {import('./scheduler.js').Timers} Timers */

export const SCHEDULER_DEFAULTS = Object.freeze({
  enabled: false,
  defaultPriority: DEFAULT_LEVEL,
  // The bucket holds this much of the pace, so a short burst is not held.
  depthSeconds: 300,
  // The longest a P2/P3 request waits before it is refused with a retry hint.
  // `teamclaude run` raises Claude Code's API_TIMEOUT_MS past it.
  maxHoldSeconds: 3600,
  // How long a session's prompt prefix is assumed to stay cached upstream.
  cacheTtlSeconds: 300,
});

/** @typedef {{ enabled: boolean, defaultPriority: Level, depthSeconds: number, maxHoldSeconds: number, cacheTtlSeconds: number }} SchedulerConfig */

/**
 * The `scheduler` config block with defaults filled in. Throws an Error naming
 * the field on anything it cannot honour, so a typo is refused at startup
 * rather than silently running the default.
 * @param {unknown} raw
 * @returns {SchedulerConfig}
 */
export function resolveSchedulerConfig(raw) {
  /** @type {SchedulerConfig} */
  const out = { ...SCHEDULER_DEFAULTS };
  if (raw == null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('scheduler must be an object');
  for (const [field, value] of Object.entries(raw)) {
    switch (field) {
      case 'enabled':
        if (typeof value !== 'boolean') throw new Error(`scheduler.enabled must be true or false, got ${JSON.stringify(value)}`);
        out.enabled = value;
        break;
      case 'defaultPriority': {
        const level = parseLevel(value);
        if (level == null) throw new Error(`scheduler.defaultPriority must be 1, 2 or 3, got ${JSON.stringify(value)}`);
        out.defaultPriority = level;
        break;
      }
      case 'depthSeconds':
      case 'maxHoldSeconds':
      case 'cacheTtlSeconds':
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
          throw new Error(`scheduler.${field} must be a positive number of seconds, got ${JSON.stringify(value)}`);
        }
        out[field] = value;
        break;
      default:
        throw new Error(`scheduler.${field} is not a setting (known fields: ${Object.keys(SCHEDULER_DEFAULTS).join(', ')})`);
    }
  }
  return out;
}

// ── Cost ────────────────────────────────────────────────────────────────────

const PRICE = Object.freeze({ input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 });

/** @param {unknown} v */
const count = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * One usage report in input-token equivalents.
 * @param {Record<string, unknown> | null | undefined} usage
 */
export function weightedTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  return count(usage.input_tokens) * PRICE.input
    + count(usage.cache_read_input_tokens) * PRICE.cacheRead
    + count(usage.cache_creation_input_tokens) * PRICE.cacheWrite
    + count(usage.output_tokens) * PRICE.output;
}

/** An account's lifetime token totals, weighted the same way. */
function accountWeightedTotal(/** @type {any} */ account) {
  const u = account?.usage || {};
  return weightedTokens({
    input_tokens: u.totalInputTokens,
    output_tokens: u.totalOutputTokens,
    cache_read_input_tokens: u.totalCacheReadTokens,
    cache_creation_input_tokens: u.totalCacheCreationTokens,
  });
}

// Request bodies are JSON; four bytes to a token over-counts a little, which
// errs toward holding a request rather than overspending on it.
const BYTES_PER_TOKEN = 4;
const DEFAULT_OUTPUT_TOKENS = 1000;
const OUTPUT_ALPHA = 0.3;
const MAX_SESSIONS = 4096;

/**
 * The cost of a request before it is sent.
 *
 * The prompt is the body's size in tokens. The part of it the session sent last
 * time is priced as a cache read while the cache can still hold it, the rest as
 * a cache write. Output is the session's recent average, or the fleet's for a
 * session with no history.
 */
export class CostEstimator {
  /** @param {{ cacheTtlMs: number }} opts */
  constructor({ cacheTtlMs }) {
    this.cacheTtlMs = cacheTtlMs;
    /** @type {Map<string, { promptTokens: number, outputTokens: number, at: number }>} */
    this.sessions = new Map();
    /** @type {number | null} */
    this.fleetOutputTokens = null;
  }

  /** @param {{ session: string, bodyBytes: number, now: number }} input */
  estimate({ session, bodyBytes, now }) {
    const promptTokens = Math.ceil(count(bodyBytes) / BYTES_PER_TOKEN);
    const known = this.sessions.get(session);
    const warm = known && now - known.at <= this.cacheTtlMs ? Math.min(known.promptTokens, promptTokens) : 0;
    const outputTokens = known?.outputTokens ?? this.fleetOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
    const cost = warm * PRICE.cacheRead + (promptTokens - warm) * PRICE.cacheWrite + outputTokens * PRICE.output;
    return { promptTokens, outputTokens, cost };
  }

  /** @param {{ session: string, usage: Record<string, unknown>, now: number }} input */
  observe({ session, usage, now }) {
    const promptTokens = count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
    const output = count(usage.output_tokens);
    const prev = this.sessions.get(session);
    const outputTokens = prev ? prev.outputTokens * (1 - OUTPUT_ALPHA) + output * OUTPUT_ALPHA : output;
    this.sessions.delete(session);
    this.sessions.set(session, { promptTokens, outputTokens, at: now });
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    this.fleetOutputTokens = this.fleetOutputTokens == null ? output : this.fleetOutputTokens * (1 - OUTPUT_ALPHA) + output * OUTPUT_ALPHA;
  }
}

// ── Quota per token ─────────────────────────────────────────────────────────

const LEARN_ALPHA = 0.3;
const LEARN_MAX_WINDOW_MS = 60 * 60_000;

/**
 * How much weekly quota one weighted token moves, learned from the readings.
 *
 * A sample spans at least `windowMs`: readings move in coarse steps, and a
 * window shorter than one step reads as zero. An account that has no reading
 * at the start of a window, or whose weekly window resets inside it, is counted
 * from its next reading instead. A sample is taken once the utilization has
 * moved; a window that never moves is dropped after an hour.
 */
export class ExchangeLearner {
  /** @param {{ windowMs?: number }} [opts] */
  constructor({ windowMs = 5 * 60_000 } = {}) {
    this.windowMs = windowMs;
    /** @type {number | null} */
    this.quotaPerToken = null;
    /** @type {{ at: number, accounts: Map<string, { used: number, reset: number, tokens: number, weight: number }> } | null} */
    this.start = null;
  }

  /**
   * @param {number} now
   * @param {any[]} accounts
   */
  observe(now, accounts) {
    const snap = snapshot(now, accounts);
    if (!this.start) { this.start = snap; return; }
    // An account new to this window, or one whose window reset, starts here.
    for (const [id, end] of snap.accounts) {
      const begin = this.start.accounts.get(id);
      if (!begin || begin.reset !== end.reset || end.used < begin.used || end.tokens < begin.tokens) this.start.accounts.set(id, end);
    }
    if (now - this.start.at < this.windowMs) return;
    let quota = 0;
    let tokens = 0;
    for (const [id, end] of snap.accounts) {
      const begin = /** @type {{ used: number, tokens: number, weight: number }} */ (this.start.accounts.get(id));
      quota += end.weight * (end.used - begin.used);
      tokens += end.tokens - begin.tokens;
    }
    if (quota > 0 && tokens > 0) {
      const sample = quota / tokens;
      this.quotaPerToken = this.quotaPerToken == null ? sample : this.quotaPerToken * (1 - LEARN_ALPHA) + sample * LEARN_ALPHA;
      this.start = snap;
    } else if (now - this.start.at > LEARN_MAX_WINDOW_MS) {
      this.start = snap;
    }
  }
}

/**
 * @param {number} now
 * @param {any[]} accounts
 */
function snapshot(now, accounts) {
  const out = new Map();
  for (const account of accounts) {
    if (!isPacedAccount(account)) continue;
    const weight = quotaTier(account).weight;
    const q = account.quota || {};
    if (weight == null || typeof q.unified7d !== 'number' || typeof q.unified7dReset !== 'number' || q.unified7dReset <= now) continue;
    // By name, not by object: a config reload rebuilds the account objects.
    out.set(String(account.name ?? account.index), { used: q.unified7d, reset: q.unified7dReset, tokens: accountWeightedTotal(account), weight });
  }
  return { at: now, accounts: out };
}

// ── Pace inputs ─────────────────────────────────────────────────────────────

/** @param {any} account */
function isPacedAccount(account) {
  return !!account && !account.disabled && providerOf(account) === DEFAULT_PROVIDER;
}

/**
 * The fleet as fleetPace reads it: each Claude account in service with its tier
 * weight and its 5-hour and weekly windows, capped at its `maxUsage`.
 * @param {{ accounts: any[], capFor: (bucket: string, account: any) => number | null }} accountManager
 * @param {number} now
 * @returns {import('./scheduler.js').PaceAccount[]}
 */
export function paceAccounts(accountManager, now) {
  /** @type {import('./scheduler.js').PaceAccount[]} */
  const out = [];
  for (const account of accountManager.accounts) {
    if (!isPacedAccount(account)) continue;
    const q = account.quota || {};
    /** @type {import('./scheduler.js').PaceWindow[]} */
    const windows = [];
    for (const [key, resetKey] of [['unified5h', 'unified5hReset'], ['unified7d', 'unified7dReset']]) {
      const used = q[key];
      const resetAt = q[resetKey];
      if (typeof used !== 'number' || typeof resetAt !== 'number' || resetAt <= now) continue;
      windows.push({ utilization: used, resetAt, limit: accountManager.capFor(key, account) ?? 1 });
    }
    out.push({ weight: quotaTier(account).weight, windows });
  }
  return out;
}

// ── The proxy's scheduler ───────────────────────────────────────────────────

const REFRESH_MS = 15_000;
const SPEND_SPAN_MS = 10 * 60_000;
const MAX_EPISODES = 20;
// How long a session's first request waits for its process to be read.
const LOOKUP_WAIT_MS = 250;

/** @typedef {import('./session-graph.js').SessionView & { held: number, children: SessionStatus[] }} SessionStatus */

/**
 * @typedef {{ kind: 'admitted', ticket: Ticket, session: string, level: Level, heldMs: number }
 *         | { kind: 'timeout', retryAfterSeconds: number }
 *         | { kind: 'gone' }} Admission
 * @typedef {{ startedAt: number, endedAt: number | null, sessions: string[], peakDebtFraction: number }} Episode
 */

export class FleetScheduler {
  /**
   * @param {{ config: SchedulerConfig, accountManager: any, now?: () => number,
   *           timers?: Timers, log?: (line: string) => void,
   *           peerLookup?: (socket: any) => Promise<import('./peer-process.js').PeerProcess | null> }} opts
   *   peerLookup: reads the client process behind a connection (peer-process.js)
   */
  constructor({ config, accountManager, now = Date.now, timers, log = line => console.log(line), peerLookup = peerProcess }) {
    this.config = config;
    this.accountManager = accountManager;
    this.now = now;
    this.log = log;
    this.timers = timers ?? {
      set: (/** @type {() => void} */ fn, /** @type {number} */ ms) => { const id = setTimeout(fn, ms); id.unref?.(); return id; },
      clear: (/** @type {unknown} */ id) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (id)),
    };
    this.learner = new ExchangeLearner();
    this.estimator = new CostEstimator({ cacheTtlMs: config.cacheTtlSeconds * 1000 });
    this.graph = new SessionGraph({ now });
    this.peerLookup = peerLookup;
    /** Each session's process lookup, run once. @type {Map<string, Promise<void>>} */
    this.lookups = new Map();
    /** @type {Episode[]} */
    this.episodes = [];
    /** @type {Array<{ at: number, committed: number }>} */
    this.spend = [];
    /** @type {import('./scheduler.js').Pace} */
    this.pace = { rate: null, headroom: 0, horizonMs: null };
    this.capacity = 0;
    this.core = new Scheduler({
      now, timers: this.timers, depthMs: config.depthSeconds * 1000,
      onModeChange: (mode, previous) => this._modeChanged(mode, previous),
    });
    /** @type {unknown} */
    this.refreshTimer = null;
    if (config.enabled) this._scheduleRefresh();
  }

  get enabled() { return this.config.enabled; }

  /**
   * The level a request runs at: for a session, the graph's answer (its
   * override, its own header, else the nearest ancestor's level); for a request
   * with no session, its header. Else the configured default.
   * @param {string | null} session
   * @param {unknown} header
   * @returns {Level}
   */
  levelFor(session, header) {
    if (session) return this.graph.levelOf(session, this.config.defaultPriority).level;
    return parseLevel(header) ?? this.config.defaultPriority;
  }

  /**
   * @param {string} session
   * @param {Level | null} level null clears the override
   */
  setSessionPriority(session, level) {
    this.graph.setOverride(session, level);
  }

  /**
   * Record one request in the session graph and count it in flight until
   * `done`. A session's first request from a local process waits up to
   * LOOKUP_WAIT_MS for that process to be read, so it starts at the level it
   * inherits.
   * @param {string} session
   * @param {Record<string, string | string[] | undefined>} headers
   * @param {unknown} socket the client connection, for peerProcess
   * @param {unknown} header the priority header
   * @returns {Promise<{ done: () => void }>}
   */
  async track(session, headers, socket, header) {
    const { parentClaim, agent } = requestClaims(headers);
    this.graph.observe(session, { parentClaim, header: parseLevel(header), agent });
    let lookup = this.lookups.get(session);
    if (!lookup) {
      lookup = this.peerLookup(socket)
        .then(found => { if (found && this.graph.node(session)) this.graph.resolveProcess(session, found); })
        .catch(() => {});
      this.lookups.set(session, lookup);
      if (this.lookups.size > MAX_GRAPH_SESSIONS) this._pruneLookups();
      /** @type {unknown} */
      let timer = null;
      await Promise.race([lookup, new Promise(resolve => { timer = this.timers.set(() => resolve(undefined), LOOKUP_WAIT_MS); })]);
      this.timers.clear(timer);
    }
    const agentId = agent?.id ?? null;
    this.graph.start(session, agentId);
    let open = true;
    return { done: () => { if (open) { open = false; this.graph.finish(session, agentId); } } };
  }

  /**
   * The session tree, each session with how many of its requests are held.
   * @returns {SessionStatus[]}
   */
  sessions() {
    const waiting = this.core.waitingBySession();
    /** @param {import('./session-graph.js').SessionView} v @returns {SessionStatus} */
    const withHeld = v => ({ ...v, held: waiting.get(v.id) ?? 0, children: v.children.map(withHeld) });
    const tree = this.graph.snapshot(this.config.defaultPriority).sessions.map(withHeld);
    this._pruneLookups();
    return tree;
  }

  /** Drop the lookups of sessions the graph has forgotten. */
  _pruneLookups() {
    for (const id of this.lookups.keys()) if (!this.graph.node(id)) this.lookups.delete(id);
  }

  /** Recompute the pace from the current readings. */
  refresh() {
    const now = this.now();
    this.accountManager.refreshExpiredQuotas?.();
    this.learner.observe(now, this.accountManager.accounts);
    const fleet = paceAccounts(this.accountManager, now);
    this.capacity = fleet.reduce((sum, a) => sum + (typeof a.weight === 'number' && a.windows.length ? a.weight : 0), 0);
    this.pace = fleetPace({ accounts: fleet, now });
    const perToken = this.learner.quotaPerToken;
    this.core.setRate(this.pace.rate == null || perToken == null || perToken <= 0 ? null : this.pace.rate / perToken);
    this.spend.push({ at: now, committed: this.core.committed });
    while (this.spend.length > 2 && now - this.spend[1].at > SPEND_SPAN_MS) this.spend.shift();
    const open = this.episodes[this.episodes.length - 1];
    if (open && open.endedAt == null) {
      open.peakDebtFraction = Math.max(open.peakDebtFraction, this._debtFraction());
      open.sessions = [...new Set([...open.sessions, ...this.core.overdriveSessions])];
    }
  }

  /**
   * Wait until this request may go upstream.
   * @param {{ session: string, level: Level, bodyBytes: number, signal?: AbortSignal }} input
   * @returns {Promise<Admission>}
   */
  async admit({ session, level, bodyBytes, signal }) {
    this.refresh();
    const started = this.now();
    const { cost } = this.estimator.estimate({ session, bodyBytes, now: started });
    const expire = new AbortController();
    const timer = level === 1 ? null : this.timers.set(() => expire.abort(), this.config.maxHoldSeconds * 1000);
    const both = signal ? AbortSignal.any([signal, expire.signal]) : expire.signal;
    try {
      const ticket = await this.core.request({ level, session, estimate: cost, signal: both });
      if (ticket) return { kind: 'admitted', ticket, session, level, heldMs: this.now() - started };
      if (signal?.aborted) return { kind: 'gone' };
      return { kind: 'timeout', retryAfterSeconds: this._retryAfterSeconds() };
    } finally {
      if (timer != null) this.timers.clear(timer);
    }
  }

  /**
   * Settle an admitted request on what upstream reported. Usage reports from
   * every attempt the request made are summed: a failed attempt that streamed
   * input before dying still spent it.
   * @param {Admission & { kind: 'admitted' }} admission
   * @param {Array<Record<string, unknown>>} usages
   */
  settle(admission, usages) {
    const now = this.now();
    let cost = 0;
    for (const usage of usages) {
      cost += weightedTokens(usage);
      this.estimator.observe({ session: admission.session, usage, now });
    }
    admission.ticket.settle(cost);
    this.refresh();
  }

  status() {
    const now = this.now();
    const core = this.core.status();
    const perToken = this.learner.quotaPerToken;
    const open = this.episodes[this.episodes.length - 1];
    return {
      enabled: this.enabled,
      mode: core.mode,
      defaultPriority: this.config.defaultPriority,
      quotaPerToken: perToken,
      pace: {
        quotaPerHour: this.pace.rate == null ? null : this.pace.rate * 3600_000,
        tokensPerMinute: core.ratePerMs == null ? null : core.ratePerMs * 60_000,
      },
      bucketTokens: core.bucket,
      depthTokens: core.depth,
      committedTokens: core.committed,
      debt: { tokens: core.debt, fractionOfFleet: this._debtFraction(), clearsAt: core.debtClearsAt },
      queued: { 2: core.queued[2], 3: core.queued[3] },
      oldestWaitMs: core.oldestWaitMs,
      inFlight: core.open,
      overdrive: open && open.endedAt == null ? { since: open.startedAt, sessions: [...new Set([...open.sessions, ...core.overdriveSessions])] } : null,
      resetsAt: this.pace.horizonMs == null ? null : now + this.pace.horizonMs,
      projectedLimitAt: this._projectedLimitAt(),
      sessionPriorities: Object.fromEntries(this.graph.overrides),
      sessions: this.sessions(),
      episodes: this.episodes.map(e => ({ ...e })),
    };
  }

  /** The compact view `/teamclaude/quota` carries, or null when disabled. */
  quotaView() {
    if (!this.enabled) return null;
    const st = this.status();
    return {
      mode: st.mode,
      debtFraction: st.debt.fractionOfFleet,
      resumesAt: st.debt.clearsAt,
      queued: st.queued,
      projectedLimitAt: st.projectedLimitAt,
      resetsAt: st.resetsAt,
    };
  }

  close() {
    if (this.refreshTimer != null) this.timers.clear(this.refreshTimer);
    this.refreshTimer = null;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  _scheduleRefresh() {
    this.refreshTimer = this.timers.set(() => {
      try { this.refresh(); } finally { this._scheduleRefresh(); }
    }, REFRESH_MS);
  }

  /** The outstanding debt as a fraction of the fleet's whole capacity. */
  _debtFraction() {
    const perToken = this.learner.quotaPerToken;
    if (!perToken || this.capacity <= 0) return 0;
    return this.core.debt * perToken / this.capacity;
  }

  /**
   * When the fleet reaches its limit at the spend rate of the last ten
   * minutes, or null when it never does at that rate before the window resets
   * or there is not enough history to say.
   */
  _projectedLimitAt() {
    const perToken = this.learner.quotaPerToken;
    if (!perToken || this.spend.length < 2 || this.pace.horizonMs == null) return null;
    const first = this.spend[0];
    const last = this.spend[this.spend.length - 1];
    const span = last.at - first.at;
    if (span < 60_000) return null;
    const quotaPerMs = (last.committed - first.committed) / span * perToken;
    if (quotaPerMs <= 0) return null;
    const at = this.now() + this.pace.headroom / quotaPerMs;
    return at < this.now() + this.pace.horizonMs ? Math.round(at) : null;
  }

  _retryAfterSeconds() {
    const clears = this.core.status().debtClearsAt;
    const wait = clears == null ? 60_000 : clears - this.now();
    return Math.max(1, Math.ceil(wait / 1000));
  }

  /**
   * @param {import('./scheduler.js').Mode} mode
   * @param {import('./scheduler.js').Mode} previous
   */
  _modeChanged(mode, previous) {
    const now = this.now();
    if (mode === 'overdrive') {
      const sessions = [...this.core.overdriveSessions];
      this.episodes.push({ startedAt: now, endedAt: null, sessions, peakDebtFraction: this._debtFraction() });
      if (this.episodes.length > MAX_EPISODES) this.episodes.shift();
      this.log(`[TeamClaude] Scheduler: OVERDRIVE — P1 is spending faster than the pace (${sessions.map(s => s.slice(0, 8)).join(', ') || 'unknown session'}); P2/P3 are held.`);
      return;
    }
    if (previous === 'overdrive') {
      const open = this.episodes[this.episodes.length - 1];
      if (open && open.endedAt == null) open.endedAt = now;
      const st = this.core.status();
      const pct = (this._debtFraction() * 100).toFixed(2);
      const resume = st.debtClearsAt == null ? 'at once' : `~${new Date(st.debtClearsAt).toLocaleTimeString()}`;
      this.log(`[TeamClaude] Scheduler: overdrive ended — repaying ${pct}% of fleet quota; P2/P3 resume ${resume}.`);
      return;
    }
    if (previous === 'recovering' && mode === 'paced') {
      this.log('[TeamClaude] Scheduler: overdrive debt repaid — P2/P3 resume at pace.');
    }
  }
}
