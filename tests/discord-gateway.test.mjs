import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayClient } from '../discord-gateway-lib.mjs';

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(frame) {
    this.sent.push(JSON.parse(frame));
  }

  close() {
    this.closed = true;
    this.emit('close', { code: 1000 });
  }

  receive(frame) {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const entries = new Map();

  return {
    now: () => now,
    random: () => 0,
    setTimeout(callback, milliseconds) {
      const id = nextId++;
      entries.set(id, { callback, due: now + milliseconds });
      return id;
    },
    clearTimeout(id) {
      entries.delete(id);
    },
    async advance(milliseconds) {
      const deadline = now + milliseconds;
      while (true) {
        const ready = [...entries.entries()]
          .filter(([, entry]) => entry.due <= deadline)
          .sort(([, left], [, right]) => left.due - right.due)[0];
        if (!ready) break;
        const [id, entry] = ready;
        entries.delete(id);
        now = entry.due;
        await entry.callback();
      }
      now = deadline;
    },
  };
}

function createHarness() {
  const sockets = [];
  const timers = createFakeTimers();
  const interactions = [];
  const statuses = [];
  const client = createGatewayClient({
    token: 'test-token',
    fetchImpl: async () => new Response(JSON.stringify({ url: 'wss://gateway.discord.test' })),
    WebSocketImpl: class extends FakeWebSocket {
      constructor(url) {
        super(url);
        sockets.push(this);
      }
    },
    onInteraction: async (value) => interactions.push(value.id),
    onStatus: (status) => statuses.push(status),
    timers,
  });
  return { client, interactions, sockets, statuses, timers };
}

