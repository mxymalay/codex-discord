import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { AppServerClient, initializeAppServerClient } from './discord-bridge-lib.mjs';

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

export async function listCodexProjects({ codexPath, processCwd, clientFactory } = {}) {
  const client = createClient({ clientFactory, codexPath, processCwd });
  try {
    await initializeAppServerClient(client);
    const projects = [];
    let cursor = null;
    let requestId = 2;
    do {
      const page = await client.request({
        method: 'project/list',
        id: requestId,
        params: { cursor, limit: 100 },
      });
      requestId += 1;
      if (Array.isArray(page?.data)) projects.push(...page.data);
      cursor = page?.nextCursor ?? null;
    } while (cursor !== null);
    return projects;
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
        warmed = true;
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

  return {
    warm() {
      if (warmed) return Promise.resolve(projects.slice());
      return startRefresh();
    },
    choices(focused = '') {
      refreshIfExpired();
      const query = String(focused ?? '').trim().toLocaleLowerCase();
      const saved = projects
        .filter((item) => !query || String(item?.name ?? '').toLocaleLowerCase().includes(query))
        .slice(0, 24)
        .map((item) => ({ name: String(item.name), value: String(item.id) }));
      saved.push({ name: '无项目', value: NO_PROJECT });
      return saved;
    },
    refresh() {
      return startRefresh();
    },
    getById(id) {
      refreshIfExpired();
      return projects.find((item) => String(item?.id ?? '') === id) ?? null;
    },
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

function runGitWithSpawn({ command = 'git', args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => reject(Object.assign(new Error('Unable to start Git'), { code: 'GIT_START_FAILED' })));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout });
      else reject(Object.assign(new Error('Git operation failed'), { code: 'GIT_FAILED' }));
    });
  });
}

function formatBranchTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid task creation timestamp');
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function resolvedDescendant(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function cleanupOwnedWorkspace({ workspace, worktreeRoot, operationId, gitRunner }) {
  if (!workspace || workspace.mode !== 'worktree') return false;
  const expectedPath = path.resolve(worktreeRoot, operationId);
  const actualPath = path.resolve(String(workspace.worktreePath ?? ''));
  const ownsPath = workspace.operationId === operationId
    && actualPath === expectedPath
    && resolvedDescendant(worktreeRoot, actualPath);
  const ownsBranch = workspace.operationId === operationId
    && typeof workspace.branchName === 'string'
    && workspace.branchName.startsWith('codex/discord-');
  const sourceRoot = typeof workspace.sourceRoot === 'string' && workspace.sourceRoot.trim()
    ? workspace.sourceRoot
    : null;
  if (!ownsPath || !ownsBranch || !sourceRoot) return false;

  let firstError = null;
  try {
    await gitRunner({
      command: 'git',
      args: ['-C', sourceRoot, 'worktree', 'remove', '--force', actualPath],
    });
  } catch (error) {
    firstError = error;
  }
  try {
    await gitRunner({ command: 'git', args: ['-C', sourceRoot, 'branch', '-D', workspace.branchName] });
  } catch (error) {
    firstError ??= error;
  }
  if (firstError) throw firstError;
  return true;
}

function noOpCleanup() {
  return Promise.resolve(false);
}

export async function prepareTaskWorkspace({
  selection,
  worktreeRoot,
  operationId,
  gitRunner = runGitWithSpawn,
  now = new Date(),
} = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(operationId ?? ''))) throw new Error('Invalid operation ID');
  const roots = Array.isArray(selection?.roots) ? selection.roots.filter((root) => typeof root === 'string' && root.trim()) : [];
  if (roots.length === 0) throw new Error('Task selection has no valid roots');

  if (selection.kind === 'projectless') {
    await fs.mkdir(roots[0], { recursive: true });
    return {
      mode: 'projectless',
      cwd: roots[0],
      runtimeWorkspaceRoots: [roots[0]],
      branchName: null,
      worktreePath: null,
      operationId,
      cleanupBeforeThreadStart: noOpCleanup,
    };
  }

  if (!String(worktreeRoot ?? '').trim()) throw new Error('Configured worktree root is required');

  const sourceRoot = roots[0];
  try {
    await gitRunner({ command: 'git', args: ['-C', sourceRoot, 'rev-parse', '--show-toplevel'] });
  } catch {
    return {
      mode: 'local',
      cwd: sourceRoot,
      runtimeWorkspaceRoots: roots.slice(),
      branchName: null,
      worktreePath: null,
      operationId,
      cleanupBeforeThreadStart: noOpCleanup,
    };
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
    const result = await gitRunner({ command: 'git', args: ['-C', sourceRoot, 'rev-parse', 'HEAD'] });
    baseRef = String(result?.stdout ?? '').trim();
    if (!baseRef) throw new Error('Current Git HEAD is empty');
  }

  const branchName = `codex/discord-${formatBranchTimestamp(now)}-${randomBytes(3).toString('hex')}`;
  const worktreePath = path.resolve(worktreeRoot, operationId);
  if (!resolvedDescendant(worktreeRoot, worktreePath)) throw new Error('Unsafe worktree path');
  await gitRunner({
    command: 'git',
    args: ['-C', sourceRoot, 'worktree', 'add', '-b', branchName, worktreePath, baseRef],
  });
  const workspace = {
    mode: 'worktree',
    cwd: worktreePath,
    runtimeWorkspaceRoots: [worktreePath, ...roots.slice(1)],
    branchName,
    worktreePath,
    sourceRoot,
    operationId,
  };
  workspace.cleanupBeforeThreadStart = () => cleanupOwnedWorkspace({
    workspace,
    worktreeRoot,
    operationId,
    gitRunner,
  });
  return workspace;
}

