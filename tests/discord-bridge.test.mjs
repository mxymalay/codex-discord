import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startNewCodexTask } from '../discord-task-create-lib.mjs';

import {
  AppServerClient,
  buildCodexAppServerMessages,
  cancelContinuation,
  classifyReply,
  compareSnowflakes,
  createContinuationRequest,
  createEmptyInboxState,
  dispatchContinuation,
  discordRequest,
  enqueueContinuation,
  enqueuePendingReply,
  getPendingReplies,
  initializeAppServerClient,
  initializeInboxCursors,
  isActiveWriterError,
  listContinuations,
  markContinuationDelivered,
  migrateInboxState,
  migrateLegacyPendingReplies,
  recordInboxMessage,
  removePendingReply,
  resolveCodexExecutable,
  resumeCodexThread,
} from '../discord-bridge-lib.mjs';

const config = {
  discordGuildId: '222222222222222222',
  discordAllowedUserId: '333333333333333333',
  discordTaskChannelId: '444444444444444444',
  discordConfirmationChannelId: '555555555555555555',
  discordQuotaChannelId: '666666666666666666',
};

const mapping = {
  version: 1,
  messages: {
    '777777777777777701': {
      threadId: '11111111-1111-4111-8111-111111111111',
      cwd: 'C:\\workspace\\demo',
      channelId: config.discordConfirmationChannelId,
      eventName: 'user-task-confirmation-required',
    },
  },
};

function scriptedAppServerProcess({ threadId, turnId, resume = false }) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => child.emit('close', 0);
  let buffered = '';
  child.stdin.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const message = JSON.parse(line);
      if (message.method === 'initialized') continue;
      let result = {};
      if (message.method === 'thread/start' || message.method === 'thread/resume') {
        result = { thread: { id: threadId, name: null } };
      }
      if (message.method === 'turn/start') {
        const response = JSON.stringify({ id: message.id, result: { turn: { id: turnId } } });
        const completion = JSON.stringify({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
        child.stdout.write(`${response}\n${completion}\n`);
        continue;
      }
      child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
    }
  });
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)));
  return { child, resume };
}

function makeMessage(overrides = {}) {
  return {
    id: '777777777777777801',
    guild_id: config.discordGuildId,
    channel_id: config.discordConfirmationChannelId,
    author: { id: config.discordAllowedUserId, bot: false },
    content: '可以，但先备份，只做前两项。',
    message_reference: {
      guild_id: config.discordGuildId,
      channel_id: config.discordConfirmationChannelId,
      message_id: '777777777777777701',
    },
    ...overrides,
  };
}

test('accepts arbitrary text only when replying to a mapped task message', () => {
  const result = classifyReply(makeMessage(), config, mapping, createEmptyInboxState());
  assert.equal(result.accepted, true);
  assert.equal(result.text, '可以，但先备份，只做前两项。');
  assert.equal(result.mapping.threadId, '11111111-1111-4111-8111-111111111111');
});

test('accepts REST-fetched replies when Discord omits the optional guild id', () => {
  const message = makeMessage();
  delete message.guild_id;
  const result = classifyReply(message, config, mapping, createEmptyInboxState());
  assert.equal(result.accepted, true);
});

test('rejects unauthorized, unmapped, empty, duplicate, bot, and quota messages', async (t) => {
  const cases = [
    ['wrong user', { author: { id: '777777777777777901', bot: false } }],
    ['bot author', { author: { id: config.discordAllowedUserId, bot: true } }],
    ['not a reply', { message_reference: null }],
    ['unknown reference', { message_reference: { message_id: '777777777777777999' } }],
    ['empty text', { content: '   ' }],
    ['wrong guild', { guild_id: '777777777777777902' }],
    ['quota channel', { channel_id: config.discordQuotaChannelId }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, () => {
      assert.equal(classifyReply(makeMessage(overrides), config, mapping, createEmptyInboxState()).accepted, false);
    });
  }

  const duplicateState = createEmptyInboxState();
  duplicateState.processedMessageIds.push('777777777777777801');
  assert.equal(classifyReply(makeMessage(), config, mapping, duplicateState).accepted, false);
});

