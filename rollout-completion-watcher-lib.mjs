import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getUserAuthoredMessageText } from './discord-task-index-lib.mjs';

import {
  advanceDiscordTurnOrigin,
  enrichDiscordOriginNotification,
  prepareDiscordOriginProgressDelivery,
  prepareDiscordOriginTerminalDelivery,
  resolveDiscordOrigin,
} from './discord-bridge-lib.mjs';

const stateVersion = 2;
const maxMessageChars = 50_000;
const maxInputMessages = 12;
const metadataReadBytes = 512 * 1024;
const recentTailBytes = 8 * 1024 * 1024;
const recentContextWindowMs = 24 * 60 * 60 * 1000;
const maxProgressLineBytes = 256 * 1024;
const maxNotificationLineBytes = 8 * 1024 * 1024;
const maxProgressChars = 1_400;
const originPollQueues = new WeakMap();

export function createEmptyRolloutWatcherState() {
  return { version: stateVersion, initialized: false, files: {}, pending: {} };
}

export async function readRolloutWatcherState(statePath, { sessionsRoot } = {}) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (state?.version === 1 && typeof state.files === 'object') {
      const files = Object.fromEntries(Object.entries(state.files).map(([filePath, fileState]) => [filePath, {
        offset: Number(fileState?.offset ?? 0),
        threadId: String(fileState?.threadId ?? ''),
        cwd: String(fileState?.cwd ?? ''),
        activeTurnId: String(fileState?.activeTurnId ?? ''),
      }]));
      const migrated = { version: stateVersion, initialized: Boolean(state.initialized), files, pending: {} };
      for (const [turnId, item] of Object.entries(state.pending ?? {})) {
        const threadId = String(item?.notification?.['thread-id'] ?? '');
        const cwd = String(item?.notification?.cwd ?? '');
        const candidates = sessionsRoot ? await listRolloutFiles(sessionsRoot) : Object.keys(files);
        const matches = [];
        for (const rolloutPath of candidates) {
          let entries;
          try { entries = parseLines(Buffer.from(await fs.readFile(rolloutPath, 'utf8'))); } catch { continue; }
          const metadata = entries.find((entry) => entry?.type === 'session_meta');
          const complete = entries.find((entry) => entry?.type === 'event_msg' && entry.payload?.type === 'task_complete' && String(entry.payload?.turn_id ?? '') === String(turnId));
          if (complete && rootSessionMeta(metadata, threadId)) {
            matches.push(rolloutPath);
          }
        }
        if (matches.length === 1) {
          migrated.pending[turnId] = { completedAtMs: Number(item?.completedAtMs ?? Date.now()), lastAttemptAtMs: Number(item?.lastAttemptAtMs ?? 0), rolloutPath: matches[0], threadId, cwd };
        }
      }
      return migrated;
    }
    if (state?.version !== stateVersion || typeof state.files !== 'object' || typeof state.pending !== 'object') {
      throw new Error('invalid rollout watcher state');
    }
    return state;
  } catch (error) {
    if (error?.code === 'ENOENT') return createEmptyRolloutWatcherState();
    throw error;
  }
}

export async function writeRolloutWatcherState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temporaryPath, statePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function listRolloutFiles(root) {
  const result = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) result.push(path.resolve(candidate));
    }
  }
  await visit(root);
  return result;
}

function boundedText(value) {
  const text = String(value ?? '');
  if (text.length <= maxMessageChars) return text;
  return `${text.slice(0, 10_000)}\n…内容过长，已省略中间部分…\n${text.slice(-39_970)}`;
}

function parseLines(buffer, { dropFirstPartial = false } = {}) {
  let content = buffer;
  if (dropFirstPartial) {
    const firstNewline = content.indexOf(0x0a);
    if (firstNewline < 0) return [];
    content = content.subarray(firstNewline + 1);
  }
  return content.toString('utf8').split('\n').filter((line) => line.trim()).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function parseLinesWithOffsets(buffer) {
  const entries = [];
  let start = 0;
  for (;;) {
    const newline = buffer.indexOf(0x0a, start);
    if (newline < 0) break;
    const end = newline + 1;
    const raw = buffer.subarray(start, newline > start && buffer[newline - 1] === 0x0d ? newline - 1 : newline);
    if (raw.length > 0 && raw.length <= maxProgressLineBytes) {
      try { entries.push({ entry: JSON.parse(raw.toString('utf8')), start, end }); } catch {}
    }
    start = end;
  }
  return { entries, completeEnd: start };
}

async function scanJsonLines(filePath, visit, { maxLineBytes = maxNotificationLineBytes, onSkippedLine } = {}) {
  const handle = await fs.open(filePath, 'r');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let fileOffset = 0;
  let pending = Buffer.alloc(0);
  let pendingStart = 0;
  let dropping = false;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      let segmentStart = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, segmentStart);
        if (newline < 0) break;
        const end = fileOffset + newline + 1;
        if (dropping) {
          dropping = false;
        } else {
          const segment = chunk.subarray(segmentStart, newline);
          const raw = pending.length ? Buffer.concat([pending, segment]) : segment;
          if (raw.length > 0 && raw.length <= maxLineBytes) {
            const line = raw[raw.length - 1] === 0x0d ? raw.subarray(0, -1) : raw;
            try {
              if (visit(JSON.parse(line.toString('utf8')), { start: pendingStart, end }) === false) return;
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
              onSkippedLine?.();
            }
          } else if (raw.length > maxLineBytes) {
            onSkippedLine?.();
          }
        }
        pending = Buffer.alloc(0);
        segmentStart = newline + 1;
        pendingStart = end;
      }
      if (!dropping && segmentStart < chunk.length) {
        const remainder = chunk.subarray(segmentStart);
        if (pending.length + remainder.length > maxLineBytes) {
          pending = Buffer.alloc(0);
          dropping = true;
          onSkippedLine?.();
        } else {
          pending = pending.length ? Buffer.concat([pending, remainder]) : Buffer.from(remainder);
        }
      }
      fileOffset += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