function taskCreationErrorCategory(error) {
  if (error?.code === 'PROJECT_REFRESH_FAILED') return 'project-refresh-failed';
  if (String(error?.code ?? '').startsWith('GIT_')) return 'git-failed';
  return 'task-create-failed';
}

export async function startNewCodexTask({
  selection,
  workspace,
  text,
  interactionId,
  codexPath,
  processCwd,
  clientFactory,
  onThreadCreated,
} = {}) {
  const client = createClient({ clientFactory, codexPath, processCwd });
  let threadId = null;
  let taskName = '生成中';
  try {
    await initializeAppServerClient(client);
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
    const completion = client.waitForTurn(turnId).finally(() => closeClient(client));
    return { threadId, turnId, taskName, completion, workspace };
  } catch (error) {
    closeClient(client);
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
  now = new Date(),
} = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Task creation state is required');
  if (!interactionId) throw new Error('Interaction ID is required');
  state.createdTasksByInteraction ??= {};
  const recorded = state.createdTasksByInteraction[interactionId];
  if (recorded) {
    const pending = inFlightByState.get(state)?.get(interactionId);
    if (pending) return pending;
    return { ...recorded, duplicate: true };
  }

  let stateFlights = inFlightByState.get(state);
  if (!stateFlights) {
    stateFlights = new Map();
    inFlightByState.set(state, stateFlights);
  }

  const operation = (async () => {
    state.createdTasksByInteraction[interactionId] = { status: 'creating' };
    let prepared = null;
    try {
      prepared = await prepareTaskWorkspace({ selection, worktreeRoot, operationId: interactionId, gitRunner, now });
      const persistentWorkspace = persistableWorkspace(prepared);
      state.createdTasksByInteraction[interactionId] = { status: 'workspace-ready', workspace: persistentWorkspace };
      const started = await startNewCodexTask({
        selection,
        workspace: prepared,
        text,
        interactionId,
        codexPath,
        processCwd,
        clientFactory,
        onThreadCreated: async ({ threadId, taskName }) => {
          state.createdTasksByInteraction[interactionId] = {
            status: 'thread-created',
            threadId,
            taskName,
            workspace: persistentWorkspace,
          };
        },
      });
      const retainedWorkspace = { ...started.workspace, cleanupBeforeThreadStart: noOpCleanup };
      const record = {
        status: 'started',
        threadId: started.threadId,
        turnId: started.turnId,
        taskName: started.taskName,
        workspace: persistentWorkspace,
      };
      state.createdTasksByInteraction[interactionId] = record;
      return { ...record, completion: started.completion, workspace: retainedWorkspace };
    } catch (error) {
      const current = state.createdTasksByInteraction[interactionId];
      if (error?.threadId || current?.threadId) {
        const record = {
          status: 'first-turn-failed',
          threadId: error?.threadId ?? current.threadId,
          taskName: error?.taskName ?? current.taskName ?? '生成中',
          workspace: persistableWorkspace(error?.workspace ?? prepared ?? current.workspace),
          errorCategory: taskCreationErrorCategory(error),
        };
        state.createdTasksByInteraction[interactionId] = record;
        return record;
      }
      let cleanupCategory = null;
      if (prepared?.cleanupBeforeThreadStart) {
        try {
          await prepared.cleanupBeforeThreadStart();
        } catch {
          cleanupCategory = 'git-cleanup-failed';
        }
      }
      state.createdTasksByInteraction[interactionId] = {
        status: 'failed-before-thread',
        workspace: persistableWorkspace(prepared),
        errorCategory: cleanupCategory ?? taskCreationErrorCategory(error),
      };
      throw error;
    }
  })();

  stateFlights.set(interactionId, operation);
  try {
    return await operation;
  } finally {
    stateFlights.delete(interactionId);
  }
}

export async function recoverInterruptedTaskCreations({
  state,
  worktreeRoot,
  gitRunner = runGitWithSpawn,
  nowMs = Date.now(),
} = {}) {
  state.createdTasksByInteraction ??= {};
  const results = [];
  for (const [interactionId, record] of Object.entries(state.createdTasksByInteraction)) {
    if (!['creating', 'workspace-ready'].includes(record?.status) || record?.threadId) continue;
    let cleaned = false;
    let errorCategory = null;
    if (record.workspace) {
      try {
        cleaned = await cleanupOwnedWorkspace({
          workspace: record.workspace,
          worktreeRoot,
          operationId: interactionId,
          gitRunner,
        });
      } catch {
        errorCategory = 'git-cleanup-failed';
      }
    }
    state.createdTasksByInteraction[interactionId] = {
      ...record,
      status: 'recovered-failed',
      recoveredAt: new Date(nowMs).toISOString(),
      ...(errorCategory ? { errorCategory } : {}),
    };
    results.push({ interactionId, cleaned, status: 'recovered-failed', ...(errorCategory ? { errorCategory } : {}) });
  }
  return results;
}
