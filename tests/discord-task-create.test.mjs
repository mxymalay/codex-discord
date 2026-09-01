import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { commitInboxState, createEmptyInboxState, recordInboxMessage } from '../discord-bridge-lib.mjs';

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
  head = '0123456789abcdef0123456789abcdef01234567',
  headError = null,
  repositoryRoot = 'C:\\repo',
  probeError = null,
  versionError = null,
  partialAddError = null,
  removeError = null,
  branchDeleteFailure = null,
  branchHeads = new Map(),
  worktrees = [],
} = {}) {
  for (const item of worktrees) {
    branchHeads.set(item.branch, item.head ?? head);
  }
  return async ({ command, args }) => {
    calls.push({ command, args: [...args] });
    assert.equal(command, 'git');
    assert.equal(Array.isArray(args), true);
    if (args[0] === '--version') {
      if (versionError) throw versionError;
      return { stdout: 'git version 2.51.0\n' };
    }
    if (args.includes('worktree') && args.includes('list')) {
      return {
        stdout: worktrees.map((item) => [
          `worktree ${item.path}`,
          `HEAD ${item.head ?? head}`,
          `branch refs/heads/${item.branch}`,
          '',
        ].join('\0')).join(''),
      };
    }
    if (args.includes('worktree') && args.includes('add')) {
      const branch = args[args.indexOf('-b') + 1];
      const worktreePath = args.at(-2);
      worktrees.push({ path: worktreePath, branch, head });
      branchHeads.set(branch, head);
      if (partialAddError) throw partialAddError;
      return { stdout: '' };
    }
    if (args.includes('worktree') && args.includes('remove')) {
      if (removeError) throw removeError;
      const target = path.resolve(args.at(-1));
      const index = worktrees.findIndex((item) => path.resolve(item.path) === target);
      if (index >= 0) worktrees.splice(index, 1);
      return { stdout: '' };
    }
    if (args.includes('show-ref') && args.includes('--verify')) {
      const branch = String(args.at(-1)).replace(/^refs\/heads\//, '');
      if (!branchHeads.has(branch)) {
        throw Object.assign(new Error('missing ref'), { code: 'GIT_REF_NOT_FOUND' });
      }
      return { stdout: `${branchHeads.get(branch)}\n` };
    }
    if (args.includes('branch') && args.includes('-D')) {
      if (branchDeleteFailure?.remaining > 0) {
        branchDeleteFailure.remaining -= 1;
        throw Object.assign(new Error('branch delete failed'), { code: 'GIT_FAILED' });
      }
      branchHeads.delete(args.at(-1));
      return { stdout: '' };
    }
    if (args.at(-1) === '--show-toplevel') {
      if (probeError) throw probeError;
      if (!isRepo) throw Object.assign(new Error('not a repository'), { code: 'GIT_NOT_REPOSITORY' });
      return { stdout: `${repositoryRoot}\n` };
    }
    if (args.includes('symbolic-ref')) {
      if (!defaultRef) throw Object.assign(new Error('no origin HEAD'), { code: 'GIT_FAILED' });
      return { stdout: `${defaultRef}\n` };
    }
    if (args.at(-1) === 'HEAD') {
      if (headError) throw headError;
      return { stdout: `${head}\n` };
    }
    return { stdout: '' };
  };
}

function fakeFileSystem({
  gitRoots = [],
  missingRoots = [],
  nonDirectoryRoots = [],
  inaccessibleMarkers = [],
} = {}) {
  const normalize = (value) => path.resolve(value).toLocaleLowerCase();
  const gitMarkers = new Set(gitRoots.map((root) => normalize(path.join(root, '.git'))));
  const missing = new Set(missingRoots.map(normalize));
  const nonDirectories = new Set(nonDirectoryRoots.map(normalize));
  const inaccessible = new Set(inaccessibleMarkers.map(normalize));
  return {
    async stat(target) {
      if (missing.has(normalize(target))) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isDirectory: () => !nonDirectories.has(normalize(target)) };
    },
    async lstat(target) {
      const key = normalize(target);
      if (inaccessible.has(key)) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      if (gitMarkers.has(key)) return { isDirectory: () => true, isFile: () => false };
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    async mkdir() {},
  };
}

function capturingPersistence(events = []) {
  const snapshots = [];
  return {
    snapshots,
    persistState: async (state) => {
      const snapshot = structuredClone(state);
      snapshots.push(snapshot);
      const records = Object.values(snapshot.createdTasksByInteraction ?? {});
      const record = records.at(-1);
      events.push(`persist:${record?.status ?? 'empty'}${record?.status === 'creating' && record.workspace ? '-planned' : ''}`);
    },
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

function generatedWorkspace(operationId, overrides = {}) {
  const worktreePath = `G:\\codex-worktrees\\${operationId}`;
  return {
    mode: 'worktree',
    cwd: worktreePath,
    runtimeWorkspaceRoots: [worktreePath],
    worktreePath,
    branchName: 'codex/discord-20260901-010203-abcdef',
    sourceRoot: 'C:\\repo',
    repositoryRoot: 'C:\\repo',
    operationId,
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
  }), (error) => {
    assert.equal(error.message, 'Codex project catalog request failed');
    assert.equal(error.message.includes('unavailable'), false);
    return true;
  });
  assert.deepEqual(methods, ['initialize', 'initialized', 'project/list', 'close']);
});

test('rejects malformed project pages and repeated cursors with sanitized closure', async (t) => {
  let invalidCursorRequests = 0;
  const cases = [
    ['non-array data', { data: {}, nextCursor: null }],
    ['invalid cursor type', () => {
      invalidCursorRequests += 1;
      if (invalidCursorRequests > 1) throw new Error('invalid cursor was not rejected');
      return { data: [], nextCursor: 7 };
    }],
  ];
  for (const [name, page] of cases) {
    await t.test(name, async () => {
      const methods = [];
      await assert.rejects(() => listCodexProjects({
        codexPath: 'codex', processCwd: 'C:\\workspace',
        clientFactory: () => fakeAppServer(methods, { 'project/list': page }),
      }), /Codex project catalog response invalid/);
      assert.equal(methods.at(-1), 'close');
    });
  }

  const methods = [];
  let cycleRequests = 0;
  await assert.rejects(() => listCodexProjects({
    codexPath: 'codex', processCwd: 'C:\\workspace',
    clientFactory: () => fakeAppServer(methods, {
      'project/list': () => {
        cycleRequests += 1;
        if (cycleRequests > 2) throw new Error('cycle was not detected');
        return { data: [], nextCursor: 'same-cursor' };
      },
    }),
  }), /Codex project catalog response invalid/);
  assert.deepEqual(methods, ['initialize', 'initialized', 'project/list', 'project/list', 'close']);
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

test('project catalog snapshot methods never start I/O after the cache expires', async () => {
  let clock = 0;
  let calls = 0;
  const catalog = createProjectCatalog({
    ttlMs: 10,
    now: () => clock,
    loader: async () => {
      calls += 1;
      return [project({ id: 'cached', name: 'Cached Project' })];
    },
  });
  await catalog.warm();
  clock = 11;

  assert.deepEqual(catalog.snapshotChoices('cached'), [
    { name: 'Cached Project', value: 'cached' },
    { name: '无项目', value: NO_PROJECT },
  ]);
  assert.equal(catalog.snapshotGetById('cached').name, 'Cached Project');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
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

test('an initial catalog failure remains unwarmed and warm retries successfully', async () => {
  let calls = 0;
  const catalog = createProjectCatalog({
    loader: async () => {
      calls += 1;
      if (calls === 1) throw new Error('first load failed');
      return [project({ id: 'retry', name: 'Retry Project' })];
    },
  });
  await assert.rejects(() => catalog.warm(), /project catalog refresh failed/);
  assert.deepEqual(catalog.status(), {
    warmed: false,
    refreshing: false,
    lastRefreshAt: null,
    errorCategory: 'project-refresh-failed',
  });
  assert.equal((await catalog.warm())[0].id, 'retry');
  assert.equal(calls, 2);
  assert.equal(catalog.status().warmed, true);
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
    fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }),
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
    fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }),
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
    fileSystem: fakeFileSystem(),
    gitRunner: fakeGitRunner(calls, { isRepo: false }),
  });
  assert.equal(prepared.mode, 'local');
  assert.equal(prepared.cwd, 'C:\\files');
  assert.deepEqual(prepared.runtimeWorkspaceRoots, ['C:\\files', 'D:\\shared']);
  assert.equal(calls.length, 2);
  assert.equal(calls.some(({ args }) => args.includes('add')), false);
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

