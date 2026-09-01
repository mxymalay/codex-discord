import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import * as bridgeModule from '../discord-bridge.mjs';
import { startNewCodexTask } from '../discord-task-create-lib.mjs';
import { createBridgeApplication, finalizeContinuationOutcome, getDiscordBotMember, pollChannel } from '../discord-bridge.mjs';
import { createInteractionRouter } from '../discord-interactions.mjs';

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('production interaction wiring refreshes the shared index and uses only bounded control actions', async () => {
  assert.equal(typeof bridgeModule.createProductionBridgeDependencies, 'function');
  const events = [];
  const controlCalls = [];
  let interactionDependencies;
  const rebuilt = { version: 1, generatedAt: '2026-09-01T08:00:00.000Z', tasks: [{ threadId: 'fresh-root' }] };
  const production = bridgeModule.createProductionBridgeDependencies({
    runOnce: true,
    buildTaskIndexImpl: async (options) => { events.push(['build', options.previousIndex]); return rebuilt; },
    writeTaskIndexAtomicImpl: async (_targetPath, index) => { events.push(['write', structuredClone(index)]); },
    runCodexControlActionImpl: async (options) => {
      controlCalls.push(options);
      return options.action === 'status'
        ? { ok: true, desktop: { running: true } }
        : { ok: true, stoppedProcessCount: 1 };
    },
    createInteractionRestClientImpl: () => ({ callback: async () => {}, editOriginal: async () => ({ id: 'message-1' }) }),
    createInteractionRouterImpl: (dependencies) => {
      interactionDependencies = dependencies;
      return { handle: async () => {} };
    },
  });
  const originalIndex = { version: 1, generatedAt: '2026-09-01T07:00:00.000Z', tasks: [] };
  const context = {
    config: {
      ...config,
      discordApplicationId: '111111111111111111',
      discordWorktreeRoot: 'C:\\safe\\worktrees',
      discordProjectlessRoot: 'C:\\safe\\projectless',
    },
    token: 'test-token',
    executables: { codexPath: 'codex.exe', powershellPath: 'pwsh.exe' },
    taskIndex: originalIndex,
    inboxState: createEmptyInboxState(),
    inboxReadOnly: false,
    projectCatalog: {},
    trackDiscordRest: (operation) => operation(),
    trackActiveResource: (resource) => resource,
    getSystemStatus: () => ({}),
    recordActivity: (field, at) => events.push(['activity', field, at]),
  };

  await production.createInteractionHandler(context);
  const refreshed = await interactionDependencies.refreshTaskIndex();
  assert.notEqual(refreshed, originalIndex);
  assert.deepEqual(originalIndex, rebuilt);
  assert.notEqual(refreshed.tasks, originalIndex.tasks);
  originalIndex.tasks.push({ threadId: 'later-shared-mutation' });
  assert.deepEqual(refreshed.tasks, [{ threadId: 'fresh-root' }]);
  assert.deepEqual(events.map((event) => event[0]), ['build', 'write', 'activity']);
  assert.equal(events[0][1], originalIndex);

  assert.deepEqual(await interactionDependencies.getCodexControlStatus(), { ok: true, desktop: { running: true } });
  assert.deepEqual(await interactionDependencies.stopCodexDesktop(), { ok: true, stoppedProcessCount: 1 });
  assert.deepEqual(controlCalls.map((call) => call.action), ['status', 'stop-codex']);
  for (const call of controlCalls) {
    assert.equal(call.powershellPath, 'pwsh.exe');
    assert.match(call.controlPath, /codex-control\.ps1$/u);
    assert.deepEqual(Object.keys(call).sort(), ['action', 'controlPath', 'powershellPath']);
  }
});

