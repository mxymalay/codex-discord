import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startNewCodexTask } from '../discord-task-create-lib.mjs';
import { finalizeContinuationOutcome, pollChannel } from '../discord-bridge.mjs';

import {
  AppServerClient,
  buildCodexAppServerMessages,
  cancelContinuation,
  cancelContinuationPersisted,
  classifyReply,
  compareSnowflakes,
  commitInboxState,
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
  listRetryableContinuations,
  markContinuationDelivered,
  migrateInboxState,
  migrateLegacyPendingReplies,
  recordInboxMessage,
  recoverContinuationAttempts,
  removePendingReply,
  resolveCodexExecutable,
  resumeCodexThread,
  writeJsonAtomic,
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

test('non-durable reply outcome stops the channel batch before a higher snowflake advances the cursor', async () => {
  const state = createEmptyInboxState();
  state.cursors[config.discordConfirmationChannelId] = '777777777777777800';
  const low = makeMessage({ id: '777777777777777801' });
  const high = makeMessage({ id: '777777777777777802', content: 'higher message' });
  const attempted = [];

  const outcome = await pollChannel({
    token: 'test-token',
    config,
    state,
    channelId: config.discordConfirmationChannelId,
    getMessages: async () => [low, high],
    readMapping: async () => mapping,
    continueRequest: async ({ request }) => {
      attempted.push(request.requestId);
      return { status: 'failed', reason: 'state-persist-failed', durable: false, stopChannelScan: true };
    },
    persistState: async () => {},
    writeLog: async () => {},
  });

  assert.deepEqual(attempted, [low.id]);
  assert.equal(state.cursors[config.discordConfirmationChannelId], '777777777777777800');
  assert.deepEqual(outcome, { status: 'stopped', requestId: low.id, reason: 'state-persist-failed' });
});

test('transient reply failure returns a stop contract and rate-limits its Bot error receipt', async () => {
  const state = createEmptyInboxState();
  state.cursors[config.discordConfirmationChannelId] = '777777777777777800';
  const request = createContinuationRequest({
    source: 'reply', requestId: '777777777777777801', threadId: 'root-1', text: 'continue',
    channelId: config.discordConfirmationChannelId, replyToMessageId: '777777777777777801',
  });
  const replies = [];
  const transientFailureAcks = new Map();
  const input = {
    result: { status: 'failed', reason: 'state-persist-failed' },
    state,
    request,
    transientFailureAcks,
    now: () => Date.parse('2026-09-01T00:00:00Z'),
    persistState: async () => {},
    sendReply: async (payload) => { replies.push(payload); },
  };

  const first = await finalizeContinuationOutcome(input);
  const second = await finalizeContinuationOutcome(input);

  assert.equal(first.durable, false);
  assert.equal(first.stopChannelScan, true);
  assert.equal(second.stopChannelScan, true);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /暂时|稍后重试|安全保存/);
  assert.equal(replies[0].content.includes('没有成功续接'), false);
  assert.equal(state.cursors[config.discordConfirmationChannelId], '777777777777777800');
});