test('persists a projectless operation plan before creating its directory', async () => {
  const events = [];
  const fileSystem = {
    async mkdir() { events.push('mkdir'); },
  };
  const prepared = await prepareTaskWorkspace({
    selection: { kind: 'projectless', projectId: null, projectName: '无项目', roots: ['C:\\tasks'] },
    worktreeRoot: 'G:\\unused', operationId: 'projectlessplan1', fileSystem,
    onWorkspacePlanned: async (workspace) => {
      assert.equal(workspace.cwd, 'C:\\tasks');
      events.push('persist-plan');
    },
  });
  assert.equal(prepared.mode, 'projectless');
  assert.deepEqual(events, ['persist-plan', 'mkdir']);
});

test('rejects unsafe operation IDs before invoking Git', async () => {
  const calls = [];
  await assert.rejects(() => prepareTaskWorkspace({
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: 'G:\\codex-worktrees',
    operationId: '..\\outside',
    fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }),
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
    fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }),
    gitRunner: fakeGitRunner(calls),
  }), /worktree root/i);
  assert.deepEqual(calls, []);
});

test('rejects missing and non-directory saved roots before probing Git', async (t) => {
  const cases = [
    ['missing root', fakeFileSystem({ missingRoots: ['C:\\shared'] })],
    ['non-directory root', fakeFileSystem({ nonDirectoryRoots: ['C:\\shared'] })],
  ];
  for (const [name, fileSystem] of cases) {
    await t.test(name, async () => {
      const calls = [];
      await assert.rejects(() => prepareTaskWorkspace({
        selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo', 'C:\\shared'] },
        worktreeRoot: 'G:\\codex-worktrees', operationId: 'invalidroot1', fileSystem,
        gitRunner: fakeGitRunner(calls),
      }), /saved project root is unavailable/i);
      assert.deepEqual(calls, []);
    });
  }
});

test('requires every saved project root to be absolute before filesystem or Git access', async () => {
  const calls = [];
  let statCalls = 0;
  await assert.rejects(() => prepareTaskWorkspace({
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo', 'relative\\shared'] },
    worktreeRoot: 'G:\\codex-worktrees', operationId: 'absoluteroot1',
    fileSystem: {
      ...fakeFileSystem(),
      async stat() { statCalls += 1; return { isDirectory: () => true }; },
    },
    gitRunner: fakeGitRunner(calls),
  }), /saved project root is unavailable/i);
  assert.equal(statCalls, 0);
  assert.deepEqual(calls, []);
});

test('does not bypass Git isolation when executable, ownership, or repository probes fail', async (t) => {
  const cases = [
    ['missing executable', {
      fileSystem: fakeFileSystem(),
      git: { isRepo: false, versionError: Object.assign(new Error('spawn failed'), { code: 'GIT_START_FAILED' }) },
    }],
    ['ownership probe failure', {
      fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }),
      git: { probeError: Object.assign(new Error('dubious ownership C:\\private'), { code: 'GIT_FAILED' }) },
    }],
    ['filesystem access failure', {
      fileSystem: fakeFileSystem({ inaccessibleMarkers: ['C:\\repo\\.git'] }),
      git: { isRepo: false },
    }],
  ];
  for (const [name, setup] of cases) {
    await t.test(name, async () => {
      const calls = [];
      await assert.rejects(() => prepareTaskWorkspace({
        selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
        worktreeRoot: 'G:\\codex-worktrees', operationId: 'probefail1',
        fileSystem: setup.fileSystem,
        gitRunner: fakeGitRunner(calls, setup.git),
      }), (error) => {
        assert.equal(error.message, 'Git workspace inspection failed');
        assert.equal(error.message.includes('private'), false);
        return true;
      });
      assert.equal(calls.some(({ args }) => args.includes('add')), false);
    });
  }
});

test('missing Git markers plus a generic repository probe failure remains fatal', async () => {
  const calls = [];
  await assert.rejects(() => prepareTaskWorkspace({
    selection: { kind: 'project', projectId: 'p1', projectName: 'Files', roots: ['C:\\files'] },
    worktreeRoot: 'G:\\codex-worktrees', operationId: 'genericprobe1',
    fileSystem: fakeFileSystem(),
    gitRunner: fakeGitRunner(calls, {
      probeError: Object.assign(new Error('fatal from localized Git C:\\private'), { code: 'GIT_FAILED' }),
    }),
  }), (error) => {
    assert.equal(error.message, 'Git workspace inspection failed');
    assert.equal(error.message.includes('private'), false);
    return true;
  });
  assert.equal(calls.some(({ args }) => args.includes('add')), false);
});

