// A malformed frame from an authenticated caller ends that caller's session,
// not the daemon (#4). Before the fix, mcpl-core's 'error' had no listener, so
// EventEmitter threw it from the readline callback as an uncaught exception,
// which in the daemon reaches the handler that stops every agent and exits.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { CallerPolicy } from '../src/config.js';
import { Session } from '../src/session.js';

/** The slice of a `ws` WebSocket that mcpl-core's fromWebSocket uses. */
class SocketDouble extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(text: string): void { this.sent.push(text); }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

function session(ws: SocketDouble) {
  const lines: string[] = [];
  let closed = 0;
  const caller = { name: 'alice' } as CallerPolicy;
  const s = new Session(
    caller,
    ws as never,
    { toolDefinitions: () => [], callTool: async () => ({ content: [] }) },
    { ready: () => {}, closed: () => { closed++; } },
    (line) => lines.push(line),
  );
  return { s, lines, closedCount: () => closed };
}

test('a line that is not JSON closes only that session, and says why', async () => {
  const ws = new SocketDouble();
  const { s, lines, closedCount } = session(ws);
  const served = s.serve();
  ws.emit('message', '{bad');
  await served;
  assert.equal(closedCount(), 1, 'the session reports itself closed');
  assert.equal(ws.readyState, 3, 'its socket is closed');
  assert.ok(lines.some((l) => l.startsWith('alice: ') && l.includes('Malformed JSON-RPC message')), lines.join('\n'));
});

test('a socket error closes only that session, and says why', async () => {
  const ws = new SocketDouble();
  const { s, lines, closedCount } = session(ws);
  const served = s.serve();
  ws.emit('error', new Error('connection reset'));
  await served;
  assert.equal(closedCount(), 1);
  assert.ok(lines.some((l) => l.includes('connection reset')), lines.join('\n'));
});
