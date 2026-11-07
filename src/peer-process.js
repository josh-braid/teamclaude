// The local process at the other end of a loopback connection: its pid, its
// working directory, and the chain of processes it descends from.
//
// session-graph.js finds a session's parent by walking that chain to the
// nearest process that is itself a known session's client: a `claude` started
// from another session's Bash tool, or through `teamclaude run` inside it,
// descends from that session's process. Each process is named by its pid AND
// its start time, so a pid the kernel has since reused never matches.
//
// The environment cannot answer this: the Claude Code binary drops the
// CLAUDE_CODE_* variables it inherited from its own environment block, so a
// running `claude` no longer shows which session launched it.
//
// Linux only, and only for a peer on this machine whose /proc entries this
// process may read (the same user). Anywhere else the answer is null.

import { readFile, readdir, readlink } from 'node:fs/promises';

/** How far up the process tree to look. */
const MAX_ANCESTORS = 32;

/**
 * @typedef {{ pid: number, start: number }} ProcessId
 * @typedef {ProcessId & { cwd: string | null, ancestors: ProcessId[] }} PeerProcess
 */

/**
 * @param {{ remoteAddress?: string, remotePort?: number, localPort?: number }} socket
 * @param {{ procRoot?: string }} [opts]
 * @returns {Promise<PeerProcess | null>}
 */
export async function peerProcess(socket, { procRoot = '/proc' } = {}) {
  if (process.platform !== 'linux' || !isLoopback(socket.remoteAddress)) return null;
  const { remotePort, localPort } = socket;
  if (!remotePort || !localPort) return null;
  const inode = await socketInode(procRoot, remotePort, localPort);
  if (!inode) return null;
  const pid = await socketOwner(procRoot, inode);
  if (pid == null) return null;
  const [stat, cwd] = await Promise.all([readStat(procRoot, pid), readlink(`${procRoot}/${pid}/cwd`).catch(() => null)]);
  if (!stat) return null;
  /** @type {ProcessId[]} */
  const ancestors = [];
  for (let at = stat.ppid; at > 1 && ancestors.length < MAX_ANCESTORS;) {
    const up = await readStat(procRoot, at);
    if (!up) break;
    ancestors.push({ pid: at, start: up.start });
    at = up.ppid;
  }
  return { pid, start: stat.start, cwd, ancestors };
}

/**
 * The parent pid and start time (in clock ticks since boot) from a
 * /proc/<pid>/stat line. The command name is in parentheses and may itself
 * hold spaces and parentheses, so the fields are counted from the last `)`.
 * @param {string} line
 * @returns {{ ppid: number, start: number } | null}
 */
export function parseStat(line) {
  const close = line.lastIndexOf(')');
  if (close < 0) return null;
  const f = line.slice(close + 2).split(' ');
  const ppid = Number(f[1]);
  const start = Number(f[19]);
  return Number.isInteger(ppid) && Number.isInteger(start) ? { ppid, start } : null;
}

/** @param {string} procRoot @param {number} pid */
async function readStat(procRoot, pid) {
  const line = await readFile(`${procRoot}/${pid}/stat`, 'utf8').catch(() => null);
  return line == null ? null : parseStat(line);
}

/** @param {string | undefined} address */
function isLoopback(address) {
  if (!address) return false;
  if (address === '::1') return true;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return v4.startsWith('127.');
}

/**
 * The inode of the client's end of the connection: the socket whose local port
 * is our remote port and whose remote port is our local one.
 * @param {string} procRoot
 * @param {number} clientPort
 * @param {number} serverPort
 */
async function socketInode(procRoot, clientPort, serverPort) {
  const local = ':' + clientPort.toString(16).toUpperCase().padStart(4, '0');
  const remote = ':' + serverPort.toString(16).toUpperCase().padStart(4, '0');
  for (const table of ['tcp', 'tcp6']) {
    const text = await readFile(`${procRoot}/net/${table}`, 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length > 9 && f[1].endsWith(local) && f[2].endsWith(remote) && f[9] !== '0') return f[9];
    }
  }
  return null;
}

/**
 * The process holding socket `inode` open. Processes this user cannot read are
 * skipped, which is every process that is not this user's.
 * @param {string} procRoot
 * @param {string} inode
 */
async function socketOwner(procRoot, inode) {
  const target = `socket:[${inode}]`;
  const pids = (await readdir(procRoot).catch(() => [])).filter(name => /^\d+$/.test(name) && Number(name) !== process.pid);
  const found = await Promise.all(pids.map(async pid => {
    const fds = await readdir(`${procRoot}/${pid}/fd`).catch(() => []);
    for (const fd of fds) {
      if (await readlink(`${procRoot}/${pid}/fd/${fd}`).catch(() => null) === target) return Number(pid);
    }
    return null;
  }));
  return found.find(pid => pid != null) ?? null;
}