test('the default Git runner sanitizes probe environment and classifies only the controlled not-repository result', async () => {
  const taskCreate = await import('../discord-task-create-lib.mjs');
  assert.equal(typeof taskCreate.runGitWithSpawn, 'function');
  const invocations = [];
  const spawnImpl = (_command, _args, options) => {
    invocations.push(options);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stderr.write('fatal: not a git repository (or any of the parent directories): .git\n');
      child.stderr.end();
      child.emit('close', 128);
    });
    return child;
  };
  const environment = {
    PATH: 'C:\\Git\\cmd',
    DISCORD_BRIDGE_KEEP: 'preserved',
    gIt_DiR: 'C:\\attacker',
    Git_Work_Tree: 'C:\\attacker-tree',
    git_COMMON_dir: 'C:\\attacker-common',
    Git_Object_Directory: 'C:\\attacker-objects',
    git_alternate_object_directories: 'C:\\attacker-alt',
    Git_Index_File: 'C:\\attacker-index',
    git_namespace: 'attacker',
    Git_Shallow_File: 'C:\\attacker-shallow',
    git_Index_Version: '2',
    Git_Config_Parameters: "'core.worktree'='C:\\attacker-tree'",
    gIt_CoNfIg_CoUnT: '1',
    Git_Config_Key_0: 'core.worktree',
    git_config_value_0: 'C:\\attacker-tree',
    Git_Config_Global: 'C:\\attacker-global',
    git_config_SYSTEM: 'C:\\attacker-system',
    Git_Config_NoSystem: '0',
    gIt_TrAcE: 'C:\\attacker-trace',
    Git_Ceiling_Directories: 'C:\\plain',
    git_Discovery_Across_Filesystem: 'false',
    lC_aLl: 'zh_CN.UTF-8',
    LaNg: 'zh_CN.UTF-8',
    git_terminal_prompt: '1',
  };

  await assert.rejects(() => taskCreate.runGitWithSpawn({
    args: ['-C', 'C:\\plain', 'rev-parse', '--show-toplevel'], spawnImpl, environment,
  }), (error) => error.code === 'GIT_NOT_REPOSITORY' && !error.message.includes('plain'));
  await assert.rejects(() => taskCreate.runGitWithSpawn({
    args: ['-C', 'C:\\plain', 'symbolic-ref', 'HEAD'], spawnImpl, environment,
  }), (error) => error.code === 'GIT_FAILED' && !error.message.includes('plain'));

  for (const options of invocations) {
    assert.equal(options.shell, false);
    const environmentKeys = Object.keys(options.env);
    assert.deepEqual(environmentKeys.filter((key) => key.toUpperCase().startsWith('GIT_')), [
      'GIT_TERMINAL_PROMPT',
    ]);
    assert.deepEqual(environmentKeys.filter((key) => key.toUpperCase() === 'LC_ALL'), ['LC_ALL']);
    assert.deepEqual(environmentKeys.filter((key) => key.toUpperCase() === 'LANG'), ['LANG']);
    assert.deepEqual(environmentKeys.filter((key) => key.toUpperCase() === 'GIT_TERMINAL_PROMPT'), ['GIT_TERMINAL_PROMPT']);
    assert.equal(options.env.LC_ALL, 'C');
    assert.equal(options.env.LANG, 'C');
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(options.env.PATH, 'C:\\Git\\cmd');
    assert.equal(options.env.DISCORD_BRIDGE_KEEP, 'preserved');
  }
});

test('sanitizes failure to resolve both remote HEAD and current HEAD without creating a worktree', async () => {
  const calls = [];
  await assert.rejects(() => prepareTaskWorkspace({
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: 'G:\\codex-worktrees', operationId: 'headfail1',
    fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }),
    gitRunner: fakeGitRunner(calls, {
      defaultRef: null,
      headError: Object.assign(new Error('cannot read C:\\private\\HEAD'), { code: 'GIT_FAILED' }),
    }),
  }), (error) => {
    assert.equal(error.message, 'Git workspace preparation failed');
    assert.equal(error.message.includes('private'), false);
    return true;
  });
  assert.equal(calls.some(({ args }) => args.includes('add')), false);
});

