import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  AppServerClient,
  commitInboxState,
  createDiscordTurnOriginRecord,
  initializeAppServerClient,
} from './discord-bridge-lib.mjs';

export const NO_PROJECT = '__projectless__';

function createClient({ clientFactory, codexPath, processCwd }) {
  return clientFactory
    ? clientFactory({ codexPath, cwd: processCwd })
    : new AppServerClient({ codexPath, cwd: processCwd });
}

function closeClient(client) {
  try {
    client.close?.();
  } catch {
    // Closing is best-effort after the request lifecycle has ended.
  }
}

function clientResource(client) {
  let released = false;
  const release = (force) => {
    if (released) return;
    released = true;
    try {
      if (force && typeof client.cancel === 'function') client.cancel();
      else client.close?.();
    } catch {
      // App Server release is best-effort and idempotent at this boundary.
    }
  };
  return {
    close: () => release(false),
    cancel: () => release(true),
  };
}

export async function listCodexProjects({ codexPath, processCwd, clientFactory } = {}) {
  const client = createClient({ clientFactory, codexPath, processCwd });
  try {
    try {
      await initializeAppServerClient(client);
      const projects = [];
      const seenCursors = new Set();
      let cursor = null;
      let requestId = 2;
      do {
        const page = await client.request({
          method: 'project/list',
          id: requestId,
          params: { cursor, limit: 100 },
        });
        requestId += 1;
        const validPage = page && typeof page === 'object'
          && Array.isArray(page.data)
          && (page.nextCursor === null || typeof page.nextCursor === 'string');
        if (!validPage) {
          const error = new Error('Codex project catalog response invalid');
          error.code = 'PROJECT_LIST_INVALID';
          throw error;
        }
        projects.push(...page.data);
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (!cursor || seenCursors.has(cursor)) {
            const error = new Error('Codex project catalog response invalid');
            error.code = 'PROJECT_LIST_INVALID';
            throw error;
          }
          seenCursors.add(cursor);
        }
      } while (cursor !== null);
      return projects;
    } catch (error) {
      if (error?.code === 'PROJECT_LIST_INVALID') throw error;
      const sanitized = new Error('Codex project catalog request failed');
      sanitized.code = 'PROJECT_LIST_FAILED';
      throw sanitized;
    }
  } finally {
    closeClient(client);
  }
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  return value instanceof Date ? value.getTime() : Number(value);
}

export function createProjectCatalog({ loader, ttlMs = 60_000, now = Date.now } = {}) {
  if (typeof loader !== 'function') throw new TypeError('Project catalog loader is required');
  let projects = [];
  let warmed = false;
  let lastRefreshAt = null;
  let errorCategory = null;
  let refreshPromise = null;

  const startRefresh = ({ background = false } = {}) => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const loaded = await loader();
        if (!Array.isArray(loaded)) throw new TypeError('Invalid project catalog');
        projects = loaded.slice();
        warmed = true;
        lastRefreshAt = timestamp(now);
        errorCategory = null;
        return projects.slice();
      } catch (error) {
        errorCategory = 'project-refresh-failed';
        const sanitized = new Error('Codex project catalog refresh failed');
        sanitized.code = 'PROJECT_REFRESH_FAILED';
        throw sanitized;
      } finally {
        refreshPromise = null;
      }
    })();
    if (background) refreshPromise.catch(() => {});
    return refreshPromise;
  };

  const refreshIfExpired = () => {
    const expired = lastRefreshAt === null || timestamp(now) - lastRefreshAt >= ttlMs;
    if (expired) startRefresh({ background: true });
  };

  const snapshotChoices = (focused = '') => {
    const query = String(focused ?? '').trim().toLocaleLowerCase();
    const saved = projects
      .filter((item) => !query || String(item?.name ?? '').toLocaleLowerCase().includes(query))
      .slice(0, 24)
      .map((item) => ({ name: String(item.name), value: String(item.id) }));
    saved.push({ name: '无项目', value: NO_PROJECT });
    return saved;
  };

  const snapshotGetById = (id) => projects.find((item) => String(item?.id ?? '') === id) ?? null;

  return {
    warm() {
      if (warmed) return Promise.resolve(projects.slice());
      return startRefresh();
    },
    choices(focused = '') {
      refreshIfExpired();
      return snapshotChoices(focused);
    },
    snapshotChoices,
    snapshot() {
      return projects.map((item) => structuredClone(item));
    },
    refresh() {
      return startRefresh();
    },
    getById(id) {
      refreshIfExpired();
      return snapshotGetById(id);
    },
    snapshotGetById,
    status() {
      return {
        warmed,
        refreshing: refreshPromise !== null,
        lastRefreshAt,
        errorCategory,
      };
    },
  };
}