function rootSessionMeta(entry, threadId) {
  if (entry?.type !== 'session_meta' || String(entry.payload?.id ?? '') !== String(threadId)) return false;
  const payload = entry.payload ?? {};
  const source = String(payload.thread_source ?? '').trim().toLocaleLowerCase();
  if (source && source !== 'user') return false;
  if (String(payload.parent_thread_id ?? '').trim()) return false;
  const sessionId = String(payload.session_id ?? '').trim();
  if (sessionId && sessionId !== String(threadId)) return false;
  return !(payload.source && typeof payload.source === 'object' && Object.entries(payload.source).some(
    ([key, value]) => key.toLocaleLowerCase() === 'subagent' && value != null,
  ));
}

function exactMetadataTurn(payload, turnId) {
  return String(payload?.internal_chat_message_metadata_passthrough?.turn_id ?? '') === String(turnId);
}

function outputText(payload) {
  return (Array.isArray(payload?.content) ? payload.content : [])
    .filter((item) => item?.type === 'output_text' && typeof item?.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function sanitizeProgressText(value) {
  let text = String(value ?? '').replace(/\r\n?/gu, '\n').trim();
  const suspicious = [
    /```|`/u,
    /https?:\/\/|\[[^\]\r\n]+\]\([^\r\n)]+\)|<https?:/iu,
    /[A-Za-z]:[\\/]/u,
    /\\\\[^\s\\]+\\/u,
    /\/(?!\/)[A-Za-z0-9._~-]/u,
    /\b(?:authorization|bearer|api[_ -]?key|access[_ -]?token|password|passwd|secret)\b/iu,
    /--(?:password|passwd|token|secret|api[-_]?key)\b/iu,
    /\bAKIA[A-Z0-9]{16}\b/u,
    /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/iu,
    /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b/u,
    /\b(?:curl|wget|node|python|git|npm|pnpm|yarn|pwsh|powershell|cmd|bash|sh|rm|cp|mv|Get-[A-Za-z]+)\b/iu,
    /\b(?:const|let|var|function|class|import|export|def)\b|=>|\bprocess\.env\b/iu,
  ];
  if (suspicious.some((pattern) => pattern.test(text))) {
    return '正在处理任务（详细进度包含本机或敏感内容，已隐藏）。';
  }
  text = text.replace(/@/gu, '＠').replace(/^\s*([#>|])/gmu, '\\$1');
  text = text.replace(/\n{3,}/gu, '\n\n').trim();
  if (!text) return '';
  return text.length <= maxProgressChars ? text : `${text.slice(0, maxProgressChars - 1)}…`;
}

function eventIdentifier({ fingerprint, turnId, kind, lineStart, lineEnd, semantic = '' }) {
  return createHash('sha256')
    .update(`${fingerprint}\0${turnId}\0${kind}\0${lineStart}\0${lineEnd}\0${semantic}`, 'utf8')
    .digest('hex');
}

function discordNonce(eventId) {
  return BigInt(`0x${String(eventId).slice(0, 16)}`).toString(10).slice(0, 25);
}

function safeHeading(value, fallback) {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/@/gu, '＠')
    .replace(/[*_`#>|~[\]{}()\\]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return (text || fallback).slice(0, 180);
}

function workspaceLeaf(value) {
  const candidate = String(value ?? '').trim();
  if (!candidate) return '';
  return candidate.includes('\\') ? path.win32.basename(candidate) : path.posix.basename(candidate);
}

function elapsedText(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes} 分 ${seconds} 秒`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} 小时 ${minutes} 分`;
}

function turnSupport(entries, turnId) {
  let model = '';
  let effort = '';
  for (const item of entries) {
    const entry = item?.entry ?? item;
    if (entry?.type !== 'turn_context' || String(entry.payload?.turn_id ?? '') !== String(turnId)) continue;
    model = String(entry.payload?.model ?? model).trim();
    effort = String(entry.payload?.effort ?? entry.payload?.reasoning_effort ?? effort).trim();
  }
  return { model, effort };
}

export function supportText({ model, effort } = {}) {
  if (!model || !effort) return '';
  const modelName = model.replace(/^gpt-/iu, '').split('-')
    .map((part) => /^\d/u.test(part) ? part : `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1)}`)
    .join(' ');
  const effortName = ({ xhigh: 'XHigh' })[effort.toLocaleLowerCase()] ??
    `${effort.slice(0, 1).toLocaleUpperCase()}${effort.slice(1)}`;
  return `由 ${modelName} ${effortName} 支持`;
}

function progressContent({ detail, origin, metadata, taskIndex, startedAtMs, nowMs, support }) {
  const task = (taskIndex?.tasks ?? []).find((candidate) =>
    String(candidate?.threadId ?? '').toLocaleLowerCase() === String(origin.threadId).toLocaleLowerCase());
  const explicitProject = [origin?.projectName, task?.projectName]
    .map((value) => String(value ?? '').trim())
    .find((value) => value && value !== '无项目');
  const projectName = safeHeading(explicitProject || workspaceLeaf(metadata?.payload?.cwd), '无项目');
  const taskName = safeHeading(task?.taskName, '未命名任务');
  const clock = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const elapsed = Number.isFinite(startedAtMs) ? clock - startedAtMs : 0;
  const lines = [
    '## 任务进行中…',
    '',
    `### ${projectName} · ${taskName}`,
    '',
    '### 任务进度',
    '',
    String(detail),
    '',
    '### **运行时间**',
    '',
    `已运行 ${elapsedText(elapsed)}`,
  ];
  const footer = supportText(support);
  if (footer) lines.push('', footer);
  return lines.join('\n');
}