test('finalize cursor persistence rollback preserves a concurrently confirmed Slash request', async () => {
  const state = createEmptyInboxState();
  state.cursors[config.discordConfirmationChannelId] = '777777777777777800';
  const replyRequest = createContinuationRequest({
    source: 'reply', requestId: '777777777777777801', threadId: 'root-a', text: 'A',
    channelId: config.discordConfirmationChannelId, replyToMessageId: '777777777777777801',
  });
  let signalFinalizePersist;
  const finalizePersistStarted = new Promise((resolve) => { signalFinalizePersist = resolve; });
  let releaseFinalizePersist;
  const finalizePersistGate = new Promise((resolve) => { releaseFinalizePersist = resolve; });
  const finalize = finalizeContinuationOutcome({
    result: { status: 'failed', reason: 'resume-failed' },
    state,
    request: replyRequest,
    persistState: async () => {
      signalFinalizePersist();
      await finalizePersistGate;
      throw new Error('cursor persistence failed');
    },
    sendReply: async () => {},
  });
  await finalizePersistStarted;

  const requestB = createContinuationRequest({
    source: 'slash', requestId: 'finalize-concurrent-b', threadId: 'root-b', text: 'B',
  });
  let resumeB = 0;
  const dispatchB = dispatchContinuation(requestB, {
    state,
    encryptText: async () => 'cipher:b',
    persistState: async () => {},
    resumeCodexThread: async () => {
      resumeB += 1;
      return { turnId: 'turn-b', completion: Promise.resolve({ turn: { status: 'completed' } }) };
    },
  });
  assert.equal(await Promise.race([
    dispatchB.then(() => 'completed'),
    new Promise((resolve) => setTimeout(() => resolve('waiting'), 20)),
  ]), 'waiting');
  releaseFinalizePersist();
  const [outcome] = await Promise.all([finalize, dispatchB]);

  assert.equal(outcome.durable, false);
  const confirmedB = listContinuations(state).find((item) => item.requestId === requestB.requestId);
  assert.equal(confirmedB.status, 'confirmed-start');
  await dispatchContinuation(requestB, {
    state,
    encryptText: async () => 'cipher:b',
    persistState: async () => {},
    resumeCodexThread: async () => { resumeB += 1; return { turnId: 'duplicate-b' }; },
  });
  assert.equal(resumeB, 1);
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
  assert.equal(Object.values(state.pendingContinuations).some((item) => Object.hasOwn(item, 'text')), false);
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
  assert.equal(Object.values(state.pendingContinuations).some((item) => Object.hasOwn(item, 'text')), false);
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
    encryptedText: 'cipher:started', status: 'attempting',
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
  assert.equal(Object.values(state.pendingContinuations).some((item) => Object.hasOwn(item, 'text')), false);
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
    encryptText: async () => 'opaque-ciphertext',
    persistState: async () => { events.push(`persist:${state.processedInteractions.at(-1)?.status}`); },
    resumeCodexThread: async () => {
      events.push('resume');
      return { turnId: 'turn-durable', completion: Promise.resolve({ turn: { status: 'completed' } }) };
    },
  });
  assert.equal(result.status, 'started');
  assert.deepEqual(events.slice(0, 3), ['persist:queued', 'persist:resuming', 'resume']);
});

test('reply dispatch durably journals encrypted text before any external resume', async () => {
  const events = [];
  const snapshots = [];
  const state = createEmptyInboxState();
  const request = createContinuationRequest({
    source: 'reply', requestId: 'reply-journal-1', threadId: 'root-1', text: 'private reply',
    channelId: 'channel-1', replyToMessageId: 'reply-journal-1',
  });
  const result = await dispatchContinuation(request, {
    state,
    encryptText: async () => { events.push('encrypt'); return 'opaque-ciphertext'; },
    persistState: async () => { events.push(`persist:${listContinuations(state)[0]?.status}`); snapshots.push(structuredClone(state)); },
    resumeCodexThread: async () => {
      events.push('resume');
      return { turnId: 'turn-reply', completion: Promise.resolve({ turn: { status: 'completed' } }) };
    },
  });
  assert.equal(result.status, 'started');
  assert.deepEqual(events.slice(0, 4), ['encrypt', 'persist:queued', 'persist:resuming', 'resume']);
  assert.equal(Object.hasOwn(snapshots[0].pendingContinuations[Object.keys(snapshots[0].pendingContinuations)[0]], 'text'), false);
  assert.equal(snapshots[0].pendingContinuations[Object.keys(snapshots[0].pendingContinuations)[0]].encryptedText, 'opaque-ciphertext');
});

test('an immediate reply acknowledgement never claims it came from the retry queue', async () => {
  const acknowledgements = [];
  const result = await dispatchContinuation(createContinuationRequest({
    source: 'reply', requestId: 'reply-immediate', threadId: 'root-1', text: 'continue',
    channelId: 'channel-1', replyToMessageId: 'reply-immediate',
  }), {
    state: createEmptyInboxState(),
    encryptText: async () => 'opaque-ciphertext',
    persistState: async () => {},
    resumeCodexThread: async () => ({ turnId: 'turn-immediate', completion: Promise.resolve({ turn: { status: 'completed' } }) }),
    sendReply: async (payload) => { acknowledgements.push(payload.content); },
  });
  assert.equal(result.status, 'started');
  assert.match(acknowledgements[0], /^✅ 已送达/u);
  assert.equal(acknowledgements[0].includes('排队回复'), false);
});

test('a reply remains confirmed-start when no acknowledgement transport is available', async () => {
  const state = createEmptyInboxState();
  const result = await dispatchContinuation(createContinuationRequest({
    source: 'reply', requestId: 'reply-no-ack', threadId: 'root-1', text: 'continue',
    channelId: 'channel-1', replyToMessageId: 'reply-no-ack',
  }), {
    state,
    encryptText: async () => 'opaque-ciphertext',
    persistState: async () => {},
    resumeCodexThread: async () => ({ turnId: 'turn-no-ack', completion: Promise.resolve({ turn: { status: 'completed' } }) }),
  });
  assert.equal(result.status, 'started');
  assert.equal(listContinuations(state)[0].status, 'confirmed-start');
});

