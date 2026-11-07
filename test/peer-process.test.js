// Finding the local process at the other end of a loopback connection, and the
// processes it descends from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { peerProcess, parseStat } from '../src/peer-process.js';

const linuxOnly = { skip: process.platform !== 'linux' && 'reads /proc' };

/**
 * Start `command` (argv) so that it connects to a fresh server and holds the
 * connection, and resolve with the server's side of that socket.
 * @param {string[]} command
 */
async function connected(command) {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {net.AddressInfo} */ (server.address()).port;
  const accepted = new Promise(resolve => server.once('connection', resolve));
  const script = `require('net').connect(${port}, '127.0.0.1'); setInterval(() => {}, 1000)`;
  const child = spawn(command[0], [...command.slice(1), script], { cwd: tmpdir(), stdio: 'ignore' });
  const socket = /** @type {net.Socket} */ (await accepted);
  return { socket, child, close: () => { child.kill(); socket.destroy(); server.close(); } };
}

const ownStart = () => parseStat(readFileSync(`/proc/${process.pid}/stat`, 'utf8'))?.start;

test('the peer is found with its working directory and the processes it descends from', linuxOnly, async () => {
  const { socket, child, close } = await connected([process.execPath, '-e']);
  try {
    const found = await peerProcess(socket);
    assert.ok(found, 'the peer was found');
    assert.equal(found.pid, child.pid);
    assert.equal(found.cwd, tmpdir());
    assert.deepEqual(found.ancestors[0], { pid: process.pid, start: ownStart() }, 'its parent is this test');
  } finally { close(); }
});

test('a process between the peer and its launcher is in the chain, nearest first', linuxOnly, async () => {
  // sh stays as the node process's parent because it has more to run after it.
  const { socket, child, close } = await connected(['sh', '-c', `"${process.execPath}" -e "$0"; true`]);
  try {
    const found = await peerProcess(socket);
    assert.ok(found);
    assert.equal(found.ancestors[0].pid, child.pid, 'sh first');
    assert.equal(found.ancestors[1].pid, process.pid, 'then this test');
  } finally { close(); }
});

test('a peer that is not on this machine is not looked up', async () => {
  const fake = /** @type {net.Socket} */ (/** @type {unknown} */ ({ remoteAddress: '10.0.0.5', remotePort: 1234, localPort: 3456 }));
  assert.equal(await peerProcess(fake), null);
});

test('parseStat reads the parent and start time, whatever the command name holds', () => {
  const fields = Array.from({ length: 50 }, (_, i) => String(i));
  fields[1] = '4242';      // ppid
  fields[19] = '987654';   // starttime
  assert.deepEqual(parseStat(`1234 (we) ird (name) ${fields.join(' ')}`), { ppid: 4242, start: 987654 });
  assert.equal(parseStat('garbage'), null);
});