function expandProjectlessRoot(projectlessRoot) {
  const configured = String(projectlessRoot ?? '').trim();
  if (!configured) throw new Error('Projectless root is required');
  const profile = String(process.env.USERPROFILE ?? '').trim();
  if (/%USERPROFILE%/i.test(configured) && !profile) {
    throw new Error('Projectless root could not be expanded');
  }
  const expanded = configured.replace(/%USERPROFILE%/gi, () => profile);
  if (!expanded || /%[^%]+%/.test(expanded)) throw new Error('Projectless root could not be expanded');
  return path.win32.normalize(expanded);
}

function normalizeProjectRoots(project) {
  return (Array.isArray(project?.roots) ? project.roots : [])
    .map((root) => typeof root === 'string' ? root : root?.path)
    .filter((root) => typeof root === 'string' && root.trim())
    .map((root) => root.trim());
}

export function resolveProjectSelection({ projects, selectionId, projectlessRoot } = {}) {
  if (selectionId === NO_PROJECT) {
    return {
      kind: 'projectless',
      projectId: null,
      projectName: '无项目',
      roots: [expandProjectlessRoot(projectlessRoot)],
    };
  }
  const selected = (Array.isArray(projects) ? projects : [])
    .find((item) => typeof item?.id === 'string' && item.id === selectionId);
  if (!selected) throw new Error('Invalid or deleted project selection');
  const roots = normalizeProjectRoots(selected);
  if (roots.length === 0) throw new Error('Selected project has no valid roots');
  return {
    kind: 'project',
    projectId: selected.id,
    projectName: String(selected.name ?? selected.id),
    roots,
  };
}

function controlledGitEnvironment(environment) {
  const sanitized = Object.fromEntries(Object.entries(environment).filter(([name]) => {
    const normalized = name.toUpperCase();
    return !normalized.startsWith('GIT_') && normalized !== 'LC_ALL' && normalized !== 'LANG';
  }));
  Object.assign(sanitized, { LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' });
  return sanitized;
}

function isRepositoryProbe(args) {
  return args.length === 4 && args[0] === '-C' && args[2] === 'rev-parse' && args[3] === '--show-toplevel';
}

function isExactRefProbe(args) {
  return args.length === 6 && args[0] === '-C' && args[2] === 'show-ref'
    && args[3] === '--verify' && args[4] === '--hash' && args[5].startsWith('refs/heads/');
}

export function runGitWithSpawn({
  command = 'git', args, spawnImpl = spawn, environment = process.env,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: controlledGitEnvironment(environment),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk.slice(0, 8192 - stderr.length);
    });
    child.on('error', () => reject(Object.assign(new Error('Unable to start Git'), { code: 'GIT_START_FAILED' })));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout });
      else if (code === 128 && isRepositoryProbe(args) && /^fatal: not a git repository\b/i.test(stderr.trim())) {
        reject(Object.assign(new Error('Git root is not a repository'), { code: 'GIT_NOT_REPOSITORY' }));
      } else if (code === 1 && isExactRefProbe(args)) {
        reject(Object.assign(new Error('Git branch reference was not found'), { code: 'GIT_REF_NOT_FOUND' }));
      } else {
        reject(Object.assign(new Error('Git operation failed'), { code: 'GIT_FAILED' }));
      }
    });
  });
}

function formatBranchTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid task creation timestamp');
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function windowsPathKey(value) {
  return path.win32.resolve(String(value ?? '')).toLocaleLowerCase('en-US');
}

function windowsPathEqual(left, right) {
  return windowsPathKey(left) === windowsPathKey(right);
}

