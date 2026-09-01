import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  NO_PROJECT,
  createNewTaskOnce,
  createProjectCatalog,
  listCodexProjects,
  prepareTaskWorkspace,
  recoverInterruptedTaskCreations,
  resolveProjectSelection,
  startNewCodexTask,
} from '../discord-task-create-lib.mjs';

function fakeAppServer(methods, responses, messages = []) {
  return {
    async request(message) {
      methods.push(message.method);
      messages.push(structuredClone(message));
      const response = responses[message.method];
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return response(message);
      return structuredClone(response ?? {});
    },
    send(message) {
      methods.push(message.method);
      messages.push(structuredClone(message));
    },
    waitForTurn(turnId) {
      return Promise.resolve({ turn: { id: turnId, status: 'completed' } });
    },
    close() {
      methods.push('close');
    },
  };
}

function fakeGitRunner(calls, {
  isRepo = true,
  defaultRef = 'origin/main',
  head = '0123456789abcdef',
} = {}) {
  return async ({ command, args }) => {
    calls.push({ command, args: [...args] });
    assert.equal(command, 'git');
    assert.equal(Array.isArray(args), true);
    if (args.at(-1) === '--show-toplevel') {
      if (!isRepo) throw Object.assign(new Error('not a repository'), { code: 'GIT_FAILED' });
      return { stdout: `${args[1]}\n` };
    }
    if (args.includes('symbolic-ref')) {
      if (!defaultRef) throw Object.assign(new Error('no origin HEAD'), { code: 'GIT_FAILED' });
      return { stdout: `${defaultRef}\n` };
    }
    if (args.at(-1) === 'HEAD') return { stdout: `${head}\n` };
    return { stdout: '' };
  };
}

function project(overrides = {}) {
  return {
    id: 'project-1',
    name: 'POS',
    roots: [{ path: 'C:\\repo' }, { path: 'C:\\shared' }],
    ...overrides,
  };
}

test('lists every saved project page in server order on one initialized client', async () => {
  const methods = [];
  const messages = [];
  const projects = await listCodexProjects({
    codexPath: 'codex',
    processCwd: 'C:\\workspace',
    clientFactory: () => fakeAppServer(methods, {
      'project/list': ({ params }) => params.cursor === null
        ? { data: [project({ id: 'p1', name: 'First' })], nextCursor: 'page-2' }
        : { data: [project({ id: 'p2', name: 'Second' })], nextCursor: null },
    }, messages),
  });

  assert.deepEqual(methods, ['initialize', 'initialized', 'project/list', 'project/list', 'close']);
  assert.deepEqual(projects.map(({ id }) => id), ['p1', 'p2']);
  assert.deepEqual(messages.filter(({ method }) => method === 'project/list').map(({ params }) => params), [
    { cursor: null, limit: 100 },
    { cursor: 'page-2', limit: 100 },
  ]);
});

test('closes the project-list App Server client when paging fails', async () => {
  const methods = [];
  await assert.rejects(() => listCodexProjects({
    codexPath: 'codex',
    processCwd: 'C:\\workspace',
    clientFactory: () => fakeAppServer(methods, { 'project/list': new Error('unavailable') }),
  }), /unavailable/);
  assert.deepEqual(methods, ['initialize', 'initialized', 'project/list', 'close']);
});

