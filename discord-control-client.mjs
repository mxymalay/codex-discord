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

export function getBridgeHealthWriterStats(targetPath) {
  const state = healthWriters.get(path.resolve(targetPath));
  return {
    activePreparations: state?.activeOrdinary ? 1 : 0,
    pendingOrdinary: state?.pendingOrdinary ? 1 : 0,
    activeForcedPreparations: state?.activeForcedPreparations ?? 0,
  };
}

function stateFor(targetPath) {
  const key = path.resolve(targetPath);
  let state = healthWriters.get(key);
  if (!state || !Object.hasOwn(state, 'commitTail')) {
    state = { key, activeOrdinary: null, pendingOrdinary: null, activeForcedPreparations: 0, commitTail: Promise.resolve() };
    healthWriters.set(key, state);
  }
  return state;
}
async function cleanTemp(fsImpl, temporaryPath) {
  try {
    if (fsImpl.rm) await fsImpl.rm(temporaryPath, { force: true });
    else await fsImpl.unlink?.(temporaryPath);
  } catch {}
}

function tryCleanupState(state, observedTail = state.commitTail) {
  if (state.activeOrdinary || state.pendingOrdinary || state.activeForcedPreparations > 0) return;
  const cleanup = () => {
    if (!state.activeOrdinary && !state.pendingOrdinary && state.activeForcedPreparations === 0 &&
      state.commitTail === observedTail && healthWriters.get(state.key) === state) {
      healthWriters.delete(state.key);
    }
  };
  observedTail.then(cleanup, cleanup);
}

async function prepareWrite(request, state) {
  const canCommit = () => !request.signal?.aborted && request.shouldCommit();
  if (!canCommit()) return;
  const temp = path.join(path.dirname(request.targetPath), `.${path.basename(request.targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await request.fsImpl.writeFile(temp, `${JSON.stringify(sanitizeHealth(request.status))}\n`, 'utf8');
    if (!canCommit()) return;
    const prior = state.commitTail;
    const commitPromise = prior.then(async () => {
      if (canCommit()) await request.fsImpl.rename(temp, request.targetPath);
    });
    state.commitTail = commitPromise.catch(() => {});
    await commitPromise;
  } finally { await cleanTemp(request.fsImpl, temp); }
}

function launchOrdinary(state) {
  const request = state.pendingOrdinary;
  if (!request || state.activeOrdinary) return;
  state.pendingOrdinary = null; state.activeOrdinary = request;
  prepareWrite(request, state).then(request.resolve, request.reject).then(
    () => {
      state.activeOrdinary = null;
      launchOrdinary(state);
      tryCleanupState(state);
    },
    () => {
      state.activeOrdinary = null;
      launchOrdinary(state);
      tryCleanupState(state);
    },
  );
}

/** Atomically replace a same-directory, sanitized bridge health snapshot. Ordinary writes may resolve as { coalesced: true } when replaced by a newer pending snapshot. */
export function writeBridgeHealthAtomic(targetPath, status, { fsImpl = fs, signal, shouldCommit = () => !signal?.aborted, bypassQueue = false } = {}) {
  const state = stateFor(targetPath);
  const request = { targetPath, status, fsImpl, signal, shouldCommit, resolve: null, reject: null };
  if (bypassQueue) {
    state.activeForcedPreparations += 1;
    return prepareWrite(request, state).then(
      (value) => {
        state.activeForcedPreparations -= 1;
        tryCleanupState(state);
        return value;
      },
      (error) => {
        state.activeForcedPreparations -= 1;
        tryCleanupState(state);
        throw error;
      },
    );
  }
  return new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; if (state.pendingOrdinary) state.pendingOrdinary.resolve({ coalesced: true }); state.pendingOrdinary = request; launchOrdinary(state); });
}