test('production index refreshes serialize an older scan before a fresh takeover snapshot without stopping on a new task', async () => {
  const oldBuild = deferred();
  const callbacks = [];
  const edits = [];
  let buildCalls = 0;
  let stopCalls = 0;
  const taskA = {
    threadId: 'root-a', taskName: '任务 A', status: 'running',
    lastActivityAt: '2026-09-01T07:00:00.000Z',
  };
  const taskB = {
    threadId: 'root-b', taskName: '新活动任务 B', status: 'running',
    lastActivityAt: '2026-09-01T08:00:00.000Z',
  };
  const initial = { version: 1, generatedAt: '2026-09-01T07:00:00.000Z', tasks: [taskA] };
  const older = { version: 1, generatedAt: '2026-09-01T07:30:00.000Z', tasks: [taskA] };
  const fresh = { version: 1, generatedAt: '2026-09-01T08:00:00.000Z', tasks: [taskA, taskB] };
  const production = bridgeModule.createProductionBridgeDependencies({
    runOnce: true,
    buildTaskIndexImpl: async () => {
      buildCalls += 1;
      if (buildCalls === 1) return structuredClone(initial);
      if (buildCalls === 2) return oldBuild.promise;
      return structuredClone(fresh);
    },
    writeTaskIndexAtomicImpl: async () => {},
    runCodexControlActionImpl: async ({ action }) => {
      if (action === 'stop-codex') stopCalls += 1;
      return action === 'status'
        ? { ok: true, desktop: { running: true } }
        : { ok: true, stoppedProcessCount: 1 };
    },
    createInteractionRestClientImpl: () => ({
      async callback(interaction, body) { callbacks.push({ interaction, body }); },
      async editOriginal(interaction, body) { edits.push({ interaction, body }); return { id: 'risk-message' }; },
    }),
  });
  const context = {
    config: {
      ...config,
      discordApplicationId: '111111111111111111',
      discordWorktreeRoot: 'C:\\safe\\worktrees',
      discordProjectlessRoot: 'C:\\safe\\projectless',
    },
    token: 'test-token',
    executables: { codexPath: 'codex.exe', powershellPath: 'pwsh.exe' },
    taskIndex: { version: 1, generatedAt: null, tasks: [] },
    inboxState: createEmptyInboxState(),
    inboxReadOnly: false,
    projectCatalog: {},
    gatewayStatus: { state: 'ready' },
    trackDiscordRest: (operation) => operation(),
    trackActiveResource: (resource) => resource,
    getSystemStatus: () => ({}),
    recordActivity: () => {},
  };
  const handle = await production.createInteractionHandler(context);
  const identity = { guild_id: config.discordGuildId, member: { user: { id: config.discordAllowedUserId } } };
  await handle({
    id: 'initial-exit', token: 'initial-token', type: 2, ...identity,
    data: { name: '退出Codex', options: [] },
  });
  const confirmId = edits[0].body.components[0].components[0].custom_id;

  assert.equal(typeof production.refreshTaskIndex, 'function');
  const olderRefresh = production.refreshTaskIndex(context, { nowMs: Date.parse(older.generatedAt) });
  await Promise.resolve();
  assert.equal(buildCalls, 2);
  const confirmation = handle({
    id: 'confirm-exit', token: 'confirm-token', type: 3, ...identity,
    message: { id: 'risk-message' },
    data: { custom_id: confirmId, component_type: 2 },
  });
  await Promise.resolve();
  assert.equal(buildCalls, 2);

  oldBuild.resolve(structuredClone(older));
  await olderRefresh;
  await confirmation;

  assert.equal(buildCalls, 3);
  assert.equal(stopCalls, 0);
  assert.deepEqual(context.taskIndex.tasks.map((item) => item.threadId), ['root-a', 'root-b']);
  assert.deepEqual(callbacks.map((item) => item.body.type), [5, 6]);
  assert.match(edits.at(-1).body.embeds[0].description, /检测到新活动任务/);
  assert.match(edits.at(-1).body.embeds[0].description, /新活动任务 B/);
});

test('a rejected production index refresh propagates but does not poison the serial coordinator', async () => {
  let buildCalls = 0;
  const activities = [];
  const production = bridgeModule.createProductionBridgeDependencies({
    buildTaskIndexImpl: async () => {
      buildCalls += 1;
      if (buildCalls === 1) throw new Error('offline index failure');
      return { version: 1, generatedAt: '2026-09-01T09:00:00.000Z', tasks: [] };
    },
    writeTaskIndexAtomicImpl: async () => {},
  });
  const context = {
    config: { discordWorktreeRoot: 'C:\\safe\\worktrees' },
    taskIndex: { version: 1, generatedAt: null, tasks: [] },
    recordActivity: (field, at) => activities.push([field, at]),
  };

  assert.equal(typeof production.refreshTaskIndex, 'function');
  await assert.rejects(production.refreshTaskIndex(context), /offline index failure/u);
  const recovered = await production.refreshTaskIndex(context);
  assert.equal(buildCalls, 2);
  assert.equal(recovered.generatedAt, '2026-09-01T09:00:00.000Z');
  assert.deepEqual(activities, [['lastIndexUpdateAt', '2026-09-01T09:00:00.000Z']]);
});

function makeBridgeDependencies(events, overrides = {}) {
  const timestamps = [
    '2026-09-01T00:00:01.000Z', '2026-09-01T00:00:02.000Z',
    '2026-09-01T00:00:03.000Z', '2026-09-01T00:00:04.000Z',
  ];
  const gateway = {
    getStatus: () => ({ state: 'ready', lastEventAt: Date.parse('2026-09-01T00:00:03.000Z') }),
    async stop() { events.push('gateway-stopped'); },
  };
  return {
    now: () => timestamps.shift() ?? '2026-09-01T00:00:04.000Z',
    async loadConfig() { return config; },
    validateConfig() {},
    async loadToken() { return 'test-token'; },
    async resolveExecutables() { events.push('executables-resolved'); return { codexPath: 'codex.exe', powershellPath: 'pwsh.exe' }; },
    async registerCommands() { events.push('commands-registered'); },
    async fetchRegisteredCommands() { return [
      '任务列表', '任务详情', '任务搜索', '新建任务', '继续任务',
      '继续队列', '额度', '系统状态', '系统测试', '退出Codex', '帮助',
    ].map((name) => ({ name })); },
    async loadTaskIndex() { events.push('index-ready'); return { version: 1, generatedAt: '2026-09-01T00:00:00.000Z', tasks: [] }; },
    async loadInboxState() { return createEmptyInboxState(); },
    async recoverTaskCreations() { events.push('task-creation-recovered'); },
    async warmProjectCatalog() { events.push('project-catalog-ready'); return { status: () => ({ warmed: true }) }; },
    createInteractionHandler() { return async () => {}; },
    async startGateway() { events.push('gateway-started'); return gateway; },
    async startLegacyPollers() {
      events.push('legacy-pollers-started');
      return { async stop() { events.push('legacy-pollers-stopped'); } };
    },
    async persistTaskIndex() { events.push('index-persisted'); },
    async persistInboxState() { events.push('inbox-persisted'); },
    getActiveTurns: () => [],
    ...overrides,
  };
}