function toolKind(payload) {
  const name = String(payload?.name ?? payload?.namespace ?? '').toLocaleLowerCase();
  if (name.includes('exec') || name.includes('command')) return '命令';
  if (name.includes('patch') || name.includes('edit')) return '文件修改';
  if (name.includes('web') || name.includes('search')) return '检索';
  if (name.includes('image')) return '图像';
  return '工具';
}

function coalesceProgressBursts(events) {
  const coalesced = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (event.kind !== 'commentary' || previous?.kind !== 'commentary') {
      coalesced.push({ ...event, identityStart: event.start, identityEnd: event.end });
      continue;
    }
    previous.end = event.end;
    if (previous.semantic === event.semantic) continue;
    const combined = `${previous.semantic}\n\n${event.semantic}`;
    if (combined.length <= maxProgressChars) {
      previous.semantic = combined;
    } else {
      const marker = '…较早进度已合并…\n';
      previous.semantic = `${marker}${event.semantic.slice(-(maxProgressChars - marker.length))}`;
    }
    previous.content = previous.semantic;
  }
  return coalesced;
}

function extractOriginProgress(lines, origin, fingerprint, { taskIndex, nowMs } = {}) {
  const events = [];
  let activeTurnId = '';
  let terminalSeen = false;
  let startedAtMs = Number.NaN;
  const metadata = lines.find(({ entry }) => rootSessionMeta(entry, origin.threadId))?.entry;
  const support = turnSupport(lines, origin.turnId);
  for (const item of lines) {
    const { entry, start, end } = item;
    if (entry?.type === 'event_msg') {
      const payload = entry.payload ?? {};
      if (payload.type === 'task_started') {
        activeTurnId = String(payload.turn_id ?? '');
        terminalSeen = false;
        if (activeTurnId === origin.turnId) {
          startedAtMs = Date.parse(String(entry.timestamp ?? ''));
        }
        if (activeTurnId === origin.turnId && end > origin.rolloutCursor) {
          events.push({ kind: 'started', content: '正在处理本轮任务。', start, end });
        }
        continue;
      }
      if (payload.type === 'task_complete' && String(payload.turn_id ?? activeTurnId) === origin.turnId) {
        terminalSeen = true;
        activeTurnId = '';
        continue;
      }
      if (terminalSeen || activeTurnId !== origin.turnId || end <= origin.rolloutCursor) continue;
      if (payload.type === 'agent_message' && payload.phase === 'commentary' && typeof payload.message === 'string') {
        const text = sanitizeProgressText(payload.message);
        if (text) events.push({ kind: 'commentary', content: text, start, end, semantic: text });
      } else if (payload.type === 'patch_apply_end' && String(payload.turn_id ?? '') === origin.turnId && String(payload.call_id ?? '').trim()) {
        const failed = payload.success === false || String(payload.status ?? '').toLocaleLowerCase() === 'failed';
        events.push({ kind: failed ? 'tool-failed' : 'tool-complete', content: failed ? '🔧 文件修改失败' : '🔧 文件修改已完成', start, end, semantic: String(payload.call_id) });
      } else if (payload.type === 'item_completed' && String(payload.turn_id ?? '') === origin.turnId) {
        const itemType = String(payload.item?.type ?? '');
        if (['SubAgentActivity', 'CollabAgentToolCall'].includes(itemType)) continue;
        const status = String(payload.item?.status ?? '').toLocaleLowerCase();
        const failed = status === 'failed' || (itemType === 'CommandExecution' && Number(payload.item?.exit_code) !== 0);
        if (failed && ['CommandExecution', 'McpToolCall', 'Extension'].includes(itemType)) {
          events.push({ kind: 'tool-failed', content: '🔧 工具执行失败', start, end, semantic: String(payload.item?.id ?? itemType) });
        }
      }
      continue;
    }
    if (entry?.type !== 'response_item' || terminalSeen || activeTurnId !== origin.turnId || end <= origin.rolloutCursor) continue;
    const payload = entry.payload ?? {};
    if (!exactMetadataTurn(payload, origin.turnId)) continue;
    if (payload.type === 'message' && payload.role === 'assistant' && payload.phase === 'commentary') {
      const text = sanitizeProgressText(outputText(payload));
      if (text) events.push({ kind: 'commentary', content: text, start, end, semantic: text });
      continue;
    }
    const callId = String(payload.call_id ?? '').trim();
    if (!callId) continue;
    if (['custom_tool_call', 'function_call'].includes(payload.type)) {
      events.push({ kind: 'tool-start', content: `🔧 ${toolKind(payload)}正在执行`, start, end, semantic: callId });
    } else if (['custom_tool_call_output', 'function_call_output'].includes(payload.type)) {
      events.push({ kind: 'tool-complete', content: '🔧 工具已完成', start, end, semantic: callId });
    }
  }
  return coalesceProgressBursts(events).map((event) => {
    const eventId = eventIdentifier({
      fingerprint, turnId: origin.turnId, kind: event.kind,
      lineStart: event.identityStart ?? event.start, lineEnd: event.identityEnd ?? event.end,
    });
    return {
      ...event,
      content: progressContent({ detail: event.content, origin, metadata, taskIndex, startedAtMs, nowMs, support }),
      eventId,
      nonce: discordNonce(eventId),
    };
  });
}

