// The priority scheduler at the proxy's HTTP boundary: what a client sees when
// it is held, admitted ahead of others, or refused, and what upstream sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyRequestListener, createProxyServer, PRIORITY_HEADER } from '../src/server.js';
import { FleetScheduler, resolveSchedulerConfig } from '../src/fleet-scheduler.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const USAGE = { input_tokens: 10, output_tokens: 5 };

/** An upstream that answers every completion with a fixed usage, and records what it saw. */
function recordingUpstream() {
  /** @type {Array<{ url: string, headers: http.IncomingHttpHeaders }>} */
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ url: req.url || '', headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', id: `msg_${seen.length}`, content: [], usage: USAGE }));
    });
  });
  return { server, seen };
}

/** A pace source: one Pro account at `u7d` of its week, a week from reset. */
function paceSource(u7d) {
  return {
    accounts: [{
      name: 'pace', rateLimitTier: 'default_claude_ai',
      quota: { unified7d: u7d, unified7dReset: Date.now() + 7 * 24 * 3600_000 },
      usage: {},
    }],
    capFor: () => null,
    refreshExpiredQuotas() {},
  };
}

/**
 * @param {{ u7d?: number, config?: object,
 *           peerLookup?: (socket: unknown) => Promise<import('../src/peer-process.js').PeerProcess | null> }} [opts]
 */
function scheduler({ u7d = 0.5, config = {}, peerLookup = async () => null } = {}) {
  const fs = new FleetScheduler({
    config: resolveSchedulerConfig({ enabled: true, ...config }),
    accountManager: paceSource(u7d),
    log: () => {},
    peerLookup,
  });
  fs.learner.quotaPerToken = 1e-7;
  fs.refresh();
  return fs;
}

async function proxyWith(fs, upstreamPort) {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
  const listener = createProxyRequestListener({ accountManager: am, upstream: `http://127.0.0.1:${upstreamPort}`, scheduler: fs });
  const proxy = http.createServer(listener);
  return { proxy, port: await listen(proxy) };
}

/**
 * @param {number} port
 * @param {{ priority?: string, session?: string, bytes?: number, path?: string, extra?: Record<string, string> }} [opts]
 */
async function post(port, { priority, session = 'sess-0001', bytes = 0, path = '/v1/messages', extra = {} } = {}) {
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json', 'x-claude-code-session-id': session, ...extra };
  if (priority) headers[PRIORITY_HEADER] = priority;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'claude-x', messages: [], pad: 'x'.repeat(bytes) }),
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

test('the priority header is never forwarded upstream', async () => {
  const { server: upstream, seen } = recordingUpstream();
  const { proxy, port } = await proxyWith(scheduler(), await listen(upstream));
  try {
    assert.equal((await post(port, { priority: '1' })).status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers[PRIORITY_HEADER], undefined);
  } finally { proxy.close(); upstream.close(); }
});

test('with the scheduler off the header is still dropped and nothing is held', async () => {
  const { server: upstream, seen } = recordingUpstream();
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
  const proxy = http.createServer(createProxyRequestListener({ accountManager: am, upstream: `http://127.0.0.1:${await listen(upstream)}` }));
  const port = await listen(proxy);
  try {
    for (let i = 0; i < 3; i++) assert.equal((await post(port, { priority: '3', bytes: 1_000_000 })).status, 200);
    assert.equal(seen.length, 3);
    assert.equal(seen[0].headers[PRIORITY_HEADER], undefined);
  } finally { proxy.close(); upstream.close(); }
});

