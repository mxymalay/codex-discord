import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const CONTROL_ACTIONS = new Set([
  'status', 'stop-codex', 'start-temporary', 'stop-temporary', 'enable-long-term', 'disable-long-term',
]);
const MAX_OUTPUT_BYTES = 64 * 1024;
const HEALTH_STATES = new Set(['idle', 'connecting', 'ready', 'reconnecting', 'stopped', 'ok', 'offline', 'failed', 'unknown']);
const HEALTH_CATEGORIES = new Set([
  'bridge-health-write-failed', 'startup-failed', 'gateway-timeout', 'gateway-frame-invalid',
  'gateway-hello-invalid', 'gateway-reconnect-requested', 'gateway-disconnected', 'gateway-connect-failed',
  'interaction-handler-failed', 'queue-retry-failed', 'channel-poll-failed', 'index-refresh-failed',
  'rollout-poll-failed', 'rollout-state-save-failed', 'turn-completion-connection-lost',
  'continuation-started', 'continuation-queued', 'message-ignored', 'unknown',
]);
const healthWriters = new Map();

function failed(action, errorCategory) {
  return { ok: false, action, errorCategory };
}

function readSingleJson(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return { errorCategory: 'control-invalid-json' };
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((line) => {
    try { JSON.parse(line); return true; } catch { return false; }
  })) return { errorCategory: 'control-multiple-json' };
  try {
    const value = JSON.parse(trimmed);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { errorCategory: 'control-invalid-json' };
    return { value };
  } catch {
    return { errorCategory: 'control-invalid-json' };
  }
}

/** Run one fixed PowerShell action without exposing command output on failures. */
export function runCodexControlAction({
  action,
  powershellPath,
  controlPath,
  spawnImpl = spawn,
  timeoutMs = 15_000,
} = {}) {
  if (!CONTROL_ACTIONS.has(action)) return Promise.reject(new Error('Invalid control action'));

  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timeoutId = null;
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      resolve(result);
    };
    const terminateChild = () => {
      try { child?.kill?.(); } catch { /* The spawned child is already unavailable. */ }
    };
    const onOutput = (stream, chunk) => {
      const bytes = Buffer.byteLength(chunk);
      if (stream === 'stdout') {
        stdoutBytes += bytes;
        if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk;
      } else {
        stderrBytes += bytes;
      }
      if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
        settle(failed(action, 'control-output-too-large'));
        terminateChild();
      }
    };

    try {
      child = spawnImpl(powershellPath, ['-NoProfile', '-File', controlPath, '-Action', action], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      settle(failed(action, 'control-spawn-failed'));
      return;
    }
    if (!child || typeof child.once !== 'function') {
      settle(failed(action, 'control-spawn-failed'));
      return;
    }

    child.stdout?.on('data', (chunk) => onOutput('stdout', chunk));
    child.stderr?.on('data', (chunk) => onOutput('stderr', chunk));
    child.once('error', () => {
      settle(failed(action, 'control-spawn-failed'));
      terminateChild();
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) return settle(failed(action, 'control-output-too-large'));
      if (exitCode !== 0) return settle(failed(action, 'control-nonzero-exit'));
      const parsed = readSingleJson(stdout);
      return settle(parsed.value === undefined ? failed(action, parsed.errorCategory) : parsed.value);
    });
    const boundedTimeout = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Math.floor(Number(timeoutMs))) : 15_000;
    timeoutId = setTimeout(() => {
      settle(failed(action, 'control-timeout'));
      terminateChild();
    }, boundedTimeout);
  });
}

function healthState(value) {
  const candidate = String(value ?? 'unknown').toLowerCase();
  return HEALTH_STATES.has(candidate) ? candidate : 'unknown';
}

function healthCategory(value) {
  const candidate = String(value ?? 'unknown').toLowerCase();
  return HEALTH_CATEGORIES.has(candidate) ? candidate : 'unknown';
}

function healthTimestamp(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function healthQueueCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(1_000_000, Math.floor(number)) : 0;
}

function sanitizeHealth(status) {
  return {
    version: 1,
    observedAt: new Date().toISOString(),
    gateway: { state: healthState(status?.gateway?.state) },
    discordRest: { state: healthState(status?.discordRest?.state) },
    queueCount: healthQueueCount(status?.queueCount),
    startedAt: healthTimestamp(status?.startedAt),
    lastActivityAt: healthTimestamp(status?.lastActivityAt),
    latestEventCategory: healthCategory(status?.latestEventCategory ?? status?.latestErrorCategory),
  };
}

/** Atomically replace a same-directory, sanitized bridge health snapshot. */
export async function writeBridgeHealthAtomic(targetPath, status, { fsImpl = fs, signal, shouldCommit = () => !signal?.aborted, bypassQueue = false } = {}) {
  const canCommit = () => !signal?.aborted && shouldCommit();
  if (!canCommit()) return;
  const queueKey = path.resolve(targetPath);
  const previous = healthWriters.get(queueKey) ?? Promise.resolve();
  const writeOperation = async () => {
    if (!canCommit()) return;
    const directory = path.dirname(targetPath);
    const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
    const serialized = `${JSON.stringify(sanitizeHealth(status))}\n`;
    try {
      await fsImpl.writeFile(temporaryPath, serialized, 'utf8');
      if (!canCommit()) return;
      await fsImpl.rename(temporaryPath, targetPath);
    } finally {
      try {
        if (typeof fsImpl.rm === 'function') await fsImpl.rm(temporaryPath, { force: true });
        else if (typeof fsImpl.unlink === 'function') await fsImpl.unlink(temporaryPath);
      } catch {
        // A successful rename has already consumed the unique temporary file.
      }
    }
  };
  const write = previous.catch(() => {}).then(writeOperation);
  if (!bypassQueue) healthWriters.set(queueKey, write);
  try {
    await write;
  } finally {
    if (!bypassQueue && healthWriters.get(queueKey) === write) healthWriters.delete(queueKey);
  }
}

export function getBridgeHealthWriterStats(targetPath) {
  const pending = healthWriters.get(path.resolve(targetPath));
  return { activePreparations: pending ? 1 : 0, pendingOrdinary: pending ? 1 : 0 };
}
