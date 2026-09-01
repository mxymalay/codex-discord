import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTakeoverSnapshot,
  createTakeoverUiState,
  hasNewActiveTasks,
  validateTakeoverUiState,
} from '../codex-takeover-lib.mjs';

function task(threadId, status, minute) {
  return {
    threadId,
    taskName: `任务 ${threadId}`,
    status,
    lastActivityAt: `2026-09-01T12:${String(minute).padStart(2, '0')}:00.000Z`,
  };
}

test('takeover snapshot lists only running and confirmation main tasks with target first', () => {
  const snapshot = buildTakeoverSnapshot({ tasks: [
    task('done', 'completed', 3),
    task('other', 'running', 4),
    task('target', 'confirmation-required', 1),
  ] }, { targetThreadId: 'target', limit: 10 });
  assert.deepEqual(snapshot.items.map((item) => item.threadId), ['target', 'other']);
  assert.deepEqual(snapshot.activeIds, ['other', 'target']);
  assert.equal(snapshot.remaining, 0);
});

test('new active task invalidates an existing confirmation but completed tasks do not', () => {
  const before = buildTakeoverSnapshot({ tasks: [task('a', 'running', 1)] });
  const added = buildTakeoverSnapshot({ tasks: [task('a', 'running', 1), task('b', 'running', 2)] });
  const reduced = buildTakeoverSnapshot({ tasks: [task('a', 'completed', 3)] });
  assert.equal(hasNewActiveTasks(before, added), true);
  assert.equal(hasNewActiveTasks(before, reduced), false);
});

test('takeover UI state expires after five minutes and validates tenancy', () => {
  const state = createTakeoverUiState({
    id: 'interaction-1', kind: 'takeover', userId: '333', guildId: '222',
    targetThreadId: 'target', queueId: 'queue-1', snapshot: { activeIds: ['target'] }, nowMs: 1000,
  });
  assert.equal(state.expiresAt, 301000);
  assert.deepEqual(validateTakeoverUiState(state, { kind: 'takeover', userId: '333', guildId: '222', nowMs: 300999 }), { ok: true, reason: 'valid' });
  assert.deepEqual(validateTakeoverUiState(state, { kind: 'takeover', userId: '333', guildId: '222', nowMs: 301000 }), { ok: false, reason: 'expired' });
});