test('a confirmed reply retries only its failed acknowledgement on another dispatch', async () => {
  const state = createEmptyInboxState();
  const request = createContinuationRequest({
    source: 'reply', requestId: 'retry-ack-only', threadId: 'root-1', text: 'continue',
    channelId: 'channel-1', replyToMessageId: 'retry-ack-only',
  });
  let resumeCount = 0;
  let acknowledgementCount = 0;
  const dependencies = {
    state,
    encryptText: async () => 'opaque-ciphertext',
    persistState: async () => {},
    resumeCodexThread: async () => {
      resumeCount += 1;
      return { turnId: 'turn-ack-only', completion: Promise.resolve({ turn: { status: 'completed' } }) };
    },
    sendReply: async () => {
      acknowledgementCount += 1;
      if (acknowledgementCount === 1) throw new Error('temporary Discord failure');
    },
  };

  const first = await dispatchContinuation(request, dependencies);
  const second = await dispatchContinuation(request, dependencies);

  assert.equal(first.status, 'started');
  assert.equal(second.status, 'started');
  assert.equal(resumeCount, 1);
  assert.equal(acknowledgementCount, 2);
  assert.equal(listContinuations(state)[0].status, 'delivered');
});

test('a reloaded confirmed reply sends only its pending acknowledgement and persists delivery', async () => {
  const originalState = createEmptyInboxState();
  const request = createContinuationRequest({
    source: 'reply', requestId: 'reload-ack-only', threadId: 'root-1', text: 'continue',
    channelId: 'channel-1', replyToMessageId: 'reload-ack-only',
  });
  let resumeCount = 0;
  await dispatchContinuation(request, {
    state: originalState,
    encryptText: async () => 'opaque-ciphertext',
    persistState: async () => {},
    resumeCodexThread: async () => {
      resumeCount += 1;
      return { turnId: 'turn-before-reload', completion: Promise.resolve({ turn: { status: 'completed' } }) };
    },
    sendReply: async () => { throw new Error('temporary Discord failure'); },
  });
  const reloaded = migrateInboxState(structuredClone(originalState));
  let acknowledgementCount = 0;
  let persistedStatus;

  const result = await dispatchContinuation(listContinuations(reloaded)[0], {
    state: reloaded,
    persistState: async () => { persistedStatus = listContinuations(reloaded)[0]?.status; },
    resumeCodexThread: async () => { resumeCount += 1; throw new Error('must not resume confirmed turn'); },
    sendReply: async () => { acknowledgementCount += 1; },
  });

  assert.equal(result.status, 'started');
  assert.equal(resumeCount, 1);
  assert.equal(acknowledgementCount, 1);
  assert.equal(listContinuations(reloaded)[0].status, 'delivered');
  assert.equal(persistedStatus, 'delivered');
});

test('bridge retry candidates include queued work and confirmed replies awaiting acknowledgement', () => {
  const state = createEmptyInboxState();
  for (const entry of [
    { source: 'slash', requestId: 'queued-slash', status: 'queued' },
    { source: 'reply', requestId: 'queued-reply', status: 'queued' },
    { source: 'reply', requestId: 'confirmed-reply', status: 'confirmed-start' },
    { source: 'slash', requestId: 'confirmed-slash', status: 'confirmed-start' },
    { source: 'reply', requestId: 'delivered-reply', status: 'delivered' },
  ]) {
    enqueueContinuation(state, {
      ...createContinuationRequest({
        source: entry.source,
        requestId: entry.requestId,
        threadId: 'root-1',
        text: 'continue',
        channelId: entry.source === 'reply' ? 'channel-1' : undefined,
        replyToMessageId: entry.source === 'reply' ? entry.requestId : undefined,
      }),
      encryptedText: `cipher:${entry.requestId}`,
      status: entry.status,
    });
  }

  assert.deepEqual(
    listRetryableContinuations(state).map((item) => item.requestId).sort(),
    ['confirmed-reply', 'queued-reply', 'queued-slash'],
  );
});

