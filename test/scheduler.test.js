import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, fleetPace, parseLevel, DEFAULT_LEVEL } from '../src/scheduler.js';

// ── A fake clock the scheduler's timers run on ──────────────────────────────

function fakeClock(start = 0) {
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
    /** Advance to `to`, firing every timer due on the way, in order. */
    async advanceTo(/** @type {number} */ to) {
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
    async advance(/** @type {number} */ ms) { await this.advanceTo(t + ms); },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

/** Mulberry32: a small seeded PRNG, so a failing case replays. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resolve-state of a promise without awaiting it. */
function track(/** @type {Promise<any>} */ p) {
  const s = { done: false, value: /** @type {any} */ (undefined) };
  p.then(v => { s.done = true; s.value = v; });
  return s;
}

// ── parseLevel ──────────────────────────────────────────────────────────────

test('parseLevel accepts exactly 1, 2 and 3', () => {
  assert.equal(parseLevel('1'), 1);
  assert.equal(parseLevel(2), 2);
  assert.equal(parseLevel(' 3 '), 3);
  for (const bad of ['0', '4', '1.5', 'p1', '', null, undefined, NaN]) {
    assert.equal(parseLevel(bad), null, String(bad));
  }
  assert.equal(DEFAULT_LEVEL, 2);
});

// ── fleetPace ───────────────────────────────────────────────────────────────

test('pace for one account is the headroom over the time to reset', () => {
  const pace = fleetPace({ now: 0, accounts: [{ weight: 1, windows: [{ utilization: 0.25, resetAt: 1000 }] }] });
  assert.equal(pace.headroom, 0.75);
  assert.ok(Math.abs(/** @type {number} */ (pace.rate) - 0.75 / 1000) < 1e-15);
});

test('the binding window is the one with the lower rate, scaled by tier weight', () => {
  const pace = fleetPace({
    now: 0,
    accounts: [{
      weight: 20,
      windows: [
        { utilization: 0.5, resetAt: 100 },   // 0.5/100   = 0.005
        { utilization: 0.9, resetAt: 1000 },  // 0.1/1000  = 0.0001  ← binds
      ],
    }],
  });
  assert.ok(Math.abs(/** @type {number} */ (pace.rate) - 20 * 0.0001) < 1e-15);
  assert.ok(Math.abs(pace.headroom - 20 * 0.1) < 1e-12);
});

test('the fleet pace is the sum over accounts, and a cap lowers the limit', () => {
  const pace = fleetPace({
    now: 0,
    accounts: [
      { weight: 1, windows: [{ utilization: 0, resetAt: 1000 }] },
      { weight: 5, windows: [{ utilization: 0.5, resetAt: 1000, limit: 0.8 }] },
    ],
  });
  assert.ok(Math.abs(/** @type {number} */ (pace.rate) - (1 / 1000 + 5 * 0.3 / 1000)) < 1e-15);
});

test('an account with no usable reading is left out, and none at all gives no pace', () => {
  const unknown = [
    { weight: null, windows: [{ utilization: 0.1, resetAt: 1000 }] },
    { weight: 1, windows: [{ utilization: null, resetAt: 1000 }] },
    { weight: 1, windows: [{ utilization: 0.1, resetAt: null }] },
    { weight: 1, windows: [{ utilization: 0.1, resetAt: 5 }] }, // reset has passed
    { weight: 1, windows: [] },
  ];
  assert.deepEqual(fleetPace({ now: 10, accounts: unknown }), { rate: null, headroom: 0, horizonMs: null });
  const one = fleetPace({ now: 10, accounts: [...unknown, { weight: 1, windows: [{ utilization: 0, resetAt: 110 }] }] });
  assert.equal(one.rate, 1 / 100);
});

test('a spent account contributes no pace and no headroom', () => {
  const pace = fleetPace({ now: 0, accounts: [{ weight: 1, windows: [{ utilization: 1.2, resetAt: 1000 }] }] });
  assert.equal(pace.rate, 0);
  assert.equal(pace.headroom, 0);
});

// ── Scheduler: admission ────────────────────────────────────────────────────

test('with no pace known every level passes straight through', async () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers });
  for (const level of [1, 2, 3]) {
    const t = track(s.request({ level, session: `s${level}`, estimate: 1e9 }));
    await flush();
    assert.ok(t.done && t.value, `level ${level}`);
  }
  assert.equal(s.status().mode, 'passthrough');
});

