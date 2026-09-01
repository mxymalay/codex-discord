import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const indexVersion = 1;
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

async function readOptionalJson(filePath, fallback) {
  if (!filePath) return structuredClone(fallback);
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

async function readSidebarEntries(sessionIndexPath) {
  let content;
  try {
    content = await fs.readFile(sessionIndexPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
  const byId = new Map();
  for (const entry of parseJsonLines(content)) {
    const id = stringOrNull(entry?.id);
    if (id) byId.set(identityKey(id), entry);
  }
  return byId;
}

async function listRolloutFiles(sessionsRoot) {
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
      else if (entry.isFile() && /^rollout-.*\.jsonl$/u.test(entry.name)) result.push(path.resolve(candidate));
    }
  }
  if (sessionsRoot) await visit(sessionsRoot);
  return result.sort((left, right) => left.localeCompare(right));
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

function buildRecord({ entries, rolloutPath, offset, sidebarEntry, previous, nowMs, worktreeRoot, latestMapping }) {
  const metadataEntry = entries.find((entry) => entry?.type === 'session_meta' && entry?.payload);
  const meta = metadataEntry?.payload;
  if (!isUserRootSession(meta, sidebarEntry)) return null;

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

  const mappingEvent = String(latestMapping?.mapping?.eventName ?? '');
  const mappingIsCurrent = latestMapping && (latestMapping.mappedAt == null || statusChangedMs == null || latestMapping.mappedAt >= statusChangedMs);
  if (mappingIsCurrent && mappingEvent === 'user-task-confirmation-required' && status !== 'running') {
    status = 'confirmation-required';
  }

  const sidebarCreatedMs = validTime(sidebarEntry?.created_at ?? sidebarEntry?.createdAt);
  const sidebarUpdatedMs = validTime(sidebarEntry?.updated_at ?? sidebarEntry?.updatedAt);
  if (sidebarCreatedMs != null) createdMs = createdMs == null ? sidebarCreatedMs : Math.min(createdMs, sidebarCreatedMs);
  if (sidebarUpdatedMs != null) lastActivityMs = lastActivityMs == null ? sidebarUpdatedMs : Math.max(lastActivityMs, sidebarUpdatedMs);
  const project = projectMetadata(meta, sidebarEntry, previous);
  const worktree = worktreeMetadata(meta, worktreeRoot);
  return {
    threadId: String(meta.id),
    projectId: project.projectId,
    projectName: project.projectName,
    taskName: stringOrNull(sidebarEntry?.thread_name ?? sidebarEntry?.threadName ?? sidebarEntry?.name) ?? previous?.taskName ?? '未命名任务',
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

export async function buildTaskIndex({
  sessionsRoot,
  sessionIndexPath,
  messageMapPath,
  previousIndex = emptyIndex(),
  nowMs = Date.now(),
  discordWorktreeRoot,
}) {
  const sidebarEntries = await readSidebarEntries(sessionIndexPath);
  const messageMap = await readOptionalJson(messageMapPath, { version: 1, messages: {} });
  const mappings = newestMappings(messageMap);
  const previousById = new Map((previousIndex?.tasks ?? []).map((record) => [identityKey(record.threadId), record]));
  const worktreeRoot = configuredWorktreeRoot(discordWorktreeRoot, previousIndex);
  const recordsById = new Map();

  for (const rolloutPath of await listRolloutFiles(sessionsRoot)) {
    let content;
    try {
      content = await fs.readFile(rolloutPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const entries = parseJsonLines(content);
    const meta = entries.find((entry) => entry?.type === 'session_meta')?.payload;
    const threadId = stringOrNull(meta?.id);
    if (!threadId) continue;
    const record = buildRecord({
      entries,
      rolloutPath,
      offset: Buffer.byteLength(content),
      sidebarEntry: sidebarEntries.get(identityKey(threadId)),
      previous: previousById.get(identityKey(threadId)),
      nowMs: Number(nowMs),
      worktreeRoot,
      latestMapping: mappings.get(identityKey(threadId)),
    });
    if (!record) continue;
    const current = recordsById.get(threadId);
    if (!current || (validTime(record.lastActivityAt) ?? 0) > (validTime(current.lastActivityAt) ?? 0)) {
      recordsById.set(threadId, record);
    }
  }

  const tasks = [...recordsById.values()].sort((left, right) =>
    (validTime(right.lastActivityAt) ?? 0) - (validTime(left.lastActivityAt) ?? 0) || left.threadId.localeCompare(right.threadId));
  return { version: indexVersion, generatedAt: new Date(Number(nowMs)).toISOString(), tasks };
}

async function readRecordEntries(record) {
  const content = await fs.readFile(String(record?.rolloutPath ?? ''), 'utf8');
  const offset = Math.max(0, Math.min(Buffer.byteLength(content), Number(record?.offset ?? Buffer.byteLength(content))));
  const bounded = Buffer.from(content, 'utf8').subarray(0, offset).toString('utf8');
  return parseJsonLines(bounded);
}

export async function readTaskDetail(record) {
  let entries;
  try {
    entries = await readRecordEntries(record);
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

export async function searchTasks({ index, keyword, limit = 10 }) {
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
      const key = `${path.resolve(String(record?.rolloutPath ?? ''))}\u0000${Number(record?.offset ?? 0)}`;
      let body = detailSearchCache.get(key);
      if (body === undefined) {
        const detail = await readTaskDetail(record);
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
