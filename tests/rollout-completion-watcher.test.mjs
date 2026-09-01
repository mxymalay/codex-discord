import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createEmptyRolloutWatcherState,
  dispatchNotificationViaPowerShell,
  initializeRolloutWatcherState,
  pollRolloutCompletions,
  readRolloutWatcherState,
  writeRolloutWatcherState,
} from '../rollout-completion-watcher-lib.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function sessionMeta() {
  return {
    timestamp: '2026-09-01T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: threadId,
      cwd: 'C:\\workspace\\demo',
      thread_source: 'user',
    },
  };
}

function taskStarted() {
  return {
    timestamp: '2026-09-01T00:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: turnId },
  };
}

function userMessage(text = '请检查 Discord 通知为什么漏发') {
  return {
    timestamp: '2026-09-01T00:00:02.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: text },
  };
}

function taskComplete(message = '已经完成修复。') {
  return {
    timestamp: '2026-09-01T00:00:10.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: turnId, last_agent_message: message },
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-watcher-'));
  const sessionsRoot = path.join(root, 'sessions');
  const statePath = path.join(root, 'rollout-watcher-state.json');
  const rolloutPath = path.join(sessionsRoot, '2026', '09', '01', `rollout-${threadId}.jsonl`);
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  return { root, sessionsRoot, statePath, rolloutPath };
}

test('baselines existing bytes but preserves the active turn context for the next completion', async () => {
  const paths = await fixture();
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage()].map(jsonLine).join(''), 'utf8');
    const state = createEmptyRolloutWatcherState();
    await initializeRolloutWatcherState({ sessionsRoot: paths.sessionsRoot, state });

    const tracked = state.files[path.resolve(paths.rolloutPath)];
    assert.equal(state.initialized, true);
    assert.equal(tracked.threadId, threadId);
    assert.equal(tracked.cwd, 'C:\\workspace\\demo');
    assert.equal(tracked.activeTurnId, turnId);
    assert.equal(Object.hasOwn(tracked, 'inputMessages'), false);
    assert.equal(JSON.stringify(state).includes('请检查 Discord 通知为什么漏发'), false);
    assert.equal(tracked.offset, (await fs.stat(paths.rolloutPath)).size);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('waits for a complete JSONL line and grace period, then dispatches one standard notification', async () => {
  const paths = await fixture();
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage()].map(jsonLine).join(''), 'utf8');
    const state = createEmptyRolloutWatcherState();
    await initializeRolloutWatcherState({ sessionsRoot: paths.sessionsRoot, state });
    const dispatched = [];
    const completeLine = JSON.stringify(taskComplete());

    await fs.appendFile(paths.rolloutPath, completeLine, 'utf8');
    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'),
      graceMs: 5_000,
      dispatchNotification: async (notification) => dispatched.push(notification),
    });
    assert.equal(dispatched.length, 0, 'an incomplete JSONL line must not be consumed');

    await fs.appendFile(paths.rolloutPath, '\n', 'utf8');
    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:12.000Z'),
      graceMs: 5_000,
      dispatchNotification: async (notification) => dispatched.push(notification),
    });
    assert.equal(dispatched.length, 0, 'the fallback must give the native hook time to deliver first');
    assert.equal(JSON.stringify(state.pending).includes('请检查 Discord 通知为什么漏发'), false);
    assert.equal(JSON.stringify(state.pending).includes('已经完成修复。'), false);

    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:16.000Z'),
      graceMs: 5_000,
      dispatchNotification: async (notification) => dispatched.push(notification),
    });
    assert.deepEqual(dispatched, [{
      type: 'agent-turn-complete',
      'thread-id': threadId,
      'turn-id': turnId,
      cwd: 'C:\\workspace\\demo',
      'input-messages': ['请检查 Discord 通知为什么漏发'],
      'last-assistant-message': '已经完成修复。',
    }]);

    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:30.000Z'),
      graceMs: 5_000,
      dispatchNotification: async (notification) => dispatched.push(notification),
    });
    assert.equal(dispatched.length, 1, 'a completed turn must not be dispatched twice');
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('persists an unfinished turn so a guard restart still catches its later completion', async () => {
  const paths = await fixture();
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage('重启后也要提醒')].map(jsonLine).join(''), 'utf8');
    const beforeRestart = createEmptyRolloutWatcherState();
    await initializeRolloutWatcherState({ sessionsRoot: paths.sessionsRoot, state: beforeRestart });
    await writeRolloutWatcherState(paths.statePath, beforeRestart);
    const stored = await fs.readFile(paths.statePath, 'utf8');
    assert.equal(stored.includes('重启后也要提醒'), false);
    assert.equal(stored.includes('重启后的任务已完成。'), false);

    await fs.appendFile(paths.rolloutPath, jsonLine(taskComplete('重启后的任务已完成。')), 'utf8');
    const afterRestart = await readRolloutWatcherState(paths.statePath);
    const dispatched = [];
    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state: afterRestart,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'),
      graceMs: 5_000,
      dispatchNotification: async (notification) => dispatched.push(notification),
    });

    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0]['input-messages'], ['重启后也要提醒']);
    assert.equal(dispatched[0]['last-assistant-message'], '重启后的任务已完成。');
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('keeps a failed fallback pending and retries it later', async () => {
  const paths = await fixture();
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage(), taskComplete()].map(jsonLine).join(''), 'utf8');
    const state = createEmptyRolloutWatcherState();
    await initializeRolloutWatcherState({ sessionsRoot: paths.sessionsRoot, state });
    state.files[path.resolve(paths.rolloutPath)].offset = Buffer.byteLength(
      [sessionMeta(), taskStarted(), userMessage()].map(jsonLine).join(''),
    );
    let attempts = 0;
    const dispatchNotification = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary Discord failure');
    };

    await assert.rejects(() => pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'),
      graceMs: 5_000,
      dispatchNotification,
    }), /temporary Discord failure/);
    assert.equal(Object.keys(state.pending).length, 1);

    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:30.000Z'),
      graceMs: 5_000,
      dispatchNotification,
    });
    assert.equal(attempts, 2);
    assert.equal(Object.keys(state.pending).length, 0);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('keeps only a sanitized locator when the canonical rollout is unavailable', async () => {
  const paths = await fixture();
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage(), taskComplete()].map(jsonLine).join(''), 'utf8');
    const state = createEmptyRolloutWatcherState();
    await initializeRolloutWatcherState({ sessionsRoot: paths.sessionsRoot, state });
    state.files[path.resolve(paths.rolloutPath)].offset = Buffer.byteLength(
      [sessionMeta(), taskStarted(), userMessage()].map(jsonLine).join(''),
    );
    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:12.000Z'),
      graceMs: 5_000,
      dispatchNotification: async () => { throw new Error('dispatch must wait for grace period'); },
    });
    await fs.rm(paths.rolloutPath);
    await assert.rejects(() => pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'),
      graceMs: 5_000,
      dispatchNotification: async () => {},
    }), /Rollout content is unavailable/);
    assert.equal(Object.keys(state.pending).length, 1);
    assert.equal(JSON.stringify(state.pending).includes('请检查 Discord 通知为什么漏发'), false);
    assert.equal(JSON.stringify(state.pending).includes('已经完成修复。'), false);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('migrates legacy watcher state without retaining conversation content', async () => {
  const paths = await fixture();
  try {
    await fs.writeFile(paths.statePath, JSON.stringify({
      version: 1,
      initialized: true,
      files: {
        [paths.rolloutPath]: {
          offset: 42,
          threadId,
          cwd: 'C:\\workspace\\demo',
          activeTurnId: turnId,
          inputMessages: ['do not retain this'],
        },
      },
      pending: {
        [turnId]: { notification: { 'input-messages': ['do not retain this'], 'last-assistant-message': 'do not retain this' } },
      },
    }), 'utf8');
    const migrated = await readRolloutWatcherState(paths.statePath);
    assert.equal(migrated.version, 2);
    assert.equal(Object.hasOwn(migrated.files[paths.rolloutPath], 'inputMessages'), false);
    assert.deepEqual(migrated.pending, {});
    await writeRolloutWatcherState(paths.statePath, migrated);
    assert.equal((await fs.readFile(paths.statePath, 'utf8')).includes('do not retain this'), false);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('migrates a recoverable v1 pending completion to a locator and dispatches once', async () => {
  const paths = await fixture();
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage(), taskComplete()].map(jsonLine).join(''), 'utf8');
    await fs.writeFile(paths.statePath, JSON.stringify({ version: 1, initialized: true, files: {}, pending: {
      [turnId]: { completedAtMs: 0, lastAttemptAtMs: 0, notification: { 'thread-id': threadId, cwd: 'C:\\workspace\\demo', 'input-messages': ['legacy secret'], 'last-assistant-message': 'legacy result' } },
    } }), 'utf8');
    const state = await readRolloutWatcherState(paths.statePath, { sessionsRoot: paths.sessionsRoot });
    assert.equal(state.pending[turnId].rolloutPath, path.resolve(paths.rolloutPath));
    assert.equal(JSON.stringify(state.pending).includes('legacy secret'), false);
    const delivered = [];
    await pollRolloutCompletions({ sessionsRoot: paths.sessionsRoot, state, nowMs: Date.now() + 60_000, graceMs: 0, dispatchNotification: async (item) => delivered.push(item) });
    assert.equal(delivered.length, 1);
    assert.equal(Object.keys(state.pending).length, 0);
  } finally { await fs.rm(paths.root, { recursive: true, force: true }); }
});

