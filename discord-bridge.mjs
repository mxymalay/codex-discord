import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { resolveCodexHome } from './discord-runtime-lib.mjs';
import { expandPathVariables, isAbsolutePath, normalizePath } from './discord-paths-lib.mjs';

import {
  assertValidInboxStateV2,
  assertValidLegacyInboxState,
  cancelContinuationPersisted,
  claimContinuationTakeover,
  classifyReply,
  commitInboxState,
  createContinuationRequest,
  createEmptyInboxState,
  decryptPendingReplyText,
  discordRequest,
  discordReplyChannelIds,
  encryptPendingReplyText,
  dispatchContinuation,
  getDiscordMessagesAfter,
  listRetryableContinuations,
  getLatestDiscordMessageId,
  initializeInboxCursors,
  interruptCodexThread,
  listActiveCodexThreads,
  listContinuations,
  loadDiscordToken,
  migrateLegacyPendingReplies,
  migrateInboxState,
  readJsonFile,
  recordInboxMessage,
  recoverContinuationAttempts,
  releaseContinuationTakeoverClaim,
  resolveCodexExecutable,
  resolvePowerShellExecutable,
  sendDiscordReply,
  steerCodexThread,
  writeJsonAtomic,
} from './discord-bridge-lib.mjs';
import { COMMAND_NAMES, registerGuildCommands } from './discord-commands-lib.mjs';
import { createGatewayClient } from './discord-gateway-lib.mjs';
import {
  createInteractionRestClient,
  createInteractionRouter,
  createTaskStatusRow,
  inspectQueuedTakeover,
  publishContinuationTakeoverMessage,
} from './discord-interactions.mjs';
import {
  buildTaskIndex,
  readTaskDetail,
  readTaskIndex,
  searchTasks,
  writeTaskIndexAtomic,
} from './discord-task-index-lib.mjs';
import {
  createNewTaskOnce,
  createProjectCatalog,
  listCodexProjects,
  recordTaskCreationReceiptOutcome,
  recoverInterruptedTaskCreations,
} from './discord-task-create-lib.mjs';
import { probeTemporaryAtomicWrite } from './discord-health-lib.mjs';
import {
  dispatchNotificationViaPowerShell,
  initializeRolloutWatcherState,
  pollRolloutCompletions,
  readRolloutWatcherState,
  writeRolloutWatcherState,
} from './rollout-completion-watcher-lib.mjs';
import { runCodexControlAction, writeBridgeHealthAtomic } from './discord-control-client.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(toolDir, 'config.json');
const mappingPath = path.join(toolDir, 'discord-message-map.json');
const inboxStatePath = path.join(toolDir, 'discord-inbox-state.json');
const logPath = path.join(toolDir, 'discord-bridge.log');
const codexRoot = resolveCodexHome({ toolDir });
const sessionsRoot = path.join(codexRoot, 'sessions');
const rolloutWatcherStatePath = path.join(toolDir, 'rollout-watcher-state.json');
const taskIndexPath = path.join(toolDir, 'discord-task-index.json');
const quotaStatePath = path.join(toolDir, 'quota-state.json');
const bridgeHealthPath = path.join(toolDir, 'discord-bridge-health.json');
const controlPath = path.join(toolDir, process.platform === 'darwin' ? 'discord-macos-control.mjs' : 'codex-control.ps1');
const sessionIndexPath = path.join(codexRoot, 'session_index.jsonl');
const pollIntervalMs = 4000;
const pendingRetryIntervalMs = 30_000;
const indexRefreshIntervalMs = 30_000;
const transientFailureAcks = new Map();

const activityFields = new Set([
  'lastRegistrationAt', 'lastIndexUpdateAt', 'lastGatewayEventAt',
  'lastRolloutProgressAt', 'lastNotificationSentAt', 'lastTaskCreationAt',
  'lastQueueRetryAt',
]);

function isoTimestamp(value) {
  const candidate = value instanceof Date ? value : new Date(value);
  return Number.isFinite(candidate.getTime()) ? candidate.toISOString() : new Date().toISOString();
}

function latestTimestamp(timestamps) {
  const valid = Object.values(timestamps ?? {})
    .map((value) => ({ value, milliseconds: Date.parse(String(value ?? '')) }))
    .filter((item) => Number.isFinite(item.milliseconds))
    .sort((left, right) => right.milliseconds - left.milliseconds);
  return valid[0]?.value ?? null;
}

function exactCommandNames(commands) {
  const names = (Array.isArray(commands) ? commands : []).map((item) => String(item?.name ?? ''));
  const uniqueNames = new Set(names);
  if (names.length !== COMMAND_NAMES.length
    || uniqueNames.size !== COMMAND_NAMES.length
    || COMMAND_NAMES.some((name) => !uniqueNames.has(name))) {
    throw new Error('Guild command verification failed');
  }
  return names;
}

function boundedShutdownTimeout(value) {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) ? Math.max(0, Math.min(60_000, Math.floor(milliseconds))) : 10_000;
}

function boundedHealthTimeout(value) {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) ? Math.max(1, Math.min(10_000, Math.floor(milliseconds))) : 2_000;
}

export async function trackDiscordRest(context, operation) {
  try {
    const result = await operation();
    context.setDiscordRestStatus('ok');
    return result;
  } catch (error) {
    context.setDiscordRestStatus('failed');
    throw error;
  }
}