test('project catalog autocomplete is cache-only and deduplicates an expired background refresh', async () => {
  let clock = 0;
  let calls = 0;
  let releaseRefresh;
  const refreshResult = new Promise((resolve) => { releaseRefresh = resolve; });
  const catalog = createProjectCatalog({
    ttlMs: 60_000,
    now: () => clock,
    loader: async () => {
      calls += 1;
      if (calls === 1) return [project({ id: 'old', name: 'Old Project' })];
      return refreshResult;
    },
  });

  await Promise.all([catalog.warm(), catalog.warm()]);
  assert.equal(calls, 1);
  assert.deepEqual(catalog.choices('old'), [
    { name: 'Old Project', value: 'old' },
    { name: '无项目', value: NO_PROJECT },
  ]);

  clock = 60_000;
  const first = catalog.choices('');
  const second = catalog.choices('');
  assert.equal(calls, 2);
  assert.deepEqual(first, second);
  assert.equal(first[0].value, 'old');
  assert.equal(catalog.status().refreshing, true);

  releaseRefresh([project({ id: 'new', name: 'New Project' })]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(catalog.getById('new').name, 'New Project');
  assert.equal(catalog.status().refreshing, false);
});

test('project catalog keeps last good data and exposes only a sanitized refresh error category', async () => {
  let clock = 0;
  let fail = false;
  const catalog = createProjectCatalog({
    ttlMs: 10,
    now: () => clock,
    loader: async () => {
      if (fail) throw new Error('C:\\private\\project token=secret');
      return [project({ id: 'safe', name: 'Saved' })];
    },
  });
  await catalog.warm();
  clock = 11;
  fail = true;

  assert.equal(catalog.getById('safe').name, 'Saved');
  await new Promise((resolve) => setImmediate(resolve));
  const status = catalog.status();
  assert.equal(status.errorCategory, 'project-refresh-failed');
  assert.equal(status.lastRefreshAt, 0);
  assert.equal(JSON.stringify(status).includes('private'), false);
  assert.equal(catalog.choices('')[0].value, 'safe');
  await assert.rejects(() => catalog.refresh(), (error) => {
    assert.match(error.message, /project catalog refresh failed/);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(error.message.includes('private'), false);
    return true;
  });
});

test('resolves only exact saved project IDs and rejects deleted, rootless, or path selections', () => {
  const projects = [project()];
  assert.deepEqual(resolveProjectSelection({ projects, selectionId: 'project-1' }), {
    kind: 'project',
    projectId: 'project-1',
    projectName: 'POS',
    roots: ['C:\\repo', 'C:\\shared'],
  });
  assert.throws(() => resolveProjectSelection({ projects, selectionId: ' project-1 ' }), /project selection/i);
  assert.throws(() => resolveProjectSelection({ projects, selectionId: 'deleted' }), /project selection/i);
  assert.throws(() => resolveProjectSelection({ projects, selectionId: 'C:\\repo' }), /project selection/i);
  assert.throws(() => resolveProjectSelection({
    projects: [project({ roots: [{ path: '' }, {}] })],
    selectionId: 'project-1',
  }), /valid roots/i);
});

test('resolves the fixed projectless selection without creating its expanded directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-projectless-selection-'));
  const missing = path.join(root, 'Documents', 'Codex', 'Discord Tasks');
  const previous = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  try {
    assert.deepEqual(resolveProjectSelection({
      projects: [],
      selectionId: NO_PROJECT,
      projectlessRoot: '%USERPROFILE%\\Documents\\Codex\\Discord Tasks',
    }), {
      kind: 'projectless',
      projectId: null,
      projectName: '无项目',
      roots: [path.win32.join(root, 'Documents', 'Codex', 'Discord Tasks')],
    });
    await assert.rejects(() => fs.stat(missing), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects a projectless USERPROFILE token when the profile is unavailable', () => {
  const previous = process.env.USERPROFILE;
  delete process.env.USERPROFILE;
  try {
    assert.throws(() => resolveProjectSelection({
      projects: [],
      selectionId: NO_PROJECT,
      projectlessRoot: '%USERPROFILE%\\Documents\\Codex\\Discord Tasks',
    }), /could not be expanded/i);
  } finally {
    if (previous !== undefined) process.env.USERPROFILE = previous;
  }
});

test('routes a Git saved project to an operation-owned generated worktree and preserves extra roots', async () => {
  const calls = [];
  const prepared = await prepareTaskWorkspace({
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo', 'C:\\shared'] },
    worktreeRoot: 'G:\\codex-worktrees',
    operationId: 'abc123',
    now: new Date('2026-09-01T01:02:03Z'),
    gitRunner: fakeGitRunner(calls, { isRepo: true, defaultRef: 'origin/main' }),
  });

  assert.equal(prepared.mode, 'worktree');
  assert.match(prepared.branchName, /^codex\/discord-20260901-010203-[0-9a-f]{6}$/);
  assert.equal(prepared.worktreePath, 'G:\\codex-worktrees\\abc123');
  assert.deepEqual(prepared.runtimeWorkspaceRoots, [prepared.worktreePath, 'C:\\shared']);
  assert.deepEqual(calls.at(-1).args.slice(2, 6), ['worktree', 'add', '-b', prepared.branchName]);
  assert.deepEqual(calls.at(-1).args.slice(-2), [prepared.worktreePath, 'origin/main']);
});