test('does not migrate an ambiguous or missing v1 pending rollout locator', async () => {
  const paths = await fixture();
  try {
    const legacy = () => ({ version: 1, initialized: true, files: {}, pending: {
      [turnId]: { completedAtMs: 0, notification: { 'thread-id': threadId, cwd: 'C:\\workspace\\demo', 'last-assistant-message': 'do not retain' } },
    } });
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), taskComplete()].map(jsonLine).join(''), 'utf8');
    const second = path.join(paths.sessionsRoot, '2026', '09', '01', `rollout-copy-${threadId}.jsonl`);
    await fs.writeFile(second, [sessionMeta(), taskStarted(), taskComplete()].map(jsonLine).join(''), 'utf8');
    await fs.writeFile(paths.statePath, JSON.stringify(legacy()), 'utf8');
    let state = await readRolloutWatcherState(paths.statePath, { sessionsRoot: paths.sessionsRoot });
    assert.deepEqual(state.pending, {});
    await fs.rm(second);
    await fs.rm(paths.rolloutPath);
    await fs.writeFile(paths.statePath, JSON.stringify(legacy()), 'utf8');
    state = await readRolloutWatcherState(paths.statePath, { sessionsRoot: paths.sessionsRoot });
    assert.deepEqual(state.pending, {});
  } finally { await fs.rm(paths.root, { recursive: true, force: true }); }
});

