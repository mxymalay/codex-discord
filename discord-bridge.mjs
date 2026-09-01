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
  listContinuations,
  getLatestDiscordMessageId,
  initializeInboxCursors,
  loadDiscordToken,
  migrateLegacyPendingReplies,
  migrateInboxState,
  readJsonFile,
  recordInboxMessage,
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
  if (request.source === 'reply') {
    recordInboxMessage(state, request.channelId, request.requestId, true);
    await saveState(state);
  }
  await log(`continuation ${result.status} source=${request.source} request=${mask(request.requestId)} thread=${mask(request.threadId, 8)} turn=${mask(result.turnId, 8)}`);
  if (result.status === 'failed' && request.source === 'reply') {
    await sendDiscordReply({
      token,
      channelId: request.channelId,
      replyToMessageId: request.replyToMessageId,
      content: '❌ 没有成功续接原 Codex 任务。不会新建任务；请确认 Codex 可正常打开后，再回复一次。',
    }).catch(() => {});
  }
  return result;
}

async function retryPendingTurns({ token, config, state }) {
  const now = Date.now();
  for (const pending of listContinuations(state).filter((item) => item.status === 'queued')) {
    const lastAttempt = Date.parse(String(pending.lastAttemptAt ?? ''));
    if (Number.isFinite(lastAttempt) && now - lastAttempt < pendingRetryIntervalMs) continue;
    await startContinuation({ token, config, state, request: pending });
  }
}

async function pollChannel({ token, config, state, channelId }) {
  let cursor = String(state.cursors[channelId] ?? '0');
  for (;;) {
    const messages = await getDiscordMessagesAfter({ token, channelId, after: cursor });
    if (messages.length === 0) return;

    for (const message of messages) {
      const mapping = await readJsonFile(mappingPath, { version: 1, messages: {} });
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
        await startContinuation({ token, config, state, request });
      } else {
        recordInboxMessage(state, channelId, String(message.id), false);
        await saveState(state);
        await log(`message ignored message=${mask(message.id)} channel=${mask(channelId)} reason=${accepted.reason}`);
      }
      cursor = String(state.cursors[channelId]);
    }

    if (messages.length < 100) return;
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

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
  });
}

main().catch(async (error) => {
  await log(`bridge fatal error=${error?.message ?? 'unknown'}`);
  process.exitCode = 1;
});