/** Compose the bridge lifecycle from injectable components. */
export function createBridgeApplication(dependencies = {}) {
  const context = {
    config: null,
    token: null,
    executables: null,
    taskIndex: null,
    inboxState: null,
    inboxReadOnly: false,
    projectCatalog: null,
    interactionHandler: null,
    uiState: new Map(),
    gateway: null,
    legacyPollers: null,
    gatewayStatus: { state: 'idle' },
    discordRestStatus: { state: 'unknown', lastSuccessAt: null },
    latestErrorCategory: null,
    startedAt: null,
    isStopping: false,
    activeResources: new Set(),
    timestamps: Object.fromEntries([...activityFields].map((field) => [field, null])),
  };
  let started = false;
  let prepared = false;
  let acceptingResources = true;
  let stopPromise = null;
  let healthTimer = null;
  let healthPublication = Promise.resolve();
  let healthGeneration = 0;
  let healthController = null;
  let healthLifecycle = 'inactive';
  let healthFinalAllowed = false;
  let startupCleanupComplete = false;
  const idleWaiters = new Set();

  const notifyIdle = () => {
    if (context.activeResources.size !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const releaseResource = (resource) => {
    const release = typeof resource?.cancel === 'function' ? resource.cancel : resource?.close;
    if (typeof release !== 'function') return;
    try {
      Promise.resolve(release.call(resource)).catch(() => {});
    } catch {
      // Shutdown aggregation records the resource category, never private errors.
    }
  };

  const trackActiveResource = (resource) => {
    if (!resource?.completion || typeof resource.completion.then !== 'function') return resource;
    const entry = {
      kind: String(resource.kind ?? 'active-resource'),
      completion: resource.completion,
      close: typeof resource.close === 'function' ? resource.close : undefined,
      cancel: typeof resource.cancel === 'function' ? resource.cancel : undefined,
    };
    if (!acceptingResources) {
      Promise.resolve(entry.completion).catch(() => {});
      releaseResource(entry);
      return resource;
    }
    context.activeResources.add(entry);
    Promise.resolve(entry.completion).then(
      () => { context.activeResources.delete(entry); notifyIdle(); },
      () => { context.activeResources.delete(entry); notifyIdle(); },
    );
    return resource;
  };

  const waitForActiveResources = () => {
    if (context.activeResources.size === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  };
  context.trackActiveResource = trackActiveResource;

  const reportHealthFailure = (generation) => {
    if (generation === healthGeneration) context.latestErrorCategory = 'bridge-health-write-failed';
    try { Promise.resolve(dependencies.logHealthFailure?.('bridge-health-write-failed')).catch(() => {}); } catch {}
  };
  const healthIsCurrent = (generation, controller, forceFinal) => generation === healthGeneration && controller === healthController && !controller.signal.aborted &&
    (forceFinal ? healthLifecycle === 'stopping' && healthFinalAllowed : ['starting', 'running'].includes(healthLifecycle));
  const safePublishHealth = ({ forceFinal = false } = {}) => {
    if (typeof dependencies.publishHealth !== 'function') return Promise.resolve(false);
    const generation = healthGeneration;
    const lifecycleController = healthController;
    if (!lifecycleController || !healthIsCurrent(generation, lifecycleController, forceFinal)) return Promise.resolve(false);
    const previous = healthPublication;
    const run = async () => {
      try {
        await previous.catch(() => {});
        if (!healthIsCurrent(generation, lifecycleController, forceFinal)) return false;
        const publicationController = new AbortController();
        const abort = () => publicationController.abort();
        lifecycleController.signal.addEventListener('abort', abort, { once: true });
        const operation = Promise.resolve().then(() => dependencies.publishHealth(context, {
          signal: publicationController.signal, generation, forceFinal,
          shouldCommit: () => healthIsCurrent(generation, lifecycleController, forceFinal) && !publicationController.signal.aborted,
        }));
        operation.catch(() => {});
        let timeoutId;
        let outcome = 'failed';
        try {
          outcome = await Promise.race([
            operation.then(() => 'ok', () => 'failed'),
            new Promise((resolve) => { timeoutId = setTimeout(() => resolve('timeout'), boundedHealthTimeout(dependencies.healthPublishTimeoutMs)); }),
          ]);
        } finally {
          clearTimeout(timeoutId);
          lifecycleController.signal.removeEventListener('abort', abort);
        }
        if (outcome === 'ok') return true;
        publicationController.abort();
        reportHealthFailure(generation);
        return false;
      } catch {
        reportHealthFailure(generation);
        return false;
      }
    };
    healthPublication = run().catch(() => false);
    return healthPublication;
  };

  const safeInvalidateHealth = async () => {
    if (typeof dependencies.invalidateHealth !== 'function') return false;
    const generation = healthGeneration;
    const operation = Promise.resolve().then(() => dependencies.invalidateHealth());
    operation.catch(() => {});
    let timeoutId;
    let outcome = 'failed';
    try {
      outcome = await Promise.race([
        operation.then(() => 'ok', () => 'failed'),
        new Promise((resolve) => { timeoutId = setTimeout(() => resolve('timeout'), boundedHealthTimeout(dependencies.healthPublishTimeoutMs)); }),
      ]);
    } catch {}
    clearTimeout(timeoutId);
    if (outcome !== 'ok') reportHealthFailure(generation);
    return outcome === 'ok';
  };

  const reportStartupCleanupFailure = () => {
    try { Promise.resolve(dependencies.logHealthFailure?.('startup-cleanup-failed')).catch(() => {}); } catch {}
  };
  const stopPartialResources = async (resources) => {
    const stops = resources.map((resource) => {
      const stop = Promise.resolve().then(() => resource?.stop?.());
      stop.catch(() => { reportStartupCleanupFailure(); });
      return stop;
    });
    let timeoutId;
    const completed = await Promise.race([
      Promise.allSettled(stops).then(() => true),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(false), boundedShutdownTimeout(dependencies.shutdownTimeoutMs ?? 10_000));
      }),
    ]);
    clearTimeout(timeoutId);
    if (!completed) reportStartupCleanupFailure();
  };
  const cleanupFailedStart = async () => {
    if (startupCleanupComplete) return;
    startupCleanupComplete = true;
    const gateway = context.gateway;
    const legacyPollers = context.legacyPollers;
    context.gateway = null;
    context.legacyPollers = null;
    acceptingResources = false;
    started = false;
    context.isStopping = true;
    context.latestErrorCategory = 'startup-failed';
    context.gatewayStatus = { state: 'failed' };
    const clearHealthInterval = dependencies.clearInterval ?? globalThis.clearInterval;
    if (healthTimer != null) {
      try { clearHealthInterval(healthTimer); } catch { reportStartupCleanupFailure(); }
      healthTimer = null;
    }
    await stopPartialResources([gateway, legacyPollers]);
    healthController?.abort();
    healthGeneration++;
    healthController = new AbortController();
    healthLifecycle = 'stopping';
    healthFinalAllowed = true;
    healthPublication = Promise.resolve();
    let terminalCommitted = false;
    try {
      terminalCommitted = await safePublishHealth({ forceFinal: true });
      if (!terminalCommitted) {
        healthController?.abort();
        await safeInvalidateHealth();
      }
    } finally {
      healthFinalAllowed = false;
      healthLifecycle = 'stopped';
    }
  };

  const publishHealthSoon = () => { void safePublishHealth(); };
  const recordActivity = (field, at = dependencies.now?.() ?? Date.now()) => {
    if (!activityFields.has(field)) throw new Error(`Unknown bridge activity field: ${field}`);
    context.timestamps[field] = isoTimestamp(at);
    if (started) publishHealthSoon();
  };

  const getSystemStatus = () => ({
    gateway: context.isStopping ? context.gatewayStatus : (context.gateway?.getStatus?.() ?? context.gatewayStatus),
    discordRest: { ...context.discordRestStatus },
    notificationListener: {
      state: context.legacyPollers ? 'running' : 'stopped',
      lastSuccessAt: context.timestamps.lastNotificationSentAt,
    },
    rollout: {
      state: context.legacyPollers ? 'running' : 'stopped',
      lastProgressAt: context.timestamps.lastRolloutProgressAt,
    },
    index: {
      generatedAt: context.taskIndex?.generatedAt ?? context.timestamps.lastIndexUpdateAt,
      count: context.taskIndex?.tasks?.length ?? 0,
    },
    queueCount: listContinuations(context.inboxState ?? {}).filter((item) => item?.status === 'queued').length,
    latestErrorCategory: context.latestErrorCategory,
    timestamps: { ...context.timestamps },
  });
  context.recordActivity = recordActivity;
  context.getSystemStatus = getSystemStatus;
  context.publishHealth = safePublishHealth;
  context.trackDiscordRest = (operation) => trackDiscordRest(context, operation);
  context.setGatewayStatus = (status) => {
    context.gatewayStatus = status && typeof status === 'object' ? status : { state: 'unknown' };
    if (status?.lastEventAt != null) recordActivity('lastGatewayEventAt', status.lastEventAt);
    if (status?.lastError) context.setLatestErrorCategory(status.lastError);
    else if (started) publishHealthSoon();
  };
  context.setDiscordRestStatus = (state) => {
    context.discordRestStatus = { state: String(state ?? 'unknown'), lastSuccessAt: state === 'ok' ? isoTimestamp() : context.discordRestStatus.lastSuccessAt };
    if (started) publishHealthSoon();
  };
  context.setLatestErrorCategory = (category) => {
    context.latestErrorCategory = String(category ?? 'unknown');
    if (started) publishHealthSoon();
  };

  async function prepare(registrationOnly) {
    if (prepared) return;
    context.config = await dependencies.loadConfig();
    await dependencies.validateConfig?.(context.config, { registrationOnly });
    context.token = await dependencies.loadToken(context);
    if (!registrationOnly) context.executables = await dependencies.resolveExecutables(context);
    prepared = true;
  }

  async function registerAndVerify() {
    await context.trackDiscordRest(() => dependencies.registerCommands(context));
    const commands = await context.trackDiscordRest(() => dependencies.fetchRegisteredCommands(context));
    const commandNames = exactCommandNames(commands);
    recordActivity('lastRegistrationAt');
    return commandNames;
  }

  return {
    context,
    recordActivity,
    trackActiveResource,
    getSystemStatus,
    async registerCommandsOnce() {
      await prepare(true);
      return { commandNames: await registerAndVerify() };
    },
    async start() {
      if (started) return;
      acceptingResources = true;
      context.isStopping = false;
      stopPromise = null;
      startupCleanupComplete = false;
      healthController?.abort();
      healthGeneration++;
      healthController = new AbortController();
      healthLifecycle = 'starting';
      healthFinalAllowed = false;
      context.healthGeneration = healthGeneration;
      try {
        await prepare(false);
        await registerAndVerify();
        context.inboxState = await dependencies.loadInboxState(context);
        await dependencies.recoverTaskCreations(context);
        context.projectCatalog = await dependencies.warmProjectCatalog(context);
        context.taskIndex = await dependencies.loadTaskIndex(context);
        recordActivity('lastIndexUpdateAt');
        context.interactionHandler = await dependencies.createInteractionHandler(context);
        context.gateway = await dependencies.startGateway(context);
        context.setGatewayStatus(context.gateway?.getStatus?.() ?? { state: 'connecting' });
        context.legacyPollers = await dependencies.startLegacyPollers(context);
        started = true;
        healthLifecycle = 'running';
        context.startedAt = isoTimestamp(dependencies.now?.() ?? Date.now());
        await safePublishHealth();
        const setHealthInterval = dependencies.setInterval ?? globalThis.setInterval;
        healthTimer = setHealthInterval(() => { publishHealthSoon(); }, 10_000);
      } catch (error) {
        await cleanupFailedStart();
        throw error;
      }
    },
    async waitForLegacyCompletion() {
      await context.legacyPollers?.completion;
    },
    async stop() {
      if (stopPromise) return stopPromise;
      if (!started && !context.gateway && !context.legacyPollers && ['inactive', 'stopped'].includes(healthLifecycle)) return undefined;
      acceptingResources = false;
      context.isStopping = true;
      healthController?.abort();
      healthGeneration++;
      healthController = new AbortController();
      healthLifecycle = 'stopping';
      healthFinalAllowed = true;
      context.healthGeneration = healthGeneration;
      healthPublication = Promise.resolve();
      const clearHealthInterval = dependencies.clearInterval ?? globalThis.clearInterval;
      if (healthTimer !== null) {
        clearHealthInterval(healthTimer);
        healthTimer = null;
      }
      stopPromise = (async () => {
        const failures = [];
        const invoke = (category, operation) => {
          if (typeof operation !== 'function') return Promise.resolve();
          try {
            return Promise.resolve(operation()).catch(() => { failures.push(category); });
          } catch {
            failures.push(category);
            return Promise.resolve();
          }
        };

        const operations = [];
        operations.push(invoke('gateway-stop', () => context.gateway?.stop?.()));
        operations.push(invoke('legacy-pollers-stop', () => context.legacyPollers?.stop?.()));
        operations.push(invoke('task-index-persist', () => dependencies.persistTaskIndex?.(context)));
        operations.push(invoke('inbox-persist', () => dependencies.persistInboxState?.(context)));
        operations.push(invoke('rollout-persist', () => dependencies.persistRolloutState?.(context)));
        operations.push(waitForActiveResources());

        const timeoutMs = boundedShutdownTimeout(dependencies.shutdownTimeoutMs ?? 10_000);
        let timeoutId;
        const completed = await Promise.race([
          Promise.allSettled(operations).then(() => true),
          new Promise((resolve) => {
            timeoutId = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
        clearTimeout(timeoutId);
        if (!completed) {
          failures.push('deadline-exceeded');
          for (const resource of [...context.activeResources]) {
            releaseResource(resource);
            context.activeResources.delete(resource);
          }
          notifyIdle();
        }
        started = false;
        context.gatewayStatus = { state: 'stopped' };
        await safePublishHealth({ forceFinal: true });
        healthFinalAllowed = false;
        healthLifecycle = 'stopped';
        if (failures.length > 0) {
          throw new Error(`Discord bridge shutdown failed: ${[...new Set(failures)].join(',')}`);
        }
        return { status: 'stopped' };
      })();
      return stopPromise;
    },
  };
}

function mask(value, visible = 6) {
  const text = String(value ?? '');
  return text.length > visible ? `…${text.slice(-visible)}` : text;
}

const persistentLogCategories = new Set([
  'bridge-event', 'bridge-started', 'bridge-fatal', 'continuation-state-corrupt',
  'completion-watcher-started', 'rollout-poll-failed', 'rollout-state-save-failed',
  'queue-retry-failed', 'channel-poll-failed', 'index-refresh-failed', 'message-ignored',
  'message-guidance-sent',
  'bridge-health-write-failed',
  'turn-completed', 'turn-failed', 'turn-cancelled', 'turn-finished',
  'turn-completion-connection-lost', 'continuation-started', 'continuation-queued',
  'continuation-uncertain', 'continuation-failed', 'continuation-result',
]);

function stableLogId(value) {
  const candidate = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{6,128}$/u.test(candidate) ? mask(candidate, 8) : null;
}

export function formatPersistentLogEvent(category, fields = {}, at = new Date()) {
  const stableCategory = persistentLogCategories.has(String(category)) ? String(category) : 'bridge-event';
  const parts = [`${isoTimestamp(at)} event=${stableCategory}`];
  for (const [input, output] of [
    ['taskId', 'task'], ['threadId', 'thread'], ['turnId', 'turn'],
    ['requestId', 'request'], ['channelId', 'channel'], ['messageId', 'message'],
  ]) {
    const identifier = stableLogId(fields?.[input]);
    if (identifier) parts.push(`${output}=${identifier}`);
  }
  const exitCode = Number(fields?.exitCode);
  if (Number.isInteger(exitCode)) parts.push(`exitCode=${exitCode}`);
  const durationMs = Number(fields?.durationMs);
  if (Number.isFinite(durationMs) && durationMs >= 0) parts.push(`durationMs=${Math.floor(durationMs)}`);
  return parts.join(' ');
}

export async function writePersistentLogEvent({ filePath, category, fields = {}, now = () => new Date() }) {
  const timestamp = typeof now === 'function' ? now() : now;
  const line = `${formatPersistentLogEvent(category, fields, timestamp)}\n`;
  await fs.appendFile(filePath, line, 'utf8').catch(() => {});
}

async function log(category, fields = {}) {
  await writePersistentLogEvent({ filePath: logPath, category, fields });
}

function corruptBackupTimestamp(now) {
  return isoTimestamp(typeof now === 'function' ? now() : now).replaceAll(':', '-');
}

async function copyCorruptInboxBackup(inboxPath, now) {
  const parsed = path.parse(inboxPath);
  const timestamp = corruptBackupTimestamp(now);
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const discriminator = suffix === 0 ? '' : `-${suffix}`;
    const backupPath = path.join(parsed.dir, `${parsed.name}.corrupt-${timestamp}${discriminator}${parsed.ext || '.json'}`);
    try {
      await fs.copyFile(inboxPath, backupPath, fsConstants.COPYFILE_EXCL);
      return backupPath;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Discord continuation state backup limit exceeded');
}

/** Load and migrate durable continuation state without replaying a malformed file. */
export async function loadInboxStateWithRecovery({
  inboxPath,
  encryptText,
  persistState,
  writeLog = log,
  now = () => new Date(),
}) {
  let state;
  try {
    let raw;
    try {
      raw = await fs.readFile(inboxPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      state = createEmptyInboxState();
    }
    if (raw !== undefined) {
      try {
        state = JSON.parse(raw);
      } catch {
        const error = new Error('Discord continuation state is corrupt');
        error.code = 'CONTINUATION_STATE_CORRUPT';
        throw error;
      }
      if (state?.version === 2) assertValidInboxStateV2(state, { allowLegacyPlaintext: true });
      else assertValidLegacyInboxState(state);
    }
    await migrateLegacyPendingReplies({ state, encryptText });
    migrateInboxState(state);
    assertValidInboxStateV2(state);
    recoverContinuationAttempts(state);
    await commitInboxState({ state, persistState });
    return { state, readOnly: false, errorCategory: null };
  } catch (error) {
    if (error?.code !== 'CONTINUATION_STATE_CORRUPT') throw error;
    await copyCorruptInboxBackup(inboxPath, now);
    await writeLog('continuation-state-corrupt');
    return {
      state: createEmptyInboxState(),
      readOnly: true,
      errorCategory: 'continuation-state-corrupt',
    };
  }
}

function expandAbsoluteRoot(value) {
  const configured = String(value ?? '').trim();
  const expanded = expandPathVariables(configured, { environment: {
    ...process.env, USERPROFILE: process.env.USERPROFILE || os.homedir(), CODEX_HOME: codexRoot,
  } });
  if (!isAbsolutePath(expanded)) {
    throw new Error('Discord task creation root must be absolute');
  }
  return normalizePath(expanded);
}

export function validateConfig(config, { registrationOnly = false } = {}) {
  const required = registrationOnly ? [
    'discordApplicationId', 'discordGuildId', 'discordTokenPath',
  ] : [
    'discordApplicationId',
    'discordGuildId',
    'discordAllowedUserId',
    'discordTaskChannelId',
    'discordConfirmationChannelId',
    'discordQuotaChannelId',
    'discordTokenPath',
  ];
  for (const property of required) {
    if (!String(config[property] ?? '').trim()) throw new Error(`Missing Discord bridge config property: ${property}`);
  }
  if (registrationOnly) return;
  if (String(config.discordQuotaChannelId) === String(config.discordTaskChannelId) ||
      String(config.discordQuotaChannelId) === String(config.discordConfirmationChannelId)) {
    throw new Error('Quota channel must be separate from task channels');
  }
  config.discordProjectlessRoot = expandAbsoluteRoot(config.discordProjectlessRoot);
  config.discordWorktreeRoot = expandAbsoluteRoot(config.discordWorktreeRoot);
}

async function existingDirectory(candidate) {
  if (!candidate) return null;
  try {
    return (await fs.stat(candidate)).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

async function saveState(state) {
  await writeJsonAtomic(inboxStatePath, state);
}

function trackContinuationCompletion(started, request, token, trackActiveResource, sendReply = (payload) => sendDiscordReply({ token, ...payload })) {
  if (!started?.completion || typeof started.completion.then !== 'function') return;
  const tracked = started.completion
      .then(async (params) => {
        const status = String(params?.turn?.status ?? 'unknown');
        const category = ({
          completed: 'turn-completed',
          failed: 'turn-failed',
          cancelled: 'turn-cancelled',
          canceled: 'turn-cancelled',
        })[status] ?? 'turn-finished';
        await log(category, { threadId: request.threadId, turnId: started.turnId });
        if (status === 'failed' && request.source === 'reply') {
          await sendReply({
            token,
            channelId: request.channelId,
            replyToMessageId: request.replyToMessageId,
            content: '⚠️ Codex 已接收这条回复，但本轮执行失败。请打开原任务查看错误后再回复一次。',
          });
        }
      })
      .catch(async () => {
        await log('turn-completion-connection-lost', { threadId: request.threadId, turnId: started.turnId });
      })
  trackActiveResource?.({
    kind: 'continuation',
    completion: tracked,
    close: started.close,
    cancel: started.cancel,
  });
}

async function recordInboxMessageDurably(state, channelId, messageId, processed, persistState) {
  try {
    await commitInboxState({
      state,
      persistState,
      fields: ['cursors', 'processedMessageIds'],
      mutate: () => recordInboxMessage(state, String(channelId), String(messageId), processed),
      errorMessage: 'Inbox message persistence failed',
    });
  } catch {
    throw new Error('Inbox message persistence failed');
  }
}

export async function finalizeContinuationOutcome({
  result,
  state,
  request,
  token,
  persistState = saveState,
  sendReply = (payload) => sendDiscordReply({ token, ...payload }),
  transientFailureAcks: failureAcks = transientFailureAcks,
  now = Date.now,
}) {
  let durable = result?.status === 'started' || result?.status === 'queued' || result?.status === 'uncertain' ||
    !['state-persist-failed', 'encryption-unavailable'].includes(String(result?.reason ?? ''));
  if (request.source === 'reply' && durable) {
    try {
      await recordInboxMessageDurably(state, request.channelId, request.requestId, true, persistState);
    } catch {
      durable = false;
      result = { ...result, reason: 'state-persist-failed' };
    }
  }

  if (request.source === 'reply' && result?.status === 'uncertain' && durable) {
    await sendReply({
      channelId: request.channelId,
      replyToMessageId: request.replyToMessageId,
      content: '⚠️ Codex 启动结果不确定；为避免重复执行不会自动重试，请打开原任务确认实际状态。',
    }).catch(() => {});
  } else if (request.source === 'reply' && result?.status === 'failed' && durable) {
    await sendReply({
      channelId: request.channelId,
      replyToMessageId: request.replyToMessageId,
      content: '❌ 没有成功续接原 Codex 任务。不会新建任务；请确认 Codex 可正常打开后，再回复一次。',
    }).catch(() => {});
  } else if (request.source === 'reply' && !durable && result?.status === 'failed') {
    const requestId = String(request.requestId);
    const currentTime = Number(now());
    const lastAcknowledged = Number(failureAcks.get(requestId));
    if (!Number.isFinite(lastAcknowledged) || currentTime - lastAcknowledged >= pendingRetryIntervalMs) {
      const sent = await sendReply({
        channelId: request.channelId,
        replyToMessageId: request.replyToMessageId,
        content: '⚠️ 暂时无法安全保存这条续接请求；本频道已暂停后续处理，并会稍后重试。',
      }).then(() => true).catch(() => false);
      if (sent) failureAcks.set(requestId, currentTime);
    }
  }
  return { ...result, durable, stopChannelScan: !durable };
}

function taskStatusAcknowledgement(context, request, content) {
  return {
    content,
    components: [createTaskStatusRow(context, {
      threadId: request.threadId,
      userId: context.config.discordAllowedUserId,
      guildId: request.guildId ?? context.config.discordGuildId,
    })],
  };
}

async function startContinuation({
  token,
  config,
  state,
  request,
  trackActiveResource,
  takeoverClaimId,
  persistState = saveState,
  sendReply = (payload) => sendDiscordReply({ token, ...payload }),
  buildAcknowledgement,
  onActiveWriterQueued,
}) {
  const mappedCwd = await existingDirectory(String(request.cwd ?? ''));
  const input = { ...request, cwd: mappedCwd ?? undefined };
  const result = await dispatchContinuation(input, {
    state,
    codexPath: String(config.discordCodexPath ?? 'codex'),
    processCwd: mappedCwd ?? toolDir,
    encryptText: (text) => encryptPendingReplyText({ toolDir, powershellPath: config.discordPowerShellPath, text }),
    decryptText: (encryptedText) => decryptPendingReplyText({ toolDir, powershellPath: config.discordPowerShellPath, ciphertext: encryptedText }),
    persistState,
    takeoverClaimId,
    sendReply,
    buildAcknowledgement,
    steerCodexThread,
    trackCompletion: (started, normalized) => trackContinuationCompletion(
      started, normalized, token, trackActiveResource, sendReply,
    ),
  });
  const outcome = await finalizeContinuationOutcome({ result, state, request, token, sendReply });
  if (request.source === 'reply' && outcome.status === 'queued' && outcome.reason === 'active-writer') {
    await onActiveWriterQueued?.({ request: input, result: outcome }).catch(() => {});
  }
  const category = ({
    started: 'continuation-started',
    queued: 'continuation-queued',
    uncertain: 'continuation-uncertain',
    failed: 'continuation-failed',
  })[String(result?.status ?? '')] ?? 'continuation-result';
  await log(category, {
    requestId: request.requestId,
    threadId: request.threadId,
    turnId: result.turnId,
  });
  return outcome;
}

async function retryPendingTurns({ token, config, state, onRetry = () => {}, trackActiveResource, sendReply, buildAcknowledgement }) {
  const now = Date.now();
  for (const pending of listRetryableContinuations(state)) {
    const lastAttempt = Date.parse(String(pending.lastAttemptAt ?? ''));
    if (Number.isFinite(lastAttempt) && now - lastAttempt < pendingRetryIntervalMs) continue;
    await startContinuation({ token, config, state, request: pending, trackActiveResource, sendReply, buildAcknowledgement });
    onRetry();
  }
}

export async function pollChannel({
  token,
  config,
  state,
  channelId,
  getMessages = getDiscordMessagesAfter,
  readMapping = () => readJsonFile(mappingPath, { version: 1, messages: {} }),
  continueRequest = startContinuation,
  sendGuidance = (payload) => sendDiscordReply({ token, ...payload }),
  persistState = saveState,
  writeLog = log,
}) {
  let cursor = String(state.cursors[channelId] ?? '0');
  for (;;) {
    const messages = await getMessages({ token, channelId, after: cursor });
    if (messages.length === 0) return { status: 'complete' };

    for (const message of messages) {
      const mapping = await readMapping();
      const accepted = classifyReply(message, config, mapping, state);
      if (accepted.accepted) {
        const request = createContinuationRequest({
          source: 'reply',
          requestId: accepted.messageId,
          threadId: accepted.mapping.threadId,
          cwd: accepted.mapping.cwd,
          text: accepted.text,
          channelId: accepted.channelId,
          guildId: config.discordGuildId,
          replyToMessageId: accepted.messageId,
        });
        const outcome = await continueRequest({ token, config, state, request });
        if (outcome?.stopChannelScan) {
          return { status: 'stopped', requestId: request.requestId, reason: outcome.reason };
        }
      } else if (accepted.guidance) {
        await sendGuidance({
          channelId,
          replyToMessageId: String(message.id),
          content: '这条消息尚未发送到 Codex。请长按回复一条任务消息，或使用 `/继续任务` 选择任务。',
          nonce: String(message.id),
          enforceNonce: true,
        });
        await recordInboxMessageDurably(state, channelId, String(message.id), true, persistState);
        await writeLog('message-guidance-sent', { messageId: message.id, channelId });
      } else {
        await recordInboxMessageDurably(state, channelId, String(message.id), false, persistState);
        await writeLog('message-ignored', { messageId: message.id, channelId });
      }
      cursor = String(state.cursors[channelId]);
    }

    if (messages.length < 100) return { status: 'complete' };
  }
}

function commandRoute(config) {
  return `/applications/${encodeURIComponent(String(config.discordApplicationId))}/guilds/${encodeURIComponent(String(config.discordGuildId))}/commands`;
}

export async function getDiscordBotMember({ guildId, request }) {
  if (typeof request !== 'function') throw new TypeError('Discord request function is required');
  const bot = await request('/users/@me');
  const botId = String(bot?.id ?? '');
  if (!/^\d+$/u.test(botId)) throw new Error('Discord Bot identity is invalid');
  return request(`/guilds/${encodeURIComponent(String(guildId))}/members/${encodeURIComponent(botId)}`);
}

function rolloutProgressFingerprint(state) {
  const offsets = Object.entries(state?.files ?? {})
    .map(([filePath, item]) => `${filePath}:${Number(item?.offset ?? 0)}`)
    .sort();
  return `${offsets.join('|')}#${Object.keys(state?.pending ?? {}).sort().join('|')}`;
}

function replaceIndex(target, source) {
  target.version = source.version;
  target.generatedAt = source.generatedAt;
  target.tasks = source.tasks;
  return target;
}

export function createProductionBridgeDependencies({
  runOnce = false,
  buildTaskIndexImpl = buildTaskIndex,
  listActiveCodexThreadsImpl = listActiveCodexThreads,
  writeTaskIndexAtomicImpl = writeTaskIndexAtomic,
  runCodexControlActionImpl = runCodexControlAction,
  createInteractionRestClientImpl = createInteractionRestClient,
  createInteractionRouterImpl = createInteractionRouter,
  startContinuationImpl = startContinuation,
  sendDiscordReplyImpl = sendDiscordReply,
  persistInboxStateImpl = saveState,
  readRolloutWatcherStateImpl = readRolloutWatcherState,
  initializeRolloutWatcherStateImpl = initializeRolloutWatcherState,
  writeRolloutWatcherStateImpl = writeRolloutWatcherState,
  pollRolloutCompletionsImpl = pollRolloutCompletions,
  pollChannelImpl = pollChannel,
  logImpl = log,
} = {}) {
  let taskIndexCommitTail = Promise.resolve();
  const enqueueTaskIndexOperation = (operation) => {
    const current = taskIndexCommitTail.then(operation);
    taskIndexCommitTail = current.then(() => undefined, () => undefined);
    return current;
  };
  const rebuildTaskIndex = (context, {
    previousIndex = context.taskIndex,
    nowMs = Date.now(),
    installShared = true,
    recordActivity = true,
  } = {}) => enqueueTaskIndexOperation(async () => {
    const contextThreadId = previousIndex?.tasks?.[0]?.threadId ?? context.taskIndex?.tasks?.[0]?.threadId;
    let activeThreadIds;
    if (contextThreadId) {
      try {
        activeThreadIds = await listActiveCodexThreadsImpl({ threadId: contextThreadId });
      } catch {
        // Desktop tools are optional while the bridge runs headlessly; keep rollout-derived state on failure.
      }
    }
    const rebuilt = await buildTaskIndexImpl({
      sessionsRoot,
      sessionIndexPath,
      messageMapPath: mappingPath,
      previousIndex,
      discordWorktreeRoot: context.config.discordWorktreeRoot,
      projects: context.projectCatalog?.snapshot?.() ?? [],
      createdTasksByInteraction: context.inboxState?.createdTasksByInteraction ?? {},
      activeThreadIds,
      nowMs,
    });
    const stableSnapshot = structuredClone(rebuilt);
    if (installShared) replaceIndex(context.taskIndex, structuredClone(stableSnapshot));
    await writeTaskIndexAtomicImpl(taskIndexPath, stableSnapshot);
    if (recordActivity) context.recordActivity('lastIndexUpdateAt', stableSnapshot.generatedAt);
    return stableSnapshot;
  });
  const refreshTaskIndex = (context, options = {}) => rebuildTaskIndex(context, options);
  const persistCurrentTaskIndex = (context) => enqueueTaskIndexOperation(async () => {
    const stableSnapshot = structuredClone(context.taskIndex);
    await writeTaskIndexAtomicImpl(taskIndexPath, stableSnapshot);
    return stableSnapshot;
  });
  return {
    refreshTaskIndex,
    async loadConfig() {
      return readJsonFile(configPath);
    },
    validateConfig,
    async loadToken(context) {
      context.tokenPowerShellPath = await resolvePowerShellExecutable();
      return loadDiscordToken({ toolDir, powershellPath: context.tokenPowerShellPath });
    },
    async resolveExecutables(context) {
      const powershellPath = context.tokenPowerShellPath ?? await resolvePowerShellExecutable();
      const configuredCodexPath = process.env.CODEX_DISCORD_CODEX_PATH ?? context.config.discordCodexPath;
      const codexPath = await resolveCodexExecutable({ configuredPath: configuredCodexPath });
      context.config.discordCodexPath = codexPath;
      context.config.discordPowerShellPath = powershellPath;
      return { codexPath, powershellPath };
    },
    async registerCommands(context) {
      await registerGuildCommands({
        token: context.token,
        applicationId: context.config.discordApplicationId,
        guildId: context.config.discordGuildId,
      });
    },
    async fetchRegisteredCommands(context) {
      return discordRequest({ token: context.token, route: commandRoute(context.config) });
    },
    async loadTaskIndex(context) {
      const previousIndex = await readTaskIndex(taskIndexPath);
      return rebuildTaskIndex(context, {
        previousIndex,
        installShared: false,
        recordActivity: false,
      });
    },
    async loadInboxState(context) {
      const loaded = await loadInboxStateWithRecovery({
        inboxPath: inboxStatePath,
        encryptText: (text) => encryptPendingReplyText({
          toolDir,
          powershellPath: context.executables.powershellPath,
          text,
        }),
        persistState: persistInboxStateImpl,
      });
      context.inboxReadOnly = loaded.readOnly;
      if (loaded.errorCategory) context.setLatestErrorCategory(loaded.errorCategory);
      return loaded.state;
    },
    async recoverTaskCreations(context) {
      if (context.inboxReadOnly) return [];
      await recoverInterruptedTaskCreations({
        state: context.inboxState,
        worktreeRoot: context.config.discordWorktreeRoot,
        sessionsRoot,
        persistState: persistInboxStateImpl,
      });
    },
    async warmProjectCatalog(context) {
      const catalog = createProjectCatalog({
        loader: () => listCodexProjects({
          codexPath: context.executables.codexPath,
          processCwd: toolDir,
        }),
      });
      await catalog.warm();
      return catalog;
    },
    async createInteractionHandler(context) {
      context.uiState ??= new Map();
      const rest = createInteractionRestClientImpl({ applicationId: context.config.discordApplicationId });
      const readQuota = () => readJsonFile(quotaStatePath, { observedAt: null, limits: [] });
      const api = (route) => context.trackDiscordRest(() => discordRequest({ token: context.token, route }));
      const trackedReply = (payload) => context.trackDiscordRest(() => sendDiscordReplyImpl({
        token: context.token,
        ...payload,
      }));
      const continuePersistedRequest = (request, { takeoverClaimId } = {}) => startContinuationImpl({
        token: context.token,
        config: context.config,
        state: context.inboxState,
        request,
        takeoverClaimId,
        persistState: persistInboxStateImpl,
        trackActiveResource: context.trackActiveResource,
        sendReply: trackedReply,
        buildAcknowledgement: (request, content) => taskStatusAcknowledgement(context, request, content),
      });
      const healthDependencies = {
        config: context.config,
        loadToken: () => loadDiscordToken({ toolDir, powershellPath: context.executables.powershellPath }),
        getGatewayState: () => context.gateway?.getStatus?.() ?? context.gatewayStatus,
        getGuild: () => api(`/guilds/${encodeURIComponent(String(context.config.discordGuildId))}`),
        getMember: () => getDiscordBotMember({ guildId: context.config.discordGuildId, request: api }),
        getRoles: () => api(`/guilds/${encodeURIComponent(String(context.config.discordGuildId))}/roles`),
        getChannel: (channelId) => api(`/channels/${encodeURIComponent(String(channelId))}`),
        readTaskIndex: () => context.taskIndex,
        readContinuationState: () => context.inboxState,
        probeAtomicWrite: () => probeTemporaryAtomicWrite(),
        readQuotaState: readQuota,
        readRolloutWatcherState: () => context.rolloutState ?? {},
        powershellPath: context.executables.powershellPath,
        dispatcherPath: path.join(toolDir, 'dispatcher.ps1'),
      };
      const router = createInteractionRouterImpl({
        config: context.config,
        taskIndex: context.taskIndex,
        projectCatalog: context.projectCatalog,
        projectlessRoot: context.config.discordProjectlessRoot,
        worktreeRoot: context.config.discordWorktreeRoot,
        creationState: context.inboxState,
        continuationState: context.inboxState,
        persistCreationState: context.inboxReadOnly ? undefined : persistInboxStateImpl,
        persistContinuationState: context.inboxReadOnly ? undefined : persistInboxStateImpl,
        mutationDisabledCategory: context.inboxReadOnly ? 'continuation-state-corrupt' : null,
        uiState: context.uiState,
        codexPath: context.executables.codexPath,
        processCwd: toolDir,
        createNewTaskOnce: async (options) => {
          const result = await createNewTaskOnce(options);
          context.trackActiveResource({ kind: 'task-creation', ...result });
          if (['started', 'first-turn-failed'].includes(String(result?.status))) {
            context.recordActivity('lastTaskCreationAt');
          }
          return result;
        },
        recordCreationReceiptOutcome: (interactionId, outcome) => recordTaskCreationReceiptOutcome({
          state: context.inboxState,
          interactionId,
          status: outcome?.status,
          messageId: outcome?.messageId,
          errorCategory: outcome?.errorCategory,
          now: new Date(),
          persistState: persistInboxStateImpl,
        }),
        readTaskDetail,
        searchTasks,
        getQuotaState: readQuota,
        getSystemStatus: async () => ({
          ...context.getSystemStatus(),
          quota: await readQuota(),
        }),
        getQueue: () => listContinuations(context.inboxState),
        refreshTaskIndex: () => refreshTaskIndex(context),
        getCodexControlStatus: () => runCodexControlActionImpl({
          action: 'status',
          powershellPath: context.executables.powershellPath,
          controlPath,
        }),
        stopCodexDesktop: () => runCodexControlActionImpl({
          action: 'stop-codex',
          powershellPath: context.executables.powershellPath,
          controlPath,
        }),
        interruptTask: ({ threadId }) => interruptCodexThread({ threadId }),
        dispatchContinuation: async (request) => {
          try {
            return await continuePersistedRequest(request);
          } finally {
            context.publishHealth?.();
          }
        },
        claimContinuationTakeover: async ({ queueId, targetThreadId }) => {
          try {
            return await claimContinuationTakeover({
              state: context.inboxState,
              queueId,
              targetThreadId,
              persistState: persistInboxStateImpl,
            });
          } finally {
            context.publishHealth?.();
          }
        },
        releaseContinuationTakeoverClaim: async (claim) => {
          try {
            return await releaseContinuationTakeoverClaim({
              state: context.inboxState,
              claim,
              persistState: persistInboxStateImpl,
            });
          } finally {
            context.publishHealth?.();
          }
        },
        retryContinuation: async (claim) => {
          const item = listContinuations(context.inboxState).find((entry) =>
            entry.queueId === String(claim?.queueId ?? '') &&
            entry.threadId === String(claim?.targetThreadId ?? '') &&
            entry.status === 'takeover-claimed' &&
            entry.takeoverClaimId === String(claim?.claimId ?? ''));
          if (!item) return { status: 'failed', reason: 'not-found' };
          try {
            return await continuePersistedRequest(item, { takeoverClaimId: claim.claimId });
          } finally {
            context.publishHealth?.();
          }
        },
        cancelContinuationPersisted: async (queueId, now) => {
          try {
            return await cancelContinuationPersisted({
              state: context.inboxState,
              queueId,
              now,
              persistState: persistInboxStateImpl,
            });
          } finally {
            context.publishHealth?.();
          }
        },
        healthDependencies,
        respond: (body, interaction) => context.trackDiscordRest(() => rest.callback(interaction, body)),
        editOriginal: (body, interaction) => context.trackDiscordRest(() => rest.editOriginal(interaction, body)),
        followup: (body, interaction) => context.trackDiscordRest(() => rest.followup(interaction, body)),
      });
      return (interaction) => router.handle(interaction);
    },
    async startGateway(context) {
      const gateway = createGatewayClient({
        token: context.token,
        onInteraction: (interaction) => context.interactionHandler(interaction),
        onStatus: (status) => {
          context.setGatewayStatus(status);
        },
      });
      await gateway.start();
      return gateway;
    },
    async startLegacyPollers(context) {
      context.uiState ??= new Map();
      const config = context.config;
      const token = context.token;
      const state = context.inboxState;
      const trackedReply = (payload) => context.trackDiscordRest(() => sendDiscordReplyImpl({ token, ...payload }));
      let channelIds = discordReplyChannelIds(config, state);
      const rolloutState = await readRolloutWatcherStateImpl(rolloutWatcherStatePath, { sessionsRoot });
      context.rolloutState = rolloutState;
      if (!context.inboxReadOnly) {
        await initializeInboxCursors({
          state,
          channelIds,
          getLatest: (channelId) => context.trackDiscordRest(() => getLatestDiscordMessageId({ token, channelId })),
          persistState: persistInboxStateImpl,
        });
      }
      await initializeRolloutWatcherStateImpl({ sessionsRoot, state: rolloutState, inboxState: state });
      await writeRolloutWatcherStateImpl(rolloutWatcherStatePath, rolloutState);
      await logImpl('bridge-started');
      await logImpl('completion-watcher-started');

      let stopping = false;
      const wakes = new Set();
      let lastIndexRefresh = Date.now();
      const waitForNextPoll = () => new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          wakes.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, pollIntervalMs);
        wakes.add(finish);
      });
      const continueRequest = async (payload) => {
        try {
          return await startContinuation({
            ...payload,
            trackActiveResource: context.trackActiveResource,
            sendReply: trackedReply,
            buildAcknowledgement: (request, content) => taskStatusAcknowledgement(context, request, content),
            onActiveWriterQueued: async ({ request, result }) => {
              const inspection = await inspectQueuedTakeover({
                refreshTaskIndex: () => refreshTaskIndex(context),
                getCodexControlStatus: () => runCodexControlActionImpl({
                  action: 'status',
                  powershellPath: context.executables.powershellPath,
                  controlPath,
                }),
              }, request.threadId);
              if (!inspection.available) {
                await trackedReply({
                  channelId: request.channelId,
                  replyToMessageId: request.replyToMessageId,
                  ...inspection.payload,
                });
                return;
              }
              await publishContinuationTakeoverMessage({
                uiState: context.uiState,
                sendMessage: trackedReply,
              }, {
                queueId: result.queueId,
                targetThreadId: request.threadId,
                snapshot: inspection.snapshot,
                userId: context.config.discordAllowedUserId,
                guildId: context.config.discordGuildId,
                channelId: request.channelId,
                replyToMessageId: request.replyToMessageId,
              });
            },
          });
        } finally {
          context.publishHealth?.();
        }
      };
      const replyCompletion = (async () => {
        do {
          if (!context.inboxReadOnly) {
            channelIds = discordReplyChannelIds(config, state);
            const missingCursor = channelIds.some((channelId) => !Object.hasOwn(state.cursors, channelId));
            if (missingCursor) {
              await initializeInboxCursors({
                state,
                channelIds,
                getLatest: (channelId) => context.trackDiscordRest(() => getLatestDiscordMessageId({ token, channelId })),
                persistState: persistInboxStateImpl,
              });
            }
            for (const channelId of channelIds) {
              if (stopping) break;
              try {
                await pollChannelImpl({
                  token,
                  config,
                  state,
                  channelId,
                  getMessages: (options) => context.trackDiscordRest(() => getDiscordMessagesAfter(options)),
                  continueRequest,
                  sendGuidance: trackedReply,
                });
              } catch {
                context.setLatestErrorCategory('channel-poll-failed');
                await logImpl('channel-poll-failed', { channelId });
              }
            }
          }
          if (!runOnce && !stopping) await waitForNextPoll();
        } while (!runOnce && !stopping);
      })();
      const maintenanceCompletion = (async () => {
        do {
          const progressBefore = rolloutProgressFingerprint(rolloutState);
          try {
            await pollRolloutCompletionsImpl({
              sessionsRoot,
              state: rolloutState,
              inboxState: context.inboxReadOnly ? undefined : state,
              persistInboxState: context.inboxReadOnly ? undefined : persistInboxStateImpl,
              dispatchNotification: async (notification) => {
                await dispatchNotificationViaPowerShell({
                  notification,
                  toolDir,
                  powershellPath: context.executables.powershellPath,
                });
                context.recordActivity('lastNotificationSentAt');
              },
            });
            if (rolloutProgressFingerprint(rolloutState) !== progressBefore) {
              context.recordActivity('lastRolloutProgressAt');
              rolloutState.lastProgressAt = context.timestamps.lastRolloutProgressAt;
            }
          } catch {
              context.setLatestErrorCategory('rollout-poll-failed');
            await logImpl('rollout-poll-failed');
          } finally {
            await writeRolloutWatcherStateImpl(rolloutWatcherStatePath, rolloutState).catch(async () => {
              await logImpl('rollout-state-save-failed');
            });
          }
          if (!context.inboxReadOnly) {
            try {
              await retryPendingTurns({
                token,
                config,
                state,
                onRetry: () => context.recordActivity('lastQueueRetryAt'),
                trackActiveResource: context.trackActiveResource,
                sendReply: trackedReply,
                buildAcknowledgement: (request, content) => taskStatusAcknowledgement(context, request, content),
              });
            } catch {
              context.setLatestErrorCategory('queue-retry-failed');
              await log('queue-retry-failed');
            }
          }
          const now = Date.now();
          if (!stopping && now - lastIndexRefresh >= indexRefreshIntervalMs) {
            try {
              await refreshTaskIndex(context, { nowMs: now });
            } catch {
              context.setLatestErrorCategory('index-refresh-failed');
              await log('index-refresh-failed');
            }
            lastIndexRefresh = now;
          }
          if (!runOnce && !stopping) await waitForNextPoll();
        } while (!runOnce && !stopping);
      })();
      const completions = [replyCompletion, maintenanceCompletion];
      const completion = Promise.all(completions);
      return {
        completion,
        async stop() {
          stopping = true;
          for (const wake of [...wakes]) wake();
          const settled = await Promise.allSettled(completions);
          const failure = settled.find((item) => item.status === 'rejected');
          if (failure) throw failure.reason;
        },
      };
    },
    persistTaskIndex: persistCurrentTaskIndex,
    persistInboxState: (context) => context.inboxReadOnly ? undefined : persistInboxStateImpl(context.inboxState),
    persistRolloutState: (context) => writeRolloutWatcherState(rolloutWatcherStatePath, context.rolloutState),
    publishHealth: async (context, { signal, shouldCommit, forceFinal } = {}) => {
      const status = context.getSystemStatus();
      await writeBridgeHealthAtomic(bridgeHealthPath, {
        gateway: status.gateway,
        discordRest: status.discordRest,
        queueCount: status.queueCount,
        startedAt: context.startedAt,
        lastActivityAt: latestTimestamp(status.timestamps),
        latestEventCategory: status.latestErrorCategory,
      }, { signal, shouldCommit, bypassQueue: Boolean(forceFinal) });
    },
    logHealthFailure: (category) => log(category),
    invalidateHealth: () => fs.rm(bridgeHealthPath, { force: true }),
  };
}

async function main() {
  const runOnce = process.argv.includes('--once');
  const registerOnly = process.argv.includes('--register-commands');
  const app = createBridgeApplication(createProductionBridgeDependencies({ runOnce }));
  if (registerOnly) {
    if (!runOnce) throw new Error('--register-commands requires --once');
    const result = await app.registerCommandsOnce();
    process.stdout.write(`Verified ${result.commandNames.length} Guild commands.\n`);
    return;
  }

  let requestStop;
  const stopRequested = new Promise((resolve) => { requestStop = resolve; });
  const signalHandlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => requestStop();
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  try {
    await app.start();
    if (runOnce) await app.waitForLegacyCompletion();
    else await stopRequested;
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    await app.stop();
  }
}

const isBridgeEntryPoint = process.argv[1] &&
  path.resolve(process.argv[1]).toLocaleLowerCase() === fileURLToPath(import.meta.url).toLocaleLowerCase();
if (isBridgeEntryPoint) {
  main().catch(async () => {
    await log('bridge-fatal');
    process.exitCode = 1;
  });
}
