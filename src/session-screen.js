// The TUI's sessions screen, without the terminal: the scheduler's session tree
// flattened into display rows, the text of each row, and cursor movement.

/** @typedef {import('./fleet-scheduler.js').SessionStatus} SessionStatus */
/** @typedef {import('./session-graph.js').AgentView} AgentView */
/**
 * @typedef {{ kind: 'session', depth: number, node: SessionStatus }
 *         | { kind: 'agent', depth: number, session: string, agent: AgentView }} SessionRow
 */

const SOURCE_WORD = Object.freeze({ set: 'set', header: 'asked', inherited: 'inherited', default: 'default' });

/**
 * Depth-first: each session, then its subagents, then the sessions it
 * launched. Siblings put busy ones first, then the most recently active.
 * @param {SessionStatus[]} sessions
 * @returns {SessionRow[]}
 */
export function flattenSessions(sessions) {
  /** @type {SessionRow[]} */
  const rows = [];
  /** @param {string} session @param {AgentView[]} list @param {number} depth */
  const agents = (session, list, depth) => {
    for (const agent of order(list)) {
      rows.push({ kind: 'agent', depth, session, agent });
      agents(session, agent.agents, depth + 1);
    }
  };
  /** @param {SessionStatus[]} list @param {number} depth */
  const walk = (list, depth) => {
    for (const s of order(list)) {
      rows.push({ kind: 'session', depth, node: s });
      agents(s.id, s.agents, depth + 1);
      walk(s.children, depth + 1);
    }
  };
  walk(sessions, 0);
  return rows;
}

/**
 * @template {{ inFlight: number, idleMs: number }} T
 * @param {T[]} list
 */
function order(list) {
  return [...list].sort((a, b) => (Number(b.inFlight > 0) - Number(a.inFlight > 0)) || a.idleMs - b.idleMs);
}

/** @param {SessionStatus} s */
export function levelTag(s) {
  return `P${s.level} ${SOURCE_WORD[s.source]}`;
}

/** @param {{ inFlight: number, held?: number, requests: number, idleMs: number }} s */
export function activityText(s) {
  const held = s.held ?? 0;
  const running = s.inFlight - held;
  /** @type {string[]} */
  const parts = [];
  if (running > 0) parts.push(`running ${running}`);
  if (held > 0) parts.push(`held ${held}`);
  if (!parts.length) parts.push(`idle ${shortDuration(s.idleMs)}`);
  parts.push(`${s.requests} req`);
  return parts.join(' · ');
}

/** @param {number} ms */
function shortDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

/**
 * The session the cursor lands on after moving `step` session rows from
 * `current` (0 keeps it, if it is still there). Agent rows are not stops.
 * @param {SessionRow[]} rows
 * @param {string | null} current
 * @param {number} step
 * @returns {string | null}
 */
export function moveSelection(rows, current, step) {
  const ids = rows.flatMap(r => (r.kind === 'session' ? [r.node.id] : []));
  if (!ids.length) return null;
  const at = current == null ? -1 : ids.indexOf(current);
  if (at < 0) return ids[0];
  return ids[(at + step + ids.length) % ids.length];
}