test('rejects a mapping whose notification channel does not match the reply channel', () => {
  const wrongChannelMapping = structuredClone(mapping);
  wrongChannelMapping.messages['777777777777777701'].channelId = config.discordTaskChannelId;
  assert.equal(classifyReply(makeMessage(), config, wrongChannelMapping, createEmptyInboxState()).accepted, false);
});

test('builds initialize, resume, and turn requests without creating a new thread', () => {
  const messages = buildCodexAppServerMessages({
    threadId: '11111111-1111-4111-8111-111111111111',
    cwd: 'C:\\workspace\\demo',
    text: '重新检查一次，只修改显示格式。',
  });
  assert.deepEqual(messages.map((message) => message.method), ['initialize', 'initialized', 'thread/resume', 'turn/start']);
  assert.equal(messages.some((message) => message.method === 'thread/start'), false);
  assert.equal(messages[2].params.threadId, '11111111-1111-4111-8111-111111111111');
  assert.equal(messages[2].params.cwd, 'C:\\workspace\\demo');
  assert.deepEqual(messages[3].params.input, [{ type: 'text', text: '重新检查一次，只修改显示格式。' }]);
});

test('exports the App Server client and initializes reusable clients before requests', async () => {
  const messages = [];
  const client = {
    async request(message) {
      messages.push(message);
      return {};
    },
    send(message) {
      messages.push(message);
    },
  };

  assert.equal(typeof AppServerClient, 'function');
  await initializeAppServerClient(client);
  assert.deepEqual(messages, [
    {
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'codex-discord-bridge', version: '1.0.0' } },
    },
    { method: 'initialized', params: {} },
  ]);
});

test('resume uses the reusable initializer before preserving resume and turn completion order', async () => {
  const methods = [];
  const client = {
    async request(message) {
      methods.push(message.method);
      if (message.method === 'thread/resume') return { thread: { id: 'thread-resume' } };
      if (message.method === 'turn/start') return { turn: { id: 'turn-resume' } };
      return {};
    },
    send(message) {
      methods.push(message.method);
    },
    waitForTurn(turnId) {
      assert.equal(turnId, 'turn-resume');
      methods.push('waitForTurn');
      return Promise.resolve({ turn: { id: turnId } });
    },
    close() {
      methods.push('close');
    },
  };

  const resumed = await resumeCodexThread({
    threadId: 'thread-resume',
    cwd: 'C:\\workspace',
    processCwd: 'C:\\workspace',
    text: 'continue',
    codexPath: 'not-used',
    clientFactory: () => client,
  });
  assert.equal(resumed.turnId, 'turn-resume');
  await resumed.completion;
  assert.deepEqual(methods, [
    'initialize', 'initialized', 'thread/resume', 'turn/start', 'waitForTurn', 'close',
  ]);
});

test('new task consumes an early completion from the same stdout chunk and closes promptly', async () => {
  const { child } = scriptedAppServerProcess({ threadId: 'thread-early-new', turnId: 'turn-early-new' });
  const client = new AppServerClient({
    codexPath: 'not-used', cwd: 'C:\\workspace', spawnImpl: () => child,
  });
  const result = await startNewCodexTask({
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\workspace'] },
    workspace: { mode: 'local', cwd: 'C:\\workspace', runtimeWorkspaceRoots: ['C:\\workspace'] },
    text: 'early', interactionId: 'early-new', codexPath: 'not-used', processCwd: 'C:\\workspace',
    clientFactory: () => client,
  });
  assert.equal((await result.completion).turn.id, 'turn-early-new');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.stdin.writableEnded, true);
});

test('resume consumes an early completion from the same stdout chunk and closes promptly', async () => {
  const { child } = scriptedAppServerProcess({ threadId: 'thread-early-resume', turnId: 'turn-early-resume', resume: true });
  const client = new AppServerClient({
    codexPath: 'not-used', cwd: 'C:\\workspace', spawnImpl: () => child,
  });
  const result = await resumeCodexThread({
    threadId: 'thread-early-resume', cwd: 'C:\\workspace', text: 'continue', codexPath: 'not-used',
    clientFactory: () => client,
  });
  assert.equal((await result.completion).turn.id, 'turn-early-resume');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.stdin.writableEnded, true);
});