test('identifies after HELLO and dispatches an interaction only once', async () => {
  const { client, interactions, sockets } = createHarness();
  await client.start();
  const socket = sockets[0];
  socket.receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  assert.deepEqual(socket.sent[0], {
    op: 2,
    d: {
      token: 'test-token',
      intents: 1,
      properties: { os: 'windows', browser: 'codex-discord', device: 'codex-discord' },
    },
  });

  socket.receive({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1', resume_gateway_url: 'wss://resume.test' } });
  socket.receive({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: { id: 'interaction-1' } });
  socket.receive({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: { id: 'interaction-1' } });
  await Promise.resolve();

  assert.deepEqual(interactions, ['interaction-1']);
  assert.deepEqual(client.getStatus(), {
    state: 'ready', sessionId: 'session-1', lastHeartbeatAt: null, lastAckAt: null,
    lastEventAt: 0, reconnectCount: 0, lastError: null,
  });
});

test('resumes with the previous session and latest sequence after reconnect', async () => {
  const { client, sockets, timers } = createHarness();
  await client.start();
  sockets[0].receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  sockets[0].receive({ op: 0, t: 'READY', s: 41, d: { session_id: 'session-1', resume_gateway_url: 'wss://resume.test' } });
  sockets[0].receive({ op: 7, d: null });
  await timers.advance(1_000);

  assert.equal(sockets[1].url, 'wss://resume.test?v=10&encoding=json');
  sockets[1].receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  assert.deepEqual(sockets[1].sent[0], {
    op: 6,
    d: { token: 'test-token', session_id: 'session-1', seq: 41 },
  });
  assert.equal(client.getStatus().reconnectCount, 1);
});

test('a successful resume returns to ready and keeps its session and updated sequence', async () => {
  const { client, sockets, timers } = createHarness();
  await client.start();
  sockets[0].receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  sockets[0].receive({ op: 0, t: 'READY', s: 41, d: { session_id: 'session-1', resume_gateway_url: 'wss://resume.test' } });
  sockets[0].receive({ op: 7, d: null });
  await timers.advance(1_000);
  sockets[1].receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  sockets[1].emit('message', { data: '{invalid-frame' });
  assert.equal(client.getStatus().lastError, 'gateway-frame-invalid');

  sockets[1].receive({ op: 0, t: 'RESUMED', s: 42, d: {} });
  assert.deepEqual(client.getStatus(), {
    state: 'ready', sessionId: 'session-1', lastHeartbeatAt: null, lastAckAt: null,
    lastEventAt: 1_000, reconnectCount: 1, lastError: null,
  });
  sockets[1].receive({ op: 7, d: null });
  await timers.advance(2_000);
  sockets[2].receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  assert.deepEqual(sockets[2].sent[0], {
    op: 6, d: { token: 'test-token', session_id: 'session-1', seq: 42 },
  });
});

test('a resumed event without an existing session cannot report ready', async () => {
  const { client, sockets } = createHarness();
  await client.start();
  sockets[0].receive({ op: 0, t: 'RESUMED', s: 42, d: {} });
  assert.equal(client.getStatus().state, 'connecting');
  assert.equal(client.getStatus().sessionId, null);
  sockets[0].receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  assert.equal(sockets[0].sent[0].op, 2);
});

test('resumed events from retired sockets or a stopped lifecycle cannot change state', async () => {
  const { client, sockets, timers } = createHarness();
  await client.start();
  sockets[0].receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  sockets[0].receive({ op: 0, t: 'READY', s: 41, d: { session_id: 'session-1', resume_gateway_url: 'wss://resume.test' } });
  sockets[0].receive({ op: 7, d: null });
  await timers.advance(1_000);
  const connecting = client.getStatus();
  sockets[0].receive({ op: 0, t: 'RESUMED', s: 99, d: {} });
  assert.deepEqual(client.getStatus(), connecting);
  await client.stop();
  const stopped = client.getStatus();
  sockets[1].receive({ op: 0, t: 'RESUMED', s: 100, d: {} });
  assert.deepEqual(client.getStatus(), stopped);
});

test('invalid session clears resumable state and identifies on the next connection', async () => {
  const { client, sockets, timers } = createHarness();
  await client.start();
  sockets[0].receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  sockets[0].receive({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1', resume_gateway_url: 'wss://resume.test' } });
  sockets[0].receive({ op: 9, d: false });
  await timers.advance(1_000);
  sockets[1].receive({ op: 10, d: { heartbeat_interval: 45_000 } });

  assert.deepEqual(sockets[1].sent[0], {
    op: 2,
    d: {
      token: 'test-token',
      intents: 1,
      properties: { os: 'windows', browser: 'codex-discord', device: 'codex-discord' },
    },
  });
  assert.equal(client.getStatus().sessionId, null);
});

test('reconnects when a heartbeat is not acknowledged before the next interval', async () => {
  const { client, sockets, timers } = createHarness();
  await client.start();
  sockets[0].receive({ op: 10, d: { heartbeat_interval: 10 } });
  await timers.advance(0);
  assert.deepEqual(sockets[0].sent[1], { op: 1, d: null });

  await timers.advance(10);
  await timers.advance(1_000);
  assert.equal(sockets.length, 2);
  assert.equal(client.getStatus().state, 'connecting');
});

test('gives a server-requested heartbeat a fresh ACK deadline', async () => {
  const { client, sockets, timers } = createHarness();
  await client.start();
  const socket = sockets[0];
  socket.receive({ op: 10, d: { heartbeat_interval: 10 } });
  socket.receive({ op: 1, d: null });
  assert.deepEqual(socket.sent[1], { op: 1, d: null });

  await timers.advance(0);
  assert.equal(client.getStatus().state, 'connecting');
  socket.receive({ op: 11, d: null });
  await timers.advance(9);
  assert.equal(socket.sent.length, 2);
  await timers.advance(1);
  assert.deepEqual(socket.sent[2], { op: 1, d: null });
});

test('retires a reconnecting socket and ignores its stale events', async () => {
  const { client, interactions, sockets, timers } = createHarness();
  await client.start();
  const oldSocket = sockets[0];
  oldSocket.receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  oldSocket.receive({ op: 7, d: null });

  assert.equal(oldSocket.closed, true);
  oldSocket.receive({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: { id: 'stale-interaction' } });
  await Promise.resolve();
  assert.deepEqual(interactions, []);
  await timers.advance(1_000);
  assert.equal(sockets.length, 2);
  assert.equal(client.getStatus().state, 'connecting');
});

test('does not deliver a queued interaction after stop and accepts it once after restart', async () => {
  const { client, interactions, sockets } = createHarness();
  await client.start();
  sockets[0].receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  sockets[0].receive({ op: 0, t: 'INTERACTION_CREATE', s: 1, d: { id: 'interaction-1' } });
  await client.stop();
  await Promise.resolve();

  assert.deepEqual(interactions, []);
  await client.start();
  sockets[1].receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  sockets[1].receive({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: { id: 'interaction-1' } });
  await Promise.resolve();

  assert.deepEqual(interactions, ['interaction-1']);
});

test('does not deliver a queued interaction after reconnect and accepts it once on the new socket', async () => {
  const { client, interactions, sockets, timers } = createHarness();
  await client.start();
  sockets[0].receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  sockets[0].receive({ op: 0, t: 'INTERACTION_CREATE', s: 1, d: { id: 'interaction-1' } });
  sockets[0].receive({ op: 7, d: null });
  await Promise.resolve();

  assert.deepEqual(interactions, []);
  await timers.advance(1_000);
  sockets[1].receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  sockets[1].receive({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: { id: 'interaction-1' } });
  await Promise.resolve();

  assert.deepEqual(interactions, ['interaction-1']);
});

test('ignores a stopped start request when its gateway fetch resolves late', async () => {
  const sockets = [];
  let resolveFirstFetch;
  let fetchCalls = 0;
  const client = createGatewayClient({
    token: 'test-token',
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Promise((resolve) => { resolveFirstFetch = resolve; });
      }
      return new Response(JSON.stringify({ url: 'wss://fresh.gateway.test' }));
    },
    WebSocketImpl: class extends FakeWebSocket {
      constructor(url) {
        super(url);
        sockets.push(this);
      }
    },
    onInteraction: async () => {},
    onStatus: () => {},
    timers: createFakeTimers(),
  });

  const staleStart = client.start();
  await client.stop();
  await client.start();
  resolveFirstFetch(new Response(JSON.stringify({ url: 'wss://stale.gateway.test' })));
  await staleStart;

  assert.deepEqual(sockets.map((socket) => socket.url), ['wss://fresh.gateway.test?v=10&encoding=json']);
  assert.equal(client.getStatus().state, 'connecting');
});

test('contains a synchronous interaction handler exception as sanitized status', async () => {
  const statuses = [];
  const socket = new FakeWebSocket('wss://gateway.discord.test');
  const client = createGatewayClient({
    token: 'test-token',
    fetchImpl: async () => new Response(JSON.stringify({ url: 'wss://gateway.discord.test' })),
    WebSocketImpl: class { constructor() { return socket; } },
    onInteraction: () => { throw new Error('handler input leaked'); },
    onStatus: (status) => statuses.push(status),
    timers: createFakeTimers(),
  });
  await client.start();
  socket.receive({ op: 10, d: { heartbeat_interval: 45_000 } });

  assert.doesNotThrow(() => socket.receive({ op: 0, t: 'INTERACTION_CREATE', s: 1, d: { id: 'interaction-1' } }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(client.getStatus().lastError, 'interaction-handler-failed');
  assert.equal(JSON.stringify(statuses).includes('handler input leaked'), false);
});

test('reports only sanitized status data when the gateway request fails', async () => {
  const statuses = [];
  const client = createGatewayClient({
    token: 'super-secret-token',
    fetchImpl: async () => { throw new Error('failed with super-secret-token and interaction-body'); },
    WebSocketImpl: FakeWebSocket,
    onInteraction: async () => {},
    onStatus: (status) => statuses.push(status),
    timers: createFakeTimers(),
  });

  await assert.rejects(() => client.start(), /Discord Gateway connection failed/);
  const serialized = JSON.stringify({ status: client.getStatus(), statuses });
  assert.equal(serialized.includes('super-secret-token'), false);
  assert.equal(serialized.includes('interaction-body'), false);
});

test('sanitizes WebSocket construction failures before they reach consumers', async () => {
  const statuses = [];
  const client = createGatewayClient({
    token: 'super-secret-token',
    fetchImpl: async () => new Response(JSON.stringify({ url: 'wss://gateway.discord.test' })),
    WebSocketImpl: class {
      constructor() {
        throw new Error('WebSocket rejected super-secret-token');
      }
    },
    onInteraction: async () => {},
    onStatus: (status) => statuses.push(status),
    timers: createFakeTimers(),
  });

  await assert.rejects(() => client.start(), /Discord Gateway connection failed/);
  const serialized = JSON.stringify({ status: client.getStatus(), statuses });
  assert.equal(serialized.includes('super-secret-token'), false);
});

test('allows a client to retry start after a transient gateway URL failure', async () => {
  const sockets = [];
  let attempts = 0;
  const client = createGatewayClient({
    token: 'test-token',
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary failure');
      return new Response(JSON.stringify({ url: 'wss://gateway.discord.test' }));
    },
    WebSocketImpl: class extends FakeWebSocket {
      constructor(url) {
        super(url);
        sockets.push(this);
      }
    },
    onInteraction: async () => {},
    onStatus: () => {},
    timers: createFakeTimers(),
  });

  await assert.rejects(() => client.start(), /Discord Gateway connection failed/);
  await client.start();
  assert.equal(sockets.length, 1);
});
