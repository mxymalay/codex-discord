import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyReply,
  createEmptyInboxState,
  enqueuePendingReply,
  getDiscordMessagesAfter,
  getPendingReplies,
  getLatestDiscordMessageId,
  initializeInboxCursors,
  isActiveWriterError,
  loadDiscordToken,
  readJsonFile,
  recordInboxMessage,
  removePendingReply,
  resolveCodexExecutable,
  resolvePowerShellExecutable,
  resumeCodexThread,
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

async function startMappedTurn({ token, config, state, accepted }) {
  const mappedCwd = await existingDirectory(String(accepted.mapping.cwd ?? ''));
  const wasPending = Boolean(state.pendingReplies?.[String(accepted.messageId)]);
  try {
    const started = await resumeCodexThread({
      threadId: String(accepted.mapping.threadId),
      cwd: mappedCwd ?? undefined,
      processCwd: mappedCwd ?? toolDir,
      text: accepted.text,
      codexPath: String(config.discordCodexPath ?? 'codex'),
    });

    removePendingReply(state, accepted.messageId);
    recordInboxMessage(state, accepted.channelId, accepted.messageId, true);
    await saveState(state);
    await sendDiscordReply({
      token,
      channelId: accepted.channelId,
      replyToMessageId: accepted.messageId,
      content: `${wasPending ? '✅ 排队回复现已送达' : '✅ 已送达'}原 Codex 任务（${mask(accepted.mapping.threadId, 8)}），已开始继续执行。`,
    });
    await log(`turn accepted message=${mask(accepted.messageId)} thread=${mask(accepted.mapping.threadId, 8)} turn=${mask(started.turnId, 8)}`);

    const tracked = started.completion
      .then(async (params) => {
        const status = String(params?.turn?.status ?? 'unknown');
        await log(`turn completed thread=${mask(accepted.mapping.threadId, 8)} turn=${mask(started.turnId, 8)} status=${status}`);
        if (status === 'failed') {
          await sendDiscordReply({
            token,
            channelId: accepted.channelId,
            replyToMessageId: accepted.messageId,
            content: '⚠️ Codex 已接收这条回复，但本轮执行失败。请打开原任务查看错误后再回复一次。',
          });
        }
      })
      .catch(async () => {
        await log(`turn completion connection lost thread=${mask(accepted.mapping.threadId, 8)} turn=${mask(started.turnId, 8)}`);
      })
      .finally(() => activeTurns.delete(tracked));
    activeTurns.add(tracked);
    return 'started';
  } catch (error) {
    if (isActiveWriterError(error)) {
      const attemptedAt = new Date().toISOString();
      enqueuePendingReply(state, accepted, attemptedAt);
      recordInboxMessage(state, accepted.channelId, accepted.messageId, true);
      await saveState(state);
      await log(`turn queued message=${mask(accepted.messageId)} thread=${mask(accepted.mapping.threadId, 8)} active-writer=true`);
      if (!wasPending) {
        await sendDiscordReply({
          token,
          channelId: accepted.channelId,
          replyToMessageId: accepted.messageId,
          content: '⏳ 已排队：原 Codex 任务目前正被桌面端占用；任务释放后会自动送达，无需再次回复。',
        }).catch(() => {});
      }
      return 'queued';
    }

    removePendingReply(state, accepted.messageId);
    recordInboxMessage(state, accepted.channelId, accepted.messageId, true);
    await saveState(state);
    await log(`turn rejected message=${mask(accepted.messageId)} thread=${mask(accepted.mapping.threadId, 8)} error=${error?.message ?? 'unknown'}`);
    await sendDiscordReply({
      token,
      channelId: accepted.channelId,
      replyToMessageId: accepted.messageId,
      content: '❌ 没有成功续接原 Codex 任务。不会新建任务；请确认 Codex 可正常打开后，再回复一次。',
    }).catch(() => {});
    return 'failed';
  }
}

async function retryPendingTurns({ token, config, state }) {
  const now = Date.now();
  for (const pending of getPendingReplies(state)) {
    const lastAttempt = Date.parse(String(pending.lastAttemptAt ?? ''));
    if (Number.isFinite(lastAttempt) && now - lastAttempt < pendingRetryIntervalMs) continue;
    await startMappedTurn({ token, config, state, accepted: pending });
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
        await startMappedTurn({ token, config, state, accepted });
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
  const rolloutState = await readRolloutWatcherState(rolloutWatcherStatePath);

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
