import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FleetScheduler, ExchangeLearner, CostEstimator, paceAccounts, weightedTokens, resolveSchedulerConfig,
} from '../src/fleet-scheduler.js';

function fakeClock(start = 1_000_000) {
  let t = start;
  /** @type {Array<{ at: number, fn: () => void, id: number }>} */
  let timers = [];
  let nextId = 1;
  return {
    now: () => t,
    timers: {
      set(/** @type {() => void} */ fn, /** @type {number} */ ms) {
        const id = nextId++;
        timers.push({ at: t + Math.max(0, ms), fn, id });
        return id;
      },
      clear(/** @type {unknown} */ id) { timers = timers.filter(x => x.id !== id); },
    },
    async advance(/** @type {number} */ ms) {
      const to = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const due = timers[0];
        if (!due || due.at > to) break;
        timers.shift();
        t = due.at;
        due.fn();
        await flush();
      }
      t = to;
      await flush();
    },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

/** A Claude account as the account manager keeps it. */
function account({ name = 'acct', tier = 'default_claude_max_20x', u7d = 0.5, reset7d, u5h = null, reset5h = null, tokens = {}, maxUsage = null, disabled = false, provider = undefined } = {}) {
  return {
    name, disabled, maxUsage, provider,
    rateLimitTier: tier,
    quota: { unified7d: u7d, unified7dReset: reset7d, unified5h: u5h, unified5hReset: reset5h },
    usage: {
      totalInputTokens: tokens.input ?? 0, totalOutputTokens: tokens.output ?? 0,
      totalCacheReadTokens: tokens.read ?? 0, totalCacheCreationTokens: tokens.creation ?? 0,
    },
  };
}

function manager(accounts) {
  return {
    accounts,
    capFor(/** @type {string} */ bucket, /** @type {any} */ acct) {
      const m = acct?.maxUsage;
      if (m == null) return null;
      return typeof m === 'number' ? m : (m[bucket] ?? null);
    },
    refreshExpiredQuotas() {},
  };
}

// ── config ──────────────────────────────────────────────────────────────────

test('scheduler config defaults off and refuses unknown or bad fields', () => {
  const d = resolveSchedulerConfig(undefined);
  assert.equal(d.enabled, false);
  assert.equal(d.defaultPriority, 2);
  assert.ok(d.maxHoldSeconds > 0 && d.depthSeconds > 0 && d.cacheTtlSeconds > 0);
  assert.equal(resolveSchedulerConfig({ enabled: true, defaultPriority: 3 }).defaultPriority, 3);
  assert.throws(() => resolveSchedulerConfig({ enabld: true }), /scheduler\.enabld is not a setting/);
  assert.throws(() => resolveSchedulerConfig({ defaultPriority: 4 }), /defaultPriority/);
  assert.throws(() => resolveSchedulerConfig({ maxHoldSeconds: 0 }), /maxHoldSeconds/);
  assert.throws(() => resolveSchedulerConfig({ enabled: 'yes' }), /enabled/);
  assert.throws(() => resolveSchedulerConfig([]), /object/);
});

// ── cost ────────────────────────────────────────────────────────────────────

test('weighted tokens price cache reads, cache writes and output against input', () => {
  assert.equal(weightedTokens({ input_tokens: 100 }), 100);
  assert.equal(weightedTokens({ cache_read_input_tokens: 1000 }), 100);
  assert.equal(weightedTokens({ cache_creation_input_tokens: 100 }), 125);
  assert.equal(weightedTokens({ output_tokens: 10 }), 50);
  assert.equal(weightedTokens({ input_tokens: -5, output_tokens: NaN }), 0);
  assert.equal(weightedTokens(null), 0);
});

test('the estimate prices a warm prefix as a cache read and a cold one as a write', () => {
  const est = new CostEstimator({ cacheTtlMs: 300_000 });
  // Cold: nothing known about the session.
  const cold = est.estimate({ session: 's', bodyBytes: 40_000, now: 0 });
  // 10k prompt tokens written to cache, plus the default output guess.
  assert.equal(cold.promptTokens, 10_000);
  assert.equal(cold.cost, 10_000 * 1.25 + 5 * cold.outputTokens);
  est.observe({ session: 's', usage: { input_tokens: 100, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 900, output_tokens: 400 }, now: 1000 });
  const warm = est.estimate({ session: 's', bodyBytes: 40_000, now: 2000 });
  assert.equal(warm.outputTokens, 400, 'the session\'s own output history');
  // 10_000 prompt: 10_000 of it was the last prompt → read; none new.
  assert.equal(warm.cost, 10_000 * 0.1 + 5 * 400);
  // Held past the cache lifetime: the whole prompt is a write again.
  const expired = est.estimate({ session: 's', bodyBytes: 40_000, now: 1000 + 300_001 });
  assert.equal(expired.cost, 10_000 * 1.25 + 5 * 400);
});

// ── pace inputs ─────────────────────────────────────────────────────────────

test('pace accounts: Claude accounts in service, tier-weighted, with their caps', () => {
  const now = 0;
  const accts = [
    account({ tier: 'default_claude_max_20x', u7d: 0.5, reset7d: 1000, u5h: 0.1, reset5h: 100 }),
    account({ tier: 'default_claude_max_5x', u7d: 0.2, reset7d: 1000, maxUsage: { unified7d: 0.8 } }),
    account({ u7d: 0.1, reset7d: 1000, disabled: true }),
    account({ u7d: 0.1, reset7d: 1000, provider: 'codex' }),
  ];
  const pa = paceAccounts(manager(accts), now);
  assert.equal(pa.length, 2);
  assert.equal(pa[0].weight, 20);
  assert.deepEqual(pa[0].windows, [
    { utilization: 0.1, resetAt: 100, limit: 1 },
    { utilization: 0.5, resetAt: 1000, limit: 1 },
  ]);
  assert.equal(pa[1].weight, 5);
  assert.equal(pa[1].windows.find(w => w.resetAt === 1000)?.limit, 0.8);
});

// ── exchange learner ────────────────────────────────────────────────────────

test('the learner reads quota per token from the weekly reading against tokens spent', () => {
  const l = new ExchangeLearner({ windowMs: 5 * 60_000 });
  assert.equal(l.quotaPerToken, null);
  const a = (u, input) => account({ tier: 'default_claude_ai', u7d: u, reset7d: 9e12, tokens: { input } });
  l.observe(0, [a(0.10, 0)]);
  l.observe(60_000, [a(0.11, 1000)]);
  assert.equal(l.quotaPerToken, null, 'not before a full window');
  l.observe(5 * 60_000, [a(0.20, 10_000)]);
  // 0.10 of a weight-1 account over 10_000 tokens.
  assert.ok(Math.abs(/** @type {number} */ (l.quotaPerToken) - 0.1 / 10_000) < 1e-15);
});

test('the learner ignores a window an account reset in, and one with no movement', () => {
  const l = new ExchangeLearner({ windowMs: 1000 });
  const a = (u, reset, input) => account({ tier: 'default_claude_ai', u7d: u, reset7d: reset, tokens: { input } });
  l.observe(0, [a(0.9, 5000, 0)]);
  l.observe(2000, [a(0.01, 9000, 1000)]);   // reset happened: utilization fell
  assert.equal(l.quotaPerToken, null);
  l.observe(4000, [a(0.01, 9000, 2000)]);   // no movement yet: window stays open
  assert.equal(l.quotaPerToken, null);
  l.observe(6000, [a(0.02, 9000, 3000)]);   // 0.01 over the 2000 since the reset window
  assert.ok(Math.abs(/** @type {number} */ (l.quotaPerToken) - 0.01 / 2000) < 1e-15);
});

// ── FleetScheduler ──────────────────────────────────────────────────────────

/** A fleet of one Pro account with a known exchange rate. */
function fleet({ u7d = 0.5, reset7dIn = 7 * 24 * 3600_000, config = {}, clock = fakeClock() } = {}) {
  const acct = account({ tier: 'default_claude_ai', u7d, reset7d: clock.now() + reset7dIn });
  const logs = [];
  const fs = new FleetScheduler({
    config: resolveSchedulerConfig({ enabled: true, ...config }),
    accountManager: manager([acct]),
    now: clock.now, timers: clock.timers, log: (/** @type {string} */ m) => logs.push(m),
  });
  // 1e-7 of the window per weighted token: a Pro account holds 10M per week.
  fs.learner.quotaPerToken = 1e-7;
  fs.refresh();
  return { fs, acct, clock, logs };
}

test('disabled, nothing is held and nothing is reported', async () => {
  const clock = fakeClock();
  const fs = new FleetScheduler({ config: resolveSchedulerConfig(undefined), accountManager: manager([]), now: clock.now, timers: clock.timers });
  assert.equal(fs.enabled, false);
  assert.equal(fs.quotaView(), null);
});

test('priority comes from the operator override, then the header, then the default', () => {
  const { fs } = fleet({ config: { defaultPriority: 3 } });
  assert.equal(fs.levelFor('s1', undefined), 3);
  assert.equal(fs.levelFor('s1', '1'), 1);
  assert.equal(fs.levelFor('s1', 'bogus'), 3);
  fs.setSessionPriority('s1', 2);
  assert.equal(fs.levelFor('s1', '1'), 2);
  fs.setSessionPriority('s1', null);
  assert.equal(fs.levelFor('s1', '1'), 1);
});

test('with no exchange rate learned yet, everything passes through', async () => {
  const clock = fakeClock();
  const fs = new FleetScheduler({
    config: resolveSchedulerConfig({ enabled: true }),
    accountManager: manager([account({ u7d: 0.99, reset7d: clock.now() + 1e9 })]),
    now: clock.now, timers: clock.timers,
  });
  const a = await fs.admit({ session: 's', level: 3, bodyBytes: 4e6 });
  assert.equal(a.kind, 'admitted');
  assert.equal(fs.status().mode, 'passthrough');
});

test('a held request past maxHoldSeconds is refused with a retry hint', async () => {
  const { fs, clock } = fleet({ u7d: 0.999999, config: { maxHoldSeconds: 10, depthSeconds: 1 } });
  // Drain the bucket.
  const first = await fs.admit({ session: 'a', level: 2, bodyBytes: 4e6 });
  assert.equal(first.kind, 'admitted');
  const held = fs.admit({ session: 'b', level: 3, bodyBytes: 4e6 });
  await clock.advance(10_001);
  const r = await held;
  assert.equal(r.kind, 'timeout');
  assert.ok(r.kind === 'timeout' && r.retryAfterSeconds >= 1);
});

test('a client that leaves while held is reported gone, not timed out', async () => {
  const { fs } = fleet({ u7d: 0.999999, config: { depthSeconds: 1 } });
  await fs.admit({ session: 'a', level: 2, bodyBytes: 4e6 });
  const ac = new AbortController();
  const held = fs.admit({ session: 'b', level: 2, bodyBytes: 4e6, signal: ac.signal });
  ac.abort();
  assert.equal((await held).kind, 'gone');
});

test('overdrive is announced, shown in status and quota, and its end says when P2/P3 resume', async () => {
  const { fs, logs } = fleet({ config: { depthSeconds: 1 } });
  const rt = await fs.admit({ session: 'rt-session-1', level: 1, bodyBytes: 40_000_000 });
  assert.equal(rt.kind, 'admitted');
  const st = fs.status();
  assert.equal(st.mode, 'overdrive');
  assert.deepEqual(st.overdrive?.sessions, ['rt-session-1']);
  assert.ok(st.debt.fractionOfFleet > 0);
  assert.ok(logs.some(l => /OVERDRIVE/.test(l) && /rt-sessi/.test(l)), logs.join('\n'));
  const q = /** @type {any} */ (fs.quotaView());
  assert.equal(q.mode, 'overdrive');
  if (rt.kind === 'admitted') fs.settle(rt, [{ cache_creation_input_tokens: 10_000_000 }]);
  assert.equal(fs.status().mode, 'recovering');
  assert.ok(logs.some(l => /overdrive ended/.test(l) && /resume/.test(l)), logs.join('\n'));
  assert.equal(fs.status().episodes.length, 1);
  assert.ok(fs.status().episodes[0].endedAt != null);
  assert.ok(/** @type {any} */ (fs.quotaView()).resumesAt > 0);
});

test('a P1 spending faster than the pace projects when the fleet hits its limit', async () => {
  const { fs, clock } = fleet({ u7d: 0.5 });
  // Ten minutes of P1 at many times the pace.
  for (let i = 0; i < 10; i++) {
    const a = await fs.admit({ session: 'rt', level: 1, bodyBytes: 4_000_000 });
    if (a.kind === 'admitted') fs.settle(a, [{ cache_creation_input_tokens: 1_000_000 }]);
    await clock.advance(60_000);
  }
  const st = fs.status();
  assert.ok(st.projectedLimitAt != null, 'a projection exists');
  assert.ok(/** @type {number} */ (st.projectedLimitAt) < /** @type {number} */ (st.resetsAt), 'and lands before the reset');
});

test('settling with the real usage teaches the estimator and corrects the bucket', async () => {
  const { fs } = fleet({ config: { depthSeconds: 3600 } });
  const before = fs.status().committedTokens;
  const a = await fs.admit({ session: 's', level: 2, bodyBytes: 4000 });
  assert.equal(a.kind, 'admitted');
  if (a.kind !== 'admitted') return;
  fs.settle(a, [{ input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 20 }]);
  assert.equal(fs.status().committedTokens - before, 10 + 90 + 100);
  assert.equal(fs.estimator.sessions.get('s')?.outputTokens, 20);
});

test('an account first read after the window opened is learned from in that same window', () => {
  const l = new ExchangeLearner({ windowMs: 5 * 60_000 });
  const a = (u, input) => account({ tier: 'default_claude_ai', u7d: u, reset7d: 9e12, tokens: { input } });
  // The scheduler's first look comes before any response has carried a reading.
  l.observe(0, [account({ tier: 'default_claude_ai', u7d: null, reset7d: null })]);
  l.observe(60_000, [a(0.10, 0)]);
  l.observe(5 * 60_000 + 1, [a(0.20, 10_000)]);
  assert.ok(Math.abs(/** @type {number} */ (l.quotaPerToken) - 0.1 / 10_000) < 1e-15, String(l.quotaPerToken));
});