test('expands an absolute CODEX_HOME worktree root and fails closed on missing or relative values', async () => {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = 'G:\\CodexData\\.codex';
  try {
    const calls = [];
    const prepared = await prepareTaskWorkspace({
      selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
      worktreeRoot: '%CODEX_HOME%\\worktrees\\discord', operationId: 'expanded1',
      fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }),
      gitRunner: fakeGitRunner(calls),
    });
    assert.equal(prepared.worktreePath, 'G:\\CodexData\\.codex\\worktrees\\discord\\expanded1');

    await assert.rejects(() => prepareTaskWorkspace({
      selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
      worktreeRoot: 'relative\\worktrees', operationId: 'relative1',
      fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }), gitRunner: fakeGitRunner([]),
    }), /absolute worktree root/);

    delete process.env.CODEX_HOME;
    await assert.rejects(() => prepareTaskWorkspace({
      selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
      worktreeRoot: '%CODEX_HOME%\\worktrees\\discord', operationId: 'missinghome1',
      fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }), gitRunner: fakeGitRunner([]),
    }), /worktree root could not be expanded/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
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
    fileSystem: fakeFileSystem(),
    persistState: async () => {},
    gitRunner: fakeGitRunner(gitCalls, { isRepo: false }),
    clientFactory: () => {
      clients += 1;
      return fakeAppServer(methods, {
        'thread/start': () => {
          assert.equal(state.createdTasksByInteraction['interaction-once'].status, 'thread-starting');
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
  assert.equal(gitCalls.length, 2);
  assert.equal(gitCalls.some(({ args }) => args.includes('add')), false);
  await first.completion;
});

test('awaits durable creation transitions before each following Git or App Server mutation', async () => {
  const events = [];
  const snapshots = [];
  const state = {};
  const worktrees = [];
  const baseFileSystem = fakeFileSystem({ gitRoots: ['C:\\repo'] });
  const fileSystem = {
    ...baseFileSystem,
    async stat(target) {
      events.push('fs:stat');
      return baseFileSystem.stat(target);
    },
  };
  const baseGit = fakeGitRunner([], { worktrees });
  const gitRunner = async (request) => {
    if (request.args.includes('add')) events.push('git:add');
    return baseGit(request);
  };
  const persistState = async (current) => {
    const snapshot = structuredClone(current);
    snapshots.push(snapshot);
    const record = snapshot.createdTasksByInteraction.durable1;
    events.push(`persist:${record.status}${record.status === 'creating' && record.workspace ? '-planned' : ''}`);
  };
  const clientFactory = () => ({
    async request(message) {
      events.push(`app:${message.method}`);
      if (message.method === 'thread/start') return { thread: { id: 'thread-durable', name: null } };
      if (message.method === 'turn/start') return { turn: { id: 'turn-durable' } };
      return {};
    },
    send(message) { events.push(`app:${message.method}`); },
    waitForTurn: async (turnId) => ({ turn: { id: turnId } }),
    close() {},
  });

  const result = await createNewTaskOnce({
    state, interactionId: 'durable1',
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: 'G:\\codex-worktrees', text: 'durable', codexPath: 'codex', processCwd: 'C:\\repo',
    fileSystem, gitRunner, persistState, clientFactory,
  });
  await result.completion;

  const before = (left, right) => assert.ok(events.indexOf(left) < events.indexOf(right), `${left} must precede ${right}: ${events}`);
  before('persist:creating', 'fs:stat');
  before('persist:creating-planned', 'git:add');
  before('persist:workspace-ready', 'app:initialize');
  before('persist:thread-starting', 'app:thread/start');
  before('persist:thread-created', 'app:turn/start');
  before('app:turn/start', 'persist:started');
  assert.deepEqual(snapshots.map((snapshot) => {
    const record = snapshot.createdTasksByInteraction.durable1;
    return `${record.status}${record.status === 'creating' && record.workspace ? '-planned' : ''}`;
  }), ['creating', 'creating-planned', 'workspace-ready', 'thread-starting', 'thread-created', 'started']);

  for (const snapshot of snapshots) {
    let externalCalls = 0;
    const duplicate = await createNewTaskOnce({
      state: structuredClone(snapshot), interactionId: 'durable1',
      selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
      worktreeRoot: 'G:\\codex-worktrees', text: 'must not repeat',
      fileSystem: { stat: async () => { externalCalls += 1; } },
      gitRunner: async () => { externalCalls += 1; },
      clientFactory: () => { externalCalls += 1; },
      persistState: async () => { externalCalls += 1; },
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(externalCalls, 0);
  }
});

test('a failed thread-created persistence reloads the non-cleanable thread-starting boundary', async () => {
  const state = {};
  const durableSnapshots = [];
  const gitCalls = [];
  let statusAtThreadStart = null;
  let threadStartingRecord = null;
  await assert.rejects(() => createNewTaskOnce({
    state, interactionId: 'threadboundary1',
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: 'G:\\codex-worktrees', text: 'durable thread boundary',
    codexPath: 'codex', processCwd: 'C:\\repo',
    fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }),
    gitRunner: fakeGitRunner(gitCalls),
    persistState: async (current) => {
      const snapshot = structuredClone(current);
      const status = snapshot.createdTasksByInteraction.threadboundary1.status;
      if (status === 'thread-created') throw new Error('disk unavailable C:\\private');
      if (status === 'thread-starting') threadStartingRecord = current.createdTasksByInteraction.threadboundary1;
      durableSnapshots.push(snapshot);
    },
    clientFactory: () => fakeAppServer([], {
      'thread/start': () => {
        statusAtThreadStart = state.createdTasksByInteraction.threadboundary1.status;
        return { thread: { id: 'thread-ambiguous', name: null } };
      },
      'turn/start': { turn: { id: 'must-not-start' } },
    }),
  }), (error) => {
    assert.equal(error.message, 'Task creation state persistence failed');
    assert.equal(error.message.includes('private'), false);
    return true;
  });

  assert.equal(statusAtThreadStart, 'thread-starting');
  const reloaded = structuredClone(durableSnapshots.at(-1));
  assert.equal(reloaded.createdTasksByInteraction.threadboundary1.status, 'thread-starting');
  assert.deepEqual(state.createdTasksByInteraction.threadboundary1, threadStartingRecord);
  assert.equal(state.createdTasksByInteraction.threadboundary1.status, 'thread-starting');
  assert.equal(gitCalls.some(({ args }) => args.includes('remove') || args.includes('-D')), false);

  let duplicateCalls = 0;
  const duplicate = await createNewTaskOnce({
    state: structuredClone(reloaded), interactionId: 'threadboundary1',
    persistState: async () => { duplicateCalls += 1; },
    gitRunner: async () => { duplicateCalls += 1; },
    clientFactory: () => { duplicateCalls += 1; },
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.status, 'thread-starting');
  assert.equal(duplicateCalls, 0);

  const recoveryCalls = [];
  const recoveryState = structuredClone(reloaded);
  assert.deepEqual(await recoverInterruptedTaskCreations({
    state: recoveryState, worktreeRoot: 'G:\\codex-worktrees',
    persistState: async () => { throw new Error('thread-starting must not be rewritten'); },
    gitRunner: fakeGitRunner(recoveryCalls),
  }), []);
  assert.equal(recoveryState.createdTasksByInteraction.threadboundary1.status, 'thread-starting');
  assert.deepEqual(recoveryCalls, []);
});

test('failed initial persistence removes the staged live record and the same state can retry', async () => {
  const state = {};
  let externalCalls = 0;
  await assert.rejects(() => createNewTaskOnce({
    state, interactionId: 'initialrollback1',
    selection: { kind: 'projectless', projectId: null, projectName: '无项目', roots: ['C:\\tasks'] },
    text: 'initial failure', persistState: async () => { throw new Error('disk failed'); },
    fileSystem: { mkdir: async () => { externalCalls += 1; } },
    clientFactory: () => { externalCalls += 1; },
  }), /state persistence failed/);
  assert.equal(Object.hasOwn(state.createdTasksByInteraction, 'initialrollback1'), false);
  assert.equal(externalCalls, 0);

  const result = await createNewTaskOnce({
    state, interactionId: 'initialrollback1',
    selection: { kind: 'projectless', projectId: null, projectName: '无项目', roots: ['C:\\tasks'] },
    text: 'retry', persistState: async () => {},
    fileSystem: { mkdir: async () => { externalCalls += 1; } },
    clientFactory: () => fakeAppServer([], {
      'thread/start': { thread: { id: 'thread-initial-retry' } },
      'turn/start': { turn: { id: 'turn-initial-retry' } },
    }),
  });
  assert.equal(result.status, 'started');
  await result.completion;
});

test('task creation shares the inbox commit queue with cursor updates and prunes only terminal creation history', async () => {
  const state = createEmptyInboxState();
  for (let index = 0; index < 2_000; index += 1) {
    state.createdTasksByInteraction[`old-${String(index).padStart(4, '0')}`] = {
      status: 'started', threadId: `old-thread-${index}`,
    };
  }
  state.createdTasksByInteraction['safety-live'] = { status: 'thread-starting', threadId: 'maybe-live' };
  let active = 0;
  let maxActive = 0;
  const persistState = async (snapshot) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    assert.notStrictEqual(snapshot, state);
    active -= 1;
  };
  const creation = createNewTaskOnce({
    state,
    interactionId: 'create-b',
    selection: { kind: 'projectless', projectId: null, projectName: '无项目', roots: ['C:\\tasks'] },
    text: 'create concurrently',
    persistState,
    fileSystem: { mkdir: async () => {} },
    clientFactory: () => fakeAppServer([], {
      'thread/start': { thread: { id: 'thread-create-b', name: 'B' } },
      'turn/start': { turn: { id: 'turn-create-b' } },
    }),
  });
  const cursor = commitInboxState({
    state,
    persistState,
    fields: ['cursors', 'processedMessageIds'],
    mutate: () => recordInboxMessage(state, 'channel-b', '999', true),
  });
  const [created] = await Promise.all([creation, cursor]);
  await created.completion;
  assert.equal(maxActive, 1);
  assert.equal(state.cursors['channel-b'], '999');
  assert.equal(state.createdTasksByInteraction['create-b'].status, 'started');
  assert.equal(state.createdTasksByInteraction['safety-live'].status, 'thread-starting');
  assert.equal(Object.keys(state.createdTasksByInteraction).length <= 2_000, true);
});

test('failed started persistence restores the exact thread-created live record', async () => {
  const state = {};
  let threadCreatedRecord = null;
  await assert.rejects(() => createNewTaskOnce({
    state, interactionId: 'startedrollback1',
    selection: { kind: 'projectless', projectId: null, projectName: '无项目', roots: ['C:\\tasks'] },
    text: 'started rollback', fileSystem: { mkdir: async () => {} },
    persistState: async (current) => {
      const record = current.createdTasksByInteraction.startedrollback1;
      if (record.status === 'thread-created') threadCreatedRecord = record;
      if (record.status === 'started') throw new Error('final write failed');
    },
    clientFactory: () => fakeAppServer([], {
      'thread/start': { thread: { id: 'thread-started-rollback', name: 'Task' } },
      'turn/start': { turn: { id: 'turn-started-rollback' } },
    }),
  }), /state persistence failed/);
  assert.deepEqual(state.createdTasksByInteraction.startedrollback1, threadCreatedRecord);
  assert.equal(state.createdTasksByInteraction.startedrollback1.status, 'thread-created');
  assert.equal(state.createdTasksByInteraction.startedrollback1.threadId, 'thread-started-rollback');

  let externalCalls = 0;
  const duplicate = await createNewTaskOnce({
    state, interactionId: 'startedrollback1', persistState: async () => { externalCalls += 1; },
    gitRunner: async () => { externalCalls += 1; }, clientFactory: () => { externalCalls += 1; },
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.status, 'thread-created');
  assert.equal(externalCalls, 0);
});

test('creation and recovery require an injected persistence boundary before external mutation', async (t) => {
  await t.test('creation', async () => {
    let mkdirCalls = 0;
    await assert.rejects(() => createNewTaskOnce({
      state: {}, interactionId: 'nopersist1',
      selection: { kind: 'projectless', projectId: null, projectName: '无项目', roots: ['C:\\tasks'] },
      worktreeRoot: 'G:\\unused', text: 'no persistence',
      fileSystem: { mkdir: async () => { mkdirCalls += 1; } },
      clientFactory: () => fakeAppServer([], {
        'thread/start': { thread: { id: 'thread-no-persist' } },
        'turn/start': { turn: { id: 'turn-no-persist' } },
      }),
    }), /persistence boundary is required/);
    assert.equal(mkdirCalls, 0);
  });

  await t.test('recovery', async () => {
    const calls = [];
    const workspace = {
      mode: 'worktree', cwd: 'G:\\codex-worktrees\\nopersist2',
      runtimeWorkspaceRoots: ['G:\\codex-worktrees\\nopersist2'],
      worktreePath: 'G:\\codex-worktrees\\nopersist2',
      branchName: 'codex/discord-20260901-010203-abcdef',
      sourceRoot: 'C:\\repo', repositoryRoot: 'C:\\repo', operationId: 'nopersist2',
    };
    await assert.rejects(() => recoverInterruptedTaskCreations({
      state: { createdTasksByInteraction: { nopersist2: { status: 'workspace-ready', workspace } } },
      worktreeRoot: 'G:\\codex-worktrees',
      gitRunner: fakeGitRunner(calls, { worktrees: [{ path: workspace.worktreePath, branch: workspace.branchName }] }),
    }), /persistence boundary is required/);
    assert.deepEqual(calls, []);
  });
});

test('persists an operation plan before worktree add and safely cleans an immediate partial add', async () => {
  const events = [];
  const calls = [];
  const worktrees = [];
  const persistence = capturingPersistence(events);
  const baseGit = fakeGitRunner(calls, {
    worktrees,
    partialAddError: Object.assign(new Error('partial add C:\\private'), { code: 'GIT_FAILED' }),
  });
  const gitRunner = async (request) => {
    if (request.args.includes('add')) events.push('git:add');
    return baseGit(request);
  };
  const state = {};
  await assert.rejects(() => createNewTaskOnce({
    state, interactionId: 'partial1',
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: 'G:\\codex-worktrees', text: 'partial', codexPath: 'codex', processCwd: 'C:\\repo',
    fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }), gitRunner,
    persistState: persistence.persistState,
  }), (error) => {
    assert.equal(error.message.includes('private'), false);
    return true;
  });

  const plannedIndex = persistence.snapshots.findIndex((snapshot) => snapshot.createdTasksByInteraction.partial1.workspace?.mode === 'worktree');
  assert.notEqual(plannedIndex, -1);
  assert.ok(events.indexOf('persist:creating-planned') < events.indexOf('git:add'));
  assert.deepEqual(persistence.snapshots.slice(-3).map((snapshot) => snapshot.createdTasksByInteraction.partial1.status), [
    'cleanup-proven', 'worktree-removed', 'failed-before-thread',
  ]);
  assert.equal(persistence.snapshots.at(-1).createdTasksByInteraction.partial1.status, 'failed-before-thread');
  assert.equal(calls.filter(({ args }) => args.includes('remove') || args.includes('-D')).length, 2);
  assert.deepEqual(worktrees, []);
});

test('a restart during worktree add reloads the durable plan, prevents duplication, and recovers it', async () => {
  const calls = [];
  const worktrees = [];
  const persistence = capturingPersistence();
  let signalAdd;
  const addStarted = new Promise((resolve) => { signalAdd = resolve; });
  let rejectAdd;
  const addGate = new Promise((_resolve, reject) => { rejectAdd = reject; });
  const baseGit = fakeGitRunner(calls, { worktrees });
  const gitRunner = async (request) => {
    const result = await baseGit(request);
    if (request.args.includes('add')) {
      signalAdd();
      return addGate;
    }
    return result;
  };
  const liveState = {};
  const creation = createNewTaskOnce({
    state: liveState, interactionId: 'crashadd1',
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: 'G:\\codex-worktrees', text: 'crash', codexPath: 'codex', processCwd: 'C:\\repo',
    fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }), gitRunner,
    persistState: persistence.persistState,
  });
  await addStarted;
  const durableState = structuredClone(persistence.snapshots.at(-1));
  assert.equal(durableState.createdTasksByInteraction.crashadd1.status, 'creating');
  assert.equal(durableState.createdTasksByInteraction.crashadd1.workspace.operationId, 'crashadd1');

  let duplicateCalls = 0;
  const duplicate = await createNewTaskOnce({
    state: structuredClone(durableState), interactionId: 'crashadd1',
    fileSystem: { stat: async () => { duplicateCalls += 1; } },
    gitRunner: async () => { duplicateCalls += 1; },
    clientFactory: () => { duplicateCalls += 1; },
    persistState: async () => { duplicateCalls += 1; },
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicateCalls, 0);

  const recoveryPersistence = capturingPersistence();
  const recoveryCalls = [];
  const recovered = await recoverInterruptedTaskCreations({
    state: durableState, worktreeRoot: 'G:\\codex-worktrees',
    gitRunner: fakeGitRunner(recoveryCalls, { worktrees }),
    persistState: recoveryPersistence.persistState,
    nowMs: 1_788_230_400_000,
  });
  assert.equal(recovered[0].cleaned, true);
  assert.deepEqual(recoveryPersistence.snapshots.map((snapshot) => snapshot.createdTasksByInteraction.crashadd1.status), [
    'recovering', 'cleanup-proven', 'worktree-removed', 'recovered-failed',
  ]);
  assert.equal(recoveryCalls.filter(({ args }) => args.includes('remove') || args.includes('-D')).length, 2);

  rejectAdd(Object.assign(new Error('process interrupted'), { code: 'GIT_FAILED' }));
  await assert.rejects(() => creation, /Git workspace preparation failed/);
});