test('early completion buffering has bounded size and retention', async () => {
  let clock = 0;
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => {};
  const client = new AppServerClient({
    codexPath: 'not-used', cwd: 'C:\\workspace', spawnImpl: () => child,
    earlyCompletionMax: 2, earlyCompletionTtlMs: 10, now: () => clock,
  });
  const completed = (id) => `${JSON.stringify({ method: 'turn/completed', params: { turn: { id } } })}\n`;
  child.stdout.write(completed('turn-1'));
  child.stdout.write(completed('turn-2'));
  child.stdout.write(completed('turn-3'));

  await assert.rejects(() => client.waitForTurn('turn-1', 5), /completion timed out/);
  assert.equal((await client.waitForTurn('turn-2', 5)).turn.id, 'turn-2');
  clock = 11;
  await assert.rejects(() => client.waitForTurn('turn-3', 5), /completion timed out/);
  client.close();
  child.emit('close', 0);
});

test('early completion configuration is clamped to finite positive integer safety limits', () => {
  const makeChild = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => {};
    return child;
  };
  const hugeChild = makeChild();
  const huge = new AppServerClient({
    codexPath: 'not-used', cwd: 'C:\\workspace', spawnImpl: () => hugeChild,
    earlyCompletionMax: Number.MAX_SAFE_INTEGER,
    earlyCompletionTtlMs: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(huge.earlyCompletionMax, 1_000);
  assert.equal(huge.earlyCompletionTtlMs, 60 * 60 * 1000);

  const fractionalChild = makeChild();
  const fractional = new AppServerClient({
    codexPath: 'not-used', cwd: 'C:\\workspace', spawnImpl: () => fractionalChild,
    earlyCompletionMax: 2.9, earlyCompletionTtlMs: 10.9,
  });
  assert.equal(fractional.earlyCompletionMax, 2);
  assert.equal(fractional.earlyCompletionTtlMs, 10);
  assert.equal(Number.isInteger(fractional.earlyCompletionMax), true);
  assert.equal(Number.isInteger(fractional.earlyCompletionTtlMs), true);

  const invalidChild = makeChild();
  const invalid = new AppServerClient({
    codexPath: 'not-used', cwd: 'C:\\workspace', spawnImpl: () => invalidChild,
    earlyCompletionMax: Number.NaN, earlyCompletionTtlMs: Number.POSITIVE_INFINITY,
  });
  assert.equal(invalid.earlyCompletionMax, 100);
  assert.equal(invalid.earlyCompletionTtlMs, 5 * 60 * 1000);

  huge.close();
  fractional.close();
  invalid.close();
});

test('orders Discord Snowflakes numerically', () => {
  const values = ['777777777777777801', '777777777777777702', '777777777777777710'];
  assert.deepEqual(values.sort(compareSnowflakes), [
    '777777777777777702',
    '777777777777777710',
    '777777777777777801',
  ]);
});

test('first run baselines channels while later runs preserve cursors for offline catch-up', async () => {
  const state = createEmptyInboxState();
  const calls = [];
  await initializeInboxCursors({
    state,
    channelIds: [config.discordTaskChannelId, config.discordConfirmationChannelId],
    getLatest: async (channelId) => {
      calls.push(channelId);
      return channelId === config.discordTaskChannelId ? '777777777777777820' : '777777777777777830';
    },
  });
  assert.equal(state.initialized, true);
  assert.equal(state.cursors[config.discordTaskChannelId], '777777777777777820');
  assert.equal(state.cursors[config.discordConfirmationChannelId], '777777777777777830');
  assert.equal(calls.length, 2);

  await initializeInboxCursors({
    state,
    channelIds: [config.discordTaskChannelId, config.discordConfirmationChannelId],
    getLatest: async () => {
      throw new Error('existing cursors must not be replaced');
    },
  });
});

test('records processed messages and advances channel cursor monotonically', () => {
  const state = createEmptyInboxState();
  state.initialized = true;
  state.cursors[config.discordTaskChannelId] = '777777777777777801';
  recordInboxMessage(state, config.discordTaskChannelId, '777777777777777820', true);
  recordInboxMessage(state, config.discordTaskChannelId, '777777777777777810', false);
  assert.equal(state.cursors[config.discordTaskChannelId], '777777777777777820');
  assert.deepEqual(state.processedMessageIds, ['777777777777777820']);
});

test('Discord REST requests always send the required Bot user agent', async () => {
  let observedHeaders;
  const result = await discordRequest({
    token: 'test-token',
    route: '/users/@me',
    fetchImpl: async (_url, options) => {
      observedHeaders = options.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'bot-id' }),
      };
    },
  });

  assert.deepEqual(result, { id: 'bot-id' });
  assert.equal(observedHeaders.Authorization, 'Bot test-token');
  assert.match(observedHeaders['User-Agent'], /^DiscordBot \(.+, \d+\.\d+\.\d+\)$/);
});

