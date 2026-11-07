// The Claude Code sessions the proxy has seen, as a forest: which session
// launched which, the subagents running inside each, and the priority each one
// runs at.
//
// A session's level is the first one found walking up its parent chain: the
// operator's override, else the level the client's own header asked for. With
// none anywhere on the chain, the default. So raising a coordinator raises
// every worker it launched that has no level of its own, live.
//
// Parent links come from two places. `teamclaude run` sends the parent it was
// launched from as a header, and every process that `claude` launches inherits
// that header, so a grandchild repeats its grandparent's claim. Where the proxy
// can read the client process (see peer-process.js), the parent is the session
// whose process the client descends from, nearest first. That replaces the
// claim, and a claim it contradicts was inherited, as was the priority header
// that came with it, which is then ignored.
//
// Links that would close a cycle are refused, so every chain ends.

import { SESSION_KNOWN_TTL_MS, SESSION_ACTIVE_TTL_MS } from './session-tracker.js';

/** @typedef {import('./scheduler.js').Level} Level */
/** @typedef {'set' | 'header' | 'inherited' | 'default'} LevelSource */
/** @typedef {{ level: Level, source: LevelSource, from?: string }} ResolvedLevel */
/** @typedef {{ id: string, type: string | null, parent: string | null }} AgentClaim */

/**
 * @typedef {{
 *   id: string, type: string | null, parent: string | null,
 *   lastSeen: number, requests: number, inFlight: number,
 * }} AgentNode
 *
 * @typedef {{
 *   id: string,
 *   parent: string | null,
 *   parentFromProcess: boolean,
 *   claim: string | null | undefined,
 *   header: Level | null,
 *   headersInherited: boolean,
 *   pid: number | null,
 *   start: number | null,
 *   cwd: string | null,
 *   firstSeen: number,
 *   lastSeen: number,
 *   requests: number,
 *   inFlight: number,
 *   agents: Map<string, AgentNode>,
 * }} SessionNode
 *
 * @typedef {{
 *   id: string, type: string | null, idleMs: number, requests: number,
 *   inFlight: number, agents: AgentView[],
 * }} AgentView
 *
 * @typedef {{
 *   id: string, parent: string | null, level: Level, source: LevelSource,
 *   from?: string, headersInherited: boolean, pid: number | null,
 *   cwd: string | null, idleMs: number, requests: number, inFlight: number,
 *   agents: AgentView[], children: SessionView[],
 * }} SessionView
 */

/** The session a client was launched from, sent by `teamclaude run`: a
 *  session id, or `-` for none. Never forwarded upstream. */
export const PARENT_HEADER = 'x-teamclaude-parent-session';

// What Claude Code sends to name the subagent a request comes from.
const REQUEST_CLASS = 'x-claude-code-request-class';
const AGENT_ID = 'x-claude-code-agent-id';
const AGENT_TYPE = 'x-claude-code-agent-type';
const PARENT_AGENT_ID = 'x-claude-code-parent-agent-id';

// Ids and types come from client headers and end up on a terminal.
const ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;
const TYPE_SHAPE = /^[A-Za-z0-9 ._:-]{1,64}$/;

/**
 * What one request's headers say about its session's place in the tree.
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {{ parentClaim: string | null | undefined, agent: AgentClaim | null }}
 */
export function requestClaims(headers) {
  const one = (/** @type {string} */ name, /** @type {RegExp} */ shape) => {
    const v = headers[name];
    return typeof v === 'string' && shape.test(v) ? v : null;
  };
  const claim = one(PARENT_HEADER, /^(-|[A-Za-z0-9._-]{1,128})$/);
  const agentId = headers[REQUEST_CLASS] === 'subagent' ? one(AGENT_ID, ID_SHAPE) : null;
  return {
    parentClaim: claim == null ? undefined : (claim === '-' ? null : claim),
    agent: agentId ? { id: agentId, type: one(AGENT_TYPE, TYPE_SHAPE), parent: one(PARENT_AGENT_ID, ID_SHAPE) } : null,
  };
}

export const MAX_GRAPH_SESSIONS = 10_000;
export const MAX_AGENTS_PER_SESSION = 64;
export const MAX_OVERRIDES = 1024;

export class SessionGraph {
  /**
   * @param {{ now?: () => number, knownTtlMs?: number, activeTtlMs?: number,
   *           maxSessions?: number, defaultLevel?: Level }} [opts]
   */
  constructor({ now = Date.now, knownTtlMs = SESSION_KNOWN_TTL_MS, activeTtlMs = SESSION_ACTIVE_TTL_MS, maxSessions = MAX_GRAPH_SESSIONS } = {}) {
    this.now = now;
    this.knownTtlMs = knownTtlMs;
    this.activeTtlMs = activeTtlMs;
    this.maxSessions = maxSessions;
    /** @type {Map<string, SessionNode>} */
    this.sessions = new Map();
    /** @type {Map<string, Level>} */
    this.overrides = new Map();
  }