test('hands long notification JSON to the fallback dispatcher through a UTF-8 file', async () => {
  const paths = await fixture();
  try {
    const toolDir = path.join(paths.root, 'mobile-notify');
    const capturedPath = path.join(paths.root, 'captured.json');
    await fs.mkdir(toolDir, { recursive: true });
    await fs.writeFile(path.join(toolDir, 'dispatcher.ps1'), [
      'param([string]$NotificationFile, [switch]$MobileOnly, [switch]$FallbackInvocation)',
      '$raw = [System.IO.File]::ReadAllText($NotificationFile, [System.Text.Encoding]::UTF8)',
      '[System.IO.File]::WriteAllText($env:CODEX_WATCHER_CAPTURE, $raw, [System.Text.UTF8Encoding]::new($false))',
    ].join('\n'), 'utf8');
    const notification = {
      type: 'agent-turn-complete',
      'thread-id': threadId,
      'turn-id': turnId,
      cwd: 'C:\\workspace\\demo',
      'input-messages': ['长文本通知'],
      'last-assistant-message': `已完成。${'很长的结果。'.repeat(12_000)}`,
    };
    assert.ok(JSON.stringify(notification).length > 32_767);

    const previousCapture = process.env.CODEX_WATCHER_CAPTURE;
    process.env.CODEX_WATCHER_CAPTURE = capturedPath;
    try {
      await dispatchNotificationViaPowerShell({
        notification,
        toolDir,
        powershellPath: process.execPath.includes('node')
          ? (process.env.PWSH_PATH ?? 'pwsh')
          : 'pwsh',
      });
    } finally {
      if (previousCapture === undefined) delete process.env.CODEX_WATCHER_CAPTURE;
      else process.env.CODEX_WATCHER_CAPTURE = previousCapture;
    }

    assert.deepEqual(JSON.parse(await fs.readFile(capturedPath, 'utf8')), notification);
    assert.deepEqual((await fs.readdir(toolDir)).filter((name) => name.startsWith('.rollout-notification-')), []);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});