function exactTurnCompleteEnd(lines, turnId) {
  let activeTurnId = '';
  for (const { entry, end } of lines) {
    if (entry?.type !== 'event_msg') continue;
    if (entry.payload?.type === 'task_started') activeTurnId = String(entry.payload?.turn_id ?? '');
    if (entry.payload?.type !== 'task_complete') continue;
    const completedTurnId = String(entry.payload?.turn_id ?? activeTurnId);
    if (completedTurnId === String(turnId)) return end;
  }
  return 0;
}

async function exactOriginRollout(sessionsRoot, origin) {
  const candidates = [];
  for (const filePath of await listRolloutFiles(sessionsRoot)) {
    let bytes;
    try { bytes = await fs.readFile(filePath); } catch { continue; }
    const parsed = parseLinesWithOffsets(bytes);
    const meta = parsed.entries.find(({ entry }) => entry?.type === 'session_meta')?.entry;
    if (!rootSessionMeta(meta, origin.threadId)) continue;
    const hasTurn = parsed.entries.some(({ entry }) => entry?.type === 'event_msg' &&
      entry.payload?.type === 'task_started' && String(entry.payload?.turn_id ?? '') === origin.turnId);
    if (!hasTurn) continue;
    const fingerprint = createHash('sha256')
      .update(`${path.resolve(filePath).toLocaleLowerCase()}\0${JSON.stringify(meta)}`, 'utf8').digest('hex');
    candidates.push({ filePath, bytes, parsed, fingerprint });
  }
  return candidates.length === 1 ? candidates[0] : null;
}

