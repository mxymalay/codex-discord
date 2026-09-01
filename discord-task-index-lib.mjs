import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const indexVersion = 1;
const defaultReadLimits = Object.freeze({
  wholeFileBytes: 16 * 1024 * 1024,
  headBytes: 1 * 1024 * 1024,
  tailBytes: 4 * 1024 * 1024,
  sidebarChunkBytes: 64 * 1024,
});
const taskRecordFields = [
  'threadId', 'projectId', 'projectName', 'taskName', 'status', 'createdAt',
  'lastActivityAt', 'startedAt', 'completedAt', 'runtimeMs', 'rolloutPath',
  'offset', 'worktreePath', 'worktreeBranch',
];
const detailSearchCache = new Map();

function emptyIndex() {
  return { version: indexVersion, generatedAt: null, tasks: [] };
}

function parseJsonLines(content) {
  return String(content ?? '').split(/\r?\n/).flatMap((raw) => {
    if (!raw.trim()) return [];
    try {
      return [JSON.parse(raw)];
    } catch {
      return [];
    }
  });
}

function boundedPositiveInteger(value, fallback) {
  const numeric = Math.floor(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? Math.min(numeric, fallback) : fallback;
}

function normalizedReadLimits(readLimits) {
  return {
    wholeFileBytes: boundedPositiveInteger(readLimits?.wholeFileBytes, defaultReadLimits.wholeFileBytes),
    headBytes: boundedPositiveInteger(readLimits?.headBytes, defaultReadLimits.headBytes),
    tailBytes: boundedPositiveInteger(readLimits?.tailBytes, defaultReadLimits.tailBytes),
    sidebarChunkBytes: boundedPositiveInteger(readLimits?.sidebarChunkBytes, defaultReadLimits.sidebarChunkBytes),
  };
}

function validTime(value) {
  const milliseconds = Date.parse(String(value ?? ''));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function isoTime(milliseconds) {
  return milliseconds == null ? null : new Date(milliseconds).toISOString();
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function identityKey(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function canonicalWindowsPath(value) {
  const text = stringOrNull(value);
  if (!text) return null;
  try {
    return path.win32.normalize(text.replaceAll('/', '\\')).replace(/[\\]+$/u, '').toLocaleLowerCase();
  } catch {
    return null;
  }
}

function projectRoots(project) {
  return (Array.isArray(project?.roots) ? project.roots : [])
    .map((root) => typeof root === 'string' ? root : root?.path)
    .map(canonicalWindowsPath)
    .filter(Boolean);
}

/** Resolve a task to the saved Codex project whose canonical root contains it. */
export function inferSavedProject({ cwd, worktreePath, projectId, projectName } = {}, projects = []) {
  const saved = Array.isArray(projects) ? projects : [];
  const explicitId = stringOrNull(projectId);
  const explicitName = stringOrNull(projectName);
  if (!explicitId && explicitName === '无项目') return { projectId: null, projectName: null };
  const explicit = (explicitId
    ? saved.find((project) => String(project?.id ?? '') === explicitId)
    : null) ?? (explicitName
    ? saved.find((project) => String(project?.name ?? '') === explicitName)
    : null);
  if (explicit) {
    return { projectId: String(explicit.id), projectName: String(explicit.name ?? explicit.id) };
  }

  const candidates = [canonicalWindowsPath(cwd), canonicalWindowsPath(worktreePath)].filter(Boolean);
  if (!candidates.length) return { projectId: null, projectName: null };
  let match = null;
  for (const project of saved) {
    for (const root of projectRoots(project)) {
      if (!candidates.some((candidate) => candidate === root || candidate.startsWith(`${root}\\`))) continue;
      if (!match || root.length > match.root.length) match = { project, root };
    }
  }
  return match ? {
    projectId: String(match.project.id),
    projectName: String(match.project.name ?? match.project.id),
  } : { projectId: null, projectName: null };
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((item) => {
    if (typeof item === 'string') return item;
    return String(item?.text ?? item?.content ?? '');
  }).filter(Boolean).join('\n');
}

function cleanPageText(value) {
  return String(value ?? '').replaceAll('\u0000', '').replace(/\r\n?/g, '\n').trim();
}

function normalizeSearch(value) {
  return cleanPageText(value).normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

export function isUserRootSession(meta, sidebarEntry) {
  if (!meta || typeof meta !== 'object' || !sidebarEntry || typeof sidebarEntry !== 'object') return false;
  const metaId = String(meta.id ?? '').trim();
  const sidebarId = String(sidebarEntry.id ?? '').trim();
  if (!metaId || !sidebarId || metaId.toLocaleLowerCase() !== sidebarId.toLocaleLowerCase()) return false;
  const threadSource = String(meta.thread_source ?? '').trim().toLocaleLowerCase();
  if (threadSource === 'subagent') return false;
  if (threadSource && threadSource !== 'user') return false;
  if (meta.source && typeof meta.source === 'object' && Object.entries(meta.source).some(
    ([key, value]) => key.toLocaleLowerCase() === 'subagent' && value != null,
  )) return false;
  if (String(meta.parent_thread_id ?? '').trim()) return false;
  const sessionId = String(meta.session_id ?? '').trim();
  if (sessionId && sessionId.toLocaleLowerCase() !== metaId.toLocaleLowerCase()) return false;
  return true;
}

async function readOptionalJson(filePath, fallback, fileSystem = fs) {
  if (!filePath) return structuredClone(fallback);
  try {
    return JSON.parse(await fileSystem.readFile(filePath, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

async function readSidebarEntries(sessionIndexPath, fileSystem, chunkBytes) {
  let handle;
  try {
    handle = await fileSystem.open(sessionIndexPath, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
  const byId = new Map();
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(chunkBytes);
  let pending = '';
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const text = pending + decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split(/\r?\n/u);
      pending = lines.pop() ?? '';
      for (const entry of parseJsonLines(lines.join('\n'))) {
        const id = stringOrNull(entry?.id);
        if (id) byId.set(identityKey(id), entry);
      }
    }
    pending += decoder.end();
    for (const entry of parseJsonLines(pending)) {
      const id = stringOrNull(entry?.id);
      if (id) byId.set(identityKey(id), entry);
    }
  } finally {
    await handle.close();
  }
  return byId;
}

async function listRolloutFiles(sessionsRoot, fileSystem) {
  const result = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fileSystem.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/u.test(entry.name)) result.push(path.resolve(candidate));
    }
  }
  if (sessionsRoot) await visit(sessionsRoot);
  return result.sort((left, right) => left.localeCompare(right));
}

function standardRolloutThreadId(rolloutPath) {
  const match = path.basename(rolloutPath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu,
  );
  return stringOrNull(match?.[1]);
}

async function readBytes(filePath, start, length, fileSystem) {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fileSystem.open(filePath, 'r');
  const buffer = Buffer.alloc(length);
  let total = 0;
  try {
    while (total < length) {
      const { bytesRead } = await handle.read(buffer, total, length - total, start + total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return buffer.subarray(0, total);
}

async function readHeadRegion(filePath, offset, limits, fileSystem) {
  const length = Math.min(offset, limits.headBytes);
  const raw = await readBytes(filePath, 0, length, fileSystem);
  if (length >= offset) return { entries: parseJsonLines(raw.toString('utf8')), parsedEnd: raw.length };
  const lastNewline = raw.lastIndexOf(0x0a);
  const parsedEnd = lastNewline < 0 ? 0 : lastNewline + 1;
  return { entries: parseJsonLines(raw.subarray(0, parsedEnd).toString('utf8')), parsedEnd };
}

async function readBoundedEntries(filePath, offset, limits, fileSystem, headRegion) {
  if (offset <= limits.wholeFileBytes) {
    const content = await readBytes(filePath, 0, offset, fileSystem);
    return { entries: parseJsonLines(content.toString('utf8')), middleSkipped: false };
  }
  const head = headRegion ?? await readHeadRegion(filePath, offset, limits, fileSystem);
  const nominalTailStart = Math.max(0, offset - limits.tailBytes);
  const tailStart = Math.max(head.parsedEnd, nominalTailStart);
  let tail = await readBytes(filePath, tailStart, offset - tailStart, fileSystem);
  if (tailStart > head.parsedEnd) {
    const preceding = await readBytes(filePath, tailStart - 1, 1, fileSystem);
    if (preceding[0] !== 0x0a) {
      const firstNewline = tail.indexOf(0x0a);
      tail = firstNewline < 0 ? Buffer.alloc(0) : tail.subarray(firstNewline + 1);
    }
  }
  return {
    entries: [...head.entries, ...parseJsonLines(tail.toString('utf8'))],
    middleSkipped: true,
  };
}

function newestMappings(messageMap) {
  const byThread = new Map();
  let order = 0;
  for (const [messageId, mapping] of Object.entries(messageMap?.messages ?? {})) {
    order += 1;
    const threadId = stringOrNull(mapping?.threadId);
    if (!threadId) continue;
    const mappedAt = validTime(mapping?.createdAt);
    const numericId = /^\d+$/u.test(messageId) ? BigInt(messageId) : null;
    const candidate = { mapping, mappedAt, numericId, order };
    const key = identityKey(threadId);
    const current = byThread.get(key);
    const newer = !current ||
      (mappedAt != null && (current.mappedAt == null || mappedAt > current.mappedAt)) ||
      (mappedAt === current.mappedAt && numericId != null && current.numericId != null && numericId > current.numericId) ||
      (mappedAt === current.mappedAt && numericId === current.numericId && order > current.order);
    if (newer) byThread.set(key, candidate);
  }
  return byThread;
}

function isFailureType(type) {
  return ['task_failed', 'task_aborted', 'turn_failed', 'turn_aborted', 'failed', 'aborted', 'cancelled', 'canceled']
    .includes(String(type ?? '').toLocaleLowerCase());
}

function configuredWorktreeRoot(explicitRoot, previousIndex) {
  const configured = stringOrNull(explicitRoot) ??
    stringOrNull(previousIndex?.discordWorktreeRoot) ??
    stringOrNull(process.env.DISCORD_WORKTREE_ROOT);
  if (configured) return path.resolve(configured);
  if (process.env.CODEX_HOME) return path.resolve(process.env.CODEX_HOME, 'worktrees', 'discord');
  return null;
}

function isDescendant(root, candidate) {
  if (!root || !candidate) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function projectMetadata(meta, sidebarEntry, previous) {
  return {
    projectId: stringOrNull(
      meta?.project_id ?? meta?.projectId ?? meta?.project?.id ??
      sidebarEntry?.project_id ?? sidebarEntry?.projectId ?? sidebarEntry?.project?.id ?? previous?.projectId,
    ),
    projectName: stringOrNull(
      meta?.project_name ?? meta?.projectName ?? meta?.project?.name ??
      sidebarEntry?.project_name ?? sidebarEntry?.projectName ?? sidebarEntry?.project?.name ?? previous?.projectName,
    ),
  };
}

function createdRootsByThread(createdTasksByInteraction) {
  const roots = new Map();
  for (const record of Object.values(createdTasksByInteraction ?? {})) {
    const threadId = stringOrNull(record?.threadId);
    if (!threadId || !['started', 'first-turn-failed'].includes(String(record?.status ?? ''))) continue;
    roots.set(identityKey(threadId), record);
  }
  return roots;
}

function isTrustedCreatedRoot(meta, createdRecord, expectedThreadId) {
  if (!createdRecord || !meta || typeof meta !== 'object') return false;
  const metaId = stringOrNull(meta.id);
  const persistedThreadId = stringOrNull(createdRecord.threadId);
  if (!metaId || !persistedThreadId ||
      identityKey(metaId) !== identityKey(persistedThreadId) ||
      identityKey(metaId) !== identityKey(expectedThreadId)) return false;
  const threadSource = String(meta.thread_source ?? '').trim().toLocaleLowerCase();
  if (threadSource && threadSource !== 'user') return false;
  if (String(meta.parent_thread_id ?? '').trim()) return false;
  if (meta.source && typeof meta.source === 'object' && Object.entries(meta.source).some(
    ([key, value]) => key.toLocaleLowerCase() === 'subagent' && value != null,
  )) return false;
  const sessionId = stringOrNull(meta.session_id);
  return !sessionId || identityKey(sessionId) === identityKey(metaId);
}

function worktreeMetadata(meta, worktreeRoot) {
  const runtimeRoots = meta?.runtime_workspace_roots ?? meta?.runtimeWorkspaceRoots ?? [];
  const candidatePath = stringOrNull(meta?.worktree_path ?? meta?.worktreePath) ??
    stringOrNull(Array.isArray(runtimeRoots) ? runtimeRoots[0] : null) ?? stringOrNull(meta?.cwd);
  const branch = stringOrNull(meta?.worktree_branch ?? meta?.worktreeBranch ?? meta?.git?.branch);
  if (!branch?.startsWith('codex/discord-') || !isDescendant(worktreeRoot, candidatePath)) {
    return { worktreePath: null, worktreeBranch: null };
  }
  return { worktreePath: path.resolve(candidatePath), worktreeBranch: branch };
}

function buildRecord({ entries, middleSkipped, rolloutPath, offset, expectedThreadId, sidebarEntry, createdRecord, previous, nowMs, worktreeRoot, latestMapping, projects }) {
  const metadataEntry = entries.find((entry) => entry?.type === 'session_meta' && entry?.payload);
  const meta = metadataEntry?.payload;
  if (!isUserRootSession(meta, sidebarEntry) && !isTrustedCreatedRoot(meta, createdRecord, expectedThreadId)) return null;

  let createdMs = null;
  let lastActivityMs = null;
  let firstStartedMs = null;
  let latestTerminalMs = null;
  let statusChangedMs = null;
  let status = 'pending';
  let runtimeMs = 0;
  let runtimeComplete = true;
  let activeTurnId = null;
  const turns = new Map();
  let generatedTurn = 0;

  for (const entry of entries) {
    const timestampMs = validTime(entry?.timestamp);
    if (timestampMs != null) {
      createdMs = createdMs == null ? timestampMs : Math.min(createdMs, timestampMs);
      lastActivityMs = lastActivityMs == null ? timestampMs : Math.max(lastActivityMs, timestampMs);
    }
    if (entry?.type !== 'event_msg') continue;
    const payload = entry.payload ?? {};
    const type = String(payload.type ?? '');
    if (type === 'task_started') {
      const turnId = stringOrNull(payload.turn_id) ?? `generated-${generatedTurn += 1}`;
      if (turns.has(turnId)) runtimeComplete = false;
      if (timestampMs == null) runtimeComplete = false;
      turns.set(turnId, timestampMs);
      activeTurnId = turnId;
      firstStartedMs = timestampMs == null ? firstStartedMs : (firstStartedMs == null ? timestampMs : Math.min(firstStartedMs, timestampMs));
      status = 'running';
      statusChangedMs = timestampMs ?? statusChangedMs;
      latestTerminalMs = null;
      continue;
    }
    const terminal = type === 'task_complete' || isFailureType(type) || isFailureType(payload.status);
    if (!terminal) continue;
    const turnId = stringOrNull(payload.turn_id) ?? activeTurnId;
    const hasStart = Boolean(turnId) && turns.has(turnId);
    const startedMs = hasStart ? turns.get(turnId) : null;
    if (!hasStart || timestampMs == null || startedMs == null || timestampMs < startedMs) runtimeComplete = false;
    else runtimeMs += timestampMs - startedMs;
    if (turnId) turns.delete(turnId);
    if (!turnId || activeTurnId === turnId) activeTurnId = null;
    status = type === 'task_complete' && !isFailureType(payload.status) ? 'completed' : 'failed';
    latestTerminalMs = timestampMs ?? latestTerminalMs;
    statusChangedMs = timestampMs ?? statusChangedMs;
  }

  if (activeTurnId) {
    const activeStartedMs = turns.get(activeTurnId);
    if (activeStartedMs == null || !Number.isFinite(nowMs) || nowMs < activeStartedMs) runtimeComplete = false;
    else runtimeMs += nowMs - activeStartedMs;
    status = 'running';
  }
  if ([...turns.keys()].some((turnId) => turnId !== activeTurnId)) runtimeComplete = false;
  if (middleSkipped) runtimeComplete = false;

  const mappingEvent = String(latestMapping?.mapping?.eventName ?? '');
  const mappingIsCurrent = latestMapping && (latestMapping.mappedAt == null || statusChangedMs == null || latestMapping.mappedAt >= statusChangedMs);
  if (mappingIsCurrent && mappingEvent === 'user-task-confirmation-required' && status !== 'running') {
    status = 'confirmation-required';
  }

  const sidebarCreatedMs = validTime(sidebarEntry?.created_at ?? sidebarEntry?.createdAt);
  const sidebarUpdatedMs = validTime(sidebarEntry?.updated_at ?? sidebarEntry?.updatedAt);
  if (sidebarCreatedMs != null) createdMs = createdMs == null ? sidebarCreatedMs : Math.min(createdMs, sidebarCreatedMs);
  if (sidebarUpdatedMs != null) lastActivityMs = lastActivityMs == null ? sidebarUpdatedMs : Math.max(lastActivityMs, sidebarUpdatedMs);
  const explicitProject = projectMetadata(meta, sidebarEntry, {
    ...previous,
    projectId: createdRecord?.projectId ?? previous?.projectId,
    projectName: createdRecord?.projectName ?? previous?.projectName,
  });
  const inferredProject = inferSavedProject({
    cwd: meta?.cwd ?? createdRecord?.workspace?.cwd,
    worktreePath: createdRecord?.workspace?.worktreePath,
    ...explicitProject,
  }, projects);
  const project = Array.isArray(projects) && projects.length > 0 ? inferredProject : explicitProject;
  const worktree = worktreeMetadata(meta, worktreeRoot);
  return {
    threadId: String(meta.id),
    projectId: project.projectId,
    projectName: project.projectName,
    taskName: stringOrNull(sidebarEntry?.thread_name ?? sidebarEntry?.threadName ?? sidebarEntry?.name) ??
      stringOrNull(createdRecord?.taskName) ?? previous?.taskName ?? '未命名任务',
    status,
    createdAt: isoTime(createdMs),
    lastActivityAt: isoTime(lastActivityMs),
    startedAt: isoTime(firstStartedMs),
    completedAt: status === 'running' ? null : isoTime(latestTerminalMs),
    runtimeMs: runtimeComplete ? runtimeMs : null,
    rolloutPath,
    offset,
    ...worktree,
  };
}

function durableRecord(record) {
  return Object.fromEntries(taskRecordFields
    .filter((field) => Object.hasOwn(record ?? {}, field))
    .map((field) => [field, record[field]]));
}

function refreshedPreviousRecord(previous, sidebarEntry, latestMapping) {
  const retained = durableRecord(previous);
  const sidebarCreatedMs = validTime(sidebarEntry?.created_at ?? sidebarEntry?.createdAt);
  const sidebarUpdatedMs = validTime(sidebarEntry?.updated_at ?? sidebarEntry?.updatedAt);
  const previousCreatedMs = validTime(retained.createdAt);
  const previousActivityMs = validTime(retained.lastActivityAt);
  retained.taskName = stringOrNull(sidebarEntry?.thread_name ?? sidebarEntry?.threadName ?? sidebarEntry?.name) ??
    retained.taskName ?? '未命名任务';
  const project = projectMetadata(null, sidebarEntry, retained);
  retained.projectId = project.projectId;
  retained.projectName = project.projectName;
  retained.createdAt = isoTime(sidebarCreatedMs == null ? previousCreatedMs :
    (previousCreatedMs == null ? sidebarCreatedMs : Math.min(sidebarCreatedMs, previousCreatedMs)));
  retained.lastActivityAt = isoTime(sidebarUpdatedMs == null ? previousActivityMs :
    (previousActivityMs == null ? sidebarUpdatedMs : Math.max(sidebarUpdatedMs, previousActivityMs)));

  const mappingEvent = String(latestMapping?.mapping?.eventName ?? '');
  const statusChangedMs = Math.max(validTime(retained.completedAt) ?? 0, validTime(retained.startedAt) ?? 0) || null;
  const mappingIsCurrent = latestMapping &&
    (latestMapping.mappedAt == null || statusChangedMs == null || latestMapping.mappedAt >= statusChangedMs);
  if (mappingIsCurrent && mappingEvent === 'user-task-confirmation-required' && retained.status !== 'running') {
    retained.status = 'confirmation-required';
  }
  return retained;
}

export async function buildTaskIndex({
  sessionsRoot,
  sessionIndexPath,
  messageMapPath,
  previousIndex = emptyIndex(),
  nowMs = Date.now(),
  discordWorktreeRoot,
  projects = [],
  createdTasksByInteraction = {},
  readLimits,
  fileSystem = fs,
}) {
  const limits = normalizedReadLimits(readLimits);
  const sidebarEntries = await readSidebarEntries(sessionIndexPath, fileSystem, limits.sidebarChunkBytes);
  const messageMap = await readOptionalJson(messageMapPath, { version: 1, messages: {} }, fileSystem);
  const mappings = newestMappings(messageMap);
  const previousById = new Map((previousIndex?.tasks ?? []).map((record) => [identityKey(record.threadId), record]));
  const previousByPath = new Map((previousIndex?.tasks ?? []).flatMap((record) => {
    const rolloutPath = stringOrNull(record?.rolloutPath);
    return rolloutPath ? [[path.resolve(rolloutPath), record]] : [];
  }));
  const worktreeRoot = configuredWorktreeRoot(discordWorktreeRoot, previousIndex);
  const createdRoots = createdRootsByThread(createdTasksByInteraction);
  const recordsById = new Map();
  const unsafePreviousKeys = new Set();

  for (const rolloutPath of await listRolloutFiles(sessionsRoot, fileSystem)) {
    const filenameThreadId = standardRolloutThreadId(rolloutPath);
    let threadId = filenameThreadId;
    let key = identityKey(threadId);
    let sidebarEntry = sidebarEntries.get(key);
    let previous = filenameThreadId ? previousById.get(key) : previousByPath.get(path.resolve(rolloutPath));
    if (!filenameThreadId && previous) sidebarEntry = sidebarEntries.get(identityKey(previous.threadId));
    let createdRecord = createdRoots.get(key);
    if (filenameThreadId && !sidebarEntry && !createdRecord) continue;
    try {
      const stat = await fileSystem.stat(rolloutPath);
      const offset = Number(stat.size);
      let headRegion;
      if (!filenameThreadId) {
        headRegion = await readHeadRegion(rolloutPath, offset, limits, fileSystem);
        const meta = headRegion.entries.find((entry) => entry?.type === 'session_meta')?.payload;
        threadId = stringOrNull(meta?.id);
        if (!threadId) continue;
        key = identityKey(threadId);
        sidebarEntry = sidebarEntries.get(key);
        createdRecord = createdRoots.get(key);
        if (!sidebarEntry && !createdRecord) continue;
        previous = previousById.get(key) ?? (identityKey(previous?.threadId) === key ? previous : undefined);
      }
      const hasStableProjectProvenance = previous?.projectId != null || previous?.projectName != null ||
        createdRecord?.projectId != null || createdRecord?.projectName != null || projects.length === 0;
      if (previous && sidebarEntry && hasStableProjectProvenance &&
          path.resolve(String(previous.rolloutPath ?? '')) === path.resolve(rolloutPath) && Number(previous.offset) === offset) {
        recordsById.set(key, refreshedPreviousRecord(previous, sidebarEntry, mappings.get(key)));
        continue;
      }
      const parsed = await readBoundedEntries(rolloutPath, offset, limits, fileSystem, headRegion);
      const record = buildRecord({
        entries: parsed.entries,
        middleSkipped: parsed.middleSkipped,
        rolloutPath,
        offset,
        expectedThreadId: threadId,
        sidebarEntry,
        createdRecord,
        previous,
        nowMs: Number(nowMs),
        worktreeRoot,
        latestMapping: mappings.get(key),
        projects,
      });
      if (!record) continue;
      key = identityKey(record.threadId);
      const current = recordsById.get(key);
      if (!current || (validTime(record.lastActivityAt) ?? 0) > (validTime(current.lastActivityAt) ?? 0)) {
        recordsById.set(key, record);
      }
    } catch (error) {
      if (previous && sidebarEntry &&
          path.resolve(String(previous.rolloutPath ?? '')) === path.resolve(rolloutPath)) {
        recordsById.set(identityKey(previous.threadId), refreshedPreviousRecord(
          previous,
          sidebarEntry,
          mappings.get(identityKey(previous.threadId)),
        ));
      } else if (previous && sidebarEntry) {
        unsafePreviousKeys.add(identityKey(previous.threadId));
      }
    }
  }

  for (const key of sidebarEntries.keys()) {
    if (recordsById.has(key) || unsafePreviousKeys.has(key)) continue;
    const previous = previousById.get(key);
    if (!previous) continue;
    const retained = durableRecord(previous);
    if (!stringOrNull(retained.threadId)) continue;
    recordsById.set(key, retained);
  }

  const tasks = [...recordsById.values()].sort((left, right) =>
    (validTime(right.lastActivityAt) ?? 0) - (validTime(left.lastActivityAt) ?? 0) || left.threadId.localeCompare(right.threadId));
  return { version: indexVersion, generatedAt: new Date(Number(nowMs)).toISOString(), tasks };
}

async function readRecordEntries(record, { fileSystem = fs, readLimits } = {}) {
  const rolloutPath = String(record?.rolloutPath ?? '');
  const stat = await fileSystem.stat(rolloutPath);
  const fileSize = Number(stat.size);
  const requestedOffset = Number(record?.offset ?? fileSize);
  const offset = Math.max(0, Math.min(fileSize, Number.isFinite(requestedOffset) ? requestedOffset : fileSize));
  return (await readBoundedEntries(
    rolloutPath,
    offset,
    normalizedReadLimits(readLimits),
    fileSystem,
  )).entries;
}

export async function readTaskDetail(record, options = {}) {
  let entries;
  try {
    entries = await readRecordEntries(record, options);
  } catch {
    return {
      ...record,
      contentAvailable: false,
      taskText: '',
      resultText: '',
      markdown: '## 任务内容\n内容暂不可用，请稍后重试。',
    };
  }
  let taskText = '';
  let resultText = '';
  let latestAgentText = '';
  for (const entry of entries) {
    const payload = entry.payload ?? {};
    if (entry?.type === 'event_msg') {
      if (payload.type === 'user_message' && !taskText) {
        taskText = cleanPageText(textValue(payload.message ?? payload.content));
        continue;
      }
      if (payload.type === 'agent_message') {
        const candidate = cleanPageText(textValue(payload.message ?? payload.content));
        if (candidate) latestAgentText = candidate;
        continue;
      }
      if (payload.type === 'task_complete') {
        const candidate = cleanPageText(textValue(payload.last_agent_message ?? payload.message));
        if (candidate) resultText = candidate;
      }
      continue;
    }
    if (entry?.type === 'response_item' && payload.type === 'message') {
      const role = String(payload.role ?? '').toLocaleLowerCase();
      const candidate = cleanPageText(textValue(payload.content));
      if (role === 'user' && !taskText && candidate) taskText = candidate;
      if (role === 'assistant' && candidate && (!payload.phase || payload.phase === 'final_answer')) resultText = candidate;
    }
  }
  if (!resultText) resultText = latestAgentText;
  const markdown = [
    '## 原始任务',
    taskText || '（无可用内容）',
    '',
    '## 最新结果',
    resultText || '（暂无结果）',
  ].join('\n');
  return { ...record, contentAvailable: true, taskText, resultText, markdown };
}

function taskSummary(record, matchScore) {
  const summary = {};
  for (const field of taskRecordFields) {
    if (['rolloutPath', 'offset', 'worktreePath', 'worktreeBranch'].includes(field)) continue;
    summary[field] = record?.[field] ?? null;
  }
  summary.matchScore = matchScore;
  return summary;
}

export async function searchTasks({ index, keyword, limit = 10, fileSystem = fs, readLimits }) {
  const query = normalizeSearch(keyword);
  if (!query) return [];
  const maximum = Math.min(10, Math.max(0, Math.floor(Number(limit) || 0)));
  if (maximum === 0) return [];
  const matches = [];
  for (const record of index?.tasks ?? []) {
    const taskName = normalizeSearch(record?.taskName);
    const projectName = normalizeSearch(record?.projectName);
    let score = taskName === query ? 400 : (taskName.includes(query) ? 300 : 0);
    if (!score && projectName.includes(query)) score = 200;
    if (!score) {
      const limits = normalizedReadLimits(readLimits);
      const key = [
        path.resolve(String(record?.rolloutPath ?? '')),
        Number(record?.offset ?? 0),
        limits.wholeFileBytes,
        limits.headBytes,
        limits.tailBytes,
      ].join('\u0000');
      let body = detailSearchCache.get(key);
      if (body === undefined) {
        const detail = await readTaskDetail(record, { fileSystem, readLimits: limits });
        if (detail.contentAvailable) {
          body = normalizeSearch(`${detail.taskText}\n${detail.resultText}`);
          detailSearchCache.set(key, body);
        } else {
          body = '';
        }
      }
      if (body.includes(query)) score = 100;
    }
    if (score) matches.push(taskSummary(record, score));
  }
  matches.sort((left, right) => right.matchScore - left.matchScore ||
    (validTime(right.lastActivityAt) ?? 0) - (validTime(left.lastActivityAt) ?? 0) ||
    String(left.threadId).localeCompare(String(right.threadId)));
  return matches.slice(0, maximum);
}

function persistentIndex(index) {
  return {
    version: indexVersion,
    generatedAt: index?.generatedAt ?? null,
    tasks: (index?.tasks ?? []).map((record) => Object.fromEntries(
      taskRecordFields.filter((field) => Object.hasOwn(record ?? {}, field)).map((field) => [field, record[field]]),
    )),
  };
}

export async function writeTaskIndexAtomic(indexPath, index) {
  const directory = path.dirname(indexPath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(indexPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(persistentIndex(index), null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, indexPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function readTaskIndex(indexPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    if (!parsed || parsed.version !== indexVersion || !Array.isArray(parsed.tasks)) throw new Error('invalid task index');
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyIndex();
    const timestamp = new Date().toISOString().replaceAll(':', '');
    const corruptPath = path.join(path.dirname(indexPath), `discord-task-index.corrupt-${timestamp}.json`);
    try {
      await fs.rename(indexPath, corruptPath);
    } catch (renameError) {
      if (renameError?.code !== 'ENOENT') throw renameError;
    }
    return emptyIndex();
  }
}
