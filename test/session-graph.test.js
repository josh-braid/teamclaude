// The session graph: which session launched which, the subagents inside each,
// and the priority each session runs at once inheritance is applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionGraph, requestClaims, PARENT_HEADER } from '../src/session-graph.js';

/** @param {number} seed */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = 1_000_000;

/** @param {import('../src/session-graph.js').SessionGraph} g @param {string} id */
const levelOf = (g, id) => g.levelOf(id, 2);

/** The reference: walk the parent chain and take the first level found. */
function referenceLevel(/** @type {Map<string, {parent: string|null, own: 1|2|3|null}>} */ model, /** @type {string} */ id) {
  const seen = new Set();
  for (let at = /** @type {string|null} */ (id); at && !seen.has(at); at = model.get(at)?.parent ?? null) {
    seen.add(at);
    const own = model.get(at)?.own;
    if (own != null) return own;
  }
  return 2;
}

test('a session with no level of its own takes the nearest ancestor\'s, and follows it live', () => {
  const g = new SessionGraph({ now: () => T0 });
  g.observe('root', {});
  g.observe('mid', { parentClaim: 'root' });
  g.observe('leaf', { parentClaim: 'mid' });
  assert.deepEqual(levelOf(g, 'leaf'), { level: 2, source: 'default' });
  g.setOverride('root', 1);
  assert.deepEqual(levelOf(g, 'leaf'), { level: 1, source: 'inherited', from: 'root' });
  g.setOverride('mid', 3);
  assert.deepEqual(levelOf(g, 'leaf'), { level: 3, source: 'inherited', from: 'mid' });
  g.setOverride('mid', null);
  assert.deepEqual(levelOf(g, 'leaf'), { level: 1, source: 'inherited', from: 'root' });
  assert.deepEqual(levelOf(g, 'root'), { level: 1, source: 'set' });
});

test('an override beats the session\'s own header, and its header beats inheritance', () => {
  const g = new SessionGraph({ now: () => T0 });
  g.observe('root', {});
  g.setOverride('root', 1);
  g.observe('kid', { parentClaim: 'root', header: 3 });
  assert.deepEqual(levelOf(g, 'kid'), { level: 3, source: 'header' });
  g.setOverride('kid', 2);
  assert.deepEqual(levelOf(g, 'kid'), { level: 2, source: 'set' });
});

test('law: the level is the first one found walking up the parent chain, for any forest and any overrides', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = mulberry32(seed);
    const g = new SessionGraph({ now: () => T0 });
    /** @type {Map<string, {parent: string|null, own: 1|2|3|null}>} */
    const model = new Map();
    const ids = Array.from({ length: 2 + Math.floor(rnd() * 12) }, (_, i) => `s${i}`);
    for (const id of ids) {
      // Parents may name anything, including later ids and itself: the graph
      // must refuse whatever would close a cycle.
      const parent = rnd() < 0.7 ? ids[Math.floor(rnd() * ids.length)] : null;
      const header = rnd() < 0.2 ? /** @type {1|2|3} */ (1 + Math.floor(rnd() * 3)) : null;
      g.observe(id, { parentClaim: parent, header });
    }
    for (let k = 0; k < 10; k++) {
      const id = ids[Math.floor(rnd() * ids.length)];
      g.setOverride(id, rnd() < 0.3 ? null : /** @type {1|2|3} */ (1 + Math.floor(rnd() * 3)));
    }
    for (const id of ids) {
      const node = g.node(id);
      assert.ok(node);
      model.set(id, { parent: node.parent, own: g.override(id) ?? node.header });
    }
    // The graph is a forest: every chain ends.
    for (const id of ids) {
      const seen = new Set();
      for (let at = /** @type {string|null} */ (id); at; at = model.get(at)?.parent ?? null) {
        assert.ok(!seen.has(at), `seed ${seed}: cycle through ${at}`);
        seen.add(at);
      }
    }
    for (const id of ids) assert.equal(levelOf(g, id).level, referenceLevel(model, id), `seed ${seed} ${id}`);
  }
});

test('a parent link that would close a cycle is refused', () => {
  const g = new SessionGraph({ now: () => T0 });
  g.observe('a', {});
  g.observe('b', { parentClaim: 'a' });
  g.observe('a', { parentClaim: 'b' });
  g.observe('c', { parentClaim: 'c' });
  assert.equal(g.node('a')?.parent, null);
  assert.equal(g.node('b')?.parent, 'a');
  assert.equal(g.node('c')?.parent, null);
});