test('falls back from missing remote HEAD to the current Git HEAD', async () => {
  const calls = [];
  const prepared = await prepareTaskWorkspace({
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: 'G:\\codex-worktrees',
    operationId: 'fallback1',
    now: new Date('2026-09-01T01:02:03Z'),
    gitRunner: fakeGitRunner(calls, { defaultRef: null, head: 'deadbeef' }),
  });
  assert.equal(prepared.mode, 'worktree');
  assert.equal(calls.some(({ args }) => args.at(-1) === 'HEAD'), true);
  assert.equal(calls.at(-1).args.at(-1), 'deadbeef');
});

test('routes non-Git saved projects locally with every saved root', async () => {
  const calls = [];
  const prepared = await prepareTaskWorkspace({
    selection: { kind: 'project', projectId: 'p1', projectName: 'Files', roots: ['C:\\files', 'D:\\shared'] },
    worktreeRoot: 'G:\\codex-worktrees',
    operationId: 'local1',
    gitRunner: fakeGitRunner(calls, { isRepo: false }),
  });
  assert.equal(prepared.mode, 'local');
  assert.equal(prepared.cwd, 'C:\\files');
  assert.deepEqual(prepared.runtimeWorkspaceRoots, ['C:\\files', 'D:\\shared']);
  assert.equal(calls.length, 1);
});

test('creates the configured projectless directory only while preparing the workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-projectless-workspace-'));
  const cwd = path.join(root, 'nested', 'tasks');
  try {
    const prepared = await prepareTaskWorkspace({
      selection: { kind: 'projectless', projectId: null, projectName: '无项目', roots: [cwd] },
      worktreeRoot: path.join(root, 'worktrees'),
      operationId: 'projectless1',
    });
    assert.equal(prepared.mode, 'projectless');
    assert.equal(prepared.cwd, cwd);
    assert.equal((await fs.stat(cwd)).isDirectory(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects unsafe operation IDs before invoking Git', async () => {
  const calls = [];
  await assert.rejects(() => prepareTaskWorkspace({
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: 'G:\\codex-worktrees',
    operationId: '..\\outside',
    gitRunner: fakeGitRunner(calls),
  }), /operation ID/i);
  assert.deepEqual(calls, []);
});

test('rejects a missing configured worktree root before invoking Git', async () => {
  const calls = [];
  await assert.rejects(() => prepareTaskWorkspace({
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: '',
    operationId: 'missingroot1',
    gitRunner: fakeGitRunner(calls),
  }), /worktree root/i);
  assert.deepEqual(calls, []);
});

test('starts a durable thread before its first turn with exact workspace metadata', async () => {
  const methods = [];
  const messages = [];
  const result = await startNewCodexTask({
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    workspace: { mode: 'local', cwd: 'C:\\repo', runtimeWorkspaceRoots: ['C:\\repo'] },
    text: '检查支付流程',
    interactionId: 'interaction-1',
    codexPath: 'codex',
    processCwd: 'C:\\repo',
    clientFactory: () => fakeAppServer(methods, {
      'thread/start': { thread: { id: 'thread-1', name: null } },
      'turn/start': { turn: { id: 'turn-1' } },
    }, messages),
  });

  assert.deepEqual(methods.slice(0, 4), ['initialize', 'initialized', 'thread/start', 'turn/start']);
  assert.deepEqual(messages[2], {
    method: 'thread/start',
    id: 2,
    params: {
      ephemeral: false,
      projectId: 'p1',
      cwd: 'C:\\repo',
      runtimeWorkspaceRoots: ['C:\\repo'],
      threadSource: 'user',
    },
  });
  assert.deepEqual(messages[3], {
    method: 'turn/start',
    id: 3,
    params: {
      threadId: 'thread-1',
      input: [{ type: 'text', text: '检查支付流程' }],
      cwd: 'C:\\repo',
      runtimeWorkspaceRoots: ['C:\\repo'],
      clientUserMessageId: 'interaction-1',
      turnTrigger: 'discord-slash-command',
    },
  });
  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.taskName, '生成中');
  assert.equal(result.workspace.cwd, 'C:\\repo');
  await result.completion;
  assert.equal(methods.at(-1), 'close');
});

