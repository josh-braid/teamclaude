// The TUI's sessions screen: the tree flattened into rows, and each row's text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenSessions, levelTag, activityText, moveSelection } from '../src/session-screen.js';

/** @param {Partial<import('../src/fleet-scheduler.js').SessionStatus>} over */
const node = over => /** @type {import('../src/fleet-scheduler.js').SessionStatus} */ ({
  id: 's', parent: null, level: 2, source: 'default', headersInherited: false, pid: null, cwd: null,
  idleMs: 0, requests: 0, inFlight: 0, held: 0, agents: [], children: [], ...over,
});

test('the tree flattens depth-first: a session, its subagents, then the sessions it launched', () => {
  const tree = [node({
    id: 'p',
    agents: [{ id: 'a1', type: 'Explore', idleMs: 0, requests: 1, inFlight: 1, agents: [{ id: 'a2', type: 'Plan', idleMs: 0, requests: 1, inFlight: 0, agents: [] }] }],
    children: [node({ id: 'k' })],
  }), node({ id: 'q' })];
  assert.deepEqual(flattenSessions(tree).map(r => [r.kind, r.depth, r.kind === 'session' ? r.node.id : r.agent.id]), [
    ['session', 0, 'p'], ['agent', 1, 'a1'], ['agent', 2, 'a2'], ['session', 1, 'k'], ['session', 0, 'q'],
  ]);
});

test('busy sessions come first, then the most recently active', () => {
  const tree = [node({ id: 'old', idleMs: 90_000 }), node({ id: 'busy', idleMs: 50_000, inFlight: 1 }), node({ id: 'new', idleMs: 1000 })];
  assert.deepEqual(flattenSessions(tree).map(r => r.kind === 'session' && r.node.id), ['busy', 'new', 'old']);
});

test('the level tag says where the level came from', () => {
  assert.equal(levelTag(node({ level: 1, source: 'set' })), 'P1 set');
  assert.equal(levelTag(node({ level: 3, source: 'header' })), 'P3 asked');
  assert.equal(levelTag(node({ level: 1, source: 'inherited', from: 'x' })), 'P1 inherited');
  assert.equal(levelTag(node({ level: 2, source: 'default' })), 'P2 default');
});

test('activity separates running from held, and an idle session says for how long', () => {
  assert.equal(activityText(node({ inFlight: 3, held: 1, requests: 40 })), 'running 2 · held 1 · 40 req');
  assert.equal(activityText(node({ requests: 5, idleMs: 125_000 })), 'idle 2m · 5 req');
  assert.equal(activityText(node({ requests: 1, idleMs: 4000 })), 'idle 4s · 1 req');
});

test('the cursor moves between sessions only, and stays on its session when rows move', () => {
  const rows = flattenSessions([node({ id: 'p', agents: [{ id: 'a1', type: null, idleMs: 0, requests: 1, inFlight: 1, agents: [] }], children: [node({ id: 'k' })] })]);
  assert.equal(moveSelection(rows, null, 0), 'p', 'no selection lands on the first session');
  assert.equal(moveSelection(rows, 'p', +1), 'k', 'agent rows are skipped');
  assert.equal(moveSelection(rows, 'k', +1), 'p', 'wraps');
  assert.equal(moveSelection(rows, 'p', -1), 'k');
  assert.equal(moveSelection(rows, 'gone', 0), 'p', 'a session that left gives way to the first');
  assert.equal(moveSelection([], 'p', +1), null);
});