test('journals cleanup of only its generated worktree and branch before thread-starting', async () => {
  const state = {};
  const gitCalls = [];
  const persistence = capturingPersistence();
  await assert.rejects(() => createNewTaskOnce({
    state,
    interactionId: 'cleanup1',
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: 'G:\\codex-worktrees',
    text: 'will fail', codexPath: 'codex', processCwd: 'C:\\repo',
    now: new Date('2026-09-01T01:02:03Z'),
    fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }),
    persistState: persistence.persistState,
    gitRunner: fakeGitRunner(gitCalls),
    clientFactory: () => fakeAppServer([], { initialize: new Error('App Server initialization failed') }),
  }), /App Server initialization failed/);

  const record = state.createdTasksByInteraction.cleanup1;
  assert.equal(record.status, 'failed-before-thread');
  assert.equal(record.threadId, undefined);
  const destructive = gitCalls.filter(({ args }) => args.includes('remove') || args.includes('-D'));
  assert.equal(destructive.length, 2);
  assert.deepEqual(destructive[0].args.slice(2), ['worktree', 'remove', '--force', 'G:\\codex-worktrees\\cleanup1']);
  assert.equal(destructive[1].args.at(-2), '-D');
  assert.match(destructive[1].args.at(-1), /^codex\/discord-/);
  assert.deepEqual(persistence.snapshots.slice(-3).map((snapshot) => snapshot.createdTasksByInteraction.cleanup1.status), [
    'cleanup-proven', 'worktree-removed', 'failed-before-thread',
  ]);
  const proof = persistence.snapshots.at(-3).createdTasksByInteraction.cleanup1.cleanupProof;
  assert.equal(proof.branchRef, `refs/heads/${record.workspace.branchName}`);
  assert.match(proof.branchOid, /^[0-9a-f]{40,64}$/i);
  assert.equal(persistence.snapshots.at(-1).createdTasksByInteraction.cleanup1.status, 'failed-before-thread');
});