test('P1 is admitted at once even with the bucket empty and P2/P3 waiting', async () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers, depthMs: 1000 });
  s.setRate(1);
  const drain = await s.request({ level: 2, session: 'a', estimate: 1000 });
  assert.ok(drain);
  const p2 = track(s.request({ level: 2, session: 'b', estimate: 10 }));
  const p3 = track(s.request({ level: 3, session: 'c', estimate: 10 }));
  const p1 = track(s.request({ level: 1, session: 'rt', estimate: 500 }));
  await flush();
  assert.ok(p1.done && p1.value);
  assert.ok(!p2.done && !p3.done);
  assert.equal(s.status().mode, 'overdrive');
  assert.equal(s.status().debt, 500);
});

test('a waiting P2 is admitted once the bucket refills to its estimate', async () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers, depthMs: 1000 });
  s.setRate(1);
  await s.request({ level: 2, session: 'a', estimate: 1000 });
  const next = track(s.request({ level: 2, session: 'a', estimate: 100 }));
  await clock.advance(99);
  assert.ok(!next.done);
  await clock.advance(1);
  assert.ok(next.done && next.value);
});

test('an estimate bigger than the bucket needs only a full bucket', async () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers, depthMs: 100 });
  s.setRate(1);
  const big = track(s.request({ level: 2, session: 'a', estimate: 10_000 }));
  await flush();
  assert.ok(big.done && big.value, 'a full bucket admits it');
});

test('an aborted waiter leaves the queue and resolves null', async () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers, depthMs: 100 });
  s.setRate(1);
  await s.request({ level: 2, session: 'a', estimate: 100 });
  const ac = new AbortController();
  const waiting = s.request({ level: 3, session: 'b', estimate: 50, signal: ac.signal });
  assert.equal(s.status().queued[3], 1);
  ac.abort();
  assert.equal(await waiting, null);
  assert.equal(s.status().queued[3], 0);
});

test('a pace of zero holds P2/P3 until a new pace arrives', async () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers, depthMs: 100 });
  s.setRate(1);
  await s.request({ level: 2, session: 'a', estimate: 100 });
  s.setRate(0);
  const held = track(s.request({ level: 2, session: 'a', estimate: 10 }));
  await clock.advance(1e9);
  assert.ok(!held.done);
  s.setRate(1);
  await clock.advance(10);
  assert.ok(held.done && held.value);
});

// ── Scheduler: settlement ───────────────────────────────────────────────────

test('metering charges only past the reservation, and settling corrects to the actual cost', async () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers, depthMs: 1000 });
  s.setRate(1e-9); // effectively no refill during the test
  const before = s.status().bucket;
  const t = /** @type {import('../src/scheduler.js').Ticket} */ (await s.request({ level: 2, session: 'a', estimate: 100 }));
  assert.ok(Math.abs(s.status().bucket - (before - 100)) < 1e-3);
  t.meter(60);
  assert.ok(Math.abs(s.status().bucket - (before - 100)) < 1e-3, 'within the reservation');
  t.meter(130);
  assert.ok(Math.abs(s.status().bucket - (before - 130)) < 1e-3, 'past it');
  t.settle(120);
  assert.ok(Math.abs(s.status().bucket - (before - 120)) < 1e-3, 'refunded to actual');
  t.settle(5);
  assert.ok(Math.abs(s.status().bucket - (before - 120)) < 1e-3, 'a second settle is ignored');
  assert.equal(s.status().open[2], 0);
});

// ── Laws, as property tests ─────────────────────────────────────────────────

/**
 * Drive a random workload. Returns the admission log and a check hook.
 * Each request: arrives at a random time, has a random level and session, an
 * estimate, and an actual cost the scheduler only learns at settle.
 */