  /** @param {string} id */
  node(id) { return this.sessions.get(id); }

  /** @param {string} id */
  override(id) { return this.overrides.get(id); }

  /**
   * Record what one request says about its session.
   * @param {string} id
   * @param {{ parentClaim?: string | null, header?: Level | null, agent?: AgentClaim | null }} claims
   *   parentClaim: undefined when the client made none, null for "launched at top level"
   */
  observe(id, { parentClaim, header = null, agent = null }) {
    const node = this._ensure(id);
    node.lastSeen = this.now();
    if (parentClaim !== undefined) {
      if (node.claim === undefined) node.claim = parentClaim;
      if (!node.parentFromProcess && node.parent == null && parentClaim != null) this._link(node, parentClaim);
    }
    if (header != null) node.header = header;
    if (agent) this._agent(node, agent);
  }

  /**
   * The client process behind a session (peer-process.js): the parent is the
   * session on the nearest ancestor process. A tree that finds none cannot
   * contradict a header claim, so the claim then stands.
   * @param {string} id
   * @param {import('./peer-process.js').PeerProcess} proc
   */
  resolveProcess(id, { pid, start, cwd, ancestors }) {
    const node = this._ensure(id);
    node.pid = pid;
    node.start = start;
    node.cwd = cwd;
    const parent = this._sessionOnProcesses(ancestors, id);
    if (parent == null) return;
    if (node.claim !== undefined && node.claim !== parent) node.headersInherited = true;
    node.parentFromProcess = true;
    node.parent = null;
    this._link(node, parent);
  }

  /**
   * The session on the first of `processes` that runs one, the most recently
   * active when several share it (a `/clear` starts a new session in the same
   * process).
   * @param {import('./peer-process.js').ProcessId[]} processes
   * @param {string} self
   */
  _sessionOnProcesses(processes, self) {
    for (const { pid, start } of processes) {
      /** @type {SessionNode | null} */
      let best = null;
      for (const n of this.sessions.values()) {
        if (n.id !== self && n.pid === pid && n.start === start && (!best || n.lastSeen > best.lastSeen)) best = n;
      }
      if (best) return best.id;
    }
    return null;
  }

  /**
   * @param {string} id
   * @param {string | null} agentId the subagent the request came from, null for the session itself
   */
  start(id, agentId) {
    const node = this._ensure(id);
    node.lastSeen = this.now();
    node.requests += 1;
    node.inFlight += 1;
    const agent = agentId ? node.agents.get(agentId) : null;
    if (agent) { agent.lastSeen = node.lastSeen; agent.requests += 1; agent.inFlight += 1; }
  }

  /**
   * @param {string} id
   * @param {string | null} agentId
   */
  finish(id, agentId) {
    const node = this.sessions.get(id);
    if (!node) return;
    node.lastSeen = this.now();
    node.inFlight = Math.max(0, node.inFlight - 1);
    const agent = agentId ? node.agents.get(agentId) : null;
    if (agent) { agent.lastSeen = node.lastSeen; agent.inFlight = Math.max(0, agent.inFlight - 1); }
  }

  /**
   * @param {string} id
   * @param {Level | null} level null clears it
   */
  setOverride(id, level) {
    this.overrides.delete(id);
    if (level == null) return;
    this.overrides.set(id, level);
    if (this.overrides.size > MAX_OVERRIDES) {
      const oldest = this.overrides.keys().next().value;
      if (oldest !== undefined) this.overrides.delete(oldest);
    }
  }

  /**
   * @param {string} id
   * @param {Level} defaultLevel
   * @returns {ResolvedLevel}
   */
  levelOf(id, defaultLevel) {
    const seen = new Set();
    for (let at = /** @type {string | null} */ (id); at != null && !seen.has(at);) {
      seen.add(at);
      const own = this._ownLevel(at);
      if (own) {
        if (at === id) return { level: own.level, source: own.source };
        return { level: own.level, source: 'inherited', from: at };
      }
      at = this.sessions.get(at)?.parent ?? null;
    }
    return { level: defaultLevel, source: 'default' };
  }

  /** Forget idle sessions, keeping any a live session still inherits through. */
  sweep() {
    const now = this.now();
    const keep = new Set();
    for (const node of this.sessions.values()) {
      if (node.inFlight === 0 && now - node.lastSeen > this.knownTtlMs) continue;
      for (let at = /** @type {string | null} */ (node.id); at != null && !keep.has(at); at = this.sessions.get(at)?.parent ?? null) keep.add(at);
    }
    for (const id of [...this.sessions.keys()]) {
      if (keep.has(id)) continue;
      this.sessions.delete(id);
      this.overrides.delete(id);
    }
  }