test('a confirmed turn stays started when confirmation persistence, acknowledgement, or tracking fails', async () => {
  const state = createEmptyInboxState();
  const events = [];
  let persistCount = 0;
  const result = await dispatchContinuation(createContinuationRequest({
    source: 'reply', requestId: 'confirmed-errors', threadId: 'root-1', text: 'continue',
    channelId: 'channel-1', replyToMessageId: 'confirmed-errors',
  }), {
    state,
    encryptText: async () => 'opaque-ciphertext',
    persistState: async () => {
      persistCount += 1;
      events.push(`persist:${listContinuations(state)[0]?.status}`);
      if (persistCount === 3) throw new Error('private persistence path');
    },
    resumeCodexThread: async () => {
      events.push('resume');
      return { turnId: 'turn-confirmed', completion: Promise.resolve({ turn: { status: 'completed' } }) };
    },
    sendReply: async () => { events.push('ack'); throw new Error('private token'); },
    trackCompletion: () => { events.push('track'); throw new Error('private tracker'); },
  });
  assert.equal(result.status, 'started');
  assert.equal(result.turnId, 'turn-confirmed');
  assert.equal(result.reason, 'state-persist-failed');
  assert.equal(listContinuations(state)[0].status, 'start-uncertain');
  assert.equal(listContinuations(state)[0].turnId, 'turn-confirmed');
  assert.equal(events.includes('ack'), false);
  assert.equal(events.includes('track'), true);
});

test('restart preserves an uncertain external start after confirmation persistence failed', async () => {
  const state = createEmptyInboxState();
  let persistedState;
  let persistCount = 0;
  let resumeCount = 0;
  const request = createContinuationRequest({
    source: 'reply', requestId: '777777777777777801',
    threadId: mapping.messages['777777777777777701'].threadId, text: 'continue',
    channelId: config.discordConfirmationChannelId, replyToMessageId: '777777777777777801',
  });
  const first = await dispatchContinuation(request, {
    state,
    encryptText: async () => 'opaque-ciphertext',
    persistState: async (snapshot) => {
      persistCount += 1;
      if (persistCount === 4) throw new Error('confirmation persistence failed');
      persistedState = structuredClone(snapshot);
    },
    resumeCodexThread: async ({ onStartSubmitted }) => {
      resumeCount += 1;
      await onStartSubmitted();
      return { turnId: 'turn-uncertain', completion: Promise.resolve({ turn: { status: 'completed' } }) };
    },
  });
  assert.equal(first.status, 'started');
  assert.equal(first.reason, 'state-persist-failed');
  assert.equal(listContinuations(persistedState)[0].status, 'start-submitted');

  const reloaded = migrateInboxState(structuredClone(persistedState));
  recoverContinuationAttempts(reloaded, '2026-09-01T01:00:00Z');
  const recovered = listContinuations(reloaded)[0];
  assert.equal(recovered.status, 'start-uncertain');
  assert.equal(cancelContinuation(reloaded, recovered.queueId).status, 'already-started');

  const second = await dispatchContinuation(recovered, {
    state: reloaded,
    persistState: async () => {},
    resumeCodexThread: async () => { resumeCount += 1; throw new Error('must not retry uncertain start'); },
  });
  assert.equal(second.status, 'uncertain');
  assert.equal(second.reason, 'start-outcome-uncertain');
  assert.equal(resumeCount, 1);

  const polledState = migrateInboxState(structuredClone(reloaded));
  polledState.cursors[config.discordConfirmationChannelId] = '777777777777777800';
  const replies = [];
  const pollResult = await pollChannel({
    token: 'test-token',
    config,
    state: polledState,
    channelId: config.discordConfirmationChannelId,
    getMessages: async () => [makeMessage({ id: request.requestId })],
    readMapping: async () => mapping,
    continueRequest: async ({ request: polledRequest }) => {
      const result = await dispatchContinuation(polledRequest, {
        state: polledState,
        persistState: async () => {},
        resumeCodexThread: async () => { resumeCount += 1; throw new Error('must not retry uncertain start'); },
      });
      return finalizeContinuationOutcome({
        result,
        state: polledState,
        request: polledRequest,
        persistState: async () => {},
        sendReply: async (payload) => { replies.push(payload.content); },
      });
    },
    persistState: async () => {},
    writeLog: async () => {},
  });
  assert.equal(pollResult.status, 'complete');
  assert.equal(resumeCount, 1);
  assert.equal(polledState.cursors[config.discordConfirmationChannelId], request.requestId);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /启动结果不确定|不会自动重试/);
  assert.equal(replies[0].includes('没有成功续接'), false);
});

test('queued retry claim persistence failure restores the exact queued snapshot and never resumes', async () => {
  const state = createEmptyInboxState();
  const queued = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'slash', requestId: 'claim-fails', threadId: 'root-1', text: 'retry' }),
    encryptedText: 'opaque-ciphertext',
  });
  const before = structuredClone(state);
  let resumed = false;
  const result = await dispatchContinuation(queued, {
    state,
    decryptText: async () => 'retry',
    persistState: async () => { throw new Error('private state path'); },
    resumeCodexThread: async () => { resumed = true; throw new Error('must not resume'); },
  });
  assert.deepEqual(state, before);
  assert.equal(resumed, false);
  assert.deepEqual(result, { status: 'failed', queueId: queued.queueId, reason: 'state-persist-failed' });
});