async function pollDiscordOriginEventsUnlocked({
  sessionsRoot, inboxState, persistInboxState, dispatchMessage, taskIndex, nowMs = Date.now(),
}) {
  if (typeof persistInboxState !== 'function' || typeof dispatchMessage !== 'function') {
    throw new TypeError('Discord origin progress requires persistence and dispatch adapters');
  }
  let firstError = null;
  for (const [turnId, storedOrigin] of Object.entries(inboxState?.discordTurnOrigins ?? {})) {
    try {
      if (storedOrigin?.deliveryState === 'terminal-delivered') continue;
      const origin = { ...storedOrigin, turnId };
      const rollout = await exactOriginRollout(sessionsRoot, origin);
      if (!rollout || (origin.rolloutFingerprint && origin.rolloutFingerprint !== rollout.fingerprint) ||
          Number(origin.rolloutCursor ?? 0) > rollout.bytes.length) continue;
      const completeEnd = exactTurnCompleteEnd(rollout.parsed.entries, turnId);
      if (completeEnd > Number(origin.rolloutCursor ?? 0)) {
        await advanceDiscordTurnOrigin({
          state: inboxState,
          persistState: persistInboxState,
          turnId,
          rolloutCursor: completeEnd,
          rolloutFingerprint: rollout.fingerprint,
          discardPendingProgress: true,
        });
        continue;
      }
      const pendingDispatch = storedOrigin.progressDispatch;
      if (pendingDispatch) {
        if (pendingDispatch.rolloutFingerprint !== rollout.fingerprint || pendingDispatch.end > rollout.parsed.completeEnd) continue;
        const boundedEntries = rollout.parsed.entries.filter((item) => item.end <= pendingDispatch.end);
        const pendingEvent = extractOriginProgress(boundedEntries, origin, rollout.fingerprint, { taskIndex, nowMs })
          .find((event) => event.eventId === pendingDispatch.eventId && event.end === pendingDispatch.end);
        if (!pendingEvent) continue;
        const response = await dispatchMessage({
          channelId: storedOrigin.channelId,
          content: pendingEvent.content,
          kind: pendingEvent.kind,
          nonce: pendingDispatch.nonce,
          enforceNonce: true,
        });
        await advanceDiscordTurnOrigin({
          state: inboxState, persistState: persistInboxState, turnId,
          rolloutCursor: pendingDispatch.end, eventId: pendingDispatch.eventId,
          lastMessageId: response?.id, rolloutFingerprint: rollout.fingerprint,
        });
        origin.rolloutCursor = pendingDispatch.end;
        delete origin.progressDispatch;
      }
      const events = extractOriginProgress(rollout.parsed.entries, origin, rollout.fingerprint, { taskIndex, nowMs });
      for (const event of events) {
        const current = inboxState.discordTurnOrigins[turnId];
        if (current.deliveredEventIds.includes(event.eventId)) continue;
        await prepareDiscordOriginProgressDelivery({
          state: inboxState,
          persistState: persistInboxState,
          turnId,
          dispatch: {
            eventId: event.eventId, nonce: event.nonce, start: event.start, end: event.end,
            kind: event.kind, rolloutFingerprint: rollout.fingerprint,
          },
        });
        const response = await dispatchMessage({
          channelId: current.channelId,
          content: event.content,
          kind: event.kind,
          nonce: event.nonce,
          enforceNonce: true,
        });
        await advanceDiscordTurnOrigin({
          state: inboxState,
          persistState: persistInboxState,
          turnId,
          rolloutCursor: event.end,
          eventId: event.eventId,
          lastMessageId: response?.id,
          rolloutFingerprint: rollout.fingerprint,
        });
      }
      const current = inboxState.discordTurnOrigins[turnId];
      if (rollout.parsed.completeEnd > Number(current.rolloutCursor ?? 0)) {
        await advanceDiscordTurnOrigin({
          state: inboxState,
          persistState: persistInboxState,
          turnId,
          rolloutCursor: rollout.parsed.completeEnd,
          rolloutFingerprint: rollout.fingerprint,
        });
      }
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
  return inboxState;
}

/** Stream only trusted root progress and serialize concurrent polls per inbox state. */
export async function pollDiscordOriginEvents(options) {
  const state = options?.inboxState;
  if (!state || typeof state !== 'object') throw new TypeError('Discord origin inbox state is required');
  const previous = originPollQueues.get(state) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => pollDiscordOriginEventsUnlocked(options));
  const tail = current.then(() => undefined, () => undefined);
  originPollQueues.set(state, tail);
  try { return await current; } finally {
    if (originPollQueues.get(state) === tail) originPollQueues.delete(state);
  }
}

async function readRange(filePath, start, end) {
  if (end <= start) return Buffer.alloc(0);
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(end - start);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

function applyEntry(filePath, fileState, entry, pending, { emitCompletions }) {
  if (entry?.type === 'session_meta') {
    fileState.threadId = String(entry.payload?.id ?? fileState.threadId ?? '');
    fileState.cwd = String(entry.payload?.cwd ?? fileState.cwd ?? '');
    fileState.rootEligible = rootSessionMeta(entry, fileState.threadId);
    return;
  }
  if (entry?.type !== 'event_msg') return;
  const payload = entry.payload ?? {};
  if (payload.type === 'task_started') {
    fileState.activeTurnId = String(payload.turn_id ?? '');
    return;
  }
  if (payload.type !== 'task_complete') return;

  const turnId = String(payload.turn_id ?? fileState.activeTurnId ?? '');
  if (emitCompletions && fileState.rootEligible === true && turnId && fileState.threadId) {
    pending[turnId] = {
      completedAtMs: Date.parse(String(entry.timestamp ?? '')) || Date.now(),
      lastAttemptAtMs: 0,
      rolloutPath: filePath,
      threadId: fileState.threadId,
      cwd: String(fileState.cwd ?? ''),
    };
  }
  if (!fileState.activeTurnId || fileState.activeTurnId === turnId) {
    fileState.activeTurnId = '';
  }
}

async function hydrateExistingFile(filePath, info, nowMs) {
  const fileState = { offset: info.size, threadId: '', cwd: '', activeTurnId: '', rootEligible: false };
  const metadataBuffer = await readRange(filePath, 0, Math.min(info.size, metadataReadBytes));
  for (const entry of parseLines(metadataBuffer)) applyEntry(filePath, fileState, entry, {}, { emitCompletions: false });

  if (nowMs - info.mtimeMs <= recentContextWindowMs && info.size > 0) {
    const start = Math.max(0, info.size - recentTailBytes);
    const tail = await readRange(filePath, start, info.size);
    for (const entry of parseLines(tail, { dropFirstPartial: start > 0 })) {
      applyEntry(filePath, fileState, entry, {}, { emitCompletions: false });
    }
  }
  return fileState;
}

async function ensureRootEligibility(filePath, fileState, info) {
  if (typeof fileState.rootEligible === 'boolean') return;
  const metadataBuffer = await readRange(filePath, 0, Math.min(info.size, metadataReadBytes));
  const metadata = parseLines(metadataBuffer).find((entry) => entry?.type === 'session_meta');
  if (!metadata) {
    fileState.rootEligible = false;
    return;
  }
  fileState.threadId = String(metadata.payload?.id ?? fileState.threadId ?? '');
  fileState.cwd = String(metadata.payload?.cwd ?? fileState.cwd ?? '');
  fileState.rootEligible = rootSessionMeta(metadata, fileState.threadId);
}

async function recoverPersistedPendingCompletions({ filePaths, state, inboxState, nowMs }) {
  const wanted = new Map(Object.entries(inboxState?.discordTurnOrigins ?? {})
    .filter(([, origin]) => origin?.deliveryState !== 'terminal-delivered')
    .map(([turnId, origin]) => [turnId, origin]));
  if (wanted.size === 0) return;
  const candidates = new Map();
  for (const filePath of filePaths) {
    let info;
    try { info = await fs.stat(filePath); } catch { continue; }
    if (!info.isFile() || info.size <= 0 || info.size > 16 * 1024 * 1024) continue;
    const content = await readRange(filePath, 0, info.size);
    const entries = parseLines(content);
    const metas = entries.filter((entry) => entry?.type === 'session_meta');
    if (metas.length !== 1) continue;
    const threadId = String(metas[0].payload?.id ?? '');
    if (!rootSessionMeta(metas[0], threadId)) continue;
    const matching = [...wanted.entries()].filter(([, origin]) => origin.threadId === threadId);
    if (matching.length === 0) continue;
    const starts = new Set(entries
      .filter((entry) => entry?.type === 'event_msg' && entry.payload?.type === 'task_started')
      .map((entry) => String(entry.payload?.turn_id ?? '')).filter(Boolean));
    for (const [turnId] of matching) {
      if (!starts.has(turnId)) continue;
      const completion = entries.find((entry) => entry?.type === 'event_msg' &&
        entry.payload?.type === 'task_complete' && String(entry.payload?.turn_id ?? '') === turnId);
      if (!completion) continue;
      const items = candidates.get(turnId) ?? [];
      items.push({
        completedAtMs: Date.parse(String(completion.timestamp ?? '')) || nowMs,
        lastAttemptAtMs: 0,
        rolloutPath: filePath,
        threadId,
        cwd: String(metas[0].payload?.cwd ?? ''),
      });
      candidates.set(turnId, items);
    }
  }
  for (const [turnId, items] of candidates) {
    if (items.length === 1) state.pending[turnId] = items[0];
  }
}

export async function initializeRolloutWatcherState({ sessionsRoot, state, nowMs = Date.now(), inboxState }) {
  if (state.initialized) return state;
  const filePaths = await listRolloutFiles(sessionsRoot);
  for (const filePath of filePaths) {
    const info = await fs.stat(filePath);
    state.files[filePath] = await hydrateExistingFile(filePath, info, nowMs);
  }
  await recoverPersistedPendingCompletions({ filePaths, state, inboxState, nowMs });
  state.initialized = true;
  return state;
}

async function consumeFile(filePath, fileState, info, pending) {
  if (info.size < Number(fileState.offset ?? 0)) {
    fileState.offset = 0;
    fileState.activeTurnId = '';
  }
  const start = Number(fileState.offset ?? 0);
  if (info.size <= start) return;
  const bytes = await readRange(filePath, start, info.size);
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) return;
  const complete = bytes.subarray(0, lastNewline + 1);
  for (const entry of parseLines(complete)) applyEntry(filePath, fileState, entry, pending, { emitCompletions: true });
  fileState.offset = start + complete.length;
}

async function archivedLocatorMatches(item, turnId) {
  let currentRoot = false, activeTurnId = '', targetRoot = false;
  let starts = 0, completions = 0, invalid = false, unreadable = false;
  try {
    await scanJsonLines(item.rolloutPath, (entry) => {
      if (entry?.type === 'session_meta') {
        currentRoot = rootSessionMeta(entry, item.threadId);
        if (activeTurnId === String(turnId)) targetRoot = targetRoot && currentRoot;
      }
      if (entry?.type !== 'event_msg') return;
      const payload = entry.payload ?? {};
      if (payload.type === 'task_started') {
        activeTurnId = String(payload.turn_id ?? '');
        if (activeTurnId === String(turnId)) { starts++; targetRoot = currentRoot; }
      }
      if (payload.type === 'task_complete' && String(payload.turn_id ?? '') === String(turnId)) {
        if (activeTurnId !== String(turnId) || !targetRoot || !currentRoot) invalid = true;
        completions++;
      }
    }, { onSkippedLine: () => { unreadable = true; } });
  } catch { return null; }
  if (unreadable) return null;
  return !invalid && starts === 1 && completions === 1;
}

async function recoverArchivedPendingLocator({ sessionsRoot, item, turnId }) {
  const originalPath = path.resolve(String(item.rolloutPath ?? ''));
  const sessionDirectory = path.resolve(sessionsRoot);
  const relative = path.relative(sessionDirectory, originalPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
  try { await fs.stat(originalPath); return; }
  catch (error) { if (error?.code !== 'ENOENT') return; }
  // Codex moves archived sessions under this sibling directory. Never search arbitrary
  // locations or choose by thread ID alone: a fork can share inherited historical turns.
  const archiveRoot = path.join(path.dirname(sessionDirectory), 'archived_sessions');
  let candidates;
  try {
    const rootInfo = await fs.lstat(archiveRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return;
    candidates = (await listRolloutFiles(archiveRoot)).filter((candidate) => path.basename(candidate) === path.basename(originalPath));
  } catch { return; }
  const matches = [];
  for (const candidate of candidates) {
    try {
      const info = await fs.lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const match = await archivedLocatorMatches({ ...item, rolloutPath: candidate }, turnId);
      // An unreadable same-name candidate may also be the target: keep the original
      // pending locator until every candidate can be classified without ambiguity.
      if (match === null) return;
      if (match) matches.push(candidate);
    } catch { return; }
  }
  if (matches.length === 1) item.rolloutPath = matches[0];
}

export async function pollRolloutCompletions({
  sessionsRoot,
  state,
  nowMs = Date.now(),
  graceMs = 6_000,
  retryMs = 10_000,
  dispatchNotification,
  inboxState,
  persistInboxState,
}) {
  if (!state.initialized) await initializeRolloutWatcherState({ sessionsRoot, state, nowMs, inboxState });
  for (const filePath of await listRolloutFiles(sessionsRoot)) {
    const info = await fs.stat(filePath);
    if (!state.files[filePath]) {
      state.files[filePath] = { offset: 0, threadId: '', cwd: '', activeTurnId: '', rootEligible: false };
    }
    await ensureRootEligibility(filePath, state.files[filePath], info);
    await consumeFile(filePath, state.files[filePath], info, state.pending);
  }

  const ready = Object.entries(state.pending)
    .filter(([, item]) => nowMs - Number(item.completedAtMs) >= graceMs && nowMs - Number(item.lastAttemptAtMs ?? 0) >= retryMs)
    .sort((left, right) => Number(left[1].completedAtMs) - Number(right[1].completedAtMs));
  let firstError = null;
  for (const [turnId, item] of ready) {
    item.lastAttemptAtMs = nowMs;
    let reconstructed;
    try {
      await recoverArchivedPendingLocator({ sessionsRoot, item, turnId });
      reconstructed = await reconstructNotification(item, turnId);
    } catch {
      continue;
    }
    try {
      const { notification, internalOnly, internalSuppressionReason } = reconstructed;
      const enrichedNotification = enrichDiscordOriginNotification(notification, inboxState);
      const origin = enrichedNotification ? resolveDiscordOrigin(enrichedNotification, inboxState) : null;
      if (internalOnly && !origin) {
        delete state.pending[turnId];
        const count = Number(state.suppressedInternalTurnCount);
        state.suppressedInternalTurnCount = Number.isSafeInteger(count) && count >= 0 ? Math.min(1_000_000, count + 1) : 1;
        state.lastSuppressedReason = internalSuppressionReason;
        continue;
      }
      if (origin?.deliveryState === 'terminal-delivered') {
        delete state.pending[turnId];
        continue;
      }
      if (origin) {
        const boundary = await exactTerminalBoundary(item, turnId);
        if (boundary === null) continue;
        await advanceDiscordTurnOrigin({
          state: inboxState,
          persistState: persistInboxState,
          turnId,
          rolloutCursor: boundary,
          discardPendingProgress: true,
        });
      }
      let terminalEventId = null;
      if (origin) {
        if (typeof persistInboxState !== 'function') throw new Error('Discord origin terminal persistence is unavailable');
        terminalEventId = createHash('sha256')
          .update(`${turnId}\0${item.threadId}\0terminal`, 'utf8').digest('hex');
        await prepareDiscordOriginTerminalDelivery({
          state: inboxState,
          persistState: persistInboxState,
          turnId,
          eventId: terminalEventId,
        });
        notification['discord-origin-channel-id'] = enrichedNotification['discord-origin-channel-id'];
        notification['discord-guild-id'] = enrichedNotification['discord-guild-id'];
      }
      await dispatchNotification(notification);
      if (origin) {
        await advanceDiscordTurnOrigin({
          state: inboxState,
          persistState: persistInboxState,
          turnId,
          rolloutCursor: origin.rolloutCursor,
          terminalDeliveredAt: new Date(nowMs).toISOString(),
        });
      }
      delete state.pending[turnId];
    } catch (error) {
      // Retain this pending item and its retry timestamp, but let independent completions
      // proceed. The caller still receives a failure and persists the partially advanced state.
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
  return state;
}

async function exactTerminalBoundary(item, turnId) {
  let rootEligible = false;
  let started = false;
  let boundary = null;
  try {
    await scanJsonLines(String(item.rolloutPath ?? ''), (entry, { end }) => {
      if (entry?.type === 'session_meta') rootEligible = rootSessionMeta(entry, item.threadId);
      if (entry?.type !== 'event_msg') return undefined;
      if (entry.payload?.type === 'task_started' && String(entry.payload?.turn_id ?? '') === String(turnId)) started = true;
      if (rootEligible && started && entry.payload?.type === 'task_complete' &&
          String(entry.payload?.turn_id ?? '') === String(turnId)) {
        boundary = end;
        return false;
      }
      return undefined;
    });
  } catch {
    return null;
  }
  return boundary;
}

function isExactGoalContextInput(payload, turnId) {
  const metadata = payload?.internal_chat_message_metadata_passthrough;
  const content = payload?.content;
  const kinds = metadata?.content_item_kinds;
  if (payload?.type !== 'message' || payload.role !== 'user' || metadata?.turn_id !== String(turnId) ||
      !Array.isArray(content) || content.length === 0 || !Array.isArray(kinds) || kinds.length !== content.length) return false;
  const opening = '<codex_internal_context source="goal">';
  const closing = '</codex_internal_context>';
  return content.every((item, index) => {
    if (kinds[index] !== 'goal.internal_context' || item?.type !== 'input_text' || typeof item.text !== 'string') return false;
    const text = item.text.trim();
    if (!text.startsWith(opening) || !text.endsWith(closing)) return false;
    const body = text.slice(opening.length, -closing.length);
    return body.trim().length > 0 && !body.includes('<codex_internal_context') && !body.includes(closing);
  });
}

async function reconstructNotification(item, turnId) {
  let activeTurnId = '';
  let inputMessages = [];
  let lastInput = null;
  let rootMetadataCount = 0, targetStarts = 0;
  let currentRootEligible = false, rootEligible = false, skippedLine = false, sawCompaction = false, exactActiveCompletion = false;
  let sawUserMessage = false, sawAgentMetadata = false, sawAgentMessage = false;
  let sawGoalContext = false, sawOtherUserInput = false;
  let model = '';
  let effort = '';
  let notification = null;
  const payloadBelongsToTurn = (payload) => [payload?.internal_chat_message_metadata_passthrough?.turn_id, payload?.turn_id]
    .every((value) => value == null || value === '' || String(value) === String(turnId));
  const appendInput = (payload, source) => {
    if (activeTurnId !== String(turnId)) return;
    if (!payloadBelongsToTurn(payload)) return;
    const message = boundedText(getUserAuthoredMessageText(payload));
    if (!message) return;
    if (lastInput && !lastInput.mirrored && lastInput.source !== source && lastInput.message === message) {
      lastInput.mirrored = true;
      return;
    }
    inputMessages = [...inputMessages, message].slice(-maxInputMessages);
    lastInput = { message, source, mirrored: false };
  };
  try {
    await scanJsonLines(String(item.rolloutPath ?? ''), (entry) => {
      if (entry?.type === 'session_meta') {
        rootMetadataCount++;
        currentRootEligible = rootSessionMeta(entry, item.threadId);
        if (activeTurnId === String(turnId)) rootEligible = rootEligible && currentRootEligible;
      }
      if (activeTurnId !== String(turnId) && ['event_msg', 'response_item'].includes(entry?.type) &&
          (entry.payload?.type === 'user_message' || entry.type === 'response_item' && String(entry.payload?.role ?? '').toLocaleLowerCase() === 'user') &&
          [entry.payload?.internal_chat_message_metadata_passthrough?.turn_id, entry.payload?.turn_id]
            .some((value) => value != null && String(value) === String(turnId))) sawOtherUserInput = true;
      if (activeTurnId === String(turnId)) {
        if (entry?.type === 'inter_agent_communication_metadata' && payloadBelongsToTurn(entry.payload)) sawAgentMetadata = true;
        if (entry?.type === 'compacted') sawCompaction = true;
        if (entry?.type === 'response_item' && entry.payload?.type === 'agent_message' && payloadBelongsToTurn(entry.payload)) sawAgentMessage = true;
        if (entry?.type === 'response_item' && entry.payload?.type === 'message' && String(entry.payload?.role ?? '').toLocaleLowerCase() === 'user') sawUserMessage = true;
        if (entry?.type === 'event_msg' && entry.payload?.type === 'user_message') sawUserMessage = true;
        if (entry?.type === 'response_item' && String(entry.payload?.role ?? '').toLocaleLowerCase() === 'user') {
          if (payloadBelongsToTurn(entry.payload) && isExactGoalContextInput(entry.payload, turnId)) sawGoalContext = true;
          else sawOtherUserInput = true;
        }
        if (['event_msg', 'response_item'].includes(entry?.type) && entry.payload?.type === 'user_message') sawOtherUserInput = true;
      }
      if (entry?.type === 'response_item') {
        appendInput(entry.payload ?? {}, 'response');
        return undefined;
      }
      if (entry?.type === 'turn_context' && String(entry.payload?.turn_id ?? '') === String(turnId)) {
        model = String(entry.payload?.model ?? model).trim();
        effort = String(entry.payload?.effort ?? entry.payload?.reasoning_effort ?? effort).trim();
        return undefined;
      }
      if (entry?.type !== 'event_msg') return undefined;
      const payload = entry.payload ?? {};
      if (payload.type === 'task_started') {
        activeTurnId = String(payload.turn_id ?? '');
        if (activeTurnId === String(turnId)) { targetStarts++; rootEligible = currentRootEligible; }
        inputMessages = [];
        lastInput = null;
        return undefined;
      }
      if (payload.type === 'user_message' && activeTurnId === String(turnId)) {
        appendInput(payload, 'event');
        return undefined;
      }
      if (payload.type === 'task_complete' && String(payload.turn_id ?? activeTurnId ?? '') === String(turnId)) {
        exactActiveCompletion = activeTurnId === String(turnId) && String(payload.turn_id ?? '') === String(turnId);
        notification = {
          type: 'agent-turn-complete',
          'thread-id': String(item.threadId ?? ''),
          'turn-id': String(turnId),
          cwd: String(item.cwd ?? ''),
          'input-messages': inputMessages,
          'last-assistant-message': boundedText(payload.last_agent_message),
          ...(model ? { model } : {}),
          ...(effort ? { 'reasoning-effort': effort } : {}),
        };
        return false;
      }
      return undefined;
    }, { onSkippedLine: () => { skippedLine = true; } });
  } catch {
    throw new Error('Rollout content is unavailable; fallback notification will retry');
  }
  if (notification) {
    // Empty input alone proves nothing. Retire only a complete exact root span containing
    // a pure agent-result wakeup or exclusively typed, wrapped goal-context user inputs.
    const completeRootSpan = rootMetadataCount > 0 && rootEligible && targetStarts === 1 && exactActiveCompletion &&
      !sawCompaction && !skippedLine && inputMessages.length === 0;
    const internalSuppressionReason = !completeRootSpan ? null
      : sawAgentMetadata && sawAgentMessage && !sawUserMessage ? 'inter-agent-only-turn'
        : sawGoalContext && !sawOtherUserInput ? 'goal-internal-context-only-turn' : null;
    return { notification, internalOnly: internalSuppressionReason !== null, internalSuppressionReason };
  }
  throw new Error('Rollout completion content is unavailable; fallback notification will retry');
}

export async function dispatchNotificationViaPowerShell({ notification, toolDir, powershellPath }) {
  const dispatcherPath = path.join(toolDir, 'dispatcher.ps1');
  const notificationPath = path.join(toolDir, `.rollout-notification-${process.pid}-${randomUUID()}.json`);
  await fs.writeFile(notificationPath, JSON.stringify(notification), 'utf8');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(powershellPath, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', dispatcherPath,
        '-NotificationFile', notificationPath, '-MobileOnly', '-FallbackInvocation',
      ], { cwd: toolDir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let errorText = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { errorText += chunk; });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`fallback dispatcher exited with code ${code}: ${errorText.trim()}`));
      });
    });
  } finally {
    await fs.rm(notificationPath, { force: true }).catch(() => {});
  }
}
