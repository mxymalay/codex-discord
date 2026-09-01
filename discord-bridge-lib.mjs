import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function compareSnowflakes(left, right) {
  const a = BigInt(String(left));
  const b = BigInt(String(right));
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createEmptyInboxState() {
  return {
    version: 2,
    initialized: false,
    cursors: {},
    processedMessageIds: [],
    pendingContinuations: {},
    processedInteractions: [],
    createdTasksByInteraction: {},
  };
}

const MAX_PROCESSED_INTERACTIONS = 2_000;
const MAX_CREATED_TASK_RECORDS = 2_000;
const MAX_TERMINAL_CONTINUATIONS = 200;
const CONTINUATION_STATUSES = new Set(['queued', 'resuming', 'submitting', 'attempting', 'start-submitted', 'start-uncertain', 'confirmed-start', 'acknowledging', 'delivered', 'cancelled', 'failed']);
const TERMINAL_CONTINUATION_STATUSES = new Set(['delivered', 'cancelled', 'failed']);
const TERMINAL_CREATION_STATUSES = new Set(['started', 'first-turn-failed', 'failed-before-thread', 'recovered-failed']);
const inboxStateCommitQueues = new WeakMap();

function continuationQueueId(source, requestId) {
  return createHash('sha256').update(`${source}\0${requestId}`, 'utf8').digest().subarray(0, 12).toString('base64url');
}

function continuationSummary(value) {
  const safe = String(value ?? '')
    .replace(/@/gu, '@\u200b')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/[*_`#>|~[\]{}()\\]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!safe) return '';
  return safe.length <= 120 ? safe : `${safe.slice(0, 119)}…`;
}

export async function withInboxStateLock(state, operation) {
  const previous = inboxStateCommitQueues.get(state) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const current = previous.catch(() => {}).then(async () => {
    try {
      return await operation();
    } finally {
      release();
    }
  });
  inboxStateCommitQueues.set(state, gate);
  try {
    return await current;
  } finally {
    if (inboxStateCommitQueues.get(state) === gate) inboxStateCommitQueues.delete(state);
  }
}

function restoreFields(state, snapshots) {
  for (const [field, snapshot] of snapshots) {
    if (!snapshot.exists) delete state[field];
    else state[field] = structuredClone(snapshot.value);
  }
}

function restoreEntries(state, snapshots) {
  for (const snapshot of snapshots) {
    state[snapshot.field] ??= {};
    if (!snapshot.exists) delete state[snapshot.field][snapshot.key];
    else state[snapshot.field][snapshot.key] = structuredClone(snapshot.value);
  }
}

function pruneCreatedTaskHistory(state) {
  const records = state?.createdTasksByInteraction;
  if (!records || typeof records !== 'object') return;
  let overflow = Math.max(0, Object.keys(records).length - MAX_CREATED_TASK_RECORDS);
  if (!overflow) return;
  for (const [interactionId, record] of Object.entries(records)) {
    if (!TERMINAL_CREATION_STATUSES.has(String(record?.status ?? ''))) continue;
    delete records[interactionId];
    overflow -= 1;
    if (!overflow) break;
  }
}

export async function commitInboxState({
  state,
  persistState,
  fields = [],
  entries = {},
  mutate = () => undefined,
  errorMessage = 'Inbox state persistence failed',
}) {
  if (!state || typeof state !== 'object') throw new TypeError('Inbox state is required');
  return withInboxStateLock(state, async () => {
    const uniqueFields = [...new Set(fields.map(String))];
    const before = uniqueFields.map((field) => [field, {
      exists: Object.hasOwn(state, field),
      value: Object.hasOwn(state, field) ? structuredClone(state[field]) : undefined,
    }]);
    const beforeEntries = Object.entries(entries).flatMap(([field, keys]) =>
      [...new Set((Array.isArray(keys) ? keys : []).map(String))].map((key) => ({
        field,
        key,
        exists: Object.hasOwn(state[field] ?? {}, key),
        value: Object.hasOwn(state[field] ?? {}, key) ? structuredClone(state[field][key]) : undefined,
      })));
    let result;
    try {
      result = mutate();
      if (result && typeof result.then === 'function') throw new TypeError('Inbox state mutation must be synchronous');
      if (typeof persistState !== 'function') throw new Error('Persistence adapter is unavailable');
      const immutableSnapshot = structuredClone(state);
      if (uniqueFields.includes('createdTasksByInteraction') || Object.hasOwn(entries, 'createdTasksByInteraction')) {
        pruneCreatedTaskHistory(immutableSnapshot);
      }
      if (uniqueFields.includes('pendingContinuations') || Object.hasOwn(entries, 'pendingContinuations')) {
        pruneContinuationHistory(immutableSnapshot);
      }
      await persistState(immutableSnapshot);
      if (uniqueFields.includes('createdTasksByInteraction') || Object.hasOwn(entries, 'createdTasksByInteraction')) {
        pruneCreatedTaskHistory(state);
      }
      if (uniqueFields.includes('pendingContinuations') || Object.hasOwn(entries, 'pendingContinuations')) {
        pruneContinuationHistory(state);
      }
      return result;
    } catch {
      restoreFields(state, before);
      restoreEntries(state, beforeEntries);
      throw new Error(errorMessage);
    }
  });
}

async function persistMutation(state, persistState, mutate, queueIds = []) {
  return commitInboxState({
    state,
    persistState,
    fields: ['processedInteractions'],
    entries: { pendingContinuations: queueIds },
    mutate,
    errorMessage: 'Continuation state persistence failed',
  });
}

function pruneContinuationHistory(state) {
  const terminalTime = (item) => String(({
    'confirmed-start': item?.confirmedAt,
    delivered: item?.deliveredAt,
    cancelled: item?.cancelledAt,
    failed: item?.failedAt,
  })[String(item?.status ?? '')] ?? item?.createdAt ?? '');
  const terminalContinuations = Object.entries(state?.pendingContinuations ?? {})
    .filter(([, item]) => TERMINAL_CONTINUATION_STATUSES.has(String(item?.status ?? '')))
    .sort((left, right) => terminalTime(left[1]).localeCompare(terminalTime(right[1])));
  for (const [queueId] of terminalContinuations.slice(0, Math.max(0, terminalContinuations.length - MAX_TERMINAL_CONTINUATIONS))) {
    delete state.pendingContinuations[queueId];
  }
}

function processedInteraction(state, requestId) {
  return state.processedInteractions.find((item) => String(item?.requestId ?? '') === String(requestId));
}

function recordProcessedInteraction(state, requestId, result, now) {
  if (!String(requestId ?? '').trim()) return;
  const record = {
    requestId: String(requestId),
    status: String(result?.status ?? 'failed'),
    queueId: result?.queueId ? String(result.queueId) : undefined,
    turnId: result?.turnId ? String(result.turnId) : undefined,
    reason: result?.reason ? String(result.reason) : undefined,
    processedAt: String(now),
  };
  state.processedInteractions = state.processedInteractions.filter((item) => String(item?.requestId ?? '') !== record.requestId);
  state.processedInteractions.push(record);
  if (state.processedInteractions.length > MAX_PROCESSED_INTERACTIONS) {
    state.processedInteractions.splice(0, state.processedInteractions.length - MAX_PROCESSED_INTERACTIONS);
  }
}

export function createContinuationRequest({
  source,
  requestId,
  threadId,
  cwd,
  text,
  channelId,
  replyToMessageId,
  createdAt = new Date().toISOString(),
}) {
  const normalizedSource = String(source ?? '');
  if (!['reply', 'slash'].includes(normalizedSource)) throw new Error('Continuation source is invalid');
  if (!String(requestId ?? '').trim()) throw new Error('Continuation requestId is empty');
  if (!String(threadId ?? '').trim()) throw new Error('Continuation threadId is empty');
  if (!String(text ?? '').trim()) throw new Error('Continuation text is blank');
  if (String(text).length > 4_000) throw new Error('Continuation text is too long');
  if (normalizedSource === 'reply' && (!String(channelId ?? '').trim() || !String(replyToMessageId ?? '').trim())) {
    throw new Error('Reply continuation target is incomplete');
  }
  return {
    source: normalizedSource,
    requestId: String(requestId),
    threadId: String(threadId),
    cwd: String(cwd ?? '') || undefined,
    text: String(text),
    channelId: String(channelId ?? '') || undefined,
    replyToMessageId: String(replyToMessageId ?? '') || undefined,
    createdAt: String(createdAt),
  };
}

export function migrateInboxState(candidate) {
  const state = candidate && typeof candidate === 'object' ? candidate : {};
  state.version = 2;
  state.initialized = Boolean(state.initialized);
  state.cursors = state.cursors && typeof state.cursors === 'object' ? state.cursors : {};
  state.processedMessageIds = Array.isArray(state.processedMessageIds) ? state.processedMessageIds.map(String).slice(-2_000) : [];
  state.pendingContinuations = state.pendingContinuations && typeof state.pendingContinuations === 'object'
    ? state.pendingContinuations
    : {};
  state.processedInteractions = Array.isArray(state.processedInteractions)
    ? state.processedInteractions.slice(-MAX_PROCESSED_INTERACTIONS)
    : [];
  state.createdTasksByInteraction = state.createdTasksByInteraction && typeof state.createdTasksByInteraction === 'object'
    ? state.createdTasksByInteraction
    : {};
  pruneCreatedTaskHistory(state);

  pruneContinuationHistory(state);

  for (const pending of Object.values(state.pendingReplies ?? {})) {
    const mapping = pending?.mapping ?? {};
    const requestId = String(pending?.messageId ?? '');
    const threadId = String(mapping?.threadId ?? pending?.threadId ?? '');
    if (!requestId || !threadId) continue;
    enqueueContinuation(state, {
      source: 'reply',
      requestId,
      threadId,
      cwd: String(mapping?.cwd ?? pending?.cwd ?? '') || undefined,
      text: String(pending?.text ?? ''),
      encryptedText: String(pending?.encryptedText ?? '') || undefined,
      summary: continuationSummary(pending?.summary ?? pending?.text),
      channelId: String(pending?.channelId ?? '') || undefined,
      replyToMessageId: requestId,
      referencedMessageId: String(pending?.referencedMessageId ?? '') || undefined,
      mapping: structuredClone(mapping),
      createdAt: String(pending?.queuedAt ?? pending?.createdAt ?? new Date().toISOString()),
      queuedAt: String(pending?.queuedAt ?? pending?.createdAt ?? new Date().toISOString()),
      lastAttemptAt: String(pending?.lastAttemptAt ?? '') || undefined,
      attempts: Number(pending?.attempts ?? 0),
      status: 'queued',
    });
  }
  delete state.pendingReplies;
  return state;
}

export function enqueueContinuation(state, request) {
  if (!state || typeof state !== 'object') throw new Error('Continuation state is required');
  if (state.version !== 2 || !state.pendingContinuations) migrateInboxState(state);
  const source = String(request?.source ?? '');
  const requestId = String(request?.requestId ?? '');
  const threadId = String(request?.threadId ?? '');
  if (!['reply', 'slash'].includes(source) || !requestId || !threadId) throw new Error('Continuation request is invalid');
  const duplicate = Object.values(state.pendingContinuations).find((item) =>
    String(item?.source) === source && String(item?.requestId) === requestId);
  if (duplicate) return duplicate;
  const queueId = continuationQueueId(source, requestId);
  const createdAt = String(request?.createdAt ?? new Date().toISOString());
  const entry = {
    queueId,
    source,
    requestId,
    threadId,
    cwd: String(request?.cwd ?? '') || undefined,
    encryptedText: String(request?.encryptedText ?? '') || undefined,
    summary: continuationSummary(request?.summary ?? request?.text),
    channelId: String(request?.channelId ?? '') || undefined,
    replyToMessageId: String(request?.replyToMessageId ?? '') || undefined,
    referencedMessageId: String(request?.referencedMessageId ?? '') || undefined,
    mapping: request?.mapping ? structuredClone(request.mapping) : undefined,
    createdAt,
    queuedAt: String(request?.queuedAt ?? createdAt),
    lastAttemptAt: String(request?.lastAttemptAt ?? '') || undefined,
    attempts: Math.max(0, Number(request?.attempts ?? 0)),
    status: CONTINUATION_STATUSES.has(String(request?.status)) ? String(request.status) : 'queued',
  };
  state.pendingContinuations[queueId] = entry;
  if (source === 'slash') recordProcessedInteraction(state, requestId, { status: 'queued', queueId }, entry.queuedAt);
  return entry;
}

export function listContinuations(state) {
  return Object.values(state?.pendingContinuations ?? {}).sort((left, right) => {
    const byTime = String(left?.createdAt ?? '').localeCompare(String(right?.createdAt ?? ''));
    return byTime || String(left?.queueId ?? '').localeCompare(String(right?.queueId ?? ''));
  });
}

export function listRetryableContinuations(state) {
  return listContinuations(state).filter((item) =>
    item?.status === 'queued' || (item?.source === 'reply' && item?.status === 'confirmed-start'));
}

export function cancelContinuation(state, queueId, now = new Date().toISOString()) {
  const item = state?.pendingContinuations?.[String(queueId)];
  if (!item) return { status: 'not-found' };
  if (item.status === 'cancelled') return { status: 'already-cancelled', queueId: item.queueId };
  if (item.status !== 'queued') return { status: 'already-started', queueId: item.queueId };
  item.status = 'cancelled';
  item.cancelledAt = String(now);
  if (item.source === 'slash') recordProcessedInteraction(state, item.requestId, { status: 'failed', queueId: item.queueId, reason: 'cancelled' }, now);
  const result = { status: 'cancelled', queueId: item.queueId };
  pruneContinuationHistory(state);
  return result;
}

export async function cancelContinuationPersisted({ state, queueId, now = new Date().toISOString(), persistState }) {
  return persistMutation(state, persistState, () => cancelContinuation(state, queueId, now), [String(queueId)]);
}

export function recoverContinuationAttempts(state, now = new Date().toISOString()) {
  migrateInboxState(state);
  for (const item of Object.values(state.pendingContinuations)) {
    if (item?.status === 'resuming') {
      item.status = 'queued';
      item.failureReason = undefined;
      if (item.source === 'slash') {
        recordProcessedInteraction(state, item.requestId, { status: 'queued', queueId: item.queueId }, now);
      }
    } else if (['submitting', 'attempting', 'start-submitted'].includes(item?.status)) {
      item.status = 'start-uncertain';
      item.uncertainAt = String(now);
      item.failureReason = 'start-outcome-uncertain';
      if (item.source === 'slash') {
        recordProcessedInteraction(state, item.requestId, {
          status: 'uncertain', queueId: item.queueId, reason: 'start-outcome-uncertain',
        }, now);
      }
    } else if (item?.status === 'acknowledging') {
      item.status = 'confirmed-start';
    }
  }
  pruneContinuationHistory(state);
  return state;
}

export function markContinuationDelivered(state, queueId, now = new Date().toISOString()) {
  const item = state?.pendingContinuations?.[String(queueId)];
  if (!item) return { status: 'not-found' };
  if (item.status === 'cancelled') return { status: 'cancelled', queueId: item.queueId };
  item.status = 'delivered';
  item.deliveredAt = String(now);
  pruneContinuationHistory(state);
  return item;
}

export async function initializeInboxCursors({ state, channelIds, getLatest }) {
  migrateInboxState(state);
  for (const channelId of channelIds.map(String)) {
    if (!state.cursors[channelId]) {
      state.cursors[channelId] = String(await getLatest(channelId));
    }
  }
  state.initialized = true;
  return state;
}

export function isActiveWriterError(error) {
  return /already has an active writer/i.test(String(error?.message ?? error ?? ''));
}

async function acknowledgeContinuation(dependencies, request, content) {
  if (request.source !== 'reply' || typeof dependencies.sendReply !== 'function') return false;
  await dependencies.sendReply({
    channelId: request.channelId,
    replyToMessageId: request.replyToMessageId ?? request.requestId,
    content,
  });
  return true;
}

async function deliverConfirmedReply(state, item, dependencies, now, queuedDelivery = false) {
  let claim;
  try {
    claim = await commitInboxState({
      state,
      persistState: dependencies.persistState,
      entries: { pendingContinuations: [item.queueId] },
      mutate: () => {
        const current = state.pendingContinuations[item.queueId];
        if (current?.status === 'delivered') return { kind: 'delivered', item: structuredClone(current) };
        if (current?.status !== 'confirmed-start' || current?.source !== 'reply') {
          return { kind: 'unavailable', item: current ? structuredClone(current) : null };
        }
        current.status = 'acknowledging';
        current.ackClaimedAt = now;
        return { kind: 'claimed', item: structuredClone(current) };
      },
      errorMessage: 'Continuation acknowledgement claim persistence failed',
    });
  } catch {
    return { status: 'started', queueId: item.queueId, turnId: item.turnId, reason: 'state-persist-failed' };
  }
  const current = claim?.item;
  const result = { status: 'started', queueId: item.queueId, turnId: current?.turnId ?? item.turnId };
  if (claim?.kind === 'delivered') return result;
  if (claim?.kind !== 'claimed') {
    return {
      status: current?.status === 'start-uncertain' ? 'uncertain' : 'failed',
      queueId: item.queueId,
      reason: ['resuming', 'submitting', 'attempting', 'start-submitted', 'acknowledging'].includes(current?.status)
        ? 'attempt-in-progress'
        : current?.failureReason ?? current?.status ?? 'not-found',
    };
  }

  let acknowledged = false;
  try {
    acknowledged = await acknowledgeContinuation(
      dependencies,
      current,
      `✅ ${queuedDelivery ? '排队回复现已送达' : '已送达'}原 Codex 任务（…${String(current.threadId).slice(-8)}），已开始继续执行。`,
    );
  } catch {
    acknowledged = false;
  }
  try {
    await commitInboxState({
      state,
      persistState: dependencies.persistState,
      entries: { pendingContinuations: [item.queueId] },
      mutate: () => {
        const latest = state.pendingContinuations[item.queueId];
        if (latest?.status !== 'acknowledging') return;
        if (acknowledged) markContinuationDelivered(state, item.queueId, now);
        else {
          latest.status = 'confirmed-start';
          delete latest.ackClaimedAt;
        }
      },
      errorMessage: 'Continuation acknowledgement persistence failed',
    });
  } catch {
    try {
      await commitInboxState({
        state,
        persistState: dependencies.persistState,
        entries: { pendingContinuations: [item.queueId] },
        mutate: () => {
          const latest = state.pendingContinuations[item.queueId];
          if (latest?.status === 'acknowledging') {
            latest.status = 'confirmed-start';
            delete latest.ackClaimedAt;
          }
        },
        errorMessage: 'Continuation acknowledgement release persistence failed',
      });
    } catch {
      await withInboxStateLock(state, () => {
        const latest = state.pendingContinuations[item.queueId];
        if (latest?.status === 'acknowledging') {
          latest.status = 'confirmed-start';
          delete latest.ackClaimedAt;
        }
      });
    }
    return { ...result, reason: 'state-persist-failed' };
  }
  return acknowledged ? result : { ...result, reason: 'ack-failed' };
}

export async function dispatchContinuation(request, dependencies = {}) {
  const candidate = dependencies.state ?? createEmptyInboxState();
  const state = candidate?.version === 2 && candidate.pendingContinuations &&
      Array.isArray(candidate.processedInteractions) && candidate.createdTasksByInteraction
    ? candidate
    : migrateInboxState(candidate);
  dependencies.state = state;
  const now = String(typeof dependencies.now === 'function' ? dependencies.now() : new Date().toISOString());
  const source = String(request?.source ?? '');
  const requestId = String(request?.requestId ?? '');
  let existing = listContinuations(state).find((item) => item.source === source && item.requestId === requestId);
  const wasQueuedRequest = Boolean(existing);
  const isQueuedRetry = Boolean(request?.queueId && existing?.queueId === String(request.queueId));
  if (existing?.status === 'start-uncertain') {
    return { status: 'uncertain', queueId: existing.queueId, reason: 'start-outcome-uncertain' };
  }
  if (existing?.source === 'reply' && existing.status === 'confirmed-start') {
    return deliverConfirmedReply(state, existing, dependencies, now);
  }
  if (!isQueuedRetry) {
    if (existing) {
      if (['confirmed-start', 'delivered'].includes(existing.status)) {
        return { status: 'started', queueId: existing.queueId, turnId: existing.turnId };
      }
      if (existing.status === 'queued') return { status: 'queued', queueId: existing.queueId };
      return { status: 'failed', queueId: existing.queueId, reason: ['resuming', 'submitting', 'attempting', 'start-submitted', 'acknowledging'].includes(existing.status) ? 'attempt-in-progress' : existing.failureReason ?? existing.status };
    }
    const processed = source === 'slash' ? processedInteraction(state, requestId) : null;
    if (processed) {
      return {
        status: processed.status,
        queueId: processed.queueId,
        turnId: processed.turnId,
        reason: processed.reason,
      };
    }
  }
  if (existing && existing.status !== 'queued') {
    return {
      status: ['confirmed-start', 'delivered'].includes(existing.status) ? 'started' : 'failed',
      queueId: existing.queueId,
      turnId: existing.turnId,
      reason: ['resuming', 'submitting', 'attempting', 'start-submitted', 'acknowledging'].includes(existing.status) ? 'attempt-in-progress' : existing.failureReason ?? existing.status,
    };
  }

  const target = existing ?? request;
  let continuationText = String(request?.text ?? '');
  if (!continuationText && target?.encryptedText && typeof dependencies.decryptText === 'function') {
    continuationText = String(await dependencies.decryptText(target.encryptedText));
  }
  let normalized;
  try {
    normalized = createContinuationRequest({
      source,
      requestId,
      threadId: target?.threadId,
      cwd: target?.cwd,
      text: continuationText,
      channelId: target?.channelId,
      replyToMessageId: target?.replyToMessageId ?? target?.requestId,
      createdAt: target?.createdAt ?? now,
    });
  } catch {
    const result = { status: 'failed', reason: 'invalid-request' };
    if (source === 'slash') {
      try {
        await commitInboxState({
          state,
          persistState: dependencies.persistState,
          fields: ['processedInteractions'],
          mutate: () => recordProcessedInteraction(state, requestId, result, now),
          errorMessage: 'Continuation state persistence failed',
        });
      } catch {
        return { status: 'failed', reason: 'state-persist-failed' };
      }
    }
    return result;
  }

  if (!existing) {
    let encryptedText;
    try {
      encryptedText = await dependencies.encryptText?.(normalized.text);
    } catch {
      return { status: 'failed', reason: 'encryption-unavailable' };
    }
    if (!String(encryptedText ?? '').trim()) return { status: 'failed', reason: 'encryption-unavailable' };
    try {
      await persistMutation(state, dependencies.persistState, () => enqueueContinuation(state, {
        ...normalized,
        encryptedText: String(encryptedText),
        queuedAt: now,
        attempts: 0,
        status: 'queued',
      }), [continuationQueueId(source, requestId)]);
    } catch {
      return { status: 'failed', reason: 'state-persist-failed' };
    }
    existing = listContinuations(state).find((item) => item.source === source && item.requestId === requestId);
  }

  let claimObservation;
  try {
    await commitInboxState({
      state,
      persistState: dependencies.persistState,
      fields: ['processedInteractions'],
      entries: { pendingContinuations: [existing.queueId] },
      mutate: () => {
        const current = state.pendingContinuations[existing.queueId];
        if (!current || current.status !== 'queued') {
          claimObservation = current ? structuredClone(current) : null;
          return;
        }
        current.status = 'resuming';
        current.lastAttemptAt = now;
        current.attempts = Number(current.attempts ?? 0) + 1;
        if (source === 'slash') recordProcessedInteraction(state, requestId, { status: 'resuming', queueId: current.queueId }, now);
      },
      errorMessage: 'Continuation state persistence failed',
    });
  } catch {
    return { status: 'failed', queueId: existing.queueId, reason: 'state-persist-failed' };
  }
  if (claimObservation !== undefined) {
    if (claimObservation?.status === 'start-uncertain') {
      return { status: 'uncertain', queueId: existing.queueId, reason: 'start-outcome-uncertain' };
    }
    if (claimObservation?.source === 'reply' && claimObservation.status === 'confirmed-start') {
      return deliverConfirmedReply(state, claimObservation, dependencies, now);
    }
    if (['confirmed-start', 'delivered'].includes(claimObservation?.status)) {
      return { status: 'started', queueId: existing.queueId, turnId: claimObservation.turnId };
    }
    return {
      status: 'failed',
      queueId: existing.queueId,
      reason: ['resuming', 'submitting', 'attempting', 'start-submitted', 'acknowledging'].includes(claimObservation?.status)
        ? 'attempt-in-progress'
        : claimObservation?.failureReason ?? claimObservation?.status ?? 'not-found',
    };
  }

  const resume = dependencies.resumeCodexThread ?? resumeCodexThread;
  let started;
  const onStartSubmitting = async () => {
    await commitInboxState({
      state,
      persistState: dependencies.persistState,
      fields: ['processedInteractions'],
      entries: { pendingContinuations: [existing.queueId] },
      mutate: () => {
        const current = state.pendingContinuations[existing.queueId];
        if (!current || current.status !== 'resuming') throw new Error('Continuation claim was lost');
        current.status = 'submitting';
        current.submittingAt = now;
        if (source === 'slash') recordProcessedInteraction(state, requestId, { status: 'attempting', queueId: current.queueId }, now);
      },
      errorMessage: 'Continuation submission intent persistence failed',
    });
  };
  const onStartSubmitted = async () => {
    await commitInboxState({
      state,
      persistState: dependencies.persistState,
      fields: ['processedInteractions'],
      entries: { pendingContinuations: [existing.queueId] },
      mutate: () => {
        const current = state.pendingContinuations[existing.queueId];
        if (!current || !['resuming', 'submitting'].includes(current.status)) throw new Error('Continuation claim was lost');
        current.status = 'start-submitted';
        current.submittedAt = now;
        if (source === 'slash') recordProcessedInteraction(state, requestId, { status: 'attempting', queueId: current.queueId }, now);
      },
      errorMessage: 'Continuation submission state persistence failed',
    });
  };
  try {
    started = await resume({
      threadId: normalized.threadId,
      cwd: normalized.cwd,
      processCwd: normalized.cwd ?? dependencies.processCwd,
      text: normalized.text,
      codexPath: dependencies.codexPath,
      clientFactory: dependencies.clientFactory,
      onStartSubmitting,
      onStartSubmitted,
    });
  } catch (error) {
    if (isActiveWriterError(error)) {
      try {
        await persistMutation(state, dependencies.persistState, () => {
          const queued = state.pendingContinuations[existing.queueId];
          queued.status = 'queued';
          if (source === 'slash') recordProcessedInteraction(state, requestId, { status: 'queued', queueId: queued.queueId }, now);
        }, [existing.queueId]);
      } catch {
        await withInboxStateLock(state, () => {
          const current = state.pendingContinuations[existing.queueId];
          if (current?.status === 'resuming') current.status = 'queued';
          if (source === 'slash') {
            recordProcessedInteraction(state, requestId, { status: 'queued', queueId: existing.queueId }, now);
          }
        });
        return { status: 'failed', queueId: existing.queueId, reason: 'state-persist-failed' };
      }
      const result = { status: 'queued', queueId: existing.queueId };
      if (!wasQueuedRequest) {
        await acknowledgeContinuation(
          dependencies,
          normalized,
          '⏳ 已排队：原 Codex 任务目前正被桌面端占用；任务释放后会自动送达，无需再次回复。',
        ).catch(() => {});
      }
      return result;
    }
    if (error?.submissionStage === 'post-submit') {
      try {
        await persistMutation(state, dependencies.persistState, () => {
          const uncertain = state.pendingContinuations[existing.queueId];
          uncertain.status = 'start-uncertain';
          uncertain.uncertainAt = now;
          uncertain.failureReason = 'start-outcome-uncertain';
          if (source === 'slash') recordProcessedInteraction(state, requestId, {
            status: 'uncertain', queueId: uncertain.queueId, reason: 'start-outcome-uncertain',
          }, now);
        }, [existing.queueId]);
      } catch {
        return { status: 'uncertain', queueId: existing.queueId, reason: 'state-persist-failed' };
      }
      return { status: 'uncertain', queueId: existing.queueId, reason: 'start-outcome-uncertain' };
    }
    try {
      await persistMutation(state, dependencies.persistState, () => {
        const failed = state.pendingContinuations[existing.queueId];
        failed.status = 'failed';
        failed.failedAt = now;
        failed.failureReason = 'resume-failed';
        if (source === 'slash') recordProcessedInteraction(state, requestId, { status: 'failed', queueId: failed.queueId, reason: 'resume-failed' }, now);
      }, [existing.queueId]);
    } catch {
      return { status: 'failed', queueId: existing.queueId, reason: 'state-persist-failed' };
    }
    return { status: 'failed', queueId: existing.queueId, reason: 'resume-failed' };
  }

  const turnId = String(started?.turnId ?? '') || undefined;
  const result = { status: 'started', queueId: existing.queueId, turnId };
  try {
    await persistMutation(state, dependencies.persistState, () => {
      const confirmed = state.pendingContinuations[existing.queueId];
      confirmed.status = source === 'slash' ? 'delivered' : 'confirmed-start';
      confirmed.confirmedAt = now;
      if (source === 'slash') confirmed.deliveredAt = now;
      confirmed.turnId = turnId;
      if (source === 'slash') recordProcessedInteraction(state, requestId, result, now);
    }, [existing.queueId]);
  } catch {
    await withInboxStateLock(state, () => {
      const current = state.pendingContinuations[existing.queueId];
      if (!current || ['delivered', 'cancelled'].includes(current.status)) return;
      current.status = 'start-uncertain';
      current.uncertainAt = now;
      current.failureReason = 'start-outcome-uncertain';
      current.turnId = turnId;
      if (source === 'slash') recordProcessedInteraction(state, requestId, {
        status: 'uncertain', queueId: existing.queueId, turnId, reason: 'start-outcome-uncertain',
      }, now);
    });
    try {
      await dependencies.trackCompletion?.(started, normalized);
    } catch {
      // The external turn remains started even when local tracking cannot attach.
    }
    return { ...result, reason: 'state-persist-failed' };
  }
  try {
    await dependencies.trackCompletion?.(started, normalized);
  } catch {
    // A confirmed external turn remains started even when local tracking cannot attach.
  }
  if (source === 'reply') {
    return deliverConfirmedReply(state, state.pendingContinuations[existing.queueId], dependencies, now, wasQueuedRequest);
  }
  return result;
}

export function enqueuePendingReply(state, accepted, attemptedAt = new Date().toISOString(), encryptedText) {
  if (!String(encryptedText ?? '').trim()) throw new Error('Pending reply text must be encrypted before it is persisted');
  const messageId = String(accepted.messageId);
  const existing = listContinuations(migrateInboxState(state)).find((item) => item.source === 'reply' && item.requestId === messageId);
  if (existing) {
    existing.encryptedText = String(encryptedText);
    existing.lastAttemptAt = String(attemptedAt);
    existing.attempts = Number(existing.attempts ?? 0) + 1;
    return existing;
  }
  return enqueueContinuation(state, {
    source: 'reply',
    requestId: messageId,
    threadId: String(accepted.mapping?.threadId ?? ''),
    cwd: String(accepted.mapping?.cwd ?? '') || undefined,
    text: String(accepted.text ?? ''),
    encryptedText: String(encryptedText),
    messageId,
    referencedMessageId: String(accepted.referencedMessageId ?? ''),
    channelId: String(accepted.channelId),
    replyToMessageId: messageId,
    mapping: structuredClone(accepted.mapping),
    createdAt: String(attemptedAt),
    queuedAt: String(attemptedAt),
    lastAttemptAt: String(attemptedAt),
    attempts: 1,
  });
}

export function getPendingReplies(state) {
  return listContinuations(state)
    .filter((item) => item.source === 'reply' && item.status === 'queued')
    .map((item) => ({ ...item, messageId: item.requestId }))
    .sort((left, right) => compareSnowflakes(left.messageId, right.messageId));
}

export async function migrateLegacyPendingReplies({ state, encryptText }) {
  const pendingValues = [
    ...Object.values(state?.pendingReplies ?? {}),
    ...Object.values(state?.pendingContinuations ?? {}),
  ];
  for (const pending of pendingValues) {
    if (!Object.hasOwn(pending, 'text')) continue;
    try {
      const encryptedText = await encryptText(String(pending.text ?? ''));
      if (!encryptedText) throw new Error('empty ciphertext');
      pending.encryptedText = String(encryptedText);
      delete pending.text;
    } catch {
      throw new Error('Legacy pending reply encryption is unavailable; state was not rewritten');
    }
  }
  return state;
}

export function removePendingReply(state, messageId) {
  migrateInboxState(state);
  for (const [queueId, pending] of Object.entries(state.pendingContinuations)) {
    if (pending?.source === 'reply' && String(pending?.requestId) === String(messageId)) delete state.pendingContinuations[queueId];
  }
  return state;
}

export function recordInboxMessage(state, channelId, messageId, processed) {
  state.cursors ??= {};
  state.processedMessageIds ??= [];
  const current = String(state.cursors[channelId] ?? '0');
  if (compareSnowflakes(current, messageId) < 0) state.cursors[channelId] = String(messageId);
  if (processed && !state.processedMessageIds.map(String).includes(String(messageId))) {
    state.processedMessageIds.push(String(messageId));
    if (state.processedMessageIds.length > 2000) {
      state.processedMessageIds.splice(0, state.processedMessageIds.length - 2000);
    }
  }
  return state;
}

export function classifyReply(message, config, mappingState, inboxState) {
  const reject = (reason) => ({ accepted: false, reason });
  if (!message || typeof message !== 'object') return reject('invalid-message');
  if (message.guild_id !== undefined && message.guild_id !== null &&
      String(message.guild_id) !== String(config.discordGuildId ?? '')) return reject('wrong-guild');

  const channelId = String(message.channel_id ?? '');
  const allowedChannels = new Set([
    String(config.discordTaskChannelId ?? ''),
    String(config.discordConfirmationChannelId ?? ''),
  ]);
  if (!allowedChannels.has(channelId)) return reject('wrong-channel');
  if (channelId === String(config.discordQuotaChannelId ?? '')) return reject('quota-channel');

  const author = message.author ?? {};
  if (author.bot) return reject('bot-author');
  if (String(author.id ?? '') !== String(config.discordAllowedUserId ?? '')) return reject('unauthorized-user');

  const messageId = String(message.id ?? '');
  if ((inboxState?.processedMessageIds ?? []).map(String).includes(messageId)) return reject('duplicate-message');

  const text = String(message.content ?? '').trim();
  if (!text) return reject('empty-text');

  const reference = message.message_reference;
  const referencedMessageId = String(reference?.message_id ?? '');
  if (!referencedMessageId) return reject('not-a-reply');
  if (reference?.guild_id && String(reference.guild_id) !== String(config.discordGuildId ?? '')) return reject('reference-wrong-guild');
  if (reference?.channel_id && String(reference.channel_id) !== channelId) return reject('reference-wrong-channel');

  const mapped = mappingState?.messages?.[referencedMessageId];
  if (!mapped) return reject('unknown-reference');
  if (String(mapped.channelId ?? '') !== channelId) return reject('mapping-channel-mismatch');
  if (!['user-task-complete', 'user-task-confirmation-required'].includes(String(mapped.eventName ?? ''))) {
    return reject('mapping-event-not-actionable');
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(mapped.threadId ?? ''))) return reject('invalid-thread-id');

  return {
    accepted: true,
    messageId,
    referencedMessageId,
    channelId,
    text,
    mapping: mapped,
  };
}

export function buildCodexAppServerMessages({ threadId, cwd, text }) {
  const resumeParams = { threadId };
  const turnParams = {
    threadId,
    input: [{ type: 'text', text }],
  };
  if (cwd) {
    resumeParams.cwd = cwd;
    turnParams.cwd = cwd;
  }
  return [
    {
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'codex-discord-bridge',
          version: '1.0.0',
        },
      },
    },
    { method: 'initialized', params: {} },
    { method: 'thread/resume', id: 2, params: resumeParams },
    { method: 'turn/start', id: 3, params: turnParams },
  ];
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== null) return structuredClone(fallback);
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function resolveCodexExecutable({
  configuredPath = 'codex',
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
  const configured = String(configuredPath ?? '').trim() || 'codex';
  if (path.isAbsolute(configured)) {
    try {
      if ((await fs.stat(configured)).isFile()) return configured;
    } catch {
      // Continue to the installed Codex discovery path.
    }
  }

  if (localAppData) {
    const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    try {
      const entries = await fs.readdir(binRoot, { withFileTypes: true });
      const candidates = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(binRoot, entry.name, 'codex.exe');
        try {
          const info = await fs.stat(candidate);
          if (info.isFile()) candidates.push({ candidate, modified: info.mtimeMs });
        } catch {
          // An incomplete or concurrently replaced installation is ignored.
        }
      }
      candidates.sort((left, right) => right.modified - left.modified || right.candidate.localeCompare(left.candidate));
      if (candidates.length > 0) return candidates[0].candidate;
    } catch {
      // Fall back to the configured command when discovery is unavailable.
    }
  }
  return configured;
}

export async function resolvePowerShellExecutable({
  programFiles = process.env.ProgramFiles,
} = {}) {
  if (programFiles) {
    const installed = path.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
    try {
      if ((await fs.stat(installed)).isFile()) return installed;
    } catch {
      // Fall back to PATH when PowerShell 7 is installed elsewhere.
    }
  }
  return 'pwsh';
}

export async function discordRequest({ token, route, method = 'GET', body, fetchImpl = fetch, maxRetries = 5 }) {
  const url = `https://discord.com/api/v10${route}`;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'DiscordBot (https://github.com/openai/codex, 1.0.0)',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429 && attempt < maxRetries) {
      const rateLimit = await response.json().catch(() => ({}));
      const delayMs = Math.max(250, Math.ceil(Number(rateLimit.retry_after ?? 1) * 1000));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    if (!response.ok) {
      throw new Error(`Discord API request failed with HTTP ${response.status}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }
  throw new Error('Discord API retry limit exceeded');
}

export async function getLatestDiscordMessageId({ token, channelId, fetchImpl = fetch }) {
  const messages = await discordRequest({
    token,
    route: `/channels/${channelId}/messages?limit=1`,
    fetchImpl,
  });
  return Array.isArray(messages) && messages.length > 0 ? String(messages[0].id) : '0';
}

export async function getDiscordMessagesAfter({ token, channelId, after = '0', fetchImpl = fetch }) {
  const messages = await discordRequest({
    token,
    route: `/channels/${channelId}/messages?after=${encodeURIComponent(after)}&limit=100`,
    fetchImpl,
  });
  return (Array.isArray(messages) ? messages : []).sort((a, b) => compareSnowflakes(a.id, b.id));
}

export async function sendDiscordReply({ token, channelId, replyToMessageId, content, fetchImpl = fetch }) {
  return discordRequest({
    token,
    route: `/channels/${channelId}/messages`,
    method: 'POST',
    fetchImpl,
    body: {
      content: String(content).slice(0, 2000),
      allowed_mentions: { parse: [] },
      message_reference: {
        message_id: replyToMessageId,
        channel_id: channelId,
        fail_if_not_exists: false,
      },
    },
  });
}

export async function loadDiscordToken({ toolDir, powershellPath = 'pwsh' }) {
  const helperPath = path.join(toolDir, 'get-discord-token.ps1');
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath, ['-NoProfile', '-File', helperPath], {
      cwd: toolDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => reject(new Error('Unable to start the Discord token helper')));
    child.on('close', (code) => {
      const token = stdout.trim();
      stdout = '';
      if (code !== 0 || !token) {
        reject(new Error('Unable to decrypt the Discord Bot token for this Windows account'));
        return;
      }
      resolve(token);
    });
  });
}

async function transformPendingReplyText({ toolDir, powershellPath = 'pwsh', scriptName, value }) {
  const helperPath = path.join(toolDir, scriptName);
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath, ['-NoProfile', '-File', helperPath], {
      cwd: toolDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => reject(new Error('Unable to start the Discord pending-reply secret helper')));
    child.on('close', (code) => {
      if (code !== 0 || !stdout) reject(new Error('Unable to process Discord pending-reply text for this Windows account'));
      else resolve(stdout);
    });
    child.stdin.end(String(value));
  });
}

export function encryptPendingReplyText({ toolDir, powershellPath = 'pwsh', text }) {
  return transformPendingReplyText({ toolDir, powershellPath, scriptName: 'protect-discord-pending-reply.ps1', value: text });
}

export function decryptPendingReplyText({ toolDir, powershellPath = 'pwsh', ciphertext }) {
  return transformPendingReplyText({ toolDir, powershellPath, scriptName: 'unprotect-discord-pending-reply.ps1', value: ciphertext });
}

function boundedPositiveInteger(value, fallback, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(numeric)));
}

export class AppServerClient {
  constructor({
    codexPath,
    cwd,
    spawnImpl = spawn,
    earlyCompletionMax = 100,
    earlyCompletionTtlMs = 5 * 60 * 1000,
    now = Date.now,
  }) {
    this.child = spawnImpl(codexPath, ['app-server', '--stdio'], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.pending = new Map();
    this.completedTurns = new Map();
    this.earlyCompletedTurns = new Map();
    this.earlyCompletionMax = boundedPositiveInteger(earlyCompletionMax, 100, 1_000);
    this.earlyCompletionTtlMs = boundedPositiveInteger(earlyCompletionTtlMs, 5 * 60 * 1000, 60 * 60 * 1000);
    this.now = now;
    this.closed = false;
    this.exitError = null;

    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.#handleLine(line));
    this.child.on('error', () => this.#closeWithError(new Error('Unable to start Codex App Server')));
    this.child.on('close', (code) => {
      if (!this.closed && code !== 0) this.#closeWithError(new Error(`Codex App Server exited with code ${code}`));
      else this.#closeWithError(null);
    });
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(`Codex App Server rejected ${pending.method}: ${message.error.message ?? 'unknown error'}`);
        error.appServerRejected = true;
        error.requestSubmitted = true;
        error.method = pending.method;
        pending.reject(error);
      }
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'turn/completed') {
      const turnId = String(message.params?.turn?.id ?? '');
      if (!turnId) return;
      const completion = this.completedTurns.get(turnId);
      if (completion) {
        this.completedTurns.delete(turnId);
        clearTimeout(completion.timer);
        completion.resolve(message.params);
      } else {
        this.#pruneEarlyCompletions();
        this.earlyCompletedTurns.delete(turnId);
        this.earlyCompletedTurns.set(turnId, {
          params: message.params,
          receivedAt: Number(this.now()),
        });
        while (this.earlyCompletedTurns.size > this.earlyCompletionMax) {
          this.earlyCompletedTurns.delete(this.earlyCompletedTurns.keys().next().value);
        }
      }
    }
  }

  #pruneEarlyCompletions() {
    const cutoff = Number(this.now()) - this.earlyCompletionTtlMs;
    for (const [turnId, completion] of this.earlyCompletedTurns) {
      if (completion.receivedAt > cutoff) continue;
      this.earlyCompletedTurns.delete(turnId);
    }
  }

  #closeWithError(error) {
    if (this.closed) return;
    this.closed = true;
    this.exitError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      const pendingError = error ?? new Error('Codex App Server connection closed');
      pendingError.requestSubmitted = true;
      pendingError.method = pending.method;
      pending.reject(pendingError);
    }
    this.pending.clear();
    for (const completion of this.completedTurns.values()) {
      clearTimeout(completion.timer);
      completion.reject(error ?? new Error('Codex App Server connection closed before turn completion'));
    }
    this.completedTurns.clear();
    this.earlyCompletedTurns.clear();
  }

  send(message) {
    if (this.closed) throw this.exitError ?? new Error('Codex App Server connection is closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(message, timeoutMs = 30_000, { onSubmitted } = {}) {
    const key = String(message.id);
    let timer;
    const response = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(key);
        const error = new Error(`Codex App Server timed out waiting for ${message.method}`);
        error.requestSubmitted = true;
        error.method = message.method;
        reject(error);
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer, method: message.method });
      try {
        this.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(key);
        error.requestSubmitted = false;
        error.method = message.method;
        reject(error);
      }
    });
    if (typeof onSubmitted !== 'function') return response;
    return Promise.resolve()
      .then(() => onSubmitted())
      .then(() => response)
      .catch((error) => {
        clearTimeout(timer);
        this.pending.delete(key);
        error.requestSubmitted ??= true;
        error.method ??= message.method;
        throw error;
      });
  }

  waitForTurn(turnId, timeoutMs = 24 * 60 * 60 * 1000) {
    this.#pruneEarlyCompletions();
    const early = this.earlyCompletedTurns.get(turnId);
    if (early) {
      this.earlyCompletedTurns.delete(turnId);
      return Promise.resolve(early.params);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.completedTurns.delete(turnId);
        reject(new Error('Codex turn completion timed out'));
      }, timeoutMs);
      this.completedTurns.set(turnId, { resolve, reject, timer });
    });
  }

  close() {
    if (this.closed) return;
    this.child.stdin.end();
    setTimeout(() => {
      if (!this.closed) this.child.kill();
    }, 2000).unref();
  }

  cancel() {
    if (this.closed) return;
    this.child.kill();
  }
}

export async function initializeAppServerClient(client) {
  await client.request({
    method: 'initialize',
    id: 1,
    params: { clientInfo: { name: 'codex-discord-bridge', version: '1.0.0' } },
  });
  client.send({ method: 'initialized', params: {} });
}

export async function resumeCodexThread({
  threadId,
  cwd,
  processCwd = cwd,
  text,
  codexPath,
  clientFactory,
  onStartSubmitting,
  onStartSubmitted,
}) {
  const client = clientFactory
    ? clientFactory({ codexPath, cwd: processCwd })
    : new AppServerClient({ codexPath, cwd: processCwd });
  let released = false;
  const close = () => {
    if (released) return;
    released = true;
    client.close?.();
  };
  const cancel = () => {
    if (released) return;
    released = true;
    if (typeof client.cancel === 'function') client.cancel();
    else client.close?.();
  };
  const messages = buildCodexAppServerMessages({ threadId, cwd, text });
  try {
    await initializeAppServerClient(client);
    const resumed = await client.request(messages[2]);
    const resumedThreadId = String(resumed?.thread?.id ?? '');
    if (resumedThreadId !== threadId) throw new Error('Codex App Server resumed a different thread');
    await onStartSubmitting?.();
    let started;
    try {
      started = await client.request(messages[3], 30_000, { onSubmitted: onStartSubmitted });
    } catch (error) {
      error.submissionStage = error?.appServerRejected ? 'rejected' : (error?.requestSubmitted === false ? 'pre-submit' : 'post-submit');
      throw error;
    }
    const turnId = String(started?.turn?.id ?? '');
    if (!turnId) throw new Error('Codex App Server did not return a turn ID');
    const completion = client.waitForTurn(turnId).finally(close);
    return { turnId, completion, close, cancel };
  } catch (error) {
    close();
    error.submissionStage ??= 'pre-submit';
    throw error;
  }
}