/** A process as peer-process.js names it. */
const proc = (/** @type {number} */ pid, start = 1) => ({ pid, start });
const SHELL = proc(5);

test('the parent is the session whose process the client descends from, and it replaces a header claim', () => {
  const g = new SessionGraph({ now: () => T0 });
  g.observe('grand', {});
  g.resolveProcess('grand', { ...proc(10), cwd: '/w', ancestors: [SHELL] });
  g.observe('parent', { parentClaim: 'grand' });
  g.resolveProcess('parent', { ...proc(20), cwd: '/w', ancestors: [proc(15), proc(10), SHELL] });
  assert.equal(g.node('parent')?.parent, 'grand');
  // A plain `claude` started from inside `parent` inherits parent's launch
  // headers: they name `grand` and carry the level parent was launched at.
  g.observe('kid', { parentClaim: 'grand', header: 1 });
  assert.deepEqual(levelOf(g, 'kid'), { level: 1, source: 'header' });
  g.resolveProcess('kid', { ...proc(30), cwd: '/w/kid', ancestors: [proc(25), proc(20), proc(15), proc(10), SHELL] });
  assert.equal(g.node('kid')?.parent, 'parent', 'the nearest session process, not a further one');
  assert.equal(g.node('kid')?.cwd, '/w/kid');
  assert.deepEqual(levelOf(g, 'kid'), { level: 2, source: 'default' }, 'the inherited header is ignored');
  g.setOverride('parent', 3);
  assert.deepEqual(levelOf(g, 'kid'), { level: 3, source: 'inherited', from: 'parent' });
  // Later requests keep sending the inherited headers; they stay ignored.
  g.observe('kid', { parentClaim: 'grand', header: 1 });
  assert.deepEqual(levelOf(g, 'kid'), { level: 3, source: 'inherited', from: 'parent' });
});

test('a claim the process tree confirms keeps the header level', () => {
  const g = new SessionGraph({ now: () => T0 });
  g.observe('p', {});
  g.resolveProcess('p', { ...proc(10), cwd: null, ancestors: [SHELL] });
  g.observe('k', { parentClaim: 'p', header: 1 });
  g.resolveProcess('k', { ...proc(20), cwd: null, ancestors: [proc(10), SHELL] });
  assert.deepEqual(levelOf(g, 'k'), { level: 1, source: 'header' });
  // A top-level `teamclaude run` claims no parent ('-' on the wire, null here).
  g.observe('top', { parentClaim: null, header: 3 });
  g.resolveProcess('top', { ...proc(40), cwd: null, ancestors: [SHELL] });
  assert.deepEqual(levelOf(g, 'top'), { level: 3, source: 'header' });
});

test('a header with no parent claim is the client\'s own, whatever the process tree says', () => {
  const g = new SessionGraph({ now: () => T0 });
  g.observe('p', {});
  g.resolveProcess('p', { ...proc(10), cwd: null, ancestors: [] });
  g.observe('k', { header: 3 });
  g.resolveProcess('k', { ...proc(20), cwd: null, ancestors: [proc(10)] });
  assert.deepEqual(levelOf(g, 'k'), { level: 3, source: 'header' });
  assert.equal(g.node('k')?.parent, 'p');
});

test('a reused pid is not a parent: the start time must match too', () => {
  const g = new SessionGraph({ now: () => T0 });
  g.observe('old', {});
  g.resolveProcess('old', { ...proc(10, 100), cwd: null, ancestors: [] });
  g.observe('k', {});
  g.resolveProcess('k', { ...proc(20), cwd: null, ancestors: [proc(10, 999)] });
  assert.equal(g.node('k')?.parent, null);
});

test('of two sessions on one process, the more recently active is the parent', () => {
  let now = T0;
  const g = new SessionGraph({ now: () => now });
  g.observe('before-clear', {});
  g.resolveProcess('before-clear', { ...proc(10), cwd: null, ancestors: [] });
  now += 1000;
  g.observe('after-clear', {});
  g.resolveProcess('after-clear', { ...proc(10), cwd: null, ancestors: [] });
  g.observe('k', {});
  g.resolveProcess('k', { ...proc(20), cwd: null, ancestors: [proc(10)] });
  assert.equal(g.node('k')?.parent, 'after-clear');
});

