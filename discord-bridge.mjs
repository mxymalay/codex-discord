import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cancelContinuationPersisted,
  classifyReply,
  commitInboxState,
  createContinuationRequest,
  createEmptyInboxState,
  decryptPendingReplyText,
  discordRequest,
  encryptPendingReplyText,
  dispatchContinuation,
  getDiscordMessagesAfter,
  listRetryableContinuations,
  getLatestDiscordMessageId,
  initializeInboxCursors,
  listContinuations,
  loadDiscordToken,
  migrateLegacyPendingReplies,
  migrateInboxState,
  readJsonFile,
  recordInboxMessage,
  recoverContinuationAttempts,
  resolveCodexExecutable,
  resolvePowerShellExecutable,
  sendDiscordReply,
  writeJsonAtomic,
} from './discord-bridge-lib.mjs';
import { COMMAND_NAMES, registerGuildCommands } from './discord-commands-lib.mjs';
import { createGatewayClient } from './discord-gateway-lib.mjs';
import {
  createInteractionRestClient,
  createInteractionRouter,
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

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(toolDir, 'config.json');
const mappingPath = path.join(toolDir, 'discord-message-map.json');
const inboxStatePath = path.join(toolDir, 'discord-inbox-state.json');
const logPath = path.join(toolDir, 'discord-bridge.log');
const codexRoot = path.dirname(toolDir);
const sessionsRoot = path.join(codexRoot, 'sessions');
const rolloutWatcherStatePath = path.join(toolDir, 'rollout-watcher-state.json');
const taskIndexPath = path.join(toolDir, 'discord-task-index.json');
const quotaStatePath = path.join(toolDir, 'quota-state.json');
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

function exactCommandNames(commands) {
  const names = (Array.isArray(commands) ? commands : []).map((item) => String(item?.name ?? ''));
  if (names.length !== COMMAND_NAMES.length || names.some((name, index) => name !== COMMAND_NAMES[index])) {
    throw new Error('Guild command verification failed');
  }
  return names;
}

function boundedShutdownTimeout(value) {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) ? Math.max(0, Math.min(60_000, Math.floor(milliseconds))) : 10_000;
}