test('bridge composition starts registration, index and gateway without disabling existing pollers', async () => {
  const events = [];
  const app = createBridgeApplication(makeBridgeDependencies(events));

  await app.start();

  assert.deepEqual(events.filter((event) => event !== 'executables-resolved').slice(0, 6), [
    'commands-registered', 'index-ready', 'task-creation-recovered',
    'project-catalog-ready', 'gateway-started', 'legacy-pollers-started',
  ]);
  const status = app.getSystemStatus();
  assert.equal(status.index.count, 0);
  assert.equal(status.gateway.state, 'ready');
  assert.match(status.timestamps.lastRegistrationAt, /^2026-09-01T/);
  assert.match(status.timestamps.lastIndexUpdateAt, /^2026-09-01T/);

  app.recordActivity('lastGatewayEventAt', '2026-09-01T00:00:05.000Z');
  app.recordActivity('lastRolloutProgressAt', '2026-09-01T00:00:06.000Z');
  app.recordActivity('lastNotificationSentAt', '2026-09-01T00:00:07.000Z');
  app.recordActivity('lastTaskCreationAt', '2026-09-01T00:00:08.000Z');
  app.recordActivity('lastQueueRetryAt', '2026-09-01T00:00:09.000Z');
  assert.deepEqual(app.getSystemStatus().timestamps, {
    lastRegistrationAt: '2026-09-01T00:00:01.000Z',
    lastIndexUpdateAt: '2026-09-01T00:00:02.000Z',
    lastGatewayEventAt: '2026-09-01T00:00:05.000Z',
    lastRolloutProgressAt: '2026-09-01T00:00:06.000Z',
    lastNotificationSentAt: '2026-09-01T00:00:07.000Z',
    lastTaskCreationAt: '2026-09-01T00:00:08.000Z',
    lastQueueRetryAt: '2026-09-01T00:00:09.000Z',
  });

  await app.stop();
  assert.deepEqual(events.slice(-4), [
    'gateway-stopped', 'legacy-pollers-stopped', 'index-persisted', 'inbox-persisted',
  ]);
});

test('bridge publishes sanitized health at startup, state changes, heartbeat, and final stop without affecting shutdown', async () => {
  const events = [];
  const published = [];
  const timers = [];
  const app = createBridgeApplication(makeBridgeDependencies(events, {
    publishHealth: async (context) => { published.push(context.getSystemStatus()); },
    setInterval(callback, milliseconds) { timers.push({ callback, milliseconds, cleared: false }); return timers.length - 1; },
    clearInterval(id) { timers[id].cleared = true; },
  }));

  await app.start();
  const afterStart = published.length;
  assert.ok(afterStart >= 1);
  assert.equal(timers[0].milliseconds, 10_000);
  app.recordActivity('lastQueueRetryAt', '2026-09-01T00:00:10.000Z');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published.length, afterStart + 1);
  await timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published.length, afterStart + 2);
  await app.stop();
  assert.equal(timers[0].cleared, true);
  assert.equal(published.length, afterStart + 3);
});

test('bridge contains health publication failures as a sanitized category', async () => {
  const events = [];
  const app = createBridgeApplication(makeBridgeDependencies(events, {
    publishHealth: async () => { throw new Error('Token must-not-appear'); },
  }));
  await app.start();
  assert.equal(app.context.latestErrorCategory, 'bridge-health-write-failed');
  await app.stop();
});

test('health lifecycle bounds hung publication and makes stopped final publication last', async () => {
  const events = [];
  const published = [];
  const timers = [];
  let ordinaryRelease;
  const app = createBridgeApplication(makeBridgeDependencies(events, {
    healthPublishTimeoutMs: 5,
    publishHealth: async (_context, { forceFinal, signal } = {}) => {
      if (forceFinal) { published.push('final'); return; }
      published.push('ordinary');
      await new Promise((resolve) => { ordinaryRelease = resolve; });
      if (signal?.aborted) return;
      published.push('late-ordinary');
    },
    setInterval(callback) { timers.push(callback); return 0; },
    clearInterval() {},
  }));
  const started = await Promise.race([
    app.start().then(() => 'started'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 30)),
  ]);
  assert.equal(started, 'started');
  await app.stop();
  await timers[0]();
  ordinaryRelease?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published.at(-1), 'final');
  assert.equal(published.includes('late-ordinary'), false);
});