test('uses an explicit null project ID for projectless durable threads', async () => {
  const methods = [];
  const messages = [];
  const result = await startNewCodexTask({
    selection: { kind: 'projectless', projectId: null, projectName: '无项目', roots: ['C:\\tasks'] },
    workspace: { mode: 'projectless', cwd: 'C:\\tasks', runtimeWorkspaceRoots: ['C:\\tasks'] },
    text: 'new task', interactionId: 'interaction-projectless', codexPath: 'codex', processCwd: 'C:\\tasks',
    clientFactory: () => fakeAppServer(methods, {
      'thread/start': { thread: { id: 'thread-p', name: 'Named' } },
      'turn/start': { turn: { id: 'turn-p' } },
    }, messages),
  });
  assert.equal(messages[2].params.projectId, null);
  assert.equal(result.taskName, 'Named');
  await result.completion;
});

test('persists each creation state before the corresponding external mutation and deduplicates the Interaction', async () => {
  const state = {};
  const gitCalls = [];
  const methods = [];
  let clients = 0;
  const args = {
    state,
    interactionId: 'interaction-once',
    selection: { kind: 'project', projectId: 'p1', projectName: 'Files', roots: ['C:\\files'] },
    worktreeRoot: 'G:\\codex-worktrees',
    text: 'run once',
    codexPath: 'codex',
    processCwd: 'C:\\files',
    gitRunner: fakeGitRunner(gitCalls, { isRepo: false }),
    clientFactory: () => {
      clients += 1;
      return fakeAppServer(methods, {
        'thread/start': () => {
          assert.equal(state.createdTasksByInteraction['interaction-once'].status, 'workspace-ready');
          return { thread: { id: 'thread-once', name: null } };
        },
        'turn/start': () => {
          assert.equal(state.createdTasksByInteraction['interaction-once'].status, 'thread-created');
          assert.equal(state.createdTasksByInteraction['interaction-once'].threadId, 'thread-once');
          return { turn: { id: 'turn-once' } };
        },
      });
    },
  };

  const first = await createNewTaskOnce(args);
  const duplicate = await createNewTaskOnce(args);
  assert.equal(first.status, 'started');
  assert.equal(first.threadId, 'thread-once');
  assert.equal(duplicate.threadId, 'thread-once');
  assert.equal(duplicate.duplicate, true);
  assert.equal(clients, 1);
  assert.equal(gitCalls.length, 1);
  await first.completion;
});

test('cleans only its generated worktree and branch when thread creation fails', async () => {
  const state = {};
  const gitCalls = [];
  await assert.rejects(() => createNewTaskOnce({
    state,
    interactionId: 'cleanup1',
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: 'G:\\codex-worktrees',
    text: 'will fail', codexPath: 'codex', processCwd: 'C:\\repo',
    now: new Date('2026-09-01T01:02:03Z'),
    gitRunner: fakeGitRunner(gitCalls),
    clientFactory: () => fakeAppServer([], { 'thread/start': new Error('thread failed') }),
  }), /thread failed/);

  const record = state.createdTasksByInteraction.cleanup1;
  assert.equal(record.status, 'failed-before-thread');
  assert.equal(record.threadId, undefined);
  const destructive = gitCalls.filter(({ args }) => args.includes('remove') || args.includes('-D'));
  assert.equal(destructive.length, 2);
  assert.deepEqual(destructive[0].args.slice(2), ['worktree', 'remove', '--force', 'G:\\codex-worktrees\\cleanup1']);
  assert.equal(destructive[1].args.at(-2), '-D');
  assert.match(destructive[1].args.at(-1), /^codex\/discord-/);
});

test('preserves the durable thread and worktree when the first turn fails', async () => {
  const state = {};
  const gitCalls = [];
  const result = await createNewTaskOnce({
    state,
    interactionId: 'turnfail1',
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: 'G:\\codex-worktrees',
    text: 'first turn fails', codexPath: 'codex', processCwd: 'C:\\repo',
    gitRunner: fakeGitRunner(gitCalls),
    clientFactory: () => fakeAppServer([], {
      'thread/start': { thread: { id: 'thread-retained', name: null } },
      'turn/start': new Error('turn failed'),
    }),
  });

  assert.equal(result.status, 'first-turn-failed');
  assert.equal(result.threadId, 'thread-retained');
  assert.equal(state.createdTasksByInteraction.turnfail1.threadId, 'thread-retained');
  assert.equal(gitCalls.some(({ args }) => args.includes('remove') || args.includes('-D')), false);
});