/** Compose the bridge lifecycle from injectable components. */
export function createBridgeApplication(dependencies = {}) {
  const context = {
    config: null,
    token: null,
    executables: null,
    taskIndex: null,
    inboxState: null,
    projectCatalog: null,
    interactionHandler: null,
    gateway: null,
    legacyPollers: null,
    gatewayStatus: { state: 'idle' },
    latestErrorCategory: null,
    activeResources: new Set(),
    timestamps: Object.fromEntries([...activityFields].map((field) => [field, null])),
  };
  let started = false;
  let prepared = false;
  let acceptingResources = true;
  let stopPromise = null;
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

  const recordActivity = (field, at = dependencies.now?.() ?? Date.now()) => {
    if (!activityFields.has(field)) throw new Error(`Unknown bridge activity field: ${field}`);
    context.timestamps[field] = isoTimestamp(at);
  };

  const getSystemStatus = () => ({
    gateway: context.gateway?.getStatus?.() ?? context.gatewayStatus,
    discordRest: {
      state: context.timestamps.lastRegistrationAt ? 'ok' : 'unknown',
      lastSuccessAt: context.timestamps.lastRegistrationAt,
    },
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

  async function prepare(registrationOnly) {
    if (prepared) return;
    context.config = await dependencies.loadConfig();
    await dependencies.validateConfig?.(context.config, { registrationOnly });
    context.token = await dependencies.loadToken(context);
    if (!registrationOnly) context.executables = await dependencies.resolveExecutables(context);
    prepared = true;
  }

  async function registerAndVerify() {
    await dependencies.registerCommands(context);
    const commands = await dependencies.fetchRegisteredCommands(context);
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
      stopPromise = null;
      await prepare(false);
      try {
        await registerAndVerify();
        context.taskIndex = await dependencies.loadTaskIndex(context);
        recordActivity('lastIndexUpdateAt');
        context.inboxState = await dependencies.loadInboxState(context);
        await dependencies.recoverTaskCreations(context);
        context.projectCatalog = await dependencies.warmProjectCatalog(context);
        context.interactionHandler = await dependencies.createInteractionHandler(context);
        context.gateway = await dependencies.startGateway(context);
        context.gatewayStatus = context.gateway?.getStatus?.() ?? { state: 'connecting' };
        context.legacyPollers = await dependencies.startLegacyPollers(context);
        started = true;
      } catch (error) {
        context.latestErrorCategory = 'startup-failed';
        await context.gateway?.stop?.().catch(() => {});
        throw error;
      }
    },
    async waitForLegacyCompletion() {
      await context.legacyPollers?.completion;
    },
    async stop() {
      if (stopPromise) return stopPromise;
      if (!started && !context.gateway && !context.legacyPollers) return undefined;
      acceptingResources = false;
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

async function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  await fs.appendFile(logPath, line, 'utf8').catch(() => {});
}

function expandAbsoluteRoot(value, token, environmentValue) {
  const configured = String(value ?? '').trim();
  const replacement = String(environmentValue ?? '').trim();
  if (!configured || (new RegExp(token, 'iu').test(configured) && !replacement)) {
    throw new Error('Discord task creation root is invalid');
  }
  const expanded = configured.replace(new RegExp(token, 'giu'), () => replacement);
  if (/%[^%]+%/u.test(expanded) || !path.win32.isAbsolute(expanded)) {
    throw new Error('Discord task creation root must be absolute');
  }
  return path.win32.normalize(expanded);
}

function validateConfig(config, { registrationOnly = false } = {}) {
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
  config.discordProjectlessRoot = expandAbsoluteRoot(
    config.discordProjectlessRoot, '%USERPROFILE%', process.env.USERPROFILE,
  );
  config.discordWorktreeRoot = expandAbsoluteRoot(
    config.discordWorktreeRoot, '%CODEX_HOME%', process.env.CODEX_HOME,
  );
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

function trackContinuationCompletion(started, request, token, trackActiveResource) {
  const tracked = started.completion
      .then(async (params) => {
        const status = String(params?.turn?.status ?? 'unknown');
        await log(`turn completed thread=${mask(request.threadId, 8)} turn=${mask(started.turnId, 8)} status=${status}`);
        if (status === 'failed' && request.source === 'reply') {
          await sendDiscordReply({
            token,
            channelId: request.channelId,
            replyToMessageId: request.replyToMessageId,
            content: '⚠️ Codex 已接收这条回复，但本轮执行失败。请打开原任务查看错误后再回复一次。',
          });
        }
      })
      .catch(async () => {
        await log(`turn completion connection lost thread=${mask(request.threadId, 8)} turn=${mask(started.turnId, 8)}`);
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

async function startContinuation({ token, config, state, request, trackActiveResource }) {
  const mappedCwd = await existingDirectory(String(request.cwd ?? ''));
  const input = { ...request, cwd: mappedCwd ?? undefined };
  const result = await dispatchContinuation(input, {
    state,
    codexPath: String(config.discordCodexPath ?? 'codex'),
    processCwd: mappedCwd ?? toolDir,
    encryptText: (text) => encryptPendingReplyText({ toolDir, powershellPath: config.discordPowerShellPath, text }),
    decryptText: (encryptedText) => decryptPendingReplyText({ toolDir, powershellPath: config.discordPowerShellPath, ciphertext: encryptedText }),
    persistState: saveState,
    sendReply: (payload) => sendDiscordReply({ token, ...payload }),
    trackCompletion: (started, normalized) => trackContinuationCompletion(
      started, normalized, token, trackActiveResource,
    ),
  });
  const outcome = await finalizeContinuationOutcome({ result, state, request, token });
  await log(`continuation ${result.status} source=${request.source} request=${mask(request.requestId)} thread=${mask(request.threadId, 8)} turn=${mask(result.turnId, 8)}`);
  return outcome;
}

async function retryPendingTurns({ token, config, state, onRetry = () => {}, trackActiveResource }) {
  const now = Date.now();
  for (const pending of listRetryableContinuations(state)) {
    const lastAttempt = Date.parse(String(pending.lastAttemptAt ?? ''));
    if (Number.isFinite(lastAttempt) && now - lastAttempt < pendingRetryIntervalMs) continue;
    await startContinuation({ token, config, state, request: pending, trackActiveResource });
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
          replyToMessageId: accepted.messageId,
        });
        const outcome = await continueRequest({ token, config, state, request });
        if (outcome?.stopChannelScan) {
          return { status: 'stopped', requestId: request.requestId, reason: outcome.reason };
        }
      } else {
        await recordInboxMessageDurably(state, channelId, String(message.id), false, persistState);
        await writeLog(`message ignored message=${mask(message.id)} channel=${mask(channelId)} reason=${accepted.reason}`);
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

function createProductionBridgeDependencies({ runOnce = false } = {}) {
  return {
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
      const index = await buildTaskIndex({
        sessionsRoot,
        sessionIndexPath,
        messageMapPath: mappingPath,
        previousIndex,
        discordWorktreeRoot: context.config.discordWorktreeRoot,
      });
      await writeTaskIndexAtomic(taskIndexPath, index);
      return index;
    },
    async loadInboxState(context) {
      const state = await readJsonFile(inboxStatePath, createEmptyInboxState());
      await migrateLegacyPendingReplies({
        state,
        encryptText: (text) => encryptPendingReplyText({
          toolDir,
          powershellPath: context.executables.powershellPath,
          text,
        }),
      });
      migrateInboxState(state);
      recoverContinuationAttempts(state);
      await commitInboxState({ state, persistState: saveState });
      return state;
    },
    async recoverTaskCreations(context) {
      await recoverInterruptedTaskCreations({
        state: context.inboxState,
        worktreeRoot: context.config.discordWorktreeRoot,
        persistState: saveState,
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
      const rest = createInteractionRestClient({ applicationId: context.config.discordApplicationId });
      const readQuota = () => readJsonFile(quotaStatePath, { observedAt: null, limits: [] });
      const api = (route) => discordRequest({ token: context.token, route });
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
      const router = createInteractionRouter({
        config: context.config,
        taskIndex: context.taskIndex,
        projectCatalog: context.projectCatalog,
        projectlessRoot: context.config.discordProjectlessRoot,
        worktreeRoot: context.config.discordWorktreeRoot,
        creationState: context.inboxState,
        continuationState: context.inboxState,
        persistCreationState: saveState,
        persistContinuationState: saveState,
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
        readTaskDetail,
        searchTasks,
        getQuotaState: readQuota,
        getSystemStatus: async () => ({
          ...context.getSystemStatus(),
          quota: await readQuota(),
        }),
        getQueue: () => listContinuations(context.inboxState),
        dispatchContinuation: (request) => startContinuation({
          token: context.token,
          config: context.config,
          state: context.inboxState,
          request,
          trackActiveResource: context.trackActiveResource,
        }),
        cancelContinuationPersisted: (queueId, now) => cancelContinuationPersisted({
          state: context.inboxState,
          queueId,
          now,
          persistState: saveState,
        }),
        healthDependencies,
        respond: (body, interaction) => rest.callback(interaction, body),
        editOriginal: (body, interaction) => rest.editOriginal(interaction, body),
      });
      return (interaction) => router.handle(interaction);
    },
    async startGateway(context) {
      const gateway = createGatewayClient({
        token: context.token,
        onInteraction: (interaction) => context.interactionHandler(interaction),
        onStatus: (status) => {
          context.gatewayStatus = status;
          if (status?.lastEventAt != null) context.recordActivity('lastGatewayEventAt', status.lastEventAt);
          if (status?.lastError) context.latestErrorCategory = status.lastError;
        },
      });
      await gateway.start();
      return gateway;
    },
    async startLegacyPollers(context) {
      const config = context.config;
      const token = context.token;
      const state = context.inboxState;
      const channelIds = [String(config.discordTaskChannelId), String(config.discordConfirmationChannelId)];
      const rolloutState = await readRolloutWatcherState(rolloutWatcherStatePath, { sessionsRoot });
      context.rolloutState = rolloutState;
      await initializeInboxCursors({
        state,
        channelIds,
        getLatest: (channelId) => getLatestDiscordMessageId({ token, channelId }),
      });
      await commitInboxState({ state, persistState: saveState });
      await initializeRolloutWatcherState({ sessionsRoot, state: rolloutState });
      await writeRolloutWatcherState(rolloutWatcherStatePath, rolloutState);
      await log(`bridge started channels=${channelIds.map((id) => mask(id)).join(',')} codex=${path.basename(config.discordCodexPath)}`);
      await log(`completion watcher started files=${Object.keys(rolloutState.files).length}`);

      let stopping = false;
      let wake = null;
      let lastIndexRefresh = Date.now();
      const waitForNextPoll = () => new Promise((resolve) => {
        const timer = setTimeout(() => { wake = null; resolve(); }, pollIntervalMs);
        wake = () => { clearTimeout(timer); wake = null; resolve(); };
      });
      const completion = (async () => {
        do {
          const progressBefore = rolloutProgressFingerprint(rolloutState);
          try {
            await pollRolloutCompletions({
              sessionsRoot,
              state: rolloutState,
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
          } catch (error) {
            context.latestErrorCategory = 'rollout-poll-failed';
            await log(`completion watcher poll failed error=${error?.message ?? 'unknown'}`);
          } finally {
            await writeRolloutWatcherState(rolloutWatcherStatePath, rolloutState).catch(async (error) => {
              await log(`completion watcher state save failed error=${error?.message ?? 'unknown'}`);
            });
          }
          try {
            await retryPendingTurns({
              token,
              config,
              state,
              onRetry: () => context.recordActivity('lastQueueRetryAt'),
              trackActiveResource: context.trackActiveResource,
            });
          } catch (error) {
            context.latestErrorCategory = 'queue-retry-failed';
            await log(`pending retry failed error=${error?.message ?? 'unknown'}`);
          }
          for (const channelId of channelIds) {
            if (stopping) break;
            try {
              await pollChannel({
                token,
                config,
                state,
                channelId,
                continueRequest: (payload) => startContinuation({
                  ...payload,
                  trackActiveResource: context.trackActiveResource,
                }),
              });
            } catch (error) {
              context.latestErrorCategory = 'channel-poll-failed';
              await log(`poll failed channel=${mask(channelId)} error=${error?.message ?? 'unknown'}`);
            }
          }
          const now = Date.now();
          if (!stopping && now - lastIndexRefresh >= indexRefreshIntervalMs) {
            try {
              const rebuilt = await buildTaskIndex({
                sessionsRoot,
                sessionIndexPath,
                messageMapPath: mappingPath,
                previousIndex: context.taskIndex,
                discordWorktreeRoot: config.discordWorktreeRoot,
                nowMs: now,
              });
              replaceIndex(context.taskIndex, rebuilt);
              await writeTaskIndexAtomic(taskIndexPath, context.taskIndex);
              context.recordActivity('lastIndexUpdateAt', rebuilt.generatedAt);
            } catch (error) {
              context.latestErrorCategory = 'index-refresh-failed';
              await log(`task index refresh failed error=${error?.message ?? 'unknown'}`);
            }
            lastIndexRefresh = now;
          }
          if (!runOnce && !stopping) await waitForNextPoll();
        } while (!runOnce && !stopping);
      })();
      return {
        completion,
        async stop() {
          stopping = true;
          wake?.();
          await completion;
        },
      };
    },
    persistTaskIndex: (context) => writeTaskIndexAtomic(taskIndexPath, context.taskIndex),
    persistInboxState: (context) => saveState(context.inboxState),
    persistRolloutState: (context) => writeRolloutWatcherState(rolloutWatcherStatePath, context.rolloutState),
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
  main().catch(async (error) => {
    await log(`bridge fatal error=${error?.message ?? 'unknown'}`);
    process.exitCode = 1;
  });
}