test('with the bucket spent, P3 is held and refused at maxHoldSeconds while P1 goes at once', async () => {
  const { server: upstream, seen } = recordingUpstream();
  // A near-spent week: the pace is a trickle, so one big request empties the bucket.
  const fs = scheduler({ u7d: 0.999999, config: { maxHoldSeconds: 0.3, depthSeconds: 1 } });
  const { proxy, port } = await proxyWith(fs, await listen(upstream));
  try {
    assert.equal((await post(port, { priority: '2', bytes: 400_000 })).status, 200, 'a full bucket admits the first');
    const started = Date.now();
    const held = post(port, { priority: '3', session: 'sess-0002' });
    const rt = await post(port, { priority: '1', session: 'sess-0003', bytes: 400_000 });
    assert.equal(rt.status, 200, 'P1 is not held');
    const refused = await held;
    assert.ok(Date.now() - started >= 250, 'P3 was held');
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get('retry-after')) >= 1);
    assert.match(refused.body, /scheduler_hold_expired/);
    assert.equal(seen.length, 2, 'the refused P3 never reached upstream');
    assert.equal(fs.status().mode, 'recovering');
  } finally { proxy.close(); upstream.close(); fs.close(); }
});

test('an admitted request is settled on the usage upstream reported', async () => {
  const { server: upstream } = recordingUpstream();
  const fs = scheduler({ config: { depthSeconds: 3600 } });
  const { proxy, port } = await proxyWith(fs, await listen(upstream));
  try {
    const before = fs.status().committedTokens;
    assert.equal((await post(port)).status, 200);
    // 10 input + 5 output × 5, whatever the estimate was.
    assert.equal(fs.status().committedTokens - before, 35);
    assert.equal(fs.status().inFlight[2], 0);
  } finally { proxy.close(); upstream.close(); fs.close(); }
});

test('a path-pinned request is not scheduled', async () => {
  const { server: upstream, seen } = recordingUpstream();
  const fs = scheduler({ u7d: 0.999999, config: { maxHoldSeconds: 0.2, depthSeconds: 1 } });
  const { proxy, port } = await proxyWith(fs, await listen(upstream));
  try {
    await post(port, { bytes: 400_000 });                       // spends the bucket
    assert.equal((await post(port, { priority: '3', path: '/tc-acct/a/v1/messages' })).status, 200);
    assert.equal(seen.length, 2);
  } finally { proxy.close(); upstream.close(); fs.close(); }
});

// ── the control plane, on the full server ───────────────────────────────────

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

