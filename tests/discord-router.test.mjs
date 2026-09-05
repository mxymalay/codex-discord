import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import * as bridge from '../discord-bridge-lib.mjs';

function fakeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit('close');
  };
  socket.write = () => {};
  return socket;
}

test('router connection timeout rejects a pending request and destroys an unconnected socket', async () => {
  assert.equal(typeof bridge.createCodexRouterSession, 'function');
  const socket = fakeSocket();
  const session = bridge.createCodexRouterSession({ connectImpl: () => socket, timeoutMs: 10 });
  try {
    const outcome = await Promise.race([
      session.request({ method: 'initialize' }).then(() => 'unexpected success', (error) => error.message),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 150)),
    ]);
    assert.match(outcome, /connect.*timed out|timed out.*connect/i);
    assert.equal(socket.destroyed, true);
  } finally { session.close(); }
});

test('router clears its connection deadline once connected and still times out unanswered requests', async () => {
  const socket = fakeSocket();
  const session = bridge.createCodexRouterSession({ connectImpl: () => socket, timeoutMs: 10 });
  socket.emit('connect');
  try {
    await assert.rejects(session.request({ method: 'initialize' }), /timed out waiting for initialize/);
    assert.equal(socket.destroyed, false);
  } finally { session.close(); }
});