test('an ambiguous thread-start request failure retains the non-cleanable workspace', async () => {
  const state = {};
  const calls = [];
  const persistence = capturingPersistence();
  await assert.rejects(() => createNewTaskOnce({
    state, interactionId: 'ambiguousstart1',
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: 'G:\\codex-worktrees', text: 'ambiguous', codexPath: 'codex', processCwd: 'C:\\repo',
    fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }), gitRunner: fakeGitRunner(calls),
    persistState: persistence.persistState,
    clientFactory: () => fakeAppServer([], { 'thread/start': new Error('connection closed') }),
  }), /connection closed/);
  assert.equal(state.createdTasksByInteraction.ambiguousstart1.status, 'thread-starting');
  assert.equal(calls.some(({ args }) => args.includes('remove') || args.includes('-D')), false);
  assert.deepEqual(await recoverInterruptedTaskCreations({
    state: structuredClone(state), worktreeRoot: 'G:\\codex-worktrees',
    gitRunner: async () => { throw new Error('must not inspect'); }, persistState: async () => {},
  }), []);
});

test('preserves the durable thread and worktree when the first turn fails', async () => {
  const state = {};
  const gitCalls = [];
  const persistence = capturingPersistence();
  const result = await createNewTaskOnce({
    state,
    interactionId: 'turnfail1',
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    worktreeRoot: 'G:\\codex-worktrees',
    text: 'first turn fails', codexPath: 'codex', processCwd: 'C:\\repo',
    fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }),
    persistState: persistence.persistState,
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
  assert.equal(persistence.snapshots.at(-1).createdTasksByInteraction.turnfail1.status, 'first-turn-failed');
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
    fileSystem: fakeFileSystem({ gitRoots: ['C:\\repo'] }),
    persistState: async () => {},
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
  const persistence = capturingPersistence();
  const validWorkspace = {
    mode: 'worktree',
    cwd: 'G:\\codex-worktrees\\valid1',
    runtimeWorkspaceRoots: ['G:\\codex-worktrees\\valid1'],
    worktreePath: 'G:\\codex-worktrees\\valid1',
    branchName: 'codex/discord-20260901-010203-abcdef',
    sourceRoot: 'C:\\repo',
    repositoryRoot: 'C:\\repo',
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
    gitRunner: fakeGitRunner(gitCalls, { worktrees: [{
      path: 'G:\\codex-worktrees\\valid1',
      branch: 'codex/discord-20260901-010203-abcdef',
    }] }),
    persistState: persistence.persistState,
    nowMs: 1_788_230_400_000,
  });
  assert.equal(recovered.find(({ interactionId }) => interactionId === 'valid1').cleaned, true);
  assert.equal(gitCalls.filter(({ args }) => args.includes('remove') || args.includes('-D')).length, 2);
  assert.equal(state.createdTasksByInteraction.valid1.status, 'recovered-failed');
  assert.equal(state.createdTasksByInteraction.outside1.status, 'recovering');
  assert.equal(state.createdTasksByInteraction.prefix1.status, 'recovering');
  assert.equal(state.createdTasksByInteraction.mismatch1.status, 'recovering');
  assert.equal(recovered.find(({ interactionId }) => interactionId === 'outside1').retryable, true);
  assert.equal(state.createdTasksByInteraction.durable1.status, 'workspace-ready');
  assert.equal(recovered.some(({ interactionId }) => interactionId === 'durable1'), false);
  assert.equal(persistence.snapshots.at(-1).createdTasksByInteraction.valid1.status, 'recovered-failed');
});

test('startup recovery marks mutation-free creating records as recovered and never invents cleanup targets', async () => {
  const state = { createdTasksByInteraction: { creating1: { status: 'creating' } } };
  const calls = [];
  const result = await recoverInterruptedTaskCreations({
    state,
    worktreeRoot: 'G:\\codex-worktrees',
    gitRunner: fakeGitRunner(calls),
    persistState: async () => {},
    nowMs: 1_788_230_400_000,
  });
  assert.deepEqual(result, [{ interactionId: 'creating1', cleaned: false, status: 'recovered-failed' }]);
  assert.deepEqual(calls, []);
});

test('recovery makes zero destructive calls when live Git metadata crosses repository, path, or branch', async (t) => {
  const workspace = {
    mode: 'worktree',
    cwd: 'G:\\codex-worktrees\\cross1',
    runtimeWorkspaceRoots: ['G:\\codex-worktrees\\cross1'],
    worktreePath: 'G:\\codex-worktrees\\cross1',
    branchName: 'codex/discord-20260901-010203-abcdef',
    sourceRoot: 'C:\\repo',
    repositoryRoot: 'C:\\repo',
    operationId: 'cross1',
  };
  const cases = [
    ['repository mismatch', {
      repositoryRoot: 'C:\\other',
      worktrees: [{ path: workspace.worktreePath, branch: workspace.branchName }],
    }],
    ['path mismatch', {
      repositoryRoot: 'C:\\repo',
      worktrees: [{ path: 'G:\\codex-worktrees\\someone-else', branch: workspace.branchName }],
    }],
    ['branch mismatch', {
      repositoryRoot: 'C:\\repo',
      worktrees: [{ path: workspace.worktreePath, branch: 'codex/discord-20260901-010203-fedcba' }],
    }],
  ];
  for (const [name, git] of cases) {
    await t.test(name, async () => {
      const calls = [];
      const state = { createdTasksByInteraction: { cross1: { status: 'workspace-ready', workspace } } };
      const result = await recoverInterruptedTaskCreations({
        state, worktreeRoot: 'G:\\codex-worktrees',
        gitRunner: fakeGitRunner(calls, git), persistState: async () => {},
      });
      assert.equal(result[0].cleaned, false);
      assert.equal(calls.some(({ args }) => args.includes('remove') || args.includes('-D')), false);
    });
  }
});