test('successful creation disables pre-thread cleanup so its worktree is retained', async () => {
  const state = {};
  const gitCalls = [];
  const result = await createNewTaskOnce({
    state,
    interactionId: 'retain1',
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: 'G:\\codex-worktrees',
    text: 'retain', codexPath: 'codex', processCwd: 'C:\\repo',
    gitRunner: fakeGitRunner(gitCalls),
    clientFactory: () => fakeAppServer([], {
      'thread/start': { thread: { id: 'thread-retain', name: null } },
      'turn/start': { turn: { id: 'turn-retain' } },
    }),
  });
  await result.workspace.cleanupBeforeThreadStart();
  assert.equal(gitCalls.some(({ args }) => args.includes('remove') || args.includes('-D')), false);
  await result.completion;
});

test('startup recovery cleans only descendant, prefixed, operation-owned records without a thread', async () => {
  const gitCalls = [];
  const validWorkspace = {
    mode: 'worktree',
    cwd: 'G:\\codex-worktrees\\valid1',
    runtimeWorkspaceRoots: ['G:\\codex-worktrees\\valid1'],
    worktreePath: 'G:\\codex-worktrees\\valid1',
    branchName: 'codex/discord-20260901-010203-abcdef',
    sourceRoot: 'C:\\repo',
    operationId: 'valid1',
  };
  const state = {
    createdTasksByInteraction: {
      valid1: { status: 'workspace-ready', workspace: validWorkspace },
      outside1: { status: 'workspace-ready', workspace: { ...validWorkspace, operationId: 'outside1', worktreePath: 'G:\\outside\\outside1', cwd: 'G:\\outside\\outside1' } },
      prefix1: { status: 'workspace-ready', workspace: { ...validWorkspace, operationId: 'prefix1', worktreePath: 'G:\\codex-worktrees\\prefix1', cwd: 'G:\\codex-worktrees\\prefix1', branchName: 'main' } },
      mismatch1: { status: 'workspace-ready', workspace: { ...validWorkspace, operationId: 'someone-else', worktreePath: 'G:\\codex-worktrees\\mismatch1', cwd: 'G:\\codex-worktrees\\mismatch1' } },
      durable1: { status: 'workspace-ready', threadId: 'thread-existing', workspace: { ...validWorkspace, operationId: 'durable1', worktreePath: 'G:\\codex-worktrees\\durable1', cwd: 'G:\\codex-worktrees\\durable1' } },
    },
  };

  const recovered = await recoverInterruptedTaskCreations({
    state,
    worktreeRoot: 'G:\\codex-worktrees',
    gitRunner: fakeGitRunner(gitCalls),
    nowMs: 1_788_230_400_000,
  });
  assert.equal(recovered.find(({ interactionId }) => interactionId === 'valid1').cleaned, true);
  assert.equal(gitCalls.filter(({ args }) => args.includes('remove') || args.includes('-D')).length, 2);
  assert.equal(state.createdTasksByInteraction.valid1.status, 'recovered-failed');
  assert.equal(state.createdTasksByInteraction.outside1.status, 'recovered-failed');
  assert.equal(state.createdTasksByInteraction.durable1.status, 'workspace-ready');
  assert.equal(recovered.some(({ interactionId }) => interactionId === 'durable1'), false);
});

test('startup recovery marks mutation-free creating records as recovered and never invents cleanup targets', async () => {
  const state = { createdTasksByInteraction: { creating1: { status: 'creating' } } };
  const calls = [];
  const result = await recoverInterruptedTaskCreations({
    state,
    worktreeRoot: 'G:\\codex-worktrees',
    gitRunner: fakeGitRunner(calls),
    nowMs: 1_788_230_400_000,
  });
  assert.deepEqual(result, [{ interactionId: 'creating1', cleaned: false, status: 'recovered-failed' }]);
  assert.deepEqual(calls, []);
});