test('startup failure preserves its cause while bounded terminal health invalidation fails', async () => {
  const events = [];
  let allowStart = false;
  const app = createBridgeApplication(makeBridgeDependencies(events, {
    healthPublishTimeoutMs: 5,
    async registerCommands() {
      if (!allowStart) throw new Error('startup root cause');
    },
    publishHealth: async (_context, { forceFinal } = {}) => {
      if (forceFinal) throw new Error('terminal write failed');
    },
    invalidateHealth() { throw new Error('invalidator sync failure'); },
  }));

  const outcome = await Promise.race([
    app.start().then(() => 'started', (error) => error),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 40)),
  ]);
  assert.ok(outcome instanceof Error);
  assert.match(outcome.message, /startup root cause/);
  allowStart = true;
  await app.start();
  await app.stop();
});

test('startup failure preserves a committed terminal snapshot without invalidation', async () => {
  const events = [];
  let invalidations = 0;
  const terminalSnapshots = [];
  const app = createBridgeApplication(makeBridgeDependencies(events, {
    async registerCommands() { throw new Error('startup root cause'); },
    publishHealth: async (context, { forceFinal } = {}) => {
      if (forceFinal) terminalSnapshots.push(context.getSystemStatus());
    },
    async invalidateHealth() { invalidations += 1; },
  }));

  await assert.rejects(() => app.start(), /startup root cause/);
  assert.equal(terminalSnapshots.length, 1);
  assert.equal(invalidations, 0);
});

test('startup failure bounds a never-settling health invalidator and preserves its cause', async () => {
  const events = [];
  const app = createBridgeApplication(makeBridgeDependencies(events, {
    healthPublishTimeoutMs: 5,
    async registerCommands() { throw new Error('startup root cause'); },
    publishHealth: async (_context, { forceFinal } = {}) => {
      if (forceFinal) throw new Error('terminal write failed');
    },
    invalidateHealth: () => new Promise(() => {}),
  }));

  const outcome = await Promise.race([
    app.start().then(() => 'started', (error) => error),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 40)),
  ]);
  assert.ok(outcome instanceof Error);
  assert.match(outcome.message, /startup root cause/);
});

test('partial startup cleanup detaches resources so entrypoint shutdown preserves the startup cause', async () => {
  const events = [];
  const terminalSnapshots = [];
  let failLegacyStart = true;
  let failRolloutPersist = true;
  let failGatewayCleanup = true;
  let gatewayStops = 0;
  let rolloutPersists = 0;
  const gateway = {
    getStatus: () => ({ state: 'ready' }),
    async stop() {
      gatewayStops += 1;
      if (failGatewayCleanup) throw new Error('gateway cleanup failure');
    },
  };
  const app = createBridgeApplication(makeBridgeDependencies(events, {
    async startGateway() { return gateway; },
    async startLegacyPollers() {
      if (failLegacyStart) throw new Error('legacy startup root cause');
      return { async stop() {} };
    },
    async persistRolloutState() {
      rolloutPersists += 1;
      if (failRolloutPersist) throw new Error('partial rollout persistence failure');
    },
    publishHealth: async (context, { forceFinal } = {}) => {
      if (forceFinal) terminalSnapshots.push(structuredClone(context.getSystemStatus()));
    },
  }));

  const mainShape = async () => {
    try {
      await app.start();
    } finally {
      await app.stop();
    }
  };

  await assert.rejects(mainShape, /legacy startup root cause/);
  assert.equal(gatewayStops, 1);
  assert.equal(rolloutPersists, 0);
  assert.equal(terminalSnapshots.length, 1);
  assert.equal(terminalSnapshots[0].gateway.state, 'failed');
  assert.equal(terminalSnapshots[0].latestErrorCategory, 'startup-failed');

  failLegacyStart = false;
  failRolloutPersist = false;
  failGatewayCleanup = false;
  await app.start();
  await app.stop();
});