test('queued retry rechecks cancellation under the state lock after asynchronous decryption', async () => {
  const state = createEmptyInboxState();
  const queued = enqueueContinuation(state, {
    ...createContinuationRequest({
      source: 'reply', requestId: 'decrypt-cancel-race', threadId: 'root-1', text: 'continue',
      channelId: 'channel-1', replyToMessageId: 'decrypt-cancel-race',
    }),
    encryptedText: 'opaque-ciphertext',
  });
  let releaseDecrypt;
  let signalDecryptStarted;
  const decryptStarted = new Promise((resolve) => { signalDecryptStarted = resolve; });
  const decryptGate = new Promise((resolve) => { releaseDecrypt = resolve; });
  let resumeCount = 0;
  const dispatch = dispatchContinuation(queued, {
    state,
    decryptText: async () => { signalDecryptStarted(); await decryptGate; return 'continue'; },
    persistState: async () => {},
    resumeCodexThread: async () => { resumeCount += 1; return { turnId: 'must-not-start' }; },
  });
  await decryptStarted;
  await cancelContinuationPersisted({ state, queueId: queued.queueId, persistState: async () => {} });
  releaseDecrypt();

  const result = await dispatch;

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'cancelled');
  assert.equal(resumeCount, 0);
  assert.equal(state.pendingContinuations[queued.queueId].status, 'cancelled');
});

test('two concurrent dispatches for one request claim at most one external resume', async () => {
  const state = createEmptyInboxState();
  const request = createContinuationRequest({
    source: 'slash', requestId: 'concurrent-request', threadId: 'root-1', text: 'continue',
  });
  let encryptionCount = 0;
  let releaseEncryption;
  const encryptionGate = new Promise((resolve) => { releaseEncryption = resolve; });
  let resumeCount = 0;
  const dependencies = {
    state,
    encryptText: async () => {
      encryptionCount += 1;
      if (encryptionCount === 2) releaseEncryption();
      await encryptionGate;
      return 'opaque-ciphertext';
    },
    persistState: async () => {},
    resumeCodexThread: async () => {
      resumeCount += 1;
      return { turnId: `turn-${resumeCount}`, completion: Promise.resolve({ turn: { status: 'completed' } }) };
    },
  };

  const results = await Promise.all([
    dispatchContinuation(request, dependencies),
    dispatchContinuation(request, dependencies),
  ]);

  assert.equal(resumeCount, 1);
  assert.equal(results.some((result) => result.status === 'started'), true);
  assert.equal(listContinuations(state).length, 1);
});

test('dispatch never starts an external turn without a persistence adapter', async () => {
  const state = createEmptyInboxState();
  const before = structuredClone(state);
  let resumed = false;
  const result = await dispatchContinuation(createContinuationRequest({
    source: 'slash', requestId: 'missing-persist', threadId: 'root-1', text: 'continue',
  }), {
    state,
    encryptText: async () => 'opaque-ciphertext',
    resumeCodexThread: async () => { resumed = true; return { turnId: 'must-not-start' }; },
  });
  assert.deepEqual(state, before);
  assert.equal(resumed, false);
  assert.equal(result.reason, 'state-persist-failed');
});

test('restart recovery preserves an ambiguous attempting claim as non-retryable uncertainty', async () => {
  const state = createEmptyInboxState();
  const queued = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'slash', requestId: 'ambiguous-attempt', threadId: 'root-1', text: 'retry' }),
    encryptedText: 'opaque-ciphertext', status: 'attempting',
  });
  recoverContinuationAttempts(state, '2026-09-01T01:00:00.000Z');
  assert.equal(listContinuations(state)[0].status, 'start-uncertain');
  assert.equal(listContinuations(state)[0].failureReason, 'start-outcome-uncertain');
  let resumed = false;
  const result = await dispatchContinuation({ ...queued, status: 'attempting' }, {
    state,
    decryptText: async () => 'retry',
    resumeCodexThread: async () => { resumed = true; },
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(resumed, false);
});

test('active-writer queue persistence failure restores a retryable queue for the same request id', async () => {
  const state = createEmptyInboxState();
  let persistCount = 0;
  let resumeCount = 0;
  const dependencies = {
    state,
    encryptText: async () => 'opaque-ciphertext',
    decryptText: async () => 'continue',
    persistState: async () => {
      persistCount += 1;
      if (persistCount === 3) throw new Error('private state path');
    },
    resumeCodexThread: async () => {
      resumeCount += 1;
      if (resumeCount === 1) throw new Error('thread already has an active writer');
      return { turnId: 'turn-recovered', completion: Promise.resolve({ turn: { status: 'completed' } }) };
    },
  };
  const request = createContinuationRequest({ source: 'slash', requestId: 'active-persist', threadId: 'root-1', text: 'continue' });
  const failed = await dispatchContinuation(request, dependencies);
  assert.equal(failed.reason, 'state-persist-failed');
  assert.equal(listContinuations(state)[0].status, 'queued');

  const recovered = await dispatchContinuation(listContinuations(state)[0], dependencies);
  assert.equal(recovered.status, 'started');
  assert.equal(recovered.turnId, 'turn-recovered');
});

