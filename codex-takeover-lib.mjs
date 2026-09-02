/** Pure model for safe remote Codex takeover confirmations. */

export const TAKEOVER_TTL_MS = 5 * 60_000;
const INTERRUPTIBLE = new Set(['running', 'confirmation-required']);

export function buildTakeoverSnapshot(taskIndex, { targetThreadId = null, limit = 10 } = {}) {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 10;
  const active = (Array.isArray(taskIndex?.tasks) ? taskIndex.tasks : [])
    .filter((item) => INTERRUPTIBLE.has(String(item?.status)))
    .sort((a, b) => {
      if (String(a.threadId) === String(targetThreadId)) return -1;
      if (String(b.threadId) === String(targetThreadId)) return 1;
      return Date.parse(String(b.lastActivityAt ?? '')) - Date.parse(String(a.lastActivityAt ?? ''));
    });
  return {
    activeIds: active.map((item) => String(item.threadId)).sort(),
    items: active.slice(0, safeLimit).map((item) => ({
      threadId: String(item.threadId),
      taskName: String(item.taskName || '未命名任务'),
      status: String(item.status),
      target: String(item.threadId) === String(targetThreadId),
    })),
    total: active.length,
    remaining: Math.max(0, active.length - safeLimit),
  };
}

export function hasNewActiveTasks(previous, current) {
  const allowed = new Set(previous?.activeIds ?? []);
  return (current?.activeIds ?? []).some((threadId) => !allowed.has(threadId));
}

export function createTakeoverUiState({
  id, kind, userId, guildId, targetThreadId = null, queueId = null, snapshot, nowMs,
}) {
  return {
    id: String(id),
    kind: String(kind),
    userId: String(userId),
    guildId: String(guildId),
    targetThreadId: targetThreadId == null ? null : String(targetThreadId),
    queueId: queueId == null ? null : String(queueId),
    snapshot: snapshot ?? null,
    createdAt: Number(nowMs),
    expiresAt: Number(nowMs) + TAKEOVER_TTL_MS,
  };
}

export function validateTakeoverUiState(state, { kind, userId, guildId, nowMs } = {}) {
  if (!state || typeof state !== 'object') return { ok: false, reason: 'missing' };
  const validIdentity = (value) => (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint')
    && String(value).length > 0 && String(value).trim() === String(value);
  if (!validIdentity(state.kind) || !validIdentity(kind)) return { ok: false, reason: 'invalid-kind' };
  if (!validIdentity(state.userId) || !validIdentity(userId)) return { ok: false, reason: 'invalid-user' };
  if (!validIdentity(state.guildId) || !validIdentity(guildId)) return { ok: false, reason: 'invalid-guild' };
  if (String(state.kind) !== String(kind)) return { ok: false, reason: 'wrong-kind' };
  if (String(state.userId) !== String(userId)) return { ok: false, reason: 'wrong-user' };
  if (String(state.guildId) !== String(guildId)) return { ok: false, reason: 'wrong-guild' };
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return { ok: false, reason: 'invalid-time' };
  if (typeof state.expiresAt !== 'number' || !Number.isFinite(state.expiresAt) || nowMs >= state.expiresAt) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, reason: 'valid' };
}