async function simulate(seed, { rate = 1, depthMs = 50, steps = 400, levels = [1, 2, 3], p1Weight = 0.1 } = {}) {
  const r = rng(seed);
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers, depthMs });
  s.setRate(rate);
  /** @type {Array<{ at: number, level: number, session: string, estimate: number, waitingP2: number, committed: number }>} */
  const admitted = [];
  const pending = [];
  for (let i = 0; i < steps; i++) {
    await clock.advance(Math.floor(r() * 20));
    const roll = r();
    const level = levels.includes(1) && roll < p1Weight ? 1 : (roll < 0.55 && levels.includes(2) ? 2 : (levels.includes(3) ? 3 : 2));
    const session = `s${level}-${Math.floor(r() * 3)}`;
    const estimate = 1 + Math.floor(r() * 40);
    const actual = Math.max(1, Math.round(estimate * (0.5 + r())));
    const p = s.request({ level, session, estimate }).then(ticket => {
      if (!ticket) return;
      const st = s.status();
      admitted.push({ at: clock.now(), level, session, estimate, waitingP2: st.queued[2], committed: st.committed });
      // Finish a little later at the actual cost.
      clock.timers.set(() => ticket.settle(actual), 1 + Math.floor(r() * 30));
    });
    pending.push(p);
  }
  await clock.advance(1e6);
  await Promise.all(pending);
  return { s, admitted, clock };
}

test('law: P1 never waits', async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = rng(seed);
    const clock = fakeClock();
    const s = new Scheduler({ now: clock.now, timers: clock.timers, depthMs: 10 });
    s.setRate(r() * 0.1);
    for (let i = 0; i < 50; i++) {
      // Keep P2/P3 piled up behind an empty bucket.
      s.request({ level: 2 + Math.floor(r() * 2), session: `x${i}`, estimate: 100 });
      const p1 = track(s.request({ level: 1, session: 'rt', estimate: 1 + r() * 100 }));
      await flush();
      assert.ok(p1.done && p1.value, `seed ${seed} step ${i}`);
      await clock.advance(Math.floor(r() * 5));
    }
  }
});

test('law: no P3 request is admitted while a P2 request is waiting', async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { admitted } = await simulate(seed);
    for (const a of admitted) {
      if (a.level === 3) assert.equal(a.waitingP2, 0, `seed ${seed}: P3 admitted at ${a.at} past a waiting P2`);
    }
  }
});

test('law: without P1, what is committed at each admission stays within R·t + depth + one estimate', async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const rate = 1, depthMs = 50, maxEstimate = 40;
    const { admitted } = await simulate(seed, { rate, depthMs, levels: [2, 3] });
    assert.ok(admitted.length > 50, `seed ${seed}: the workload admitted too little to test`);
    // `committed` is settled costs plus open reservations. Overruns past an
    // estimate land between admissions and are repaid before the next one.
    for (const a of admitted) {
      assert.ok(a.committed <= rate * a.at + rate * depthMs + maxEstimate + 1e-6,
        `seed ${seed}: ${a.committed} committed by ${a.at}`);
    }
  }
});

test('law: settling is exact — what the bucket was charged equals what the requests cost', async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = rng(seed);
    const clock = fakeClock();
    const s = new Scheduler({ now: clock.now, timers: clock.timers, depthMs: 1e12 });
    s.setRate(1); // a huge bucket on a clock that never moves: the bucket is a ledger
    const start = s.status().bucket;
    let total = 0;
    for (let i = 0; i < 100; i++) {
      const t = /** @type {import('../src/scheduler.js').Ticket} */ (await s.request({ level: 1 + Math.floor(r() * 3), session: `s${i % 4}`, estimate: Math.floor(r() * 50) }));
      const actual = Math.floor(r() * 80);
      let metered = 0;
      for (let k = 0; k < 3; k++) { metered += Math.floor(r() * actual / 2); t.meter(Math.min(metered, actual)); }
      t.settle(actual);
      total += actual;
    }
    assert.ok(Math.abs((start - s.status().bucket) - total) < 1e-3, `seed ${seed}`);
    assert.equal(s.status().committed, total);
  }
});

test('law: after overdrive leaves debt D, P2/P3 resume after (D + need) / R', async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = rng(seed);
    const rate = 0.5 + r();
    const clock = fakeClock();
    const s = new Scheduler({ now: clock.now, timers: clock.timers, depthMs: 100 });
    s.setRate(rate);
    // Empty the bucket, then overdrive by D.
    const drain = /** @type {import('../src/scheduler.js').Ticket} */ (await s.request({ level: 2, session: 'w', estimate: rate * 100 }));
    drain.settle(rate * 100);
    const debt = 50 + Math.floor(r() * 500);
    const rt = /** @type {import('../src/scheduler.js').Ticket} */ (await s.request({ level: 1, session: 'rt', estimate: debt }));
    assert.equal(s.status().mode, 'overdrive');
    rt.settle(debt);
    assert.equal(s.status().mode, 'recovering');
    assert.ok(Math.abs(s.status().debt - debt) < 1e-6);
    const need = 10;
    const waiter = track(s.request({ level: 3, session: 'p3', estimate: need }));
    const due = (debt + need) / rate;
    await clock.advance(Math.floor(due) - 1);
    assert.ok(!waiter.done, `seed ${seed}: admitted before the debt was repaid`);
    await clock.advance(2);
    assert.ok(waiter.done && waiter.value, `seed ${seed}: still held after repayment`);
    assert.equal(s.status().mode, 'paced');
  }
});