test('active-writer rollback for request A preserves concurrently confirmed request B', async () => {
  const state = createEmptyInboxState();
  const requestA = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'slash', requestId: 'active-a', threadId: 'root-a', text: 'A' }),
    encryptedText: 'cipher:a',
  });
  const requestB = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'slash', requestId: 'active-b', threadId: 'root-b', text: 'B' }),
    encryptedText: 'cipher:b',
  });
  let signalAResume;
  const aResumeStarted = new Promise((resolve) => { signalAResume = resolve; });
  let rejectAResume;
  const aResume = new Promise((_resolve, reject) => { rejectAResume = reject; });
  let resumeB = 0;

  const dispatchA = dispatchContinuation(requestA, {
    state,
    decryptText: async () => 'A',
    persistState: async () => {
      if (state.pendingContinuations[requestA.queueId]?.status === 'queued') {
        throw new Error('A downgrade persistence failed');
      }
    },
    resumeCodexThread: async () => { signalAResume(); return aResume; },
  });
  await aResumeStarted;
  await dispatchContinuation(requestB, {
    state,
    decryptText: async () => 'B',
    persistState: async () => {},
    resumeCodexThread: async () => {
      resumeB += 1;
      return { turnId: 'turn-b', completion: Promise.resolve({ turn: { status: 'completed' } }) };
    },
  });
  rejectAResume(new Error('thread already has an active writer'));
  const resultA = await dispatchA;

  assert.equal(resultA.reason, 'state-persist-failed');
  assert.equal(state.pendingContinuations[requestA.queueId].status, 'queued');
  assert.equal(state.pendingContinuations[requestB.queueId].status, 'confirmed-start');

  await dispatchContinuation(requestB, {
    state,
    decryptText: async () => 'B',
    persistState: async () => {},
    resumeCodexThread: async () => {
      resumeB += 1;
      return { turnId: 'duplicate-b' };
    },
  });
  assert.equal(resumeB, 1);
});

test('persisted cancellation rolls back both queue and processed interaction on failure', async () => {
  const state = createEmptyInboxState();
  const queued = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'slash', requestId: 'cancel-rollback', threadId: 'root-1', text: 'cancel' }),
    encryptedText: 'opaque-ciphertext',
  });
  const before = structuredClone(state);
  await assert.rejects(() => cancelContinuationPersisted({
    state, queueId: queued.queueId, now: '2026-09-01T01:00:00.000Z',
    persistState: async () => { throw new Error('C:\\private\\state.json'); },
  }), /^Error: Continuation state persistence failed$/);
  assert.deepEqual(state, before);
});

test('terminal continuation history is bounded while every live queue entry is preserved', () => {
  const pendingContinuations = {};
  for (let index = 0; index < 205; index += 1) {
    pendingContinuations[`terminal-${index}`] = {
      queueId: `terminal-${index}`, source: 'slash', requestId: `terminal-${index}`,
      threadId: 'root-1', status: 'delivered', createdAt: `2026-09-01T00:${String(index % 60).padStart(2, '0')}:00Z`,
    };
  }
  pendingContinuations['live-queued'] = { queueId: 'live-queued', source: 'slash', requestId: 'live-queued', threadId: 'root-1', status: 'queued' };
  pendingContinuations['live-attempting'] = { queueId: 'live-attempting', source: 'reply', requestId: 'live-attempting', threadId: 'root-1', status: 'attempting' };
  const state = migrateInboxState({ pendingContinuations });
  assert.equal(listContinuations(state).filter((item) => item.status === 'delivered').length, 200);
  assert.equal(Object.hasOwn(state.pendingContinuations, 'live-queued'), true);
  assert.equal(Object.hasOwn(state.pendingContinuations, 'live-attempting'), true);
});

