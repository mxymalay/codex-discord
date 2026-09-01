import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const stateVersion = 1;
const maxMessageChars = 50_000;
const maxInputMessages = 12;
const metadataReadBytes = 512 * 1024;
const recentTailBytes = 8 * 1024 * 1024;
const recentContextWindowMs = 24 * 60 * 60 * 1000;

export function createEmptyRolloutWatcherState() {
  return { version: stateVersion, initialized: false, files: {}, pending: {} };
}

export async function readRolloutWatcherState(statePath) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
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

function applyEntry(fileState, entry, pending, { emitCompletions }) {
  if (entry?.type === 'session_meta') {
    fileState.threadId = String(entry.payload?.id ?? fileState.threadId ?? '');
    fileState.cwd = String(entry.payload?.cwd ?? fileState.cwd ?? '');
    return;
  }
  if (entry?.type !== 'event_msg') return;
  const payload = entry.payload ?? {};
  if (payload.type === 'task_started') {
    fileState.activeTurnId = String(payload.turn_id ?? '');
    fileState.inputMessages = [];
    return;
  }
  if (payload.type === 'user_message') {
    const message = boundedText(payload.message);
    if (message.trim()) {
      fileState.inputMessages = [...(fileState.inputMessages ?? []), message].slice(-maxInputMessages);
    }
    return;
  }
  if (payload.type !== 'task_complete') return;

  const turnId = String(payload.turn_id ?? fileState.activeTurnId ?? '');
  if (emitCompletions && turnId && fileState.threadId) {
    pending[turnId] = {
      completedAtMs: Date.parse(String(entry.timestamp ?? '')) || Date.now(),
      lastAttemptAtMs: 0,
      notification: {
        type: 'agent-turn-complete',
        'thread-id': fileState.threadId,
        'turn-id': turnId,
        cwd: String(fileState.cwd ?? ''),
        'input-messages': [...(fileState.inputMessages ?? [])],
        'last-assistant-message': boundedText(payload.last_agent_message),
      },
    };
  }
  if (!fileState.activeTurnId || fileState.activeTurnId === turnId) {
    fileState.activeTurnId = '';
    fileState.inputMessages = [];
  }
}

async function hydrateExistingFile(filePath, info, nowMs) {
  const fileState = { offset: info.size, threadId: '', cwd: '', activeTurnId: '', inputMessages: [] };
  const metadataBuffer = await readRange(filePath, 0, Math.min(info.size, metadataReadBytes));
  for (const entry of parseLines(metadataBuffer)) applyEntry(fileState, entry, {}, { emitCompletions: false });

  if (nowMs - info.mtimeMs <= recentContextWindowMs && info.size > 0) {
    const start = Math.max(0, info.size - recentTailBytes);
    const tail = await readRange(filePath, start, info.size);
    for (const entry of parseLines(tail, { dropFirstPartial: start > 0 })) {
      applyEntry(fileState, entry, {}, { emitCompletions: false });
    }
  }
  return fileState;
}

export async function initializeRolloutWatcherState({ sessionsRoot, state, nowMs = Date.now() }) {
  if (state.initialized) return state;
  for (const filePath of await listRolloutFiles(sessionsRoot)) {
    const info = await fs.stat(filePath);
    state.files[filePath] = await hydrateExistingFile(filePath, info, nowMs);
  }
  state.initialized = true;
  return state;
}

async function consumeFile(filePath, fileState, info, pending) {
  if (info.size < Number(fileState.offset ?? 0)) {
    fileState.offset = 0;
    fileState.activeTurnId = '';
    fileState.inputMessages = [];
  }
  const start = Number(fileState.offset ?? 0);
  if (info.size <= start) return;
  const bytes = await readRange(filePath, start, info.size);
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) return;
  const complete = bytes.subarray(0, lastNewline + 1);
  for (const entry of parseLines(complete)) applyEntry(fileState, entry, pending, { emitCompletions: true });
  fileState.offset = start + complete.length;
}

export async function pollRolloutCompletions({
  sessionsRoot,
  state,
  nowMs = Date.now(),
  graceMs = 6_000,
  retryMs = 10_000,
  dispatchNotification,
}) {
  if (!state.initialized) await initializeRolloutWatcherState({ sessionsRoot, state, nowMs });
  for (const filePath of await listRolloutFiles(sessionsRoot)) {
    const info = await fs.stat(filePath);
    if (!state.files[filePath]) {
      state.files[filePath] = { offset: 0, threadId: '', cwd: '', activeTurnId: '', inputMessages: [] };
    }
    await consumeFile(filePath, state.files[filePath], info, state.pending);
  }

  const ready = Object.entries(state.pending)
    .filter(([, item]) => nowMs - Number(item.completedAtMs) >= graceMs && nowMs - Number(item.lastAttemptAtMs ?? 0) >= retryMs)
    .sort((left, right) => Number(left[1].completedAtMs) - Number(right[1].completedAtMs));
  for (const [turnId, item] of ready) {
    item.lastAttemptAtMs = nowMs;
    await dispatchNotification(item.notification);
    delete state.pending[turnId];
  }
  return state;
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