test('recovery persistence is awaited before any destructive inspection or mutation', async () => {
  const calls = [];
  const workspace = {
    mode: 'worktree', cwd: 'G:\\codex-worktrees\\awaitrecovery1',
    runtimeWorkspaceRoots: ['G:\\codex-worktrees\\awaitrecovery1'],
    worktreePath: 'G:\\codex-worktrees\\awaitrecovery1',
    branchName: 'codex/discord-20260901-010203-abcdef',
    sourceRoot: 'C:\\repo', repositoryRoot: 'C:\\repo', operationId: 'awaitrecovery1',
  };
  const state = { createdTasksByInteraction: { awaitrecovery1: { status: 'workspace-ready', workspace } } };
  let releasePersist;
  const persistGate = new Promise((resolve) => { releasePersist = resolve; });
  let persistenceCalls = 0;
  const recovery = recoverInterruptedTaskCreations({
    state, worktreeRoot: 'G:\\codex-worktrees',
    gitRunner: fakeGitRunner(calls, { worktrees: [{ path: workspace.worktreePath, branch: workspace.branchName }] }),
    persistState: async () => {
      persistenceCalls += 1;
      if (persistenceCalls === 1) await persistGate;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.createdTasksByInteraction.awaitrecovery1.status, 'recovering');
  assert.deepEqual(calls, []);
  releasePersist();
  await recovery;
  assert.equal(persistenceCalls, 4);
  assert.equal(calls.filter(({ args }) => args.includes('remove') || args.includes('-D')).length, 2);
});

test('cleanup persists exact immutable proof before removal and worktree-removed before branch deletion', async () => {
  const operationId = 'journalorder1';
  const workspace = generatedWorkspace(operationId);
  const events = [];
  const snapshots = [];
  const baseGit = fakeGitRunner([], { worktrees: [{
    path: workspace.worktreePath, branch: workspace.branchName,
  }] });
  const gitRunner = async (request) => {
    if (request.args.includes('remove')) events.push('git:remove');
    if (request.args.includes('-D')) events.push('git:branch-delete');
    return baseGit(request);
  };
  const state = { createdTasksByInteraction: { [operationId]: { status: 'workspace-ready', workspace } } };
  const result = await recoverInterruptedTaskCreations({
    state, worktreeRoot: 'G:\\codex-worktrees', gitRunner,
    persistState: async (current) => {
      const snapshot = structuredClone(current);
      snapshots.push(snapshot);
      events.push(`persist:${snapshot.createdTasksByInteraction[operationId].status}`);
    },
  });

  const statuses = snapshots.map((snapshot) => snapshot.createdTasksByInteraction[operationId].status);
  assert.deepEqual(statuses, ['recovering', 'cleanup-proven', 'worktree-removed', 'recovered-failed']);
  assert.ok(events.indexOf('persist:cleanup-proven') < events.indexOf('git:remove'));
  assert.ok(events.indexOf('persist:worktree-removed') < events.indexOf('git:branch-delete'));
  const proof = snapshots.find((snapshot) => (
    snapshot.createdTasksByInteraction[operationId].status === 'cleanup-proven'
  )).createdTasksByInteraction[operationId].cleanupProof;
  assert.deepEqual({
    repositoryRoot: proof.repositoryRoot,
    sourceRoot: proof.sourceRoot,
    worktreePath: proof.worktreePath,
    branchName: proof.branchName,
    branchRef: proof.branchRef,
  }, {
    repositoryRoot: workspace.repositoryRoot,
    sourceRoot: workspace.sourceRoot,
    worktreePath: workspace.worktreePath,
    branchName: workspace.branchName,
    branchRef: `refs/heads/${workspace.branchName}`,
  });
  assert.match(proof.branchOid, /^[0-9a-f]{40,64}$/i);
  assert.equal(result[0].cleaned, true);
});

test('failed journal persistence restores the exact live prerequisite and same-state recovery retries safely', async (t) => {
  await t.test('cleanup-proven', async () => {
    const operationId = 'rollbackproof1';
    const workspace = generatedWorkspace(operationId);
    const calls = [];
    const state = { createdTasksByInteraction: { [operationId]: { status: 'workspace-ready', workspace } } };
    let recoveringRecord = null;
    await assert.rejects(() => recoverInterruptedTaskCreations({
      state, worktreeRoot: 'G:\\codex-worktrees',
      gitRunner: fakeGitRunner(calls, { worktrees: [{ path: workspace.worktreePath, branch: workspace.branchName }] }),
      persistState: async (current) => {
        const record = current.createdTasksByInteraction[operationId];
        if (record.status === 'recovering') recoveringRecord = record;
        if (record.status === 'cleanup-proven') throw new Error('proof write failed');
      },
    }), /state persistence failed/);
    assert.deepEqual(state.createdTasksByInteraction[operationId], recoveringRecord);
    assert.equal(state.createdTasksByInteraction[operationId].status, 'recovering');
    assert.equal(calls.some(({ args }) => args.includes('remove') || args.includes('-D')), false);

    const result = await recoverInterruptedTaskCreations({
      state, worktreeRoot: 'G:\\codex-worktrees',
      gitRunner: fakeGitRunner(calls, { worktrees: [{ path: workspace.worktreePath, branch: workspace.branchName }] }),
      persistState: async () => {},
    });
    assert.equal(result[0].cleaned, true);
    assert.equal(state.createdTasksByInteraction[operationId].status, 'recovered-failed');
  });

  await t.test('worktree-removed', async () => {
    const operationId = 'rollbackremove1';
    const workspace = generatedWorkspace(operationId);
    const worktrees = [{ path: workspace.worktreePath, branch: workspace.branchName }];
    const branchHeads = new Map();
    const calls = [];
    const gitRunner = fakeGitRunner(calls, { worktrees, branchHeads });
    const state = { createdTasksByInteraction: { [operationId]: { status: 'workspace-ready', workspace } } };
    let cleanupProvenRecord = null;
    await assert.rejects(() => recoverInterruptedTaskCreations({
      state, worktreeRoot: 'G:\\codex-worktrees', gitRunner,
      persistState: async (current) => {
        const record = current.createdTasksByInteraction[operationId];
        if (record.status === 'cleanup-proven') cleanupProvenRecord = record;
        if (record.status === 'worktree-removed') throw new Error('remove write failed');
      },
    }), /state persistence failed/);
    assert.deepEqual(state.createdTasksByInteraction[operationId], cleanupProvenRecord);
    assert.equal(state.createdTasksByInteraction[operationId].status, 'cleanup-proven');
    assert.equal(calls.filter(({ args }) => args.includes('remove')).length, 1);
    assert.equal(calls.filter(({ args }) => args.includes('-D')).length, 0);

    const result = await recoverInterruptedTaskCreations({
      state, worktreeRoot: 'G:\\codex-worktrees', gitRunner, persistState: async () => {},
    });
    assert.equal(result[0].cleaned, true);
    assert.equal(calls.filter(({ args }) => args.includes('remove')).length, 1);
    assert.equal(calls.filter(({ args }) => args.includes('-D')).length, 1);
  });

  await t.test('terminal', async () => {
    const operationId = 'rollbackterminal1';
    const workspace = generatedWorkspace(operationId);
    const worktrees = [{ path: workspace.worktreePath, branch: workspace.branchName }];
    const branchHeads = new Map();
    const calls = [];
    const gitRunner = fakeGitRunner(calls, { worktrees, branchHeads });
    const state = { createdTasksByInteraction: { [operationId]: { status: 'workspace-ready', workspace } } };
    let worktreeRemovedRecord = null;
    let failTerminal = true;
    await assert.rejects(() => recoverInterruptedTaskCreations({
      state, worktreeRoot: 'G:\\codex-worktrees', gitRunner,
      persistState: async (current) => {
        const record = current.createdTasksByInteraction[operationId];
        if (record.status === 'worktree-removed') worktreeRemovedRecord = record;
        if (record.status === 'recovered-failed' && failTerminal) {
          failTerminal = false;
          throw new Error('terminal write failed');
        }
      },
    }), /state persistence failed/);
    assert.deepEqual(state.createdTasksByInteraction[operationId], worktreeRemovedRecord);
    assert.equal(state.createdTasksByInteraction[operationId].status, 'worktree-removed');
    assert.equal(calls.filter(({ args }) => args.includes('remove')).length, 1);
    assert.equal(calls.filter(({ args }) => args.includes('-D')).length, 1);

    const result = await recoverInterruptedTaskCreations({
      state, worktreeRoot: 'G:\\codex-worktrees', gitRunner, persistState: async () => {},
    });
    assert.equal(result[0].cleaned, true);
    assert.equal(state.createdTasksByInteraction[operationId].status, 'recovered-failed');
    assert.equal(calls.filter(({ args }) => args.includes('remove')).length, 1);
    assert.equal(calls.filter(({ args }) => args.includes('-D')).length, 1);
  });
});

test('cleanup resumes from durable proof after removal succeeds but worktree-removed persistence crashes', async () => {
  const operationId = 'removecrash1';
  const workspace = generatedWorkspace(operationId);
  const worktrees = [{ path: workspace.worktreePath, branch: workspace.branchName }];
  const branchHeads = new Map();
  const calls = [];
  const gitRunner = fakeGitRunner(calls, { worktrees, branchHeads });
  const durableSnapshots = [];
  const state = { createdTasksByInteraction: { [operationId]: { status: 'workspace-ready', workspace } } };

  await assert.rejects(() => recoverInterruptedTaskCreations({
    state, worktreeRoot: 'G:\\codex-worktrees', gitRunner,
    persistState: async (current) => {
      const snapshot = structuredClone(current);
      if (snapshot.createdTasksByInteraction[operationId].status === 'worktree-removed') {
        throw new Error('disk unavailable');
      }
      durableSnapshots.push(snapshot);
    },
  }), /state persistence failed/);
  const reloaded = structuredClone(durableSnapshots.at(-1));
  assert.equal(reloaded.createdTasksByInteraction[operationId].status, 'cleanup-proven');
  assert.equal(worktrees.length, 0);
  assert.equal(calls.filter(({ args }) => args.includes('remove')).length, 1);
  assert.equal(calls.filter(({ args }) => args.includes('-D')).length, 0);

  const recoveryPersistence = capturingPersistence();
  const result = await recoverInterruptedTaskCreations({
    state: reloaded, worktreeRoot: 'G:\\codex-worktrees', gitRunner,
    persistState: recoveryPersistence.persistState,
  });
  assert.equal(result[0].cleaned, true);
  assert.equal(calls.filter(({ args }) => args.includes('remove')).length, 1);
  assert.equal(calls.filter(({ args }) => args.includes('-D')).length, 1);
  assert.deepEqual(recoveryPersistence.snapshots.map((snapshot) => snapshot.createdTasksByInteraction[operationId].status), [
    'worktree-removed', 'recovered-failed',
  ]);
});

test('branch-delete failure leaves a retryable worktree-removed journal and reentry does not remove twice', async () => {
  const operationId = 'branchretry1';
  const workspace = generatedWorkspace(operationId);
  const worktrees = [{ path: workspace.worktreePath, branch: workspace.branchName }];
  const branchHeads = new Map();
  const branchDeleteFailure = { remaining: 1 };
  const calls = [];
  const gitRunner = fakeGitRunner(calls, { worktrees, branchHeads, branchDeleteFailure });
  const state = { createdTasksByInteraction: { [operationId]: { status: 'workspace-ready', workspace } } };

  const first = await recoverInterruptedTaskCreations({
    state, worktreeRoot: 'G:\\codex-worktrees', gitRunner, persistState: async () => {},
  });
  assert.equal(first[0].cleaned, false);
  assert.equal(first[0].retryable, true);
  assert.equal(state.createdTasksByInteraction[operationId].status, 'worktree-removed');
  assert.equal(calls.filter(({ args }) => args.includes('remove')).length, 1);
  assert.equal(calls.filter(({ args }) => args.includes('-D')).length, 1);

  const second = await recoverInterruptedTaskCreations({
    state, worktreeRoot: 'G:\\codex-worktrees', gitRunner, persistState: async () => {},
  });
  assert.equal(second[0].cleaned, true);
  assert.equal(state.createdTasksByInteraction[operationId].status, 'recovered-failed');
  assert.equal(calls.filter(({ args }) => args.includes('remove')).length, 1);
  assert.equal(calls.filter(({ args }) => args.includes('-D')).length, 2);
});

test('corrupt cleanup proofs remain retryable and make zero destructive calls', async (t) => {
  const operationId = 'corruptproof1';
  const workspace = generatedWorkspace(operationId);
  const validProof = {
    repositoryRoot: workspace.repositoryRoot,
    sourceRoot: workspace.sourceRoot,
    worktreePath: workspace.worktreePath,
    branchName: workspace.branchName,
    branchRef: `refs/heads/${workspace.branchName}`,
    branchOid: '0123456789abcdef0123456789abcdef01234567',
  };
  const cases = [
    ['cleanup-proven', { ...validProof, worktreePath: 'G:\\codex-worktrees\\someone-else' }],
    ['worktree-removed', { ...validProof, branchRef: 'refs/heads/codex/discord-crossed' }],
  ];
  for (const [status, cleanupProof] of cases) {
    await t.test(status, async () => {
      const calls = [];
      const state = { createdTasksByInteraction: { [operationId]: { status, workspace, cleanupProof } } };
      const result = await recoverInterruptedTaskCreations({
        state, worktreeRoot: 'G:\\codex-worktrees',
        gitRunner: fakeGitRunner(calls, { worktrees: [{ path: workspace.worktreePath, branch: workspace.branchName }] }),
        persistState: async () => {},
      });
      assert.equal(result[0].cleaned, false);
      assert.equal(result[0].retryable, true);
      assert.equal(state.createdTasksByInteraction[operationId].status, status);
      assert.equal(calls.some(({ args }) => args.includes('remove') || args.includes('-D')), false);
    });
  }
});

test('Windows repository and worktree identities compare case-insensitively during cleanup', async () => {
  const operationId = 'pathcase1';
  const workspace = generatedWorkspace(operationId, {
    sourceRoot: 'C:\\REPO', repositoryRoot: 'C:\\REPO',
    worktreePath: 'G:\\CODEX-WORKTREES\\pathcase1', cwd: 'G:\\CODEX-WORKTREES\\pathcase1',
    runtimeWorkspaceRoots: ['G:\\CODEX-WORKTREES\\pathcase1'],
  });
  const calls = [];
  const state = { createdTasksByInteraction: { [operationId]: { status: 'workspace-ready', workspace } } };
  const result = await recoverInterruptedTaskCreations({
    state, worktreeRoot: 'g:\\codex-worktrees', persistState: async () => {},
    gitRunner: fakeGitRunner(calls, {
      repositoryRoot: 'c:\\repo',
      worktrees: [{ path: 'g:\\codex-worktrees\\PATHCASE1', branch: workspace.branchName }],
    }),
  });
  assert.equal(result[0].cleaned, true);
  assert.equal(calls.filter(({ args }) => args.includes('remove') || args.includes('-D')).length, 2);
});
