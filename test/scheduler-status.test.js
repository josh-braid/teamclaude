import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedulerText, overdriveText, renderStatus } from '../src/status-renderer.js';

const NOW = 1_700_000_000_000;
const base = { enabled: true, mode: 'paced', pace: { tokensPerMinute: 12_345 }, debt: { fractionOfFleet: 0, clearsAt: null }, queued: { 2: 0, 3: 0 }, oldestWaitMs: { 2: null, 3: null }, overdrive: null, projectedLimitAt: null, resetsAt: null };

test('off, the scheduler says nothing', () => {
  assert.equal(schedulerText(undefined, NOW), null);
  assert.equal(schedulerText({ enabled: false }, NOW), null);
  assert.equal(overdriveText(undefined, NOW), null);
});

test('paced: the pace and who is waiting', () => {
  assert.equal(schedulerText(base, NOW), 'paced · 12.3k tok/min');
  assert.equal(schedulerText({ ...base, queued: { 2: 0, 3: 3 }, oldestWaitMs: { 2: null, 3: 240_000 } }, NOW), 'paced · 12.3k tok/min · P3 3 waiting (oldest 4m)');
});

test('recovering: how much debt and when P2/P3 resume', () => {
  const s = { ...base, mode: 'recovering', debt: { fractionOfFleet: 0.012, clearsAt: NOW + 360_000 } };
  assert.equal(schedulerText(s, NOW), 'recovering · 12.3k tok/min · repaying 1.20% of fleet quota · P2/P3 resume in ~6m');
});

test('a projected limit before the reset is stated', () => {
  const s = { ...base, projectedLimitAt: NOW + 14 * 3600_000, resetsAt: NOW + 62 * 3600_000 };
  assert.match(String(schedulerText(s, NOW)), /hits its limit in ~14h, 2d before reset/);
});

test('overdrive names how long and which sessions', () => {
  const s = { ...base, mode: 'overdrive', overdrive: { since: NOW - 180_000, sessions: ['a1b2c3d4-5555', 'e5f6a7b8-9999'] } };
  assert.equal(overdriveText(s, NOW), 'for 3m, driven by P1 a1b2c3d4, e5f6a7b8 · P2/P3 held');
});

test('renderStatus shows the scheduler and overdrive rows', () => {
  const out = renderStatus({ accounts: [], scheduler: { ...base, mode: 'overdrive', overdrive: { since: NOW - 60_000, sessions: ['abc'] }, debt: { fractionOfFleet: 0.001, clearsAt: null } } }, { color: false, now: NOW });
  assert.match(out, /^Scheduler +overdrive · 12\.3k tok\/min · in debt by 0\.10% of fleet quota$/m);
  assert.match(out, /^Overdrive +for 1m, driven by P1 abc · P2\/P3 held$/m);
  assert.doesNotMatch(renderStatus({ accounts: [] }, { color: false, now: NOW }), /Scheduler|Overdrive/);
});