test('queues an active-writer reply with encrypted text and no plaintext at rest', () => {
  const state = createEmptyInboxState();
  const accepted = classifyReply(makeMessage(), config, mapping, state);
  const now = '2026-08-31T10:00:00.000Z';

  assert.equal(isActiveWriterError(new Error('Codex App Server rejected thread/resume: thread already has an active writer')), true);
  assert.equal(isActiveWriterError(new Error('Codex App Server rejected thread/resume: task not found')), false);

  enqueuePendingReply(state, accepted, now, 'dpapi-ciphertext');
  const pending = getPendingReplies(state);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].messageId, accepted.messageId);
  assert.equal(pending[0].encryptedText, 'dpapi-ciphertext');
  assert.equal(Object.hasOwn(pending[0], 'text'), false);
  assert.equal(JSON.stringify(state).includes(accepted.text), false);
  assert.equal(pending[0].mapping.threadId, accepted.mapping.threadId);
  assert.equal(pending[0].attempts, 1);
  assert.equal(pending[0].lastAttemptAt, now);

  enqueuePendingReply(state, accepted, '2026-08-31T10:01:00.000Z', 'dpapi-ciphertext');
  assert.equal(getPendingReplies(state)[0].attempts, 2);
  assert.equal(getPendingReplies(state)[0].lastAttemptAt, '2026-08-31T10:01:00.000Z');

  removePendingReply(state, accepted.messageId);
  assert.deepEqual(getPendingReplies(state), []);
});

test('migrates the reply queue and stores slash continuations without tokens or full text', () => {
  const oldPending = {
    messageId: '777777777777777801',
    referencedMessageId: '777777777777777701',
    channelId: config.discordConfirmationChannelId,
    encryptedText: 'cipher:旧回复',
    mapping: mapping.messages['777777777777777701'],
    queuedAt: '2026-09-01T00:00:00.000Z',
    lastAttemptAt: '2026-09-01T00:00:00.000Z',
    attempts: 1,
  };
  const state = migrateInboxState({
    version: 1,
    cursors: {},
    processedMessageIds: [],
    pendingReplies: { [oldPending.messageId]: oldPending },
    createdTasksByInteraction: { 'create-1': { status: 'started', threadId: 'root-new' } },
  });
  const request = createContinuationRequest({
    source: 'slash',
    requestId: 'interaction-1',
    threadId: 'root-1',
    cwd: 'C:\\workspace\\demo',
    text: '重新检查一次',
    createdAt: '2026-09-01T00:01:00.000Z',
  });

  enqueueContinuation(state, { ...request, encryptedText: 'opaque-ciphertext' });

  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes('interaction-token'), false);
  assert.equal(serialized.includes('重新检查一次'), false);
  assert.equal(listContinuations(state).length, 2);
  assert.equal(state.createdTasksByInteraction['create-1'].threadId, 'root-new');
  assert.equal(Object.hasOwn(state, 'pendingReplies'), false);
});