test('subagents form a tree under their session', () => {
  const g = new SessionGraph({ now: () => T0 });
  g.observe('s', {});
  g.observe('s', { agent: { id: 'a1', type: 'general-purpose', parent: null } });
  g.observe('s', { agent: { id: 'a2', type: 'Explore', parent: 'a1' } });
  g.observe('s', { agent: { id: 'a3', type: 'Plan', parent: null } });
  const [root] = g.snapshot().sessions;
  assert.equal(root.id, 's');
  assert.deepEqual(root.agents.map(a => [a.id, a.type, a.agents.map(b => b.id)]), [['a1', 'general-purpose', ['a2']], ['a3', 'Plan', []]]);
});

test('the snapshot is a forest of live sessions with their level, activity and children', () => {
  let now = T0;
  const g = new SessionGraph({ now: () => now });
  g.observe('p', {});
  g.observe('k', { parentClaim: 'p' });
  g.setOverride('p', 1);
  g.start('k', null);
  now += 5000;
  const snap = g.snapshot();
  assert.equal(snap.sessions.length, 1);
  const [p] = snap.sessions;
  assert.equal(p.level, 1);
  assert.equal(p.source, 'set');
  assert.equal(p.children.length, 1);
  const [k] = p.children;
  assert.deepEqual([k.id, k.level, k.source, k.from, k.inFlight, k.requests, k.idleMs], ['k', 1, 'inherited', 'p', 1, 1, 5000]);
  g.finish('k', null);
  assert.equal(g.snapshot().sessions[0].children[0].inFlight, 0);
});

test('an idle session is forgotten, but not while a live descendant still inherits through it', () => {
  let now = T0;
  const g = new SessionGraph({ now: () => now, knownTtlMs: 1000 });
  g.observe('p', {});
  g.setOverride('p', 1);
  g.observe('k', { parentClaim: 'p' });
  g.observe('lone', {});
  now += 900;
  g.observe('k', {});
  now += 200;
  g.sweep();
  assert.equal(g.node('lone'), undefined);
  assert.ok(g.node('p'), 'p is idle but k still inherits through it');
  assert.deepEqual(levelOf(g, 'k'), { level: 1, source: 'inherited', from: 'p' });
  now += 2000;
  g.sweep();
  assert.equal(g.node('p'), undefined);
  assert.equal(g.node('k'), undefined);
  assert.equal(g.override('p'), undefined, 'a forgotten session takes its override with it');
});

test('a session in flight is never forgotten', () => {
  let now = T0;
  const g = new SessionGraph({ now: () => now, knownTtlMs: 1000 });
  g.observe('s', {});
  g.start('s', null);
  now += 5000;
  g.sweep();
  assert.ok(g.node('s'));
});

test('the graph holds at most maxSessions, dropping the longest idle', () => {
  let now = T0;
  const g = new SessionGraph({ now: () => now, maxSessions: 3 });
  for (const id of ['a', 'b', 'c', 'd']) { g.observe(id, {}); now += 10; }
  assert.equal(g.node('a'), undefined);
  assert.ok(g.node('d'));
});

test('requestClaims reads the parent claim and Claude Code\'s subagent headers, and refuses malformed ones', () => {
  const sid = '11111111-2222-3333-4444-555555555555';
  assert.deepEqual(requestClaims({}), { parentClaim: undefined, agent: null });
  assert.deepEqual(requestClaims({ [PARENT_HEADER]: '-' }), { parentClaim: null, agent: null });
  assert.deepEqual(requestClaims({ [PARENT_HEADER]: sid }), { parentClaim: sid, agent: null });
  assert.deepEqual(requestClaims({ [PARENT_HEADER]: 'x\u001b[2J' }), { parentClaim: undefined, agent: null });
  assert.deepEqual(requestClaims({
    'x-claude-code-request-class': 'subagent', 'x-claude-code-agent-id': 'a866a736c8df92345',
    'x-claude-code-agent-type': 'general-purpose', 'x-claude-code-parent-agent-id': 'a4f61c8096b414dc6',
  }).agent, { id: 'a866a736c8df92345', type: 'general-purpose', parent: 'a4f61c8096b414dc6' });
  assert.equal(requestClaims({ 'x-claude-code-request-class': 'main', 'x-claude-code-agent-id': 'a1' }).agent, null);
  assert.deepEqual(requestClaims({ 'x-claude-code-request-class': 'subagent', 'x-claude-code-agent-id': 'a1', 'x-claude-code-agent-type': 'evil\u001b]0;x' }).agent, { id: 'a1', type: null, parent: null });
});