test('a runtime delivery transition prunes the oldest terminal history before persistence', () => {
  const state = createEmptyInboxState();
  for (let index = 0; index < 200; index += 1) {
    state.pendingContinuations[`terminal-${index}`] = {
      queueId: `terminal-${index}`, source: 'slash', requestId: `terminal-${index}`,
      threadId: 'root-1', status: 'delivered', createdAt: `2026-09-01T00:${String(index % 60).padStart(2, '0')}:00Z`,
    };
  }
  const queued = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'slash', requestId: 'new-terminal', threadId: 'root-1', text: 'deliver' }),
    encryptedText: 'opaque-ciphertext', createdAt: '2026-09-02T00:00:00Z',
  });
  markContinuationDelivered(state, queued.queueId, '2026-09-02T00:01:00Z');
  assert.equal(listContinuations(state).filter((item) => item.status === 'delivered').length, 200);
  assert.equal(Object.hasOwn(state.pendingContinuations, queued.queueId), true);
});

test('terminal pruning retains a newly confirmed turn even when it waited in queue longer than history', async () => {
  const state = createEmptyInboxState();
  for (let index = 0; index < 200; index += 1) {
    state.pendingContinuations[`history-${index}`] = {
      queueId: `history-${index}`, source: 'slash', requestId: `history-${index}`,
      threadId: 'root-history', status: 'delivered',
      createdAt: `2026-09-02T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00Z`,
      deliveredAt: `2026-09-02T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:30Z`,
    };
  }
  const queued = enqueueContinuation(state, {
    ...createContinuationRequest({
      source: 'slash', requestId: 'old-live-queue', threadId: 'root-1', text: 'continue',
      createdAt: '2026-09-01T00:00:00Z',
    }),
    encryptedText: 'opaque-ciphertext',
  });

  const result = await dispatchContinuation(queued, {
    state,
    now: () => '2026-09-03T00:00:00Z',
    decryptText: async () => 'continue',
    persistState: async () => {},
    resumeCodexThread: async () => ({ turnId: 'turn-new-fact', completion: Promise.resolve({ turn: { status: 'completed' } }) }),
  });

  assert.equal(result.status, 'started');
  assert.equal(state.pendingContinuations[queued.queueId].status, 'confirmed-start');
  assert.equal(state.pendingContinuations[queued.queueId].turnId, 'turn-new-fact');
});

test('confirmed reply is never pruned by later terminal history or resumed again', async () => {
  const state = createEmptyInboxState();
  const request = createContinuationRequest({
    source: 'reply', requestId: 'blocked-confirmed-a', threadId: 'root-1', text: 'continue',
    channelId: 'channel-1', replyToMessageId: 'blocked-confirmed-a', createdAt: '2026-09-01T00:00:00Z',
  });
  const blocked = enqueueContinuation(state, { ...request, encryptedText: 'cipher:a' });
  for (let index = 0; index < 200; index += 1) {
    state.pendingContinuations[`later-${index}`] = {
      queueId: `later-${index}`, source: 'slash', requestId: `later-${index}`,
      threadId: 'root-history', status: 'delivered',
      createdAt: `2026-09-02T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00Z`,
      deliveredAt: `2026-09-02T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:30Z`,
    };
  }
  let resumeCount = 0;
  const dependencies = {
    state,
    now: () => '2026-09-01T01:00:00Z',
    encryptText: async () => 'cipher:a',
    decryptText: async () => 'continue',
    persistState: async () => {},
    resumeCodexThread: async () => {
      resumeCount += 1;
      return { turnId: 'turn-a', completion: Promise.resolve({ turn: { status: 'completed' } }) };
    },
    sendReply: async () => { throw new Error('ack blocked'); },
  };

  await dispatchContinuation(blocked, dependencies);
  await dispatchContinuation(request, dependencies);

  assert.equal(state.pendingContinuations[blocked.queueId].status, 'confirmed-start');
  assert.equal(resumeCount, 1);
});

test('continuation summaries add an ellipsis only when the safe summary is actually truncated', () => {
  const state = createEmptyInboxState();
  const short = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'slash', requestId: 'short-summary', threadId: 'root-1', text: 'short' }),
    encryptedText: 'opaque-short',
  });
  const long = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'slash', requestId: 'long-summary', threadId: 'root-1', text: 'x'.repeat(140) }),
    encryptedText: 'opaque-long',
  });
  assert.equal(short.summary, 'short');
  assert.equal(long.summary.endsWith('…'), true);
  assert.equal(long.summary.length, 120);
});