test('deduplicates continuation request ids, rejects blank text, and bounds interaction records', () => {
  const state = createEmptyInboxState();
  assert.throws(() => createContinuationRequest({
    source: 'slash', requestId: 'blank-1', threadId: 'root-1', text: '   ',
  }), /blank|empty|text/i);
  const request = createContinuationRequest({
    source: 'slash', requestId: 'same-request', threadId: 'root-1', text: 'first',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  const first = enqueueContinuation(state, { ...request, encryptedText: 'cipher:first' });
  const duplicate = enqueueContinuation(state, { ...request, text: 'different', encryptedText: 'cipher:different' });
  assert.equal(duplicate.queueId, first.queueId);
  assert.equal(listContinuations(state).length, 1);

  state.processedInteractions = Array.from({ length: 2_005 }, (_, index) => ({ requestId: `old-${index}` }));
  migrateInboxState(state);
  assert.equal(state.processedInteractions.length, 2_000);
  assert.equal(state.processedInteractions[0].requestId, 'old-5');
});

test('migration bounds completed task-creation idempotence records without losing recent entries', () => {
  const createdTasksByInteraction = Object.fromEntries(Array.from({ length: 2_005 }, (_, index) => [
    `create-${index}`,
    { status: 'started', threadId: `root-${index}` },
  ]));
  const state = migrateInboxState({ createdTasksByInteraction });
  assert.equal(Object.keys(state.createdTasksByInteraction).length, 2_000);
  assert.equal(Object.hasOwn(state.createdTasksByInteraction, 'create-0'), false);
  assert.equal(state.createdTasksByInteraction['create-2004'].threadId, 'root-2004');
});

test('cancels only continuations that have not started and delivered entries cannot be cancelled', () => {
  const state = createEmptyInboxState();
  const queued = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'slash', requestId: 'queued', threadId: 'root-1', text: 'queued' }),
    encryptedText: 'cipher:queued',
  });
  const started = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'slash', requestId: 'started', threadId: 'root-2', text: 'started' }),
    encryptedText: 'cipher:started', status: 'started',
  });
  const delivered = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'slash', requestId: 'delivered', threadId: 'root-3', text: 'delivered' }),
    encryptedText: 'cipher:delivered',
  });
  markContinuationDelivered(state, delivered.queueId, '2026-09-01T00:02:00.000Z');

  assert.equal(cancelContinuation(state, queued.queueId, '2026-09-01T00:03:00.000Z').status, 'cancelled');
  assert.equal(cancelContinuation(state, started.queueId, '2026-09-01T00:03:00.000Z').status, 'already-started');
  assert.equal(cancelContinuation(state, delivered.queueId, '2026-09-01T00:03:00.000Z').status, 'already-started');
});

test('dispatch queues an active writer, retries delivery, and preserves legacy reply acknowledgements', async () => {
  const state = createEmptyInboxState();
  const acknowledgements = [];
  const persisted = [];
  let attempts = 0;
  const request = createContinuationRequest({
    source: 'reply',
    requestId: '777777777777777801',
    threadId: mapping.messages['777777777777777701'].threadId,
    cwd: mapping.messages['777777777777777701'].cwd,
    text: '继续旧通知',
    channelId: config.discordConfirmationChannelId,
    replyToMessageId: '777777777777777801',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  const dependencies = {
    state,
    now: () => '2026-09-01T00:01:00.000Z',
    encryptText: async () => 'opaque-ciphertext',
    decryptText: async () => '继续旧通知',
    persistState: async () => { persisted.push(structuredClone(state)); },
    resumeCodexThread: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('thread already has an active writer');
      return { turnId: 'turn-retried', completion: Promise.resolve({ turn: { status: 'completed' } }) };
    },
    sendReply: async (payload) => { acknowledgements.push(payload); },
  };

  const queued = await dispatchContinuation(request, dependencies);
  assert.equal(queued.status, 'queued');
  assert.equal(listContinuations(state).length, 1);
  assert.equal(JSON.stringify(state).includes('继续旧通知'), false);
  assert.match(acknowledgements[0].content, /已排队/);

  const delivered = await dispatchContinuation(listContinuations(state)[0], dependencies);
  assert.equal(delivered.status, 'started');
  assert.equal(delivered.turnId, 'turn-retried');
  assert.equal(listContinuations(state)[0].status, 'delivered');
  assert.match(acknowledgements[1].content, /排队回复现已送达/);
  assert.equal(persisted.length >= 2, true);
});

test('a queued retry that cannot resume becomes failed instead of claiming delivery', async () => {
  const state = createEmptyInboxState();
  const queued = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'slash', requestId: 'retry-fails', threadId: 'root-1', text: 'retry' }),
    encryptedText: 'opaque-ciphertext',
  });
  const result = await dispatchContinuation(queued, {
    state,
    decryptText: async () => 'retry',
    persistState: async () => {},
    resumeCodexThread: async () => { throw new Error('task not found'); },
  });
  assert.equal(result.status, 'failed');
  assert.equal(listContinuations(state)[0].status, 'failed');
});