function resolvedDescendant(root, candidate) {
  const resolvedRoot = windowsPathKey(root);
  const resolvedCandidate = windowsPathKey(candidate);
  const relative = path.win32.relative(resolvedRoot, resolvedCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function expandWorktreeRoot(worktreeRoot) {
  const configured = String(worktreeRoot ?? '').trim();
  if (!configured) throw new Error('Configured worktree root is required');
  const codexHome = String(process.env.CODEX_HOME ?? '').trim();
  if (/%CODEX_HOME%/i.test(configured) && !codexHome) {
    throw new Error('Configured worktree root could not be expanded');
  }
  const expanded = configured.replace(/%CODEX_HOME%/gi, () => codexHome);
  if (/%[^%]+%/.test(expanded)) throw new Error('Configured worktree root could not be expanded');
  const normalized = path.win32.normalize(expanded);
  if (!path.win32.isAbsolute(normalized)) throw new Error('Configured worktree root must be an absolute worktree root');
  return normalized;
}

async function validateSavedProjectRoots(roots, fileSystem) {
  if (roots.some((root) => !path.win32.isAbsolute(root))) {
    const error = new Error('Saved project root is unavailable');
    error.code = 'PROJECT_ROOT_UNAVAILABLE';
    throw error;
  }
  for (const root of roots) {
    try {
      const info = await fileSystem.stat(root);
      if (!info.isDirectory()) throw new Error('not a directory');
    } catch {
      const error = new Error('Saved project root is unavailable');
      error.code = 'PROJECT_ROOT_UNAVAILABLE';
      throw error;
    }
  }
}

async function hasGitMarker(root, fileSystem) {
  let current = path.resolve(root);
  for (;;) {
    try {
      await fileSystem.lstat(path.join(current, '.git'));
      return true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function sanitizedGitInspectionError() {
  const error = new Error('Git workspace inspection failed');
  error.code = 'GIT_INSPECTION_FAILED';
  return error;
}

async function inspectSavedProjectGit({ sourceRoot, gitRunner, fileSystem }) {
  try {
    await gitRunner({ command: 'git', args: ['--version'] });
  } catch {
    throw sanitizedGitInspectionError();
  }

  let markerPresent;
  try {
    markerPresent = await hasGitMarker(sourceRoot, fileSystem);
  } catch {
    throw sanitizedGitInspectionError();
  }

  try {
    const result = await gitRunner({ command: 'git', args: ['-C', sourceRoot, 'rev-parse', '--show-toplevel'] });
    const repositoryRoot = String(result?.stdout ?? '').trim();
    if (!repositoryRoot || !path.win32.isAbsolute(repositoryRoot)) throw new Error('invalid repository root');
    return { isRepo: true, repositoryRoot: path.win32.normalize(repositoryRoot) };
  } catch (error) {
    if (error?.code === 'GIT_NOT_REPOSITORY' && !markerPresent) return { isRepo: false, repositoryRoot: null };
    throw sanitizedGitInspectionError();
  }
}

function parseWorktreePorcelain(output) {
  const records = [];
  let current = null;
  for (const field of String(output ?? '').split('\0')) {
    if (!field) continue;
    if (field.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: field.slice('worktree '.length), branch: null, head: null };
    } else if (current && field.startsWith('HEAD ')) {
      current.head = field.slice('HEAD '.length);
    } else if (current && field.startsWith('branch ')) {
      current.branch = field.slice('branch '.length);
    }
  }
  if (current) records.push(current);
  return records;
}

function structurallyOwnedWorkspace({ workspace, worktreeRoot, operationId }) {
  if (!workspace || workspace.mode !== 'worktree') return false;
  let configuredRoot;
  try {
    configuredRoot = expandWorktreeRoot(worktreeRoot);
  } catch {
    return false;
  }
  const expectedPath = path.win32.resolve(configuredRoot, operationId);
  const actualPath = String(workspace.worktreePath ?? '');
  const repositoryRoot = String(workspace.repositoryRoot ?? '').trim();
  const sourceRoot = String(workspace.sourceRoot ?? '').trim();
  const branchName = String(workspace.branchName ?? '');
  const structurallyOwned = workspace.operationId === operationId
    && windowsPathEqual(actualPath, expectedPath)
    && resolvedDescendant(configuredRoot, actualPath)
    && path.win32.isAbsolute(repositoryRoot)
    && path.win32.isAbsolute(sourceRoot)
    && branchName.startsWith('codex/discord-');
  return structurallyOwned;
}

function validObjectId(value) {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(String(value ?? ''));
}

async function exactBranchOid({ repositoryRoot, branchRef, gitRunner }) {
  try {
    const result = await gitRunner({
      command: 'git', args: ['-C', repositoryRoot, 'show-ref', '--verify', '--hash', branchRef],
    });
    const oid = String(result?.stdout ?? '').trim();
    return validObjectId(oid) ? { state: 'present', oid } : { state: 'invalid' };
  } catch (error) {
    if (error?.code === 'GIT_REF_NOT_FOUND') return { state: 'missing' };
    return { state: 'unknown' };
  }
}

async function proveOwnedWorkspace({ workspace, worktreeRoot, operationId, gitRunner }) {
  if (!structurallyOwnedWorkspace({ workspace, worktreeRoot, operationId })) return null;
  const branchRef = `refs/heads/${workspace.branchName}`;

  try {
    const sourceProbe = await gitRunner({
      command: 'git', args: ['-C', workspace.sourceRoot, 'rev-parse', '--show-toplevel'],
    });
    if (!windowsPathEqual(String(sourceProbe?.stdout ?? '').trim(), workspace.repositoryRoot)) return null;
    const metadata = await gitRunner({
      command: 'git', args: ['-C', workspace.repositoryRoot, 'worktree', 'list', '--porcelain', '-z'],
    });
    const matches = parseWorktreePorcelain(metadata?.stdout).filter((item) => (
      windowsPathEqual(item.path, workspace.worktreePath) && item.branch === branchRef && validObjectId(item.head)
    ));
    if (matches.length !== 1) return null;
    const branch = await exactBranchOid({
      repositoryRoot: workspace.repositoryRoot, branchRef, gitRunner,
    });
    if (branch.state !== 'present' || branch.oid.toLocaleLowerCase('en-US') !== matches[0].head.toLocaleLowerCase('en-US')) {
      return null;
    }
    return {
      repositoryRoot: workspace.repositoryRoot,
      sourceRoot: workspace.sourceRoot,
      worktreePath: workspace.worktreePath,
      branchName: workspace.branchName,
      branchRef,
      branchOid: branch.oid,
    };
  } catch {
    return null;
  }
}

function validCleanupProof({ proof, workspace, worktreeRoot, operationId }) {
  return structurallyOwnedWorkspace({ workspace, worktreeRoot, operationId })
    && proof && typeof proof === 'object'
    && windowsPathEqual(proof.repositoryRoot, workspace.repositoryRoot)
    && windowsPathEqual(proof.sourceRoot, workspace.sourceRoot)
    && windowsPathEqual(proof.worktreePath, workspace.worktreePath)
    && proof.branchName === workspace.branchName
    && proof.branchRef === `refs/heads/${workspace.branchName}`
    && validObjectId(proof.branchOid);
}

async function inspectProvenWorktree({ proof, gitRunner }) {
  try {
    const sourceProbe = await gitRunner({
      command: 'git', args: ['-C', proof.sourceRoot, 'rev-parse', '--show-toplevel'],
    });
    if (!windowsPathEqual(String(sourceProbe?.stdout ?? '').trim(), proof.repositoryRoot)) return 'crossed';
    const metadata = await gitRunner({
      command: 'git', args: ['-C', proof.repositoryRoot, 'worktree', 'list', '--porcelain', '-z'],
    });
    const records = parseWorktreePorcelain(metadata?.stdout);
    const exact = records.filter((item) => (
      windowsPathEqual(item.path, proof.worktreePath)
      && item.branch === proof.branchRef
      && String(item.head).toLocaleLowerCase('en-US') === proof.branchOid.toLocaleLowerCase('en-US')
    ));
    if (exact.length === 1) return 'present';
    const crossed = records.some((item) => (
      windowsPathEqual(item.path, proof.worktreePath) || item.branch === proof.branchRef
    ));
    return crossed ? 'crossed' : 'removed';
  } catch {
    return 'unknown';
  }
}

function noOpCleanup() {
  return Promise.resolve(false);
}

export async function prepareTaskWorkspace({
  selection,
  worktreeRoot,
  operationId,
  gitRunner = runGitWithSpawn,
  fileSystem = fs,
  now = new Date(),
  onWorkspacePlanned = async () => {},
} = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(operationId ?? ''))) throw new Error('Invalid operation ID');
  const roots = Array.isArray(selection?.roots) ? selection.roots.filter((root) => typeof root === 'string' && root.trim()) : [];
  if (roots.length === 0) throw new Error('Task selection has no valid roots');

  if (selection.kind === 'projectless') {
    const workspace = {
      mode: 'projectless',
      cwd: roots[0],
      runtimeWorkspaceRoots: [roots[0]],
      branchName: null,
      worktreePath: null,
      operationId,
    };
    await onWorkspacePlanned(workspace);
    await fileSystem.mkdir(roots[0], { recursive: true });
    return { ...workspace, cleanupBeforeThreadStart: noOpCleanup };
  }

  const configuredWorktreeRoot = expandWorktreeRoot(worktreeRoot);
  await validateSavedProjectRoots(roots, fileSystem);

  const sourceRoot = roots[0];
  const git = await inspectSavedProjectGit({ sourceRoot, gitRunner, fileSystem });
  if (!git.isRepo) {
    const workspace = {
      mode: 'local',
      cwd: sourceRoot,
      runtimeWorkspaceRoots: roots.slice(),
      branchName: null,
      worktreePath: null,
      operationId,
    };
    await onWorkspacePlanned(workspace);
    return { ...workspace, cleanupBeforeThreadStart: noOpCleanup };
  }

  let baseRef;
  try {
    const result = await gitRunner({
      command: 'git',
      args: ['-C', sourceRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    });
    baseRef = String(result?.stdout ?? '').trim();
    if (!baseRef) throw new Error('Remote HEAD is empty');
  } catch {
    try {
      const result = await gitRunner({ command: 'git', args: ['-C', sourceRoot, 'rev-parse', 'HEAD'] });
      baseRef = String(result?.stdout ?? '').trim();
      if (!baseRef) throw new Error('Current Git HEAD is empty');
    } catch {
      const error = new Error('Git workspace preparation failed');
      error.code = 'GIT_WORKSPACE_PREP_FAILED';
      throw error;
    }
  }

  const branchName = `codex/discord-${formatBranchTimestamp(now)}-${randomBytes(3).toString('hex')}`;
  const worktreePath = path.win32.resolve(configuredWorktreeRoot, operationId);
  if (!resolvedDescendant(configuredWorktreeRoot, worktreePath)) throw new Error('Unsafe worktree path');
  const workspace = {
    mode: 'worktree',
    cwd: worktreePath,
    runtimeWorkspaceRoots: [worktreePath, ...roots.slice(1)],
    branchName,
    worktreePath,
    sourceRoot,
    repositoryRoot: git.repositoryRoot,
    operationId,
  };
  await onWorkspacePlanned(workspace);
  try {
    await gitRunner({
      command: 'git',
      args: ['-C', sourceRoot, 'worktree', 'add', '-b', branchName, worktreePath, baseRef],
    });
  } catch {
    const error = new Error('Git workspace preparation failed');
    error.code = 'GIT_WORKSPACE_PREP_FAILED';
    error.workspace = workspace;
    throw error;
  }
  workspace.cleanupBeforeThreadStart = noOpCleanup;
  return workspace;
}

function taskCreationErrorCategory(error) {
  if (error?.code === 'PROJECT_REFRESH_FAILED') return 'project-refresh-failed';
  if (String(error?.code ?? '').startsWith('GIT_')) return 'git-failed';
  return 'task-create-failed';
}

function persistenceError() {
  const error = new Error('Task creation state persistence failed');
  error.code = 'STATE_PERSIST_FAILED';
  error.persistenceFailure = true;
  return error;
}

async function persistInteractionRecord({ state, interactionId, record, persistState, discordTurnOrigin }) {
  try {
    const origin = discordTurnOrigin ? createDiscordTurnOriginRecord(discordTurnOrigin) : null;
    await commitInboxState({
      state,
      persistState,
      entries: {
        createdTasksByInteraction: [interactionId],
        discordTurnOrigins: origin ? [origin.turnId] : [],
      },
      mutate: () => {
        state.createdTasksByInteraction ??= {};
        state.createdTasksByInteraction[interactionId] = record;
        if (origin) {
          state.discordTurnOrigins ??= {};
          const { turnId, ...value } = origin;
          const existing = state.discordTurnOrigins[turnId];
          if (existing && (existing.threadId !== value.threadId || existing.guildId !== value.guildId ||
              existing.channelId !== value.channelId)) {
            throw new Error('Discord turn origin conflicts with an existing binding');
          }
          state.discordTurnOrigins[turnId] ??= value;
        }
      },
      errorMessage: 'Task creation state persistence failed',
    });
  } catch {
    throw persistenceError();
  }
}

export async function recordTaskCreationReceiptOutcome({
  state,
  interactionId,
  status,
  messageId,
  errorCategory,
  now = new Date(),
  persistState,
} = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Task creation state is required');
  if (!interactionId) throw new Error('Interaction ID is required');
  if (!['original-edited', 'followup-sent', 'failed'].includes(String(status ?? ''))) {
    throw new Error('Invalid creation receipt status');
  }
  const current = state.createdTasksByInteraction?.[interactionId];
  if (!current) return false;
  const observedNow = typeof now === 'function' ? now() : now;
  const updatedAt = new Date(observedNow instanceof Date ? observedNow.getTime() : Number(observedNow)).toISOString();
  const record = {
    ...current,
    receiptStatus: status,
    receiptUpdatedAt: updatedAt,
  };
  delete record.receiptMessageId;
  delete record.receiptErrorCategory;
  if (messageId) record.receiptMessageId = String(messageId).slice(0, 128);
  if (status === 'failed') {
    record.receiptErrorCategory = errorCategory === 'creation-receipt-delivery-failed'
      ? errorCategory
      : 'creation-receipt-delivery-failed';
  }
  await persistInteractionRecord({ state, interactionId, record, persistState });
  return true;
}

async function sourceMatchesProof({ proof, gitRunner }) {
  try {
    const sourceProbe = await gitRunner({
      command: 'git', args: ['-C', proof.sourceRoot, 'rev-parse', '--show-toplevel'],
    });
    return windowsPathEqual(String(sourceProbe?.stdout ?? '').trim(), proof.repositoryRoot);
  } catch {
    return false;
  }
}

async function cleanupWithJournal({
  state,
  interactionId,
  workspace,
  worktreeRoot,
  gitRunner,
  persistState,
  finalRecord,
}) {
  if (!workspace || workspace.mode !== 'worktree') {
    await persistInteractionRecord({ state, interactionId, record: finalRecord, persistState });
    return { completed: true, cleaned: false, retryable: false };
  }

  let current = state.createdTasksByInteraction[interactionId];
  let proof = current?.cleanupProof;
  if (!['cleanup-proven', 'worktree-removed'].includes(current?.status)) {
    proof = await proveOwnedWorkspace({ workspace, worktreeRoot, operationId: interactionId, gitRunner });
    if (!proof) return { completed: false, cleaned: false, retryable: true };
    await persistInteractionRecord({
      state,
      interactionId,
      record: { ...current, status: 'cleanup-proven', workspace, cleanupProof: proof },
      persistState,
    });
    current = state.createdTasksByInteraction[interactionId];
  }

  if (!validCleanupProof({ proof, workspace, worktreeRoot, operationId: interactionId })) {
    return { completed: false, cleaned: false, retryable: true };
  }

  if (current.status === 'cleanup-proven') {
    const association = await inspectProvenWorktree({ proof, gitRunner });
    if (!['present', 'removed'].includes(association)) {
      return { completed: false, cleaned: false, retryable: true };
    }
    if (association === 'present') {
      try {
        await gitRunner({
          command: 'git',
          args: ['-C', proof.repositoryRoot, 'worktree', 'remove', '--force', proof.worktreePath],
        });
      } catch {
        return { completed: false, cleaned: false, retryable: true };
      }
    }
    await persistInteractionRecord({
      state,
      interactionId,
      record: { ...current, status: 'worktree-removed', workspace, cleanupProof: proof },
      persistState,
    });
    current = state.createdTasksByInteraction[interactionId];
  }

  if (!await sourceMatchesProof({ proof, gitRunner })) {
    return { completed: false, cleaned: false, retryable: true };
  }
  const branch = await exactBranchOid({
    repositoryRoot: proof.repositoryRoot, branchRef: proof.branchRef, gitRunner,
  });
  if (branch.state === 'present') {
    if (branch.oid.toLocaleLowerCase('en-US') !== proof.branchOid.toLocaleLowerCase('en-US')) {
      return { completed: false, cleaned: false, retryable: true };
    }
    try {
      await gitRunner({
        command: 'git', args: ['-C', proof.repositoryRoot, 'branch', '-D', proof.branchName],
      });
    } catch {
      return { completed: false, cleaned: false, retryable: true };
    }
  } else if (branch.state !== 'missing') {
    return { completed: false, cleaned: false, retryable: true };
  }

  await persistInteractionRecord({
    state,
    interactionId,
    record: { ...finalRecord, workspace, cleanupProof: proof },
    persistState,
  });
  return { completed: true, cleaned: true, retryable: false };
}

export async function startNewCodexTask({
  selection,
  workspace,
  text,
  interactionId,
  codexPath,
  processCwd,
  clientFactory,
  onThreadStarting,
  onThreadCreated,
} = {}) {
  const client = createClient({ clientFactory, codexPath, processCwd });
  const resource = clientResource(client);
  let threadId = null;
  let taskName = '生成中';
  try {
    await initializeAppServerClient(client);
    await onThreadStarting?.({ workspace });
    const threadResult = await client.request({
      method: 'thread/start',
      id: 2,
      params: {
        ephemeral: false,
        projectId: selection.kind === 'project' ? selection.projectId : null,
        cwd: workspace.cwd,
        runtimeWorkspaceRoots: workspace.runtimeWorkspaceRoots,
        threadSource: 'user',
      },
    });
    threadId = String(threadResult?.thread?.id ?? '');
    if (!threadId) throw new Error('Codex App Server did not return a thread ID');
    const returnedName = String(threadResult?.thread?.name ?? '').trim();
    if (returnedName) taskName = returnedName;
    await onThreadCreated?.({ threadId, taskName, workspace });

    const turnResult = await client.request({
      method: 'turn/start',
      id: 3,
      params: {
        threadId,
        input: [{ type: 'text', text }],
        cwd: workspace.cwd,
        runtimeWorkspaceRoots: workspace.runtimeWorkspaceRoots,
        clientUserMessageId: interactionId,
        turnTrigger: 'discord-slash-command',
      },
    });
    const turnId = String(turnResult?.turn?.id ?? '');
    if (!turnId) throw new Error('Codex App Server did not return a turn ID');
    const completion = client.waitForTurn(turnId).finally(resource.close);
    return { threadId, turnId, taskName, completion, workspace, ...resource };
  } catch (error) {
    resource.close();
    if (threadId) {
      error.threadId = threadId;
      error.taskName = taskName;
      error.workspace = workspace;
    }
    throw error;
  }
}

function persistableWorkspace(workspace) {
  if (!workspace) return workspace;
  const { cleanupBeforeThreadStart: _cleanup, ...persistent } = workspace;
  return persistent;
}

const inFlightByState = new WeakMap();

export async function createNewTaskOnce({
  state,
  interactionId,
  selection,
  worktreeRoot,
  text,
  codexPath,
  processCwd,
  clientFactory,
  gitRunner = runGitWithSpawn,
  fileSystem = fs,
  persistState,
  now = new Date(),
  discordOrigin,
} = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Task creation state is required');
  if (!interactionId) throw new Error('Interaction ID is required');
  if (typeof persistState !== 'function') throw new TypeError('Task persistence boundary is required');
  let stateFlights = inFlightByState.get(state);
  if (!stateFlights) {
    stateFlights = new Map();
    inFlightByState.set(state, stateFlights);
  }
  const pending = stateFlights.get(interactionId);
  if (pending) return pending;

  const recorded = state.createdTasksByInteraction?.[interactionId];
  if (recorded) {
    return { ...recorded, duplicate: true };
  }

  let resolveOperation;
  let rejectOperation;
  const operation = new Promise((resolve, reject) => {
    resolveOperation = resolve;
    rejectOperation = reject;
  });
  stateFlights.set(interactionId, operation);
  (async () => {
    const projectIdentity = {
      projectId: selection?.kind === 'project' ? selection.projectId : null,
      projectName: selection?.projectName ?? (selection?.kind === 'project' ? selection.projectId : '无项目'),
    };
    const originIntent = discordOrigin ? {
      guildId: discordOrigin.guildId,
      channelId: discordOrigin.channelId,
      source: 'new-task',
      projectId: discordOrigin.projectId ?? null,
      projectName: discordOrigin.projectName ?? null,
      createdAt: now.toISOString(),
    } : undefined;
    let prepared = null;
    let started = null;
    try {
      await persistInteractionRecord({
        state, interactionId, record: { status: 'creating', ...projectIdentity }, persistState,
      });
      prepared = await prepareTaskWorkspace({
        selection,
        worktreeRoot,
        operationId: interactionId,
        gitRunner,
        fileSystem,
        now,
        onWorkspacePlanned: async (workspace) => persistInteractionRecord({
          state,
          interactionId,
          record: { status: 'creating', ...projectIdentity, workspace: persistableWorkspace(workspace) },
          persistState,
        }),
      });
      const persistentWorkspace = persistableWorkspace(prepared);
      await persistInteractionRecord({
        state,
        interactionId,
        record: { status: 'workspace-ready', ...projectIdentity, workspace: persistentWorkspace },
        persistState,
      });
      started = await startNewCodexTask({
        selection,
        workspace: prepared,
        text,
        interactionId,
        codexPath,
        processCwd,
        clientFactory,
        onThreadStarting: async () => {
          await persistInteractionRecord({
            state,
            interactionId,
            record: { status: 'thread-starting', ...projectIdentity, workspace: persistentWorkspace },
            persistState,
          });
        },
        onThreadCreated: async ({ threadId, taskName }) => {
          await persistInteractionRecord({
            state,
            interactionId,
            record: {
              status: 'thread-created',
              ...projectIdentity,
              threadId,
              taskName,
              workspace: persistentWorkspace,
              ...(originIntent ? { originIntent } : {}),
            },
            persistState,
          });
        },
      });
      const retainedWorkspace = { ...started.workspace, cleanupBeforeThreadStart: noOpCleanup };
      const record = {
        status: 'started',
        threadId: started.threadId,
        turnId: started.turnId,
        taskName: started.taskName,
        ...projectIdentity,
        workspace: persistentWorkspace,
      };
      await persistInteractionRecord({
        state,
        interactionId,
        record,
        persistState,
        discordTurnOrigin: discordOrigin ? {
          ...discordOrigin,
          turnId: started.turnId,
          threadId: started.threadId,
          createdAt: now.toISOString(),
        } : null,
      });
      return {
        ...record,
        completion: started.completion,
        close: started.close,
        cancel: started.cancel,
        workspace: retainedWorkspace,
      };
    } catch (error) {
      if (started) {
        Promise.resolve(started.completion).catch(() => {});
        started.close?.();
      }
      const current = state.createdTasksByInteraction[interactionId];
      if (error?.persistenceFailure) {
        if (started) {
          return {
            status: 'start-uncertain',
            threadId: started.threadId,
            turnId: started.turnId,
            taskName: started.taskName,
            ...projectIdentity,
            workspace: persistableWorkspace(started.workspace),
          };
        }
        throw error;
      }
      if (error?.threadId || current?.threadId) {
        const record = {
          status: 'first-turn-failed',
          threadId: error?.threadId ?? current.threadId,
          taskName: error?.taskName ?? current.taskName ?? '生成中',
          ...projectIdentity,
          workspace: persistableWorkspace(error?.workspace ?? prepared ?? current.workspace),
          errorCategory: taskCreationErrorCategory(error),
        };
        await persistInteractionRecord({ state, interactionId, record, persistState });
        return record;
      }
      if (current?.status === 'thread-starting') {
        throw error;
      }
      const workspace = persistableWorkspace(error?.workspace ?? prepared ?? current?.workspace);
      await cleanupWithJournal({
        state,
        interactionId,
        workspace,
        worktreeRoot,
        gitRunner,
        persistState,
        finalRecord: {
          status: 'failed-before-thread',
          ...projectIdentity,
          workspace,
          errorCategory: taskCreationErrorCategory(error),
        },
      });
      throw error;
    }
  })().then(resolveOperation, rejectOperation);
  try {
    return await operation;
  } finally {
    if (stateFlights.get(interactionId) === operation) stateFlights.delete(interactionId);
  }
}

function isExactRootSessionMeta(payload, threadId) {
  if (!payload || typeof payload !== 'object' || String(payload.id ?? '') !== threadId) return false;
  if (String(payload.thread_source ?? '').trim() && payload.thread_source !== 'user') return false;
  if (String(payload.parent_thread_id ?? '').trim()) return false;
  if (String(payload.session_id ?? '').trim() && String(payload.session_id) !== threadId) return false;
  if (payload.source && typeof payload.source === 'object' && Object.entries(payload.source).some(
    ([key, value]) => key.toLocaleLowerCase() === 'subagent' && value != null,
  )) return false;
  return true;
}

async function listRegularRollouts(root) {
  if (!root || !path.isAbsolute(root)) return [];
  const found = [];
  const visit = async (directory) => {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(candidate);
    }
  };
  await visit(root);
  return found;
}

async function findUniqueRootTurn(sessionsRoot, threadId) {
  const candidates = [];
  for (const filePath of await listRegularRollouts(sessionsRoot)) {
    let info;
    try { info = await fs.stat(filePath); } catch { continue; }
    if (!info.isFile() || info.size <= 0 || info.size > 16 * 1024 * 1024) continue;
    let content;
    try { content = await fs.readFile(filePath, 'utf8'); } catch { continue; }
    const entries = [];
    let invalid = false;
    for (const line of content.split(/\r?\n/u)) {
      if (!line) continue;
      try { entries.push(JSON.parse(line)); } catch { invalid = true; break; }
    }
    if (invalid) continue;
    const metas = entries.filter((entry) => entry?.type === 'session_meta');
    if (metas.length !== 1 || !isExactRootSessionMeta(metas[0].payload, threadId)) continue;
    const turnIds = entries
      .filter((entry) => entry?.type === 'event_msg' && entry.payload?.type === 'task_started')
      .map((entry) => String(entry.payload?.turn_id ?? ''))
      .filter(Boolean);
    if (turnIds.length === 1) candidates.push(turnIds[0]);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export async function recoverInterruptedTaskCreations({
  state,
  worktreeRoot,
  sessionsRoot,
  gitRunner = runGitWithSpawn,
  persistState,
  nowMs = Date.now(),
} = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Task creation state is required');
  if (typeof persistState !== 'function') throw new TypeError('Task persistence boundary is required');
  state.createdTasksByInteraction ??= {};
  const results = [];
  for (const [interactionId, record] of Object.entries(state.createdTasksByInteraction)) {
    if (record?.status === 'thread-created' && record.threadId && record.originIntent) {
      const turnId = await findUniqueRootTurn(sessionsRoot, record.threadId);
      if (!turnId) continue;
      const { originIntent, ...rest } = record;
      await persistInteractionRecord({
        state,
        interactionId,
        record: { ...rest, status: 'started', turnId },
        persistState,
        discordTurnOrigin: { ...originIntent, threadId: record.threadId, turnId },
      });
      results.push({ interactionId, status: 'started', recoveredTurnId: turnId });
      continue;
    }
    if (!['creating', 'workspace-ready', 'recovering', 'cleanup-proven', 'worktree-removed'].includes(record?.status)
      || record?.threadId) continue;
    if (!['cleanup-proven', 'worktree-removed'].includes(record.status)) {
      await persistInteractionRecord({
        state,
        interactionId,
        record: { ...record, status: 'recovering', recoveryStartedAt: new Date(nowMs).toISOString() },
        persistState,
      });
    }
    const workspace = state.createdTasksByInteraction[interactionId].workspace;
    const outcome = await cleanupWithJournal({
      state,
      interactionId,
      workspace,
      worktreeRoot,
      gitRunner,
      persistState,
      finalRecord: {
        ...record,
        status: 'recovered-failed',
        recoveredAt: new Date(nowMs).toISOString(),
      },
    });
    results.push({
      interactionId,
      cleaned: outcome.cleaned,
      status: state.createdTasksByInteraction[interactionId].status,
      ...(outcome.retryable ? { retryable: true } : {}),
    });
  }
  return results;
}