test('one inbox commit queue serializes writers and a failed continuation rollback preserves cursor and creation commits', async () => {
  const state = createEmptyInboxState();
  const queued = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'slash', requestId: 'commit-a', threadId: 'root-a', text: 'A' }),
    encryptedText: 'cipher-a',
  });
  let active = 0;
  let maxActive = 0;
  let releaseFailure;
  const failureGate = new Promise((resolve) => { releaseFailure = resolve; });
  let first = true;
  const persistState = async (snapshot) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (first) {
        first = false;
        await failureGate;
        throw new Error('first write fails');
      }
      assert.notStrictEqual(snapshot, state);
    } finally {
      active -= 1;
    }
  };
  const cancel = cancelContinuationPersisted({ state, queueId: queued.queueId, persistState });
  const cursor = commitInboxState({
    state, persistState, fields: ['cursors', 'processedMessageIds'],
    mutate: () => recordInboxMessage(state, 'channel', '200', true),
  });
  const create = commitInboxState({
    state, persistState, fields: ['createdTasksByInteraction'],
    mutate: () => { state.createdTasksByInteraction['create-b'] = { status: 'started', threadId: 'root-b' }; },
  });
  releaseFailure();
  await assert.rejects(cancel, /persistence failed/i);
  await Promise.all([cursor, create]);
  assert.equal(maxActive, 1);
  assert.equal(state.pendingContinuations[queued.queueId].status, 'queued');
  assert.equal(state.cursors.channel, '200');
  assert.equal(state.createdTasksByInteraction['create-b'].threadId, 'root-b');
});

test('post-submit transport ambiguity reloads as uncertain while a pre-submit active writer reloads queued', async () => {
  const makeRequest = (requestId) => createContinuationRequest({
    source: 'slash', requestId, threadId: 'root-stage', text: 'continue',
  });
  const disk = [];
  const state = createEmptyInboxState();
  const ambiguous = await dispatchContinuation(makeRequest('post-submit'), {
    state,
    encryptText: async () => 'cipher',
    persistState: async (snapshot) => { disk.push(structuredClone(snapshot)); },
    resumeCodexThread: async ({ onStartSubmitted }) => {
      await onStartSubmitted();
      const error = new Error('connection closed');
      error.submissionStage = 'post-submit';
      throw error;
    },
  });
  assert.equal(ambiguous.status, 'uncertain');
  const reloadedAmbiguous = migrateInboxState(structuredClone(disk.at(-1)));
  recoverContinuationAttempts(reloadedAmbiguous);
  assert.equal(listContinuations(reloadedAmbiguous)[0].status, 'start-uncertain');

  const activeDisk = [];
  const activeState = createEmptyInboxState();
  const active = await dispatchContinuation(makeRequest('active-writer-stage'), {
    state: activeState,
    encryptText: async () => 'cipher',
    persistState: async (snapshot) => {
      activeDisk.push(structuredClone(snapshot));
      if (listContinuations(snapshot)[0]?.status === 'queued' && activeDisk.length > 2) throw new Error('downgrade failed');
    },
    resumeCodexThread: async () => { throw new Error('thread already has an active writer'); },
  });
  assert.equal(active.reason, 'state-persist-failed');
  const reloadedActive = migrateInboxState(structuredClone(activeDisk.at(-2)));
  recoverContinuationAttempts(reloadedActive);
  assert.equal(listContinuations(reloadedActive)[0].status, 'queued');
});

test('confirmed reply acknowledgement does not hold the inbox lock across Discord I/O', async () => {
  const state = createEmptyInboxState();
  const ackItem = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'reply', requestId: 'ack-a', threadId: 'root-a', text: 'A', channelId: 'c', replyToMessageId: 'ack-a' }),
    encryptedText: 'cipher-a', status: 'confirmed-start', turnId: 'turn-a',
  });
  const cancelItem = enqueueContinuation(state, {
    ...createContinuationRequest({ source: 'slash', requestId: 'cancel-b', threadId: 'root-b', text: 'B' }),
    encryptedText: 'cipher-b',
  });
  let releaseAck;
  const ackGate = new Promise((resolve) => { releaseAck = resolve; });
  let ackStarted;
  const ackStartedGate = new Promise((resolve) => { ackStarted = resolve; });
  const ack = dispatchContinuation(ackItem, {
    state, persistState: async () => {}, decryptText: async () => 'A',
    sendReply: async () => { ackStarted(); await ackGate; },
  });
  await ackStartedGate;
  const cancelled = await Promise.race([
    cancelContinuationPersisted({ state, queueId: cancelItem.queueId, persistState: async () => {} }),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'blocked' }), 50)),
  ]);
  assert.equal(cancelled.status, 'cancelled');
  releaseAck();
  await ack;
});

test('atomic JSON writers use collision-free temporary paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-inbox-atomic-'));
  const target = path.join(root, 'state.json');
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => writeJsonAtomic(`${target}.${index}`, { index })));
    const written = JSON.parse(await fs.readFile(`${target}.7`, 'utf8'));
    assert.equal(written.index, 7);
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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