test('partial startup cleanup bounds hung resources before preserving its startup error', async () => {
  const events = [];
  const terminalSnapshots = [];
  let failStart = true;
  let hangStops = true;
  let gatewayStops = 0;
  let legacyStops = 0;
  let persistCalls = 0;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const app = createBridgeApplication(makeBridgeDependencies(events, {
    shutdownTimeoutMs: 5,
    healthPublishTimeoutMs: 5,
    async startGateway() {
      return {
        getStatus: () => ({ state: 'ready' }),
        stop() {
          gatewayStops += 1;
          return hangStops ? new Promise(() => {}) : Promise.resolve();
        },
      };
    },
    async startLegacyPollers() {
      return {
        stop() {
          legacyStops += 1;
          return hangStops ? new Promise(() => {}) : Promise.resolve();
        },
      };
    },
    publishHealth: async (context, { forceFinal } = {}) => {
      if (forceFinal) terminalSnapshots.push(structuredClone(context.getSystemStatus()));
    },
    setInterval() {
      if (failStart) throw new Error('startup root cause');
      return 1;
    },
    clearInterval() {},
    async persistTaskIndex() { persistCalls += 1; },
    async persistInboxState() { persistCalls += 1; },
    async persistRolloutState() { persistCalls += 1; },
  }));
  const mainShape = async () => {
    try {
      await app.start();
    } finally {
      await app.stop();
    }
  };

  try {
    const outcome = await Promise.race([
      mainShape().then(() => 'started', (error) => error),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 40)),
    ]);
    assert.ok(outcome instanceof Error);
    assert.match(outcome.message, /startup root cause/);
    assert.equal(gatewayStops, 1);
    assert.equal(legacyStops, 1);
    assert.equal(persistCalls, 0);
    assert.equal(terminalSnapshots.length, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);

    failStart = false;
    hangStops = false;
    await app.start();
    await app.stop();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('REST tracker publishes failed then recovered state without raw failures', async () => {
  const events = [];
  const published = [];
  const app = createBridgeApplication(makeBridgeDependencies(events, {
    publishHealth: async (context) => { published.push(structuredClone(context.getSystemStatus().discordRest)); },
  }));
  await app.start();
  await assert.rejects(() => app.context.trackDiscordRest(() => { throw new Error('Token must-not-appear'); }));
  await app.context.trackDiscordRest(async () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published.slice(-2).map((item) => item.state), ['failed', 'ok']);
  assert.equal(JSON.stringify(published).includes('must-not-appear'), false);
  await app.stop();
});

test('older v2 inbox state gains the newer empty containers before strict validation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-older-v2-inbox-'));
  const inboxPath = path.join(root, 'discord-inbox-state.json');
  const predecessor = {
    version: 2,
    initialized: true,
    cursors: { '123': '456' },
    processedMessageIds: ['789'],
    pendingReplies: {},
  };

  try {
    await fs.writeFile(inboxPath, JSON.stringify(predecessor), 'utf8');
    const bridgeModule = await import('../discord-bridge.mjs');
    const persisted = [];
    const loaded = await bridgeModule.loadInboxStateWithRecovery({
      inboxPath,
      encryptText: async () => { throw new Error('empty legacy replies require no encryption'); },
      persistState: async (state) => { persisted.push(structuredClone(state)); },
      writeLog: async () => { throw new Error('compatible predecessor must not be logged as corrupt'); },
    });

    assert.equal(loaded.readOnly, false);
    assert.equal(loaded.errorCategory, null);
    assert.deepEqual(loaded.state, {
      ...createEmptyInboxState(),
      initialized: true,
      cursors: { '123': '456' },
      processedMessageIds: ['789'],
    });
    assert.deepEqual(persisted, [loaded.state]);
    assert.deepEqual((await fs.readdir(root)).sort(), ['discord-inbox-state.json']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('corrupt inbox is preserved while an isolated read-only bridge still starts its Gateway', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-corrupt-inbox-'));
  const fixedNow = new Date('2026-09-01T06:07:08.009Z');
  const privateNeedle = 'private-token https://discord.com/api/webhooks/123 C:\\Users\\private\\state.json';
  const corruptInputs = new Map([
    ['invalid-json', `{ "version": 2, "pendingContinuations": "${privateNeedle}"`],
    ['invalid-schema', JSON.stringify({
      ...createEmptyInboxState(),
      pendingContinuations: {
        unknown: {
          queueId: 'unknown', source: 'slash', requestId: 'private-request', threadId: 'private-thread',
          status: 'queued', encryptedText: privateNeedle,
        },
      },
    })],
    ['unsupported-version', JSON.stringify({
      ...createEmptyInboxState(),
      version: 3,
      pendingContinuations: {
        unknown: {
          queueId: 'unknown', source: 'slash', requestId: 'private-request', threadId: 'private-thread',
          status: 'queued', encryptedText: privateNeedle, summary: 'unknown replay',
          createdAt: '2026-09-01T00:00:00.000Z', queuedAt: '2026-09-01T00:00:00.000Z', attempts: 0,
        },
      },
    })],
  ]);

  try {
    const bridgeModule = await import('../discord-bridge.mjs');
    let recovered;
    for (const [name, raw] of corruptInputs) {
      const caseRoot = path.join(root, name);
      const inboxPath = path.join(caseRoot, 'discord-inbox-state.json');
      await fs.mkdir(caseRoot, { recursive: true });
      await fs.writeFile(inboxPath, raw, 'utf8');
      const logCategories = [];

      recovered = await bridgeModule.loadInboxStateWithRecovery({
        inboxPath,
        now: () => fixedNow,
        encryptText: async () => { throw new Error('legacy encryption must not inspect corrupt state'); },
        persistState: async () => { throw new Error('corrupt evidence must not be overwritten'); },
        writeLog: async (category) => { logCategories.push(category); },
      });

      assert.deepEqual(recovered.state, createEmptyInboxState());
      assert.equal(recovered.readOnly, true);
      assert.equal(recovered.errorCategory, 'continuation-state-corrupt');
      assert.equal(JSON.stringify(recovered.state).includes('private-request'), false);
      assert.equal(await fs.readFile(inboxPath, 'utf8'), raw);
      const backups = (await fs.readdir(caseRoot)).filter((entry) =>
        /^discord-inbox-state\.corrupt-2026-09-01T06-07-08\.009Z(?:-\d+)?\.json$/u.test(entry));
      assert.equal(backups.length, 1);
      assert.equal(await fs.readFile(path.join(caseRoot, backups[0]), 'utf8'), raw);
      assert.deepEqual(logCategories, ['continuation-state-corrupt']);
    }

    const events = [];
    const responses = [];
    const app = createBridgeApplication(makeBridgeDependencies(events, {
      async loadInboxState(context) {
        context.inboxReadOnly = recovered.readOnly;
        context.latestErrorCategory = recovered.errorCategory;
        return recovered.state;
      },
      async recoverTaskCreations(context) {
        assert.equal(context.inboxReadOnly, true);
        events.push('task-creation-recovery-skipped');
      },
      createInteractionHandler(context) {
        const router = createInteractionRouter({
          config: { discordGuildId: '222', discordAllowedUserId: '333' },
          taskIndex: { generatedAt: fixedNow.toISOString(), tasks: [] },
          mutationDisabledCategory: context.latestErrorCategory,
          respond: async (body) => { responses.push(body); },
        });
        return (interaction) => router.handle(interaction);
      },
      async startGateway(context) {
        events.push('gateway-started');
        const interaction = (name) => ({
          id: `command-${name}`,
          token: `private-${name}`,
          application_id: '111',
          type: 2,
          guild_id: '222',
          member: { user: { id: '333' } },
          data: { name, options: [] },
        });
        await context.interactionHandler(interaction('帮助'));
        await context.interactionHandler(interaction('新建任务'));
        return { getStatus: () => ({ state: 'ready' }), async stop() { events.push('gateway-stopped'); } };
      },
    }));

    await app.start();

    assert.equal(events.includes('gateway-started'), true);
    assert.equal(app.getSystemStatus().latestErrorCategory, 'continuation-state-corrupt');
    assert.match(responses[0]?.data?.content ?? '', /任务列表/);
    assert.match(responses[1]?.data?.content ?? '', /暂不可用/);
    assert.equal(JSON.stringify(responses).includes(privateNeedle), false);
    await app.stop();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('restart preserves a valid projectless created-task workspace without corrupt recovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-projectless-inbox-'));
  const inboxPath = path.join(root, 'discord-inbox-state.json');
  const interactionId = 'projectless-created-task';
  const createdTask = {
    status: 'started',
    threadId: 'thread-projectless',
    turnId: 'turn-projectless',
    taskName: 'Projectless task',
    workspace: {
      mode: 'projectless',
      cwd: 'C:\\tasks',
      runtimeWorkspaceRoots: ['C:\\tasks'],
      operationId: interactionId,
    },
  };
  const persisted = {
    ...createEmptyInboxState(),
    createdTasksByInteraction: { [interactionId]: createdTask },
  };

  try {
    await fs.writeFile(inboxPath, JSON.stringify(persisted), 'utf8');
    const bridgeModule = await import('../discord-bridge.mjs');
    const logCategories = [];
    const loaded = await bridgeModule.loadInboxStateWithRecovery({
      inboxPath,
      encryptText: async () => { throw new Error('valid v2 state must not require legacy migration'); },
      persistState: async () => {},
      writeLog: async (category) => { logCategories.push(category); },
    });

    assert.deepEqual(logCategories, []);
    assert.deepEqual(loaded.state.createdTasksByInteraction[interactionId], createdTask);
    assert.equal(loaded.readOnly, false);
    assert.equal(loaded.errorCategory, null);
    const backups = (await fs.readdir(root)).filter((entry) => entry.includes('.corrupt-'));
    assert.equal(backups.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('persistent Node and PowerShell guard logs keep only stable operational fields', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-stable-logs-'));
  const nodeLogPath = path.join(root, 'discord-bridge.log');
  const privateNeedle = 'private-token https://discord.com/api/webhooks/123 C:\\Users\\private\\state.json 用户原文';
  try {
    const bridgeModule = await import('../discord-bridge.mjs');
    await bridgeModule.writePersistentLogEvent({
      filePath: nodeLogPath,
      category: 'rollout-poll-failed',
      fields: {
        threadId: '11111111-1111-4111-8111-123456789abc',
        exitCode: 17,
        durationMs: 42,
        error: privateNeedle,
        path: 'C:\\Users\\private\\state.json',
        url: 'https://discord.com/api/webhooks/123',
        token: 'private-token',
        userText: '用户原文',
      },
      now: () => new Date('2026-09-01T07:08:09.010Z'),
    });
    await bridgeModule.writePersistentLogEvent({
      filePath: nodeLogPath,
      category: privateNeedle,
      fields: {},
      now: () => new Date('2026-09-01T07:08:10.011Z'),
    });
    const nodeLog = await fs.readFile(nodeLogPath, 'utf8');

    const startupLibrary = path.resolve('discord-bridge-startup.ps1').replaceAll("'", "''");
    const powershell = spawnSync('pwsh', ['-NoProfile', '-Command', [
      `. '${startupLibrary}'`,
      `$entry = Format-BridgeGuardLogEntry -Category '${privateNeedle}' -ExitCode 17 -DurationMs 42 -Timestamp ([DateTimeOffset]::Parse('2026-09-01T07:08:09.010Z'))`,
      '[Console]::Out.Write($entry)',
    ].join('; ')], { encoding: 'utf8', windowsHide: true });
    assert.equal(powershell.status, 0, powershell.stderr);

    const combined = `${nodeLog}\n${powershell.stdout}\n${powershell.stderr}`;
    for (const forbidden of ['private-token', 'discord.com', 'webhooks', 'C:\\Users\\private', '用户原文']) {
      assert.equal(combined.includes(forbidden), false, `persistent log leaked ${forbidden}`);
    }
    assert.match(nodeLog, /event=rollout-poll-failed\b.*thread=…56789abc\b.*exitCode=17\b.*durationMs=42\b/u);
    assert.match(nodeLog, /event=bridge-event\b/u);
    assert.match(powershell.stdout, /event=guard-event\b.*exitCode=17\b.*durationMs=42\b/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('shutdown isolates a poller stop failure and still attempts gateway and every persistence boundary', async () => {
  const events = [];
  const app = createBridgeApplication(makeBridgeDependencies(events, {
    async startLegacyPollers() {
      events.push('legacy-pollers-started');
      return {
        async stop() {
          events.push('legacy-pollers-stopped');
          throw new Error('private poller path C:\\secret');
        },
      };
    },
    async persistRolloutState() { events.push('rollout-persisted'); },
  }));
  await app.start();

  await assert.rejects(app.stop(), (error) => {
    assert.match(error.message, /^Discord bridge shutdown failed: /);
    assert.match(error.message, /legacy-pollers-stop/);
    assert.equal(error.message.includes('private'), false);
    assert.equal(error.message.includes('secret'), false);
    return true;
  });

  const shutdown = events.slice(events.indexOf('gateway-stopped'));
  assert.deepEqual(shutdown, [
    'gateway-stopped', 'legacy-pollers-stopped', 'index-persisted', 'inbox-persisted', 'rollout-persisted',
  ]);
});

test('shutdown uses one deadline when poller stop hangs and still attempts every other cleanup', async () => {
  const events = [];
  const app = createBridgeApplication(makeBridgeDependencies(events, {
    shutdownTimeoutMs: 20,
    async startLegacyPollers() {
      events.push('legacy-pollers-started');
      return {
        async stop() {
          events.push('legacy-pollers-stopped');
          return new Promise(() => {});
        },
      };
    },
    async persistRolloutState() { events.push('rollout-persisted'); },
  }));
  await app.start();

  const startedAt = Date.now();
  const outcome = await Promise.race([
    app.stop().then(() => 'resolved', (error) => error.message),
    new Promise((resolve) => setTimeout(() => resolve('test-timeout'), 250)),
  ]);

  assert.match(outcome, /^Discord bridge shutdown failed: .*deadline-exceeded/);
  assert.ok(Date.now() - startedAt < 250);
  assert.deepEqual(events.slice(events.indexOf('gateway-stopped'), events.indexOf('gateway-stopped') + 5), [
    'gateway-stopped', 'legacy-pollers-stopped', 'index-persisted', 'inbox-persisted', 'rollout-persisted',
  ]);
});

test('shutdown waits for a running new-task first turn and removes it after normal completion', async () => {
  const events = [];
  let finishTurn;
  const completion = new Promise((resolve) => { finishTurn = resolve; });
  const app = createBridgeApplication(makeBridgeDependencies(events, { shutdownTimeoutMs: 200 }));
  await app.start();
  app.trackActiveResource({ kind: 'task-creation', completion, cancel() { events.push('task-cancelled'); } });

  let stopped = false;
  const stopping = app.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  finishTurn({ turn: { status: 'completed' } });
  await stopping;

  assert.equal(stopped, true);
  assert.equal(events.includes('task-cancelled'), false);
  assert.equal(app.context.activeResources.size, 0);
});

test('shutdown deadline cancels creation and continuation resources from the shared registry', async () => {
  const events = [];
  const never = new Promise(() => {});
  const app = createBridgeApplication(makeBridgeDependencies(events, { shutdownTimeoutMs: 20 }));
  await app.start();
  app.trackActiveResource({ kind: 'task-creation', completion: never, cancel() { events.push('task-cancelled'); } });
  app.trackActiveResource({ kind: 'continuation', completion: never, close() { events.push('continuation-closed'); } });

  const startedAt = Date.now();
  await assert.rejects(app.stop(), /deadline-exceeded/);

  assert.ok(Date.now() - startedAt < 250);
  assert.equal(events.filter((item) => item === 'task-cancelled').length, 1);
  assert.equal(events.filter((item) => item === 'continuation-closed').length, 1);
  assert.equal(app.context.activeResources.size, 0);
});

test('registration-only lifecycle verifies exactly eleven commands without starting Codex or pollers', async () => {
  const events = [];
  const app = createBridgeApplication(makeBridgeDependencies(events, {
    async resolveExecutables() { throw new Error('Codex must not be resolved'); },
    async loadTaskIndex() { throw new Error('index must not load'); },
    async startGateway() { throw new Error('gateway must not start'); },
    async startLegacyPollers() { throw new Error('pollers must not start'); },
  }));

  const result = await app.registerCommandsOnce();

  assert.deepEqual(result.commandNames, [
    '任务列表', '任务详情', '任务搜索', '新建任务', '继续任务',
    '继续队列', '额度', '系统状态', '系统测试', '退出Codex', '帮助',
  ]);
  assert.deepEqual(events, ['commands-registered']);
});

test('registration verification fails closed when Discord returns a different command set', async () => {
  const events = [];
  const app = createBridgeApplication(makeBridgeDependencies(events, {
    async fetchRegisteredCommands() { return [{ name: '帮助' }]; },
  }));

  await assert.rejects(() => app.registerCommandsOnce(), /Guild command verification failed/);
});

test('quick health resolves the current Bot identity before reading its Guild member', async () => {
  const routes = [];
  const member = await getDiscordBotMember({
    guildId: '222',
    request: async (route) => {
      routes.push(route);
      if (route === '/users/@me') return { id: '333', username: 'private-bot' };
      return { user: { id: '333' }, roles: ['444'] };
    },
  });

  assert.deepEqual(routes, ['/users/@me', '/guilds/222/members/333']);
  assert.deepEqual(member, { user: { id: '333' }, roles: ['444'] });
});

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
      params: {
        clientInfo: { name: 'codex-discord-bridge', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
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
  assert.equal(typeof resumed.close, 'function');
  assert.equal(typeof resumed.cancel, 'function');
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
  assert.equal(typeof result.close, 'function');
  assert.equal(typeof result.cancel, 'function');
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

test('finalize cursor persistence rollback preserves a concurrently delivered Slash request', async () => {
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
  assert.equal(confirmedB.status, 'delivered');
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

test('successful Slash continuation is durably delivered while preserving its idempotent result', async () => {
  const state = createEmptyInboxState();
  const now = '2026-09-01T12:00:00.000Z';
  let resumeCount = 0;
  const request = createContinuationRequest({
    source: 'slash', requestId: 'slash-terminal-success', threadId: 'root-1', text: 'continue',
  });
  const dependencies = {
    state,
    now: () => now,
    encryptText: async () => 'opaque-ciphertext',
    persistState: async () => {},
    resumeCodexThread: async () => {
      resumeCount += 1;
      return { turnId: 'turn-slash-terminal', completion: Promise.resolve({ turn: { status: 'completed' } }) };
    },
  };

  const first = await dispatchContinuation(request, dependencies);
  const duplicate = await dispatchContinuation(request, dependencies);
  const item = listContinuations(state)[0];

  assert.equal(first.status, 'started');
  assert.deepEqual(duplicate, first);
  assert.equal(resumeCount, 1);
  assert.equal(item.status, 'delivered');
  assert.equal(item.deliveredAt, now);
  assert.equal(state.processedInteractions.find((entry) => entry.requestId === request.requestId)?.turnId, 'turn-slash-terminal');
});

test('successful reply acknowledgement releases a failed delivered finalize for ack-only retry', async () => {
  const state = createEmptyInboxState();
  const request = createContinuationRequest({
    source: 'reply', requestId: 'reply-finalize-failure', threadId: 'root-1', text: 'continue',
    channelId: 'channel-1', replyToMessageId: 'reply-finalize-failure',
  });
  const queued = enqueueContinuation(state, {
    ...request, encryptedText: 'opaque-ciphertext', status: 'confirmed-start', turnId: 'turn-already-started',
  });
  let persistCount = 0;
  let acknowledgementCount = 0;
  let resumeCount = 0;
  const dependencies = {
    state,
    decryptText: async () => 'continue',
    persistState: async () => {
      persistCount += 1;
      if (persistCount === 2) throw new Error('finalize write failed');
    },
    sendReply: async () => { acknowledgementCount += 1; },
    resumeCodexThread: async () => { resumeCount += 1; throw new Error('must not resume'); },
  };

  const failedFinalize = await dispatchContinuation(queued, dependencies);
  assert.equal(failedFinalize.reason, 'state-persist-failed');
  assert.equal(state.pendingContinuations[queued.queueId].status, 'confirmed-start');

  const retry = await dispatchContinuation(request, dependencies);
  assert.equal(retry.status, 'started');
  assert.equal(state.pendingContinuations[queued.queueId].status, 'delivered');
  assert.equal(acknowledgementCount, 2);
  assert.equal(resumeCount, 0);
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

test('active-writer rollback for request A preserves concurrently delivered request B', async () => {
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
  assert.equal(state.pendingContinuations[requestB.queueId].status, 'delivered');

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

test('terminal pruning retains a newly delivered turn even when it waited in queue longer than history', async () => {
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
  assert.equal(state.pendingContinuations[queued.queueId].status, 'delivered');
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
