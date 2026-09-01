import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyReply,
  createContinuationRequest,
  createEmptyInboxState,
  decryptPendingReplyText,
  encryptPendingReplyText,
  dispatchContinuation,
  getDiscordMessagesAfter,
  listRetryableContinuations,
  getLatestDiscordMessageId,
  initializeInboxCursors,
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
const pollIntervalMs = 4000;
const pendingRetryIntervalMs = 30_000;
const runOnce = process.argv.includes('--once');
const activeTurns = new Set();
const transientFailureAcks = new Map();
let stopping = false;

function mask(value, visible = 6) {
  const text = String(value ?? '');
  return text.length > visible ? `…${text.slice(-visible)}` : text;
}

async function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  await fs.appendFile(logPath, line, 'utf8').catch(() => {});
}

function validateConfig(config) {
  const required = [
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
  if (String(config.discordQuotaChannelId) === String(config.discordTaskChannelId) ||
      String(config.discordQuotaChannelId) === String(config.discordConfirmationChannelId)) {
    throw new Error('Quota channel must be separate from task channels');
  }
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

function trackContinuationCompletion(started, request, token) {
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
      .finally(() => activeTurns.delete(tracked));
  activeTurns.add(tracked);
}

function restoreInboxState(state, snapshot) {
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, structuredClone(snapshot));
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
    const snapshot = structuredClone(state);
    recordInboxMessage(state, request.channelId, request.requestId, true);
    try {
      await persistState(state);
    } catch {
      restoreInboxState(state, snapshot);
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

async function startContinuation({ token, config, state, request }) {
  const mappedCwd = await existingDirectory(String(request.cwd ?? ''));
  const input = { ...request, cwd: mappedCwd ?? undefined };
  const result = await dispatchContinuation(input, {
    state,
    codexPath: String(config.discordCodexPath ?? 'codex'),
    processCwd: mappedCwd ?? toolDir,
    encryptText: (text) => encryptPendingReplyText({ toolDir, text }),
    decryptText: (encryptedText) => decryptPendingReplyText({ toolDir, ciphertext: encryptedText }),
    persistState: saveState,
    sendReply: (payload) => sendDiscordReply({ token, ...payload }),
    trackCompletion: (started, normalized) => trackContinuationCompletion(started, normalized, token),
  });
  const outcome = await finalizeContinuationOutcome({ result, state, request, token });
  await log(`continuation ${result.status} source=${request.source} request=${mask(request.requestId)} thread=${mask(request.threadId, 8)} turn=${mask(result.turnId, 8)}`);
  return outcome;
}

async function retryPendingTurns({ token, config, state }) {
  const now = Date.now();
  for (const pending of listRetryableContinuations(state)) {
    const lastAttempt = Date.parse(String(pending.lastAttemptAt ?? ''));
    if (Number.isFinite(lastAttempt) && now - lastAttempt < pendingRetryIntervalMs) continue;
    await startContinuation({ token, config, state, request: pending });
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
        recordInboxMessage(state, channelId, String(message.id), false);
        await persistState(state);
        await writeLog(`message ignored message=${mask(message.id)} channel=${mask(channelId)} reason=${accepted.reason}`);
      }
      cursor = String(state.cursors[channelId]);
    }

    if (messages.length < 100) return { status: 'complete' };
  }
}

async function main() {
  const config = await readJsonFile(configPath);
  validateConfig(config);
  config.discordCodexPath = await resolveCodexExecutable({ configuredPath: config.discordCodexPath });
  const powershellPath = await resolvePowerShellExecutable();
  const token = await loadDiscordToken({ toolDir });
  const channelIds = [String(config.discordTaskChannelId), String(config.discordConfirmationChannelId)];
  const state = await readJsonFile(inboxStatePath, createEmptyInboxState());
  await migrateLegacyPendingReplies({ state, encryptText: (text) => encryptPendingReplyText({ toolDir, text }) });
  migrateInboxState(state);
  recoverContinuationAttempts(state);
  const rolloutState = await readRolloutWatcherState(rolloutWatcherStatePath, { sessionsRoot });

  await initializeInboxCursors({
    state,
    channelIds,
    getLatest: (channelId) => getLatestDiscordMessageId({ token, channelId }),
  });
  await saveState(state);
  await initializeRolloutWatcherState({ sessionsRoot, state: rolloutState });
  await writeRolloutWatcherState(rolloutWatcherStatePath, rolloutState);
  await log(`bridge started channels=${channelIds.map((id) => mask(id)).join(',')} codex=${path.basename(config.discordCodexPath)}`);
  await log(`completion watcher started files=${Object.keys(rolloutState.files).length}`);

  while (!stopping) {
    try {
      await pollRolloutCompletions({
        sessionsRoot,
        state: rolloutState,
        dispatchNotification: (notification) => dispatchNotificationViaPowerShell({
          notification,
          toolDir,
          powershellPath,
        }),
      });
    } catch (error) {
      await log(`completion watcher poll failed error=${error?.message ?? 'unknown'}`);
    } finally {
      await writeRolloutWatcherState(rolloutWatcherStatePath, rolloutState).catch(async (error) => {
        await log(`completion watcher state save failed error=${error?.message ?? 'unknown'}`);
      });
    }
    try {
      await retryPendingTurns({ token, config, state });
    } catch (error) {
      await log(`pending retry failed error=${error?.message ?? 'unknown'}`);
    }
    for (const channelId of channelIds) {
      if (stopping) break;
      try {
        await pollChannel({ token, config, state, channelId });
      } catch (error) {
        await log(`poll failed channel=${mask(channelId)} error=${error?.message ?? 'unknown'}`);
      }
    }
    if (runOnce) break;
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  await Promise.allSettled([...activeTurns]);
}

const isBridgeEntryPoint = process.argv[1] &&
  path.resolve(process.argv[1]).toLocaleLowerCase() === fileURLToPath(import.meta.url).toLocaleLowerCase();
if (isBridgeEntryPoint) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopping = true;
    });
  }

  main().catch(async (error) => {
    await log(`bridge fatal error=${error?.message ?? 'unknown'}`);
    process.exitCode = 1;
  });
}