  /**
   * @param {Level} [defaultLevel]
   * @returns {{ sessions: SessionView[] }}
   */
  snapshot(defaultLevel = 2) {
    this.sweep();
    const now = this.now();
    /** @type {Map<string, SessionView>} */
    const views = new Map();
    for (const node of this.sessions.values()) {
      const resolved = this.levelOf(node.id, defaultLevel);
      views.set(node.id, {
        id: node.id, parent: node.parent, ...resolved,
        headersInherited: node.headersInherited, pid: node.pid, cwd: node.cwd,
        idleMs: now - node.lastSeen, requests: node.requests, inFlight: node.inFlight,
        agents: this._agentViews(node, now), children: [],
      });
    }
    /** @type {SessionView[]} */
    const roots = [];
    for (const view of views.values()) {
      const parent = view.parent == null ? undefined : views.get(view.parent);
      if (parent) parent.children.push(view);
      else roots.push(view);
    }
    return { sessions: roots };
  }

  /** @param {string} id */
  _ownLevel(id) {
    const set = this.overrides.get(id);
    if (set != null) return { level: set, source: /** @type {const} */ ('set') };
    const node = this.sessions.get(id);
    if (node?.header != null && !node.headersInherited) return { level: node.header, source: /** @type {const} */ ('header') };
    return null;
  }

  /**
   * Point `node` at `parent` unless that closes a cycle.
   * @param {SessionNode} node
   * @param {string} parent
   */
  _link(node, parent) {
    const seen = new Set();
    for (let at = /** @type {string | null} */ (parent); at != null && !seen.has(at); at = this.sessions.get(at)?.parent ?? null) {
      if (at === node.id) return;
      seen.add(at);
    }
    node.parent = parent;
  }

  /**
   * @param {SessionNode} node
   * @param {AgentClaim} claim
   */
  _agent(node, { id, type, parent }) {
    let agent = node.agents.get(id);
    if (!agent) {
      agent = { id, type, parent: parent && parent !== id ? parent : null, lastSeen: node.lastSeen, requests: 0, inFlight: 0 };
      node.agents.set(id, agent);
      if (node.agents.size > MAX_AGENTS_PER_SESSION) this._dropIdlestAgent(node);
    }
    agent.lastSeen = node.lastSeen;
  }

  /** @param {SessionNode} node */
  _dropIdlestAgent(node) {
    /** @type {AgentNode | null} */
    let idlest = null;
    for (const a of node.agents.values()) if (a.inFlight === 0 && (!idlest || a.lastSeen < idlest.lastSeen)) idlest = a;
    if (idlest) node.agents.delete(idlest.id);
  }

  /**
   * Subagents running now or seen within the active window, as a tree. One
   * whose parent agent has gone sits at the top.
   * @param {SessionNode} node
   * @param {number} now
   * @returns {AgentView[]}
   */
  _agentViews(node, now) {
    /** @type {Map<string, AgentView>} */
    const views = new Map();
    for (const a of node.agents.values()) {
      if (a.inFlight === 0 && now - a.lastSeen > this.activeTtlMs) continue;
      views.set(a.id, { id: a.id, type: a.type, idleMs: now - a.lastSeen, requests: a.requests, inFlight: a.inFlight, agents: [] });
    }
    /** @type {AgentView[]} */
    const top = [];
    for (const a of node.agents.values()) {
      const view = views.get(a.id);
      if (!view) continue;
      const parent = a.parent == null ? undefined : views.get(a.parent);
      if (parent && parent !== view) parent.agents.push(view);
      else top.push(view);
    }
    return top;
  }

  /** @param {string} id */
  _ensure(id) {
    let node = this.sessions.get(id);
    if (node) return node;
    const now = this.now();
    node = {
      id, parent: null, parentFromProcess: false, claim: undefined, header: null, headersInherited: false,
      pid: null, start: null, cwd: null, firstSeen: now, lastSeen: now, requests: 0, inFlight: 0, agents: new Map(),
    };
    this.sessions.set(id, node);
    if (this.sessions.size > this.maxSessions) this._makeRoom(id);
    return node;
  }

  /** @param {string} keep the session being added */
  _makeRoom(keep) {
    this.sweep();
    while (this.sessions.size > this.maxSessions) {
      /** @type {SessionNode | null} */
      let idlest = null;
      for (const n of this.sessions.values()) if (n.id !== keep && n.inFlight === 0 && (!idlest || n.lastSeen < idlest.lastSeen)) idlest = n;
      if (!idlest) return;
      this.sessions.delete(idlest.id);
      this.overrides.delete(idlest.id);
    }
  }
}