async function server(config) {
  const { server: upstream } = recordingUpstream();
  const am = new AccountManager([oauth('alpha')], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${await listen(upstream)}`, ...config });
  const port = await listen(proxy);
  const call = async (/** @type {string} */ method, /** @type {string} */ path, /** @type {unknown} */ body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  return { call, close: () => { proxy.close(); upstream.close(); } };
}

test('status and quota carry the scheduler only when it is on', async () => {
  const off = await server({});
  try {
    assert.equal((await off.call('GET', '/teamclaude/status')).json.scheduler, undefined);
    assert.equal((await off.call('GET', '/teamclaude/quota')).json.scheduler, undefined);
  } finally { off.close(); }
  const on = await server({ scheduler: { enabled: true } });
  try {
    const st = (await on.call('GET', '/teamclaude/status')).json.scheduler;
    assert.equal(st.enabled, true);
    assert.equal(st.mode, 'passthrough', 'nothing learned yet');
    assert.deepEqual(st.episodes, []);
    const q = (await on.call('GET', '/teamclaude/quota')).json.scheduler;
    assert.equal(q.mode, 'passthrough');
  } finally { on.close(); }
});

test('the session-priority endpoint sets and clears an override, and validates', async () => {
  const on = await server({ scheduler: { enabled: true } });
  try {
    const set = await on.call('POST', '/teamclaude/session-priority', { sessionId: 'sess-abc', priority: 1 });
    assert.equal(set.status, 200);
    assert.equal(set.json.priority, 1);
    assert.deepEqual((await on.call('GET', '/teamclaude/status')).json.scheduler.sessionPriorities, { 'sess-abc': 1 });
    const cleared = await on.call('POST', '/teamclaude/session-priority', { sessionId: 'sess-abc', priority: null });
    assert.equal(cleared.json.priority, null);
    assert.deepEqual((await on.call('GET', '/teamclaude/status')).json.scheduler.sessionPriorities, {});
    assert.equal((await on.call('POST', '/teamclaude/session-priority', { sessionId: 'sess-abc', priority: 4 })).status, 400);
    assert.equal((await on.call('POST', '/teamclaude/session-priority', { priority: 1 })).status, 400);
  } finally { on.close(); }
  const off = await server({});
  try {
    assert.equal((await off.call('POST', '/teamclaude/session-priority', { sessionId: 'sess-abc', priority: 1 })).status, 409);
  } finally { off.close(); }
});

test('a streamed response is settled on its merged usage, cache fields included', async () => {
  const sse = [
    { type: 'message_start', message: { id: 'msg_s', usage: { input_tokens: 4, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'message_delta', usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse);
    });
  });
  const fs = scheduler({ config: { depthSeconds: 3600 } });
  const { proxy, port } = await proxyWith(fs, await listen(upstream));
  try {
    const before = fs.status().committedTokens;
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-stream' },
      body: JSON.stringify({ model: 'claude-x', stream: true, messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /message_stop/);
    // 4 + 1000 × 0.1 + 40 × 1.25 + 20 × 5
    assert.equal(fs.status().committedTokens - before, 4 + 100 + 50 + 100);
  } finally { proxy.close(); upstream.close(); fs.close(); }
});

// ── the session tree ────────────────────────────────────────────────────────

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';

test('a session launched from another inherits its level live, and the parent header never goes upstream', async () => {
  const { server: upstream, seen } = recordingUpstream();
  let lookups = 0;
  // The child's process descends from PARENT's; its inherited headers still
  // carry the level and parent claim PARENT was launched with.
  const fs = scheduler({
    config: { depthSeconds: 3600 },
    // One lookup per session, in request order: PARENT was started from a
    // shell, CHILD by a shell inside PARENT's process.
    peerLookup: async () => (++lookups === 1
      ? { pid: 4241, start: 1, cwd: '/work', ancestors: [{ pid: 100, start: 1 }] }
      : { pid: 4243, start: 1, cwd: '/work/child', ancestors: [{ pid: 4242, start: 1 }, { pid: 4241, start: 1 }] }),
  });
  const { proxy, port } = await proxyWith(fs, await listen(upstream));
  try {
    assert.equal((await post(port, { session: PARENT, priority: '1', extra: { 'x-teamclaude-parent-session': '-' } })).status, 200);
    assert.equal((await post(port, { session: CHILD, priority: '1', extra: { 'x-teamclaude-parent-session': '-' } })).status, 200);
    assert.equal(seen[1].headers['x-teamclaude-parent-session'], undefined);
    const tree = () => fs.status().sessions;
    const child = () => tree().find(s => s.id === PARENT)?.children.find(c => c.id === CHILD);
    assert.equal(child()?.cwd, '/work/child');
    assert.deepEqual([child()?.level, child()?.source, child()?.from], [1, 'inherited', PARENT]);
    fs.setSessionPriority(PARENT, 3);
    assert.deepEqual([child()?.level, child()?.source], [3, 'inherited']);
  } finally { proxy.close(); upstream.close(); fs.close(); }
});

test('subagents show under their session, and the tree counts requests and in-flight work', async () => {
  const { server: upstream } = recordingUpstream();
  const fs = scheduler({ config: { depthSeconds: 3600 } });
  const { proxy, port } = await proxyWith(fs, await listen(upstream));
  try {
    await post(port, { session: PARENT });
    await post(port, { session: PARENT, extra: { 'x-claude-code-request-class': 'subagent', 'x-claude-code-agent-id': 'a1', 'x-claude-code-agent-type': 'Explore' } });
    const [root] = fs.status().sessions;
    assert.equal(root.id, PARENT);
    assert.equal(root.requests, 2);
    assert.equal(root.inFlight, 0);
    assert.equal(root.held, 0);
    assert.deepEqual(root.agents.map(a => [a.id, a.type, a.requests]), [['a1', 'Explore', 1]]);
  } finally { proxy.close(); upstream.close(); fs.close(); }
});