test('slash dispatch persists its idempotence journal before starting an external turn', async () => {
  const events = [];
  const state = createEmptyInboxState();
  const request = createContinuationRequest({
    source: 'slash', requestId: 'durable-before-resume', threadId: 'root-1', text: 'continue',
  });
  const result = await dispatchContinuation(request, {
    state,
    persistState: async () => { events.push(`persist:${state.processedInteractions.at(-1)?.status}`); },
    resumeCodexThread: async () => {
      events.push('resume');
      return { turnId: 'turn-durable', completion: Promise.resolve({ turn: { status: 'completed' } }) };
    },
  });
  assert.equal(result.status, 'started');
  assert.deepEqual(events.slice(0, 2), ['persist:started', 'resume']);
});

test('migrates legacy pending plaintext before state is rewritten', async () => {
  const state = { pendingReplies: {} };
  state.pendingReplies['777777777777777801'] = { messageId: '777777777777777801', text: 'legacy continuation', mapping: mapping.messages['777777777777777701'] };
  await migrateLegacyPendingReplies({ state, encryptText: async (text) => `cipher:${text}` });
  assert.equal(state.pendingReplies['777777777777777801'].encryptedText, 'cipher:legacy continuation');
  assert.equal(Object.hasOwn(state.pendingReplies['777777777777777801'], 'text'), false);
  await assert.rejects(() => migrateLegacyPendingReplies({ state: { pendingReplies: { x: { text: 'keep me' } } }, encryptText: async () => { throw new Error('DPAPI unavailable'); } }), /state was not rewritten/);
});

test('resolves the newest installed Codex executable when the scheduled-task PATH is minimal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-bridge-cli-'));
  try {
    const older = path.join(root, 'OpenAI', 'Codex', 'bin', 'older', 'codex.exe');
    const newest = path.join(root, 'OpenAI', 'Codex', 'bin', 'newest', 'codex.exe');
    await fs.mkdir(path.dirname(older), { recursive: true });
    await fs.mkdir(path.dirname(newest), { recursive: true });
    await fs.writeFile(older, 'old');
    await fs.writeFile(newest, 'new');
    const oldTime = new Date('2026-08-01T00:00:00Z');
    const newTime = new Date('2026-08-31T00:00:00Z');
    await fs.utimes(older, oldTime, oldTime);
    await fs.utimes(newest, newTime, newTime);

    assert.equal(await resolveCodexExecutable({ configuredPath: 'codex', localAppData: root }), newest);
    assert.equal(await resolveCodexExecutable({ configuredPath: older, localAppData: root }), older);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resolves PowerShell 7 instead of legacy Windows PowerShell for UTF-8 notification scripts', async () => {
  const bridgeLib = await import('../discord-bridge-lib.mjs');
  assert.equal(typeof bridgeLib.resolvePowerShellExecutable, 'function',
    'Discord bridge must expose a PowerShell 7 resolver');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-bridge-pwsh-'));
  try {
    const pwsh = path.join(root, 'PowerShell', '7', 'pwsh.exe');
    await fs.mkdir(path.dirname(pwsh), { recursive: true });
    await fs.writeFile(pwsh, 'pwsh');

    assert.equal(
      await bridgeLib.resolvePowerShellExecutable({ programFiles: root }),
      pwsh,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