test('law: two P2 sessions competing share the pace evenly', async () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers, depthMs: 10 });
  s.setRate(1);
  /** @type {Record<string, number>} */
  const got = { a: 0, b: 0 };
  // Session a floods the queue; b asks one at a time. Fair share means b is
  // not stuck behind a's backlog.
  const loop = async (/** @type {string} */ session, /** @type {number} */ parallel) => {
    const one = async () => {
      while (clock.now() < 10_000) {
        const t = await s.request({ level: 2, session, estimate: 10 });
        if (!t) return;
        got[session] += 10;
        t.settle(10);
      }
    };
    await Promise.all(Array.from({ length: parallel }, one));
  };
  const runs = Promise.all([loop('a', 8), loop('b', 1)]);
  await clock.advanceTo(10_000);
  await clock.advance(1000);
  await runs;
  const share = got.b / (got.a + got.b);
  assert.ok(share > 0.4 && share < 0.6, `b got ${share}`);
});

test('law: paced from the live reading, the fleet lands on its limit at the reset', async () => {
  // One account, one window of length T. Demand always exceeds the pace; P1
  // bursts stay inside the window's capacity. Every tick the pace is
  // recomputed from the simulated utilization alone: no debt term is needed,
  // because a repayment pause raises the pace afterwards.
  for (let seed = 1; seed <= 8; seed++) {
    const r = rng(seed);
    const T = 100_000;
    const capacity = 1000; // cost units in the whole window
    let used = 0.1 * capacity * r(); // start partway in
    const clock = fakeClock();
    const s = new Scheduler({ now: clock.now, timers: clock.timers, depthMs: 500 });
    const repace = () => {
      const pace = fleetPace({ now: clock.now(), accounts: [{ weight: capacity, windows: [{ utilization: used / capacity, resetAt: T }] }] });
      s.setRate(pace.rate);
    };
    repace();
    let stop = false;
    const worker = async (/** @type {number} */ level, /** @type {string} */ session) => {
      while (!stop) {
        const est = 1 + Math.floor(r() * 4);
        const t = await s.request({ level, session, estimate: est });
        if (!t || stop) { t?.settle(0); return; }
        const actual = Math.max(0, est + (r() - 0.5) * 2);
        used += actual;
        t.settle(actual);
      }
    };
    const workers = [worker(2, 'a'), worker(3, 'b'), worker(2, 'c')];
    for (let at = 0; at < T; at += 100) {
      // An occasional P1 burst: overdrive, then repayment. None in the last
      // tenth, where a burst could not be repaid before the reset: that is the
      // case the law excludes (P1 demand beyond what the window holds).
      if (r() < 0.01 && at < 0.9 * T) {
        const burst = 20 + r() * 40;
        const t = await s.request({ level: 1, session: 'rt', estimate: burst });
        used += burst;
        t?.settle(burst);
      }
      repace();
      await clock.advanceTo(at + 100);
    }
    stop = true;
    s.setRate(1e9);
    await clock.advance(1);
    await Promise.all(workers);
    // Within a few requests' worth of exact.
    assert.ok(Math.abs(used - capacity) < 0.02 * capacity, `seed ${seed}: used ${used} of ${capacity}`);
  }
});

test('mode change is reported once per transition', async () => {
  const clock = fakeClock();
  /** @type {string[]} */
  const seen = [];
  const s = new Scheduler({ now: clock.now, timers: clock.timers, depthMs: 10, onModeChange: (mode) => seen.push(mode) });
  s.setRate(1);
  const rt = /** @type {import('../src/scheduler.js').Ticket} */ (await s.request({ level: 1, session: 'rt', estimate: 100 }));
  rt.settle(100);
  await clock.advance(200);
  assert.deepEqual(seen, ['paced', 'overdrive', 'recovering', 'paced']);
});
