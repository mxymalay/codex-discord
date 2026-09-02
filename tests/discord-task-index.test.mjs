import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildTaskIndex,
  inferSavedProject,
  isUserRootSession,
  readTaskDetail,
  readTaskIndex,
  searchTasks,
  writeTaskIndexAtomic,
} from '../discord-task-index-lib.mjs';

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

async function writeJsonl(filePath, values, invalidLine = '') {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${invalidLine}${values.map(line).join('')}`, 'utf8');
}

function meta(id, overrides = {}) {
  return {
    timestamp: '2026-09-01T00:00:00.000Z',
    type: 'session_meta',
    payload: { id, session_id: id, thread_source: 'user', cwd: 'C:\\workspace\\demo', ...overrides },
  };
}

function event(timestamp, type, overrides = {}) {
  return { timestamp, type: 'event_msg', payload: { type, ...overrides } };
}

function responseMessage(timestamp, role, text, phase) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
      ...(phase ? { phase } : {}),
    },
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-task-index-'));
  return {
    root,
    sessionsRoot: path.join(root, 'sessions'),
    sessionIndexPath: path.join(root, 'session_index.jsonl'),
    messageMapPath: path.join(root, 'discord-message-map.json'),
    rollout(name) {
      return path.join(root, 'sessions', '2026', '09', '01', `rollout-${name}.jsonl`);
    },
  };
}

const forcedBoundedReadLimits = {
  wholeFileBytes: 768,
  headBytes: 512,
  tailBytes: 640,
  sidebarChunkBytes: 17,
};

function observingFileSystem({ onOpen, onReadFile } = {}) {
  return new Proxy(fs, {
    get(target, property) {
      if (property === 'open') {
        return async (...args) => {
          onOpen?.(...args);
          return target.open(...args);
        };
      }
      if (property === 'readFile') {
        return async (...args) => {
          onReadFile?.(...args);
          return target.readFile(...args);
        };
      }
      return Reflect.get(target, property);
    },
  });
}

test('accepts only matching sidebar user roots', () => {
  const sidebar = { id: 'root-1' };
  assert.equal(isUserRootSession({ id: 'root-1' }, sidebar), true);
  assert.equal(isUserRootSession({ id: 'root-1', thread_source: 'user', session_id: 'root-1' }, sidebar), true);
  assert.equal(isUserRootSession({ id: 'root-1', thread_source: 'subagent' }, sidebar), false);
  assert.equal(isUserRootSession({ id: 'root-1', thread_source: 'background' }, sidebar), false);
  assert.equal(isUserRootSession({ id: 'root-1', source: { subagent: { name: 'worker' } } }, sidebar), false);
  assert.equal(isUserRootSession({ id: 'root-1', parent_thread_id: 'parent-1' }, sidebar), false);
  assert.equal(isUserRootSession({ id: 'root-1', session_id: 'parent-1' }, sidebar), false);
  assert.equal(isUserRootSession({ id: 'other' }, sidebar), false);
  assert.equal(isUserRootSession({ id: 'root-1' }, null), false);
});

test('root eligibility fails closed on empty IDs and compares dispatcher identity fields case-insensitively', () => {
  assert.equal(isUserRootSession({}, {}), false);
  assert.equal(isUserRootSession({ id: '' }, { id: '' }), false);
  assert.equal(isUserRootSession({ id: '   ' }, { id: '   ' }), false);
  assert.equal(isUserRootSession({ id: 'ROOT-A', session_id: 'root-a', thread_source: 'USER' }, { id: 'root-a' }), true);
  assert.equal(isUserRootSession({ id: 'ROOT-A', session_id: 'other', thread_source: 'USER' }, { id: 'root-a' }), false);
  assert.equal(isUserRootSession({ id: 'ROOT-A', thread_source: 'SUBAGENT' }, { id: 'root-a' }), false);
});

test('saved project inference prefers valid identity then the longest canonical Windows containing root', () => {
  const projects = [
    { id: 'parent', name: 'Workspace', roots: [{ path: 'C:\\Users\\operator\\Desktop' }] },
    { id: 'example-project', name: 'example-project', roots: ['c:/users/operator/desktop/example-project/'] },
    { id: 'other', name: 'Other', roots: ['C:\\Users\\operator\\Desktop\\example-project-old'] },
  ];

  assert.deepEqual(inferSavedProject({
    cwd: 'C:\\Users\\operator\\Desktop\\EXAMPLE-PROJECT\\apps\\cashier',
    projectId: 'parent',
    projectName: 'stale name',
  }, projects), { projectId: 'parent', projectName: 'Workspace' });
  assert.deepEqual(inferSavedProject({
    cwd: 'C:/Users/operator/Desktop/EXAMPLE-PROJECT/apps/cashier',
  }, projects), { projectId: 'example-project', projectName: 'example-project' });
  assert.deepEqual(inferSavedProject({
    cwd: 'C:\\Users\\operator\\Desktop\\example-project-old-sibling\\app',
  }, projects), { projectId: 'parent', projectName: 'Workspace' });
  assert.deepEqual(inferSavedProject({
    cwd: 'D:\\outside\\task',
  }, projects), { projectId: null, projectName: null });

  assert.deepEqual(inferSavedProject({
    cwd: 'D:\\generated\\outside',
    worktreePath: 'C:\\Users\\operator\\Desktop\\example-project\\.codex\\worktree',
  }, projects), { projectId: 'example-project', projectName: 'example-project' });

  assert.deepEqual(inferSavedProject({
    cwd: 'C:\\Users\\operator\\Desktop\\example-project\\manually-projectless',
    projectId: null,
    projectName: '无项目',
  }, projects), { projectId: null, projectName: null });

  assert.deepEqual(inferSavedProject({
    cwd: 'D:\\generated\\outside',
    projectId: 'deleted-project-id',
    projectName: 'example-project',
  }, projects), { projectId: 'example-project', projectName: 'example-project' });
});

test('Discord managed worktree project provenance wins over generated path matching', () => {
  const projects = [
    { id: 'example-project', name: 'example-project', roots: ['C:\\Users\\operator\\Desktop\\example-project'] },
    { id: 'worktrees', name: 'Generated', roots: ['D:\\codex-data\\.codex\\worktrees'] },
  ];
  assert.deepEqual(inferSavedProject({
    cwd: 'D:\\codex-data\\.codex\\worktrees\\discord\\operation',
    worktreePath: 'D:\\codex-data\\.codex\\worktrees\\discord\\operation',
    projectId: 'example-project',
    projectName: 'example-project',
  }, projects), { projectId: 'example-project', projectName: 'example-project' });
});

test('indexes a persisted Discord-created root absent from sidebar but never promotes its child rollout', async () => {
  const paths = await fixture();
  const rootId = '01a05d0a-5a8f-71f2-b5e1-96fe962224b5';
  const childId = '01a05d0a-aaaa-71f2-b5e1-96fe962224b5';
  const mismatchedFilenameId = '01a05d0a-bbbb-71f2-b5e1-96fe962224b5';
  const mismatchedMetadataId = '01a05d0a-cccc-71f2-b5e1-96fe962224b5';
  try {
    await fs.writeFile(paths.sessionIndexPath, '', 'utf8');
    await writeJsonl(paths.rollout(`2026-09-01T20-55-55-${rootId}`), [
      meta(rootId, { cwd: 'C:\\Users\\operator\\Desktop\\example-project\\app' }),
      event('2026-09-01T20:55:56.000Z', 'task_started', { turn_id: 'turn-root' }),
      event('2026-09-01T21:08:15.000Z', 'task_complete', { turn_id: 'turn-root', last_agent_message: '完成' }),
    ]);
    await writeJsonl(paths.rollout(`2026-09-01T20-56-00-${childId}`), [
      meta(childId, {
        thread_source: 'subagent', parent_thread_id: rootId,
        source: { subagent: { name: 'worker' } },
      }),
      event('2026-09-01T20:56:01.000Z', 'task_started', { turn_id: 'turn-child' }),
      event('2026-09-01T20:57:00.000Z', 'task_complete', { turn_id: 'turn-child', last_agent_message: '内部结果' }),
    ]);
    await writeJsonl(paths.rollout(`2026-09-01T20-58-00-${mismatchedFilenameId}`), [
      meta(mismatchedMetadataId),
      event('2026-09-01T20:58:01.000Z', 'task_started', { turn_id: 'turn-mismatched' }),
      event('2026-09-01T20:59:00.000Z', 'task_complete', { turn_id: 'turn-mismatched', last_agent_message: '不可信结果' }),
    ]);

    const index = await buildTaskIndex({
      ...paths,
      nowMs: Date.parse('2026-09-01T21:08:16.000Z'),
      projects: [{ id: 'example-project', name: 'example-project', roots: ['C:\\Users\\operator\\Desktop\\example-project'] }],
      createdTasksByInteraction: {
        '1544329941024374935': {
          status: 'started', threadId: rootId, turnId: 'turn-root', taskName: 'Discord 新任务',
          projectId: 'example-project', projectName: 'example-project',
          workspace: {
            mode: 'worktree', cwd: 'D:\\codex-data\\.codex\\worktrees\\discord\\incident',
            worktreePath: 'D:\\codex-data\\.codex\\worktrees\\discord\\incident',
            runtimeWorkspaceRoots: ['D:\\codex-data\\.codex\\worktrees\\discord\\incident'],
            operationId: '1544329941024374935',
          },
        },
        '1544329941024374936': {
          status: 'started', threadId: mismatchedFilenameId, turnId: 'turn-mismatched', taskName: '不应提升的任务',
          workspace: { mode: 'local', cwd: 'C:\\workspace\\mismatch', operationId: '1544329941024374936' },
        },
      },
    });

    assert.deepEqual(index.tasks.map((item) => item.threadId), [rootId]);
    assert.equal(index.tasks[0].status, 'completed');
    assert.equal(index.tasks[0].projectName, 'example-project');
    assert.equal(index.tasks[0].taskName, 'Discord 新任务');
    const detail = await readTaskDetail(index.tasks[0]);
    assert.equal(detail.resultText, '完成');
    assert.deepEqual(
      (await searchTasks({ index, keyword: 'Discord 新任务' })).map((item) => item.threadId),
      [rootId],
    );
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('indexes forced-large rollouts from bounded head and tail reads without claiming an exact runtime', async () => {
  const paths = await fixture();
  const threadId = '019cdef0-1234-7890-abcd-1234567890ab';
  const rolloutPath = paths.rollout(`2026-09-01T00-00-00-${threadId}`);
  let rolloutWholeReads = 0;
  const fileSystem = observingFileSystem({
    onReadFile(filePath) {
      if (path.resolve(String(filePath)) === path.resolve(rolloutPath)) rolloutWholeReads += 1;
    },
  });
  try {
    await writeJsonl(paths.sessionIndexPath, [{ id: threadId, thread_name: '有界索引任务' }]);
    await writeJsonl(rolloutPath, [
      meta(threadId, { project_id: 'bounded-project', project_name: 'Bounded Project' }),
      event('2026-09-01T00:01:00.000Z', 'task_started', { turn_id: 'turn-head' }),
      event('2026-09-01T00:01:01.000Z', 'user_message', { message: '头部任务内容' }),
      event('2026-09-01T00:02:00.000Z', 'agent_message', { message: 'x'.repeat(2_000) }),
      event('2026-09-01T00:06:00.000Z', 'task_complete', { turn_id: 'turn-head', last_agent_message: '尾部最终结果' }),
    ]);

    const index = await buildTaskIndex({
      ...paths,
      fileSystem,
      readLimits: forcedBoundedReadLimits,
      nowMs: Date.parse('2026-09-01T00:07:00.000Z'),
    });

    assert.equal(index.tasks.length, 1);
    assert.equal(index.tasks[0].threadId, threadId);
    assert.equal(index.tasks[0].projectId, 'bounded-project');
    assert.equal(index.tasks[0].status, 'completed');
    assert.equal(index.tasks[0].completedAt, '2026-09-01T00:06:00.000Z');
    assert.equal(index.tasks[0].runtimeMs, null);
    assert.equal(index.tasks[0].offset, (await fs.stat(rolloutPath)).size);
    assert.equal(rolloutWholeReads, 0);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('keeps the first tail entry when its read window starts exactly at a JSONL line boundary', async () => {
  const paths = await fixture();
  const threadId = '019cdef0-1111-7890-abcd-1234567890ab';
  const rolloutPath = paths.rollout(`2026-09-01T00-00-00-${threadId}`);
  try {
    await writeJsonl(paths.sessionIndexPath, [{ id: threadId, thread_name: '尾部边界任务' }]);
    const head = [
      meta(threadId),
      event('2026-09-01T00:01:00.000Z', 'task_started', { turn_id: 'boundary-turn' }),
    ].map(line).join('');
    const middle = line(event('2026-09-01T00:02:00.000Z', 'agent_message', { message: 'x'.repeat(1_200) }));
    const tail = line(event('2026-09-01T00:03:00.000Z', 'task_complete', {
      turn_id: 'boundary-turn',
      last_agent_message: '边界结果',
    }));
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
    await fs.writeFile(rolloutPath, `${head}${middle}${tail}`, 'utf8');

    const index = await buildTaskIndex({
      ...paths,
      readLimits: {
        wholeFileBytes: Buffer.byteLength(head),
        headBytes: Buffer.byteLength(head),
        tailBytes: Buffer.byteLength(tail),
        sidebarChunkBytes: 17,
      },
      nowMs: Date.parse('2026-09-01T00:04:00.000Z'),
    });

    assert.equal(index.tasks[0].status, 'completed');
    assert.equal(index.tasks[0].completedAt, '2026-09-01T00:03:00.000Z');
    assert.equal(index.tasks[0].runtimeMs, null);
    assert.equal((await readTaskDetail(index.tasks[0], {
      readLimits: {
        wholeFileBytes: Buffer.byteLength(head),
        headBytes: Buffer.byteLength(head),
        tailBytes: Buffer.byteLength(tail),
      },
    })).resultText, '边界结果');
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('forced-large detail and search expose bounded head and tail content but not middle-only content', async () => {
  const paths = await fixture();
  const rolloutPath = paths.rollout('bounded-detail');
  const middleOnlyRolloutPath = paths.rollout('bounded-middle-only');
  let rolloutWholeReads = 0;
  const fileSystem = observingFileSystem({
    onReadFile(filePath) {
      if ([rolloutPath, middleOnlyRolloutPath].map((item) => path.resolve(item)).includes(path.resolve(String(filePath)))) {
        rolloutWholeReads += 1;
      }
    },
  });
  try {
    await writeJsonl(rolloutPath, [
      meta('bounded-detail'),
      responseMessage('2026-09-01T00:01:00.000Z', 'user', 'HEAD-ONLY-NEEDLE original task'),
      responseMessage('2026-09-01T00:02:00.000Z', 'assistant', `MIDDLE-ONLY-NEEDLE ${'x'.repeat(2_000)}`, 'commentary'),
      responseMessage('2026-09-01T00:03:00.000Z', 'assistant', 'TAIL-ONLY-NEEDLE final result', 'final_answer'),
    ]);
    await writeJsonl(middleOnlyRolloutPath, [
      meta('bounded-middle-only'),
      event('2026-09-01T00:00:30.000Z', 'agent_message', { message: 'x'.repeat(1_000) }),
      responseMessage('2026-09-01T00:02:00.000Z', 'user', 'MIDDLE-ONLY-NEEDLE hidden task'),
      event('2026-09-01T00:02:30.000Z', 'agent_message', { message: 'y'.repeat(1_000) }),
      event('2026-09-01T00:03:00.000Z', 'task_started', { turn_id: 'tail-turn' }),
    ]);
    const record = {
      threadId: 'bounded-detail',
      taskName: 'bounded detail',
      projectName: 'Bridge',
      rolloutPath,
      offset: (await fs.stat(rolloutPath)).size,
    };
    const middleOnlyRecord = {
      threadId: 'bounded-middle-only',
      taskName: 'bounded middle',
      projectName: 'Bridge',
      rolloutPath: middleOnlyRolloutPath,
      offset: (await fs.stat(middleOnlyRolloutPath)).size,
    };
    const detail = await readTaskDetail(record, { fileSystem, readLimits: forcedBoundedReadLimits });
    assert.equal(detail.taskText, 'HEAD-ONLY-NEEDLE original task');
    assert.equal(detail.resultText, 'TAIL-ONLY-NEEDLE final result');

    const index = { version: 1, generatedAt: null, tasks: [record, middleOnlyRecord] };
    assert.deepEqual(await searchTasks({ index, keyword: 'MIDDLE-ONLY-NEEDLE', fileSystem, readLimits: forcedBoundedReadLimits }), []);
    assert.deepEqual(
      (await searchTasks({ index, keyword: 'HEAD-ONLY-NEEDLE', fileSystem, readLimits: forcedBoundedReadLimits })).map((item) => item.threadId),
      ['bounded-detail'],
    );
    assert.deepEqual(
      (await searchTasks({ index, keyword: 'TAIL-ONLY-NEEDLE', fileSystem, readLimits: forcedBoundedReadLimits })).map((item) => item.threadId),
      ['bounded-detail'],
    );
    assert.equal(rolloutWholeReads, 0);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('reuses an unchanged previous record without opening its rollout body and refreshes sidebar and notification overlays', async () => {
  const paths = await fixture();
  const threadId = '019cdef0-4321-7890-abcd-1234567890ab';
  const rolloutPath = paths.rollout(`2026-09-01T00-00-00-${threadId}`);
  const openedPaths = [];
  const fileSystem = observingFileSystem({
    onOpen(filePath) {
      openedPaths.push(path.resolve(String(filePath)));
    },
  });
  try {
    await writeJsonl(paths.sessionIndexPath, [{
      id: threadId,
      thread_name: '当前侧边栏标题',
      updated_at: '2026-09-01T00:10:00.000Z',
    }]);
    await writeJsonl(rolloutPath, [
      meta(threadId, { project_id: 'body-project', project_name: 'Body Project' }),
      event('2026-09-01T00:04:00.000Z', 'task_started', { turn_id: 'body-turn' }),
      event('2026-09-01T00:05:00.000Z', 'task_failed', { turn_id: 'body-turn' }),
    ]);
    await fs.writeFile(paths.messageMapPath, JSON.stringify({ version: 1, messages: {
      '101': {
        threadId,
        eventName: 'user-task-confirmation-required',
        createdAt: '2026-09-01T00:11:00.000Z',
      },
    } }), 'utf8');
    const size = (await fs.stat(rolloutPath)).size;
    const previous = {
      threadId,
      projectId: 'previous-project',
      projectName: 'Previous Project',
      taskName: '旧标题',
      status: 'completed',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastActivityAt: '2026-09-01T00:02:00.000Z',
      startedAt: '2026-09-01T00:01:00.000Z',
      completedAt: '2026-09-01T00:02:00.000Z',
      runtimeMs: 60_000,
      rolloutPath,
      offset: size,
      worktreePath: null,
      worktreeBranch: null,
    };

    const index = await buildTaskIndex({
      ...paths,
      fileSystem,
      readLimits: forcedBoundedReadLimits,
      previousIndex: { version: 1, generatedAt: previous.lastActivityAt, tasks: [previous] },
      nowMs: Date.parse('2026-09-01T00:12:00.000Z'),
    });

    assert.equal(index.tasks[0].projectId, 'previous-project');
    assert.equal(index.tasks[0].taskName, '当前侧边栏标题');
    assert.equal(index.tasks[0].lastActivityAt, '2026-09-01T00:10:00.000Z');
    assert.equal(index.tasks[0].status, 'confirmation-required');
    assert.equal(openedPaths.includes(path.resolve(paths.sessionIndexPath)), true);
    assert.equal(openedPaths.includes(path.resolve(rolloutPath)), false);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('an unchanged historic null project is re-inferred from the latest example-project catalog', async () => {
  const paths = await fixture();
  const threadId = '019cdef0-4321-7890-abcd-1234567890ac';
  const rolloutPath = paths.rollout(`2026-09-01T00-00-00-${threadId}`);
  try {
    await writeJsonl(paths.sessionIndexPath, [{ id: threadId, thread_name: 'example-project 历史任务' }]);
    await writeJsonl(rolloutPath, [
      meta(threadId, { cwd: 'C:\\Users\\operator\\Desktop\\example-project\\app' }),
      event('2026-09-01T00:04:00.000Z', 'task_started', { turn_id: 'body-turn' }),
      event('2026-09-01T00:05:00.000Z', 'task_complete', { turn_id: 'body-turn' }),
    ]);
    const size = (await fs.stat(rolloutPath)).size;
    const previous = {
      threadId, projectId: null, projectName: null, taskName: '旧标题', status: 'completed',
      rolloutPath, offset: size, worktreePath: null, worktreeBranch: null,
    };

    const index = await buildTaskIndex({
      ...paths,
      previousIndex: { version: 1, generatedAt: null, tasks: [previous] },
      projects: [{ id: 'example-project', name: 'example-project', roots: ['C:\\Users\\operator\\Desktop\\example-project'] }],
    });

    assert.equal(index.tasks[0].projectId, 'example-project');
    assert.equal(index.tasks[0].projectName, 'example-project');
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('an unchanged stale explicit project is re-inferred to the current longest saved root', async () => {
  const paths = await fixture();
  const threadId = '019cdef0-4321-7890-abcd-1234567890ad';
  const rolloutPath = paths.rollout(`2026-09-01T00-00-00-${threadId}`);
  try {
    await writeJsonl(paths.sessionIndexPath, [{ id: threadId, thread_name: '迁移项目任务' }]);
    await writeJsonl(rolloutPath, [meta(threadId, { cwd: 'C:\\work\\current\\nested\\app' })]);
    const size = (await fs.stat(rolloutPath)).size;
    const index = await buildTaskIndex({
      ...paths,
      previousIndex: { version: 1, generatedAt: null, tasks: [{
        threadId, projectId: 'deleted-project', projectName: 'Deleted', taskName: '旧任务', status: 'completed',
        rolloutPath, offset: size, worktreePath: null, worktreeBranch: null,
      }] },
      projects: [
        { id: 'broad', name: 'Broad', roots: ['C:\\work\\current'] },
        { id: 'nested', name: 'Nested', roots: ['C:\\work\\current\\nested'] },
      ],
    });
    assert.equal(index.tasks[0].projectId, 'nested');
    assert.equal(index.tasks[0].projectName, 'Nested');
  } finally { await fs.rm(paths.root, { recursive: true, force: true }); }
});

test('unchanged managed worktree fast path applies its valid persisted creation project', async () => {
  const paths = await fixture();
  const threadId = '019cdef0-4321-7890-abcd-1234567890ae';
  const rolloutPath = paths.rollout(`2026-09-01T00-00-00-${threadId}`);
  try {
    await writeJsonl(rolloutPath, [meta(threadId, { cwd: 'G:\\generated\\discord-worktree' })]);
    const size = (await fs.stat(rolloutPath)).size;
    await writeJsonl(paths.sessionIndexPath, [{ id: threadId, thread_name: '托管工作树任务' }]);
    const index = await buildTaskIndex({
      ...paths,
      previousIndex: { version: 1, generatedAt: null, tasks: [{
        threadId, projectId: null, projectName: null, taskName: '旧任务', status: 'running',
        rolloutPath, offset: size, worktreePath: 'G:\\generated\\discord-worktree', worktreeBranch: 'codex/discord-test',
      }] },
      projects: [{ id: 'example-project', name: 'example-project', roots: ['C:\\Users\\operator\\Desktop\\example-project'] }],
      createdTasksByInteraction: { create1: {
        status: 'started', threadId, turnId: 'turn-1', projectId: 'example-project', projectName: 'example-project',
        taskName: '托管工作树任务',
        workspace: { mode: 'worktree', cwd: 'G:\\generated\\discord-worktree', runtimeWorkspaceRoots: ['G:\\generated\\discord-worktree'], operationId: 'create1' },
      } },
    });
    assert.equal(index.tasks[0].projectId, 'example-project');
    assert.equal(index.tasks[0].projectName, 'example-project');
  } finally { await fs.rm(paths.root, { recursive: true, force: true }); }
});

test('streams sidebar lines and skips standard-filename rollouts absent from the current sidebar before body reads', async () => {
  const paths = await fixture();
  const sidebarId = '019cdef0-aaaa-7890-abcd-1234567890ab';
  const excludedId = '019cdef0-bbbb-7890-abcd-1234567890ab';
  const sidebarRollout = paths.rollout(`2026-09-01T00-00-00-${sidebarId}`);
  const excludedRollout = paths.rollout(`2026-09-01T00-00-00-${excludedId}`);
  const openedPaths = [];
  const wholeReadPaths = [];
  const fileSystem = observingFileSystem({
    onOpen(filePath) {
      openedPaths.push(path.resolve(String(filePath)));
    },
    onReadFile(filePath) {
      wholeReadPaths.push(path.resolve(String(filePath)));
    },
  });
  try {
    await writeJsonl(paths.sessionIndexPath, [
      { id: sidebarId, thread_name: '旧的流式标题' },
      { id: sidebarId.toUpperCase(), thread_name: '当前流式标题' },
    ], '{ invalid sidebar line\n');
    await writeJsonl(sidebarRollout, [meta(sidebarId)]);
    await writeJsonl(excludedRollout, [meta(excludedId), event('2026-09-01T00:01:00.000Z', 'user_message', {
      message: '此非侧边栏正文不应读取',
    })]);

    const index = await buildTaskIndex({
      ...paths,
      fileSystem,
      readLimits: forcedBoundedReadLimits,
      nowMs: Date.parse('2026-09-01T00:02:00.000Z'),
    });

    assert.deepEqual(index.tasks.map((item) => item.threadId), [sidebarId]);
    assert.equal(index.tasks[0].taskName, '当前流式标题');
    assert.equal(openedPaths.includes(path.resolve(paths.sessionIndexPath)), true);
    assert.equal(openedPaths.includes(path.resolve(sidebarRollout)), true);
    assert.equal(openedPaths.includes(path.resolve(excludedRollout)), false);
    assert.equal(wholeReadPaths.includes(path.resolve(paths.sessionIndexPath)), false);
    assert.equal(wholeReadPaths.includes(path.resolve(sidebarRollout)), false);
    assert.equal(wholeReadPaths.includes(path.resolve(excludedRollout)), false);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('keeps rebuilding when one rollout becomes unreadable and retains its matching prior record', async () => {
  const paths = await fixture();
  const unreadableId = '019cdef0-cccc-7890-abcd-1234567890ab';
  const healthyId = '019cdef0-dddd-7890-abcd-1234567890ab';
  const unreadableRollout = paths.rollout('unreadable-fallback-name');
  const healthyRollout = paths.rollout(`2026-09-01T00-00-00-${healthyId}`);
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'open') return Reflect.get(target, property);
      return async (filePath, ...args) => {
        if (path.resolve(String(filePath)) === path.resolve(unreadableRollout)) {
          const error = new Error('fixture rollout is unreadable');
          error.code = 'EACCES';
          throw error;
        }
        return target.open(filePath, ...args);
      };
    },
  });
  try {
    await writeJsonl(paths.sessionIndexPath, [
      { id: unreadableId, thread_name: '不可读任务的新标题' },
      { id: healthyId, thread_name: '健康任务' },
    ]);
    await writeJsonl(unreadableRollout, [meta(unreadableId)]);
    await writeJsonl(healthyRollout, [meta(healthyId)]);
    const prior = {
      threadId: unreadableId,
      taskName: '不可读任务的旧标题',
      status: 'completed',
      lastActivityAt: '2026-09-01T00:01:00.000Z',
      rolloutPath: unreadableRollout,
      offset: 1,
    };

    const index = await buildTaskIndex({
      ...paths,
      fileSystem,
      previousIndex: { version: 1, generatedAt: prior.lastActivityAt, tasks: [prior] },
      nowMs: Date.parse('2026-09-01T00:02:00.000Z'),
    });

    assert.deepEqual(index.tasks.map((item) => item.threadId).sort(), [healthyId, unreadableId].sort());
    assert.equal(index.tasks.find((item) => item.threadId === unreadableId).taskName, '不可读任务的新标题');
    assert.equal(index.tasks.find((item) => item.threadId === unreadableId).status, 'completed');
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('does not restore a prior record when the current unreadable rollout is at a different path', async () => {
  const paths = await fixture();
  const threadId = '019cdef0-eeee-7890-abcd-1234567890ab';
  const currentRollout = paths.rollout(`2026-09-01T00-00-00-${threadId}`);
  const priorRollout = path.join(paths.root, 'old-sessions', `rollout-${threadId}.jsonl`);
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'open') return Reflect.get(target, property);
      return async (filePath, ...args) => {
        if (path.resolve(String(filePath)) === path.resolve(currentRollout)) {
          const error = new Error('current fixture rollout is unreadable');
          error.code = 'EACCES';
          throw error;
        }
        return target.open(filePath, ...args);
      };
    },
  });
  try {
    await writeJsonl(paths.sessionIndexPath, [{ id: threadId, thread_name: '当前路径任务' }]);
    await writeJsonl(currentRollout, [meta(threadId)]);
    const prior = {
      threadId,
      taskName: '旧路径任务',
      status: 'completed',
      lastActivityAt: '2026-09-01T00:01:00.000Z',
      rolloutPath: priorRollout,
      offset: 123,
    };

    const index = await buildTaskIndex({
      ...paths,
      fileSystem,
      previousIndex: { version: 1, generatedAt: prior.lastActivityAt, tasks: [prior] },
      nowMs: Date.parse('2026-09-01T00:02:00.000Z'),
    });

    assert.deepEqual(index.tasks, []);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('indexes sidebar user roots, uses the last sidebar title, and excludes every non-root form', async () => {
  const paths = await fixture();
  try {
    await writeJsonl(paths.sessionIndexPath, [
      { id: 'root-1', thread_name: '旧标题' },
      { id: 'child-source', thread_name: 'source child' },
      { id: 'child-parent', thread_name: 'parented child' },
      { id: 'child-session', thread_name: 'session child' },
      { id: 'ROOT-1', thread_name: '主任务' },
      { id: 'missing-rollout', thread_name: '没有 rollout' },
    ], '{ invalid sidebar line\n');
    await writeJsonl(paths.rollout('root-1'), [
      meta('root-1'),
      event('2026-09-01T00:01:00.000Z', 'task_started', { turn_id: 'turn-1' }),
      event('2026-09-01T00:02:00.000Z', 'user_message', { message: '检查通知' }),
      event('2026-09-01T00:06:00.000Z', 'task_complete', { turn_id: 'turn-1', last_agent_message: '已完成。' }),
    ], 'not-json\n');
    await writeJsonl(paths.rollout('source'), [meta('child-source', { source: { subagent: { thread_id: 'root-1' } } })]);
    await writeJsonl(paths.rollout('parent'), [meta('child-parent', { parent_thread_id: 'root-1' })]);
    await writeJsonl(paths.rollout('session'), [meta('child-session', { session_id: 'root-1' })]);
    await writeJsonl(paths.rollout('not-sidebar'), [meta('not-sidebar')]);
    await writeJsonl(path.join(paths.sessionsRoot, 'ignored.jsonl'), [meta('ignored')]);

    const index = await buildTaskIndex({
      sessionsRoot: paths.sessionsRoot,
      sessionIndexPath: paths.sessionIndexPath,
      messageMapPath: paths.messageMapPath,
      nowMs: Date.parse('2026-09-01T00:07:00.000Z'),
    });

    assert.deepEqual(index.tasks.map((item) => item.threadId), ['root-1']);
    assert.equal(index.tasks[0].taskName, '主任务');
    assert.equal(index.tasks[0].status, 'completed');
    assert.equal(index.tasks[0].runtimeMs, 300_000);
    assert.equal(index.tasks[0].startedAt, '2026-09-01T00:01:00.000Z');
    assert.equal(index.tasks[0].completedAt, '2026-09-01T00:06:00.000Z');
    assert.equal(index.tasks[0].offset, Buffer.byteLength(await fs.readFile(paths.rollout('root-1'))));
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('retains previous root metadata after rollout cleanup until current rollout content returns', async () => {
  const paths = await fixture();
  const rolloutPath = paths.rollout('retained-root');
  const previous = {
    threadId: 'retained-root',
    projectId: 'project-retained',
    projectName: 'Retained Project',
    taskName: '保留的任务名',
    status: 'completed',
    createdAt: '2026-08-30T01:00:00.000Z',
    lastActivityAt: '2026-08-30T02:00:00.000Z',
    startedAt: null,
    completedAt: null,
    runtimeMs: null,
    rolloutPath,
    offset: 321,
    worktreePath: 'C:\\safe\\worktrees\\retained-root',
    worktreeBranch: 'codex/discord-retained-root',
    taskText: 'must not be copied into the index',
  };
  try {
    await writeJsonl(paths.sessionIndexPath, [{ id: 'RETAINED-ROOT', thread_name: '侧边栏仍存在' }]);

    const retainedIndex = await buildTaskIndex({
      ...paths,
      previousIndex: { version: 1, generatedAt: '2026-08-30T02:00:00.000Z', tasks: [previous] },
      nowMs: Date.parse('2026-09-01T03:00:00.000Z'),
    });

    assert.equal(retainedIndex.tasks.length, 1);
    assert.deepEqual(retainedIndex.tasks[0], Object.fromEntries(
      Object.entries(previous).filter(([field]) => field !== 'taskText'),
    ));
    const unavailable = await readTaskDetail(retainedIndex.tasks[0]);
    assert.equal(unavailable.contentAvailable, false);
    assert.equal(unavailable.taskText, '');
    assert.equal(unavailable.resultText, '');

    await writeJsonl(rolloutPath, [
      meta('retained-root', { project_id: 'project-current', project_name: 'Current Project' }),
      event('2026-09-01T03:01:00.000Z', 'task_started', { turn_id: 'turn-current' }),
      event('2026-09-01T03:02:00.000Z', 'task_complete', { turn_id: 'turn-current', last_agent_message: '当前结果' }),
    ]);
    const rebuilt = await buildTaskIndex({
      ...paths,
      previousIndex: retainedIndex,
      nowMs: Date.parse('2026-09-01T03:03:00.000Z'),
    });

    assert.equal(rebuilt.tasks.length, 1);
    assert.equal(rebuilt.tasks[0].taskName, '侧边栏仍存在');
    assert.equal(rebuilt.tasks[0].projectId, 'project-current');
    assert.equal(rebuilt.tasks[0].lastActivityAt, '2026-09-01T03:02:00.000Z');
    assert.equal(rebuilt.tasks[0].runtimeMs, 60_000);
    assert.equal((await readTaskDetail(rebuilt.tasks[0])).contentAvailable, true);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('deduplicates mixed-case rollout IDs and preserves the newest record canonical ID', async () => {
  const paths = await fixture();
  try {
    await writeJsonl(paths.sessionIndexPath, [{ id: 'RoOt-DuP', thread_name: '唯一主任务' }]);
    await writeJsonl(paths.rollout('older'), [
      meta('ROOT-DUP'),
      event('2026-09-01T00:01:00.000Z', 'user_message', { message: '较早活动' }),
    ]);
    await writeJsonl(paths.rollout('newer'), [
      meta('root-dup'),
      event('2026-09-01T00:05:00.000Z', 'user_message', { message: '最新活动' }),
    ]);

    const index = await buildTaskIndex({ ...paths, nowMs: Date.parse('2026-09-01T00:06:00.000Z') });
    assert.equal(index.tasks.length, 1);
    assert.equal(index.tasks[0].threadId, 'root-dup');
    assert.equal(index.tasks[0].lastActivityAt, '2026-09-01T00:05:00.000Z');
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('derives running and failed status and sums only timestamped turn runtime', async () => {
  const paths = await fixture();
  try {
    await writeJsonl(paths.sessionIndexPath, [
      { id: 'running-1', thread_name: '正在运行' },
      { id: 'failed-1', thread_name: '运行失败' },
      { id: 'aborted-1', thread_name: '主动中止' },
    ]);
    await writeJsonl(paths.rollout('running'), [
      meta('running-1'),
      event('2026-09-01T00:01:00.000Z', 'task_started', { turn_id: 'turn-a' }),
      event('2026-09-01T00:03:00.000Z', 'task_complete', { turn_id: 'turn-a' }),
      event('2026-09-01T00:05:00.000Z', 'task_started', { turn_id: 'turn-b' }),
    ]);
    await fs.utimes(paths.rollout('running'), new Date('2026-09-01T12:00:00Z'), new Date('2026-09-01T12:00:00Z'));
    await writeJsonl(paths.rollout('failed'), [
      meta('failed-1'),
      event('2026-09-01T00:01:00.000Z', 'task_started', { turn_id: 'turn-f' }),
      event('2026-09-01T00:04:00.000Z', 'task_failed', { turn_id: 'turn-f', message: 'failure' }),
    ]);
    await writeJsonl(paths.rollout('aborted'), [
      meta('aborted-1'),
      event('2026-09-01T00:02:00.000Z', 'task_started', { turn_id: 'turn-x' }),
      event('2026-09-01T00:04:30.000Z', 'turn_aborted', { turn_id: 'turn-x' }),
    ]);

    const index = await buildTaskIndex({ ...paths, nowMs: Date.parse('2026-09-01T00:10:00.000Z') });
    const byId = Object.fromEntries(index.tasks.map((item) => [item.threadId, item]));
    assert.equal(byId['running-1'].status, 'running');
    assert.equal(byId['running-1'].runtimeMs, 420_000);
    assert.equal(byId['running-1'].completedAt, null);
    assert.equal(byId['failed-1'].status, 'failed');
    assert.equal(byId['failed-1'].runtimeMs, 180_000);
    assert.equal(byId['aborted-1'].status, 'failed');
    assert.equal(byId['aborted-1'].runtimeMs, 150_000);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('reports unknown runtime when any completed, active, or unmatched interval is not fully bounded', async () => {
  const paths = await fixture();
  try {
    await writeJsonl(paths.sessionIndexPath, [
      { id: 'missing-start-time', thread_name: '缺开始时间' },
      { id: 'missing-end-time', thread_name: '缺结束时间' },
      { id: 'missing-active-time', thread_name: '缺运行中时间' },
      { id: 'unmatched-prior', thread_name: '前序未配对' },
    ]);
    await writeJsonl(paths.rollout('missing-start-time'), [
      meta('missing-start-time'),
      event(undefined, 'task_started', { turn_id: 'turn-1' }),
      event('2026-09-01T00:02:00.000Z', 'task_complete', { turn_id: 'turn-1' }),
    ]);
    await writeJsonl(paths.rollout('missing-end-time'), [
      meta('missing-end-time'),
      event('2026-09-01T00:01:00.000Z', 'task_started', { turn_id: 'turn-1' }),
      event(undefined, 'task_complete', { turn_id: 'turn-1' }),
    ]);
    await writeJsonl(paths.rollout('missing-active-time'), [
      meta('missing-active-time'),
      event(undefined, 'task_started', { turn_id: 'turn-1' }),
    ]);
    await writeJsonl(paths.rollout('unmatched-prior'), [
      meta('unmatched-prior'),
      event('2026-09-01T00:01:00.000Z', 'task_started', { turn_id: 'turn-old' }),
      event('2026-09-01T00:03:00.000Z', 'task_started', { turn_id: 'turn-current' }),
      event('2026-09-01T00:04:00.000Z', 'task_complete', { turn_id: 'turn-current' }),
    ]);

    const index = await buildTaskIndex({ ...paths, nowMs: Date.parse('2026-09-01T00:05:00.000Z') });
    assert.deepEqual(Object.fromEntries(index.tasks.map((item) => [item.threadId, item.runtimeMs])), {
      'missing-start-time': null,
      'missing-end-time': null,
      'missing-active-time': null,
      'unmatched-prior': null,
    });
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('uses the newest mapped notification to overlay confirmation status', async () => {
  const paths = await fixture();
  try {
    await writeJsonl(paths.sessionIndexPath, [{ id: 'root-1', thread_name: '需要确认' }]);
    await writeJsonl(paths.rollout('root'), [
      meta('root-1'),
      event('2026-09-01T00:01:00.000Z', 'task_started', { turn_id: 'turn-1' }),
      event('2026-09-01T00:02:00.000Z', 'task_complete', { turn_id: 'turn-1', last_agent_message: '请选择方案。' }),
    ]);
    await fs.writeFile(paths.messageMapPath, JSON.stringify({ version: 1, messages: {
      '100': { threadId: 'root-1', eventName: 'user-task-complete', createdAt: '2026-09-01T00:02:01.000Z' },
      '101': { threadId: 'root-1', eventName: 'user-task-confirmation-required', createdAt: '2026-09-01T00:02:02.000Z' },
    } }), 'utf8');
    const index = await buildTaskIndex({ ...paths, nowMs: Date.parse('2026-09-01T00:03:00.000Z') });
    assert.equal(index.tasks[0].status, 'confirmation-required');
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('exposes saved project and only trusted managed Discord worktree metadata', async () => {
  const paths = await fixture();
  try {
    const worktreeRoot = path.join(paths.root, 'managed-worktrees');
    const managedPath = path.join(worktreeRoot, 'operation-1');
    await writeJsonl(paths.sessionIndexPath, [
      { id: 'managed-1', thread_name: '项目任务', project_id: 'project-1', project_name: '收银系统' },
      { id: 'outside-1', thread_name: '普通任务' },
      { id: 'subagent-1', thread_name: '伪装工作树' },
    ]);
    await writeJsonl(paths.rollout('managed'), [meta('managed-1', {
      project_id: 'project-1',
      project_name: '收银系统',
      cwd: managedPath,
      runtime_workspace_roots: [managedPath, 'C:\\shared'],
      git: { branch: 'codex/discord-20260901-010203-abcdef' },
    })]);
    await writeJsonl(paths.rollout('outside'), [meta('outside-1', {
      cwd: path.join(paths.root, 'outside'),
      runtimeWorkspaceRoots: [path.join(paths.root, 'outside')],
      git: { branch: 'codex/discord-valid-prefix' },
    })]);
    await writeJsonl(paths.rollout('subagent'), [meta('subagent-1', {
      source: { subagent: {} }, cwd: managedPath,
      runtime_workspace_roots: [managedPath], git: { branch: 'codex/discord-fake' },
    })]);

    const index = await buildTaskIndex({ ...paths, discordWorktreeRoot: worktreeRoot, nowMs: Date.now() });
    const managed = index.tasks.find((item) => item.threadId === 'managed-1');
    const outside = index.tasks.find((item) => item.threadId === 'outside-1');
    assert.equal(managed.projectId, 'project-1');
    assert.equal(managed.projectName, '收银系统');
    assert.equal(managed.worktreePath, path.resolve(managedPath));
    assert.equal(managed.worktreeBranch, 'codex/discord-20260901-010203-abcdef');
    assert.equal(outside.worktreePath, null);
    assert.equal(outside.worktreeBranch, null);
    assert.deepEqual(index.tasks.map((item) => item.threadId).sort(), ['managed-1', 'outside-1']);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('reads first task, latest completed result, and page-safe Markdown on demand', async () => {
  const paths = await fixture();
  try {
    const rolloutPath = paths.rollout('detail');
    await writeJsonl(rolloutPath, [
      meta('detail-1'),
      event('2026-09-01T00:01:00.000Z', 'task_started', { turn_id: 'turn-1' }),
      event('2026-09-01T00:01:01.000Z', 'user_message', { message: '  修复 **支付** 通知  ' }),
      event('2026-09-01T00:01:02.000Z', 'agent_message', { message: '处理中' }),
      event('2026-09-01T00:02:00.000Z', 'task_complete', { turn_id: 'turn-1', last_agent_message: '第一次结果' }),
      event('2026-09-01T00:03:00.000Z', 'task_started', { turn_id: 'turn-2' }),
      event('2026-09-01T00:04:00.000Z', 'task_complete', { turn_id: 'turn-2', last_agent_message: '最终结果\n```js\nconst ok = true;\n```' }),
    ]);
    const record = { threadId: 'detail-1', taskName: '支付任务', projectName: 'POS', rolloutPath, offset: (await fs.stat(rolloutPath)).size };
    const detail = await readTaskDetail(record);
    assert.equal(detail.taskText, '修复 **支付** 通知');
    assert.equal(detail.resultText, '最终结果\n```js\nconst ok = true;\n```');
    assert.match(detail.markdown, /## 原始任务\n修复 \*\*支付\*\* 通知/);
    assert.match(detail.markdown, /## 最新结果\n最终结果/);
    assert.equal(detail.markdown.includes('@everyone'), false);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('keeps normal-file detail behavior when a legacy record has a null offset', async () => {
  const paths = await fixture();
  try {
    const rolloutPath = paths.rollout('null-offset-detail');
    await writeJsonl(rolloutPath, [
      meta('null-offset-detail'),
      responseMessage('2026-09-01T00:01:00.000Z', 'user', '空 offset 仍读取正常小文件'),
      responseMessage('2026-09-01T00:02:00.000Z', 'assistant', '兼容结果', 'final_answer'),
    ]);

    const detail = await readTaskDetail({ threadId: 'null-offset-detail', rolloutPath, offset: null });
    assert.equal(detail.taskText, '空 offset 仍读取正常小文件');
    assert.equal(detail.resultText, '兼容结果');
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('reads current response-item messages using first user and latest final assistant semantics', async () => {
  const paths = await fixture();
  try {
    const rolloutPath = paths.rollout('current-detail');
    await writeJsonl(rolloutPath, [
      meta('current-detail'),
      responseMessage('2026-09-01T00:01:00.000Z', 'user', '检查 webhook@example.invalid 的通知映射'),
      responseMessage('2026-09-01T00:01:10.000Z', 'assistant', '正在检查临时路径 C:\\Users\\Example\\secret', 'commentary'),
      responseMessage('2026-09-01T00:02:00.000Z', 'assistant', '第一轮已完成。', 'final_answer'),
      responseMessage('2026-09-01T00:03:00.000Z', 'user', '再验证一次，但首条任务仍应保留。'),
      responseMessage('2026-09-01T00:04:00.000Z', 'assistant', '最终验证完成，未保留凭据。', 'final_answer'),
    ]);
    const record = { threadId: 'current-detail', taskName: '通知映射', projectName: 'Bridge', rolloutPath, offset: (await fs.stat(rolloutPath)).size };
    const detail = await readTaskDetail(record);
    assert.equal(detail.contentAvailable, true);
    assert.equal(detail.taskText, '检查 webhook@example.invalid 的通知映射');
    assert.equal(detail.resultText, '最终验证完成，未保留凭据。');
    assert.equal(detail.resultText.includes('临时路径'), false);
    assert.deepEqual((await searchTasks({ index: { tasks: [record] }, keyword: '凭据' })).map((item) => item.threadId), ['current-detail']);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('task detail skips app-injected user context and keeps the first real user message', async () => {
  const paths = await fixture();
  try {
    const rolloutPath = paths.rollout('injected-context-detail');
    const injected = responseMessage(
      '2026-09-01T00:01:00.000Z',
      'user',
      '<recommended_plugins>\n- Airtable\n</recommended_plugins>',
    );
    injected.payload.internal_chat_message_metadata_passthrough = {
      turn_id: 'turn-injected',
      content_item_kinds: ['plugins.recommendations', 'environments.environment_context'],
    };
    const authored = responseMessage('2026-09-01T00:01:01.000Z', 'user', '我的命令行怎么找不到 Codex');
    authored.payload.internal_chat_message_metadata_passthrough = {
      turn_id: 'turn-injected',
      content_item_kinds: ['user.text'],
    };
    await writeJsonl(rolloutPath, [meta('injected-context-detail'), injected, authored]);

    const detail = await readTaskDetail({
      threadId: 'injected-context-detail', rolloutPath, offset: (await fs.stat(rolloutPath)).size,
    });

    assert.equal(detail.taskText, '我的命令行怎么找不到 Codex');
    assert.equal(detail.markdown.includes('recommended_plugins'), false);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('marks missing rollout content unavailable and retries the same search cache key after restoration', async () => {
  const paths = await fixture();
  try {
    const rolloutPath = paths.rollout('restored');
    const restoredEntries = [meta('restored'), responseMessage('2026-09-01T00:01:00.000Z', 'user', '恢复后可搜索的唯一文字')];
    const restoredContent = restoredEntries.map(line).join('');
    const record = {
      threadId: 'restored', taskName: '普通任务', projectName: 'Bridge',
      status: 'completed', rolloutPath, offset: Buffer.byteLength(restoredContent),
    };
    const unavailable = await readTaskDetail(record);
    assert.equal(unavailable.threadId, 'restored');
    assert.equal(unavailable.contentAvailable, false);
    assert.match(unavailable.markdown, /内容暂不可用/);
    assert.deepEqual(await searchTasks({ index: { tasks: [record] }, keyword: '唯一文字' }), []);

    await writeJsonl(rolloutPath, restoredEntries);
    assert.deepEqual((await searchTasks({ index: { tasks: [record] }, keyword: '唯一文字' })).map((item) => item.threadId), ['restored']);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('search normalizes Unicode case and whitespace and ranks name, project, then body', async () => {
  const paths = await fixture();
  try {
    const records = [];
    const fixtures = [
      ['name', 'ＰＡＹ', 'Other', 'unrelated', '2026-09-01T00:01:00.000Z'],
      ['project-new', 'Other', 'Ｐａｙ Team', 'unrelated', '2026-09-01T00:04:00.000Z'],
      ['project-old', 'Other', 'pay archive', 'unrelated', '2026-09-01T00:03:00.000Z'],
      ['body', 'Other', 'Elsewhere', 'please   PAY now', '2026-09-01T00:05:00.000Z'],
      ['miss', 'Other', 'Elsewhere', 'unrelated', '2026-09-01T00:06:00.000Z'],
    ];
    for (const [id, taskName, projectName, body, lastActivityAt] of fixtures) {
      const rolloutPath = paths.rollout(id);
      await writeJsonl(rolloutPath, [meta(id), event(lastActivityAt, 'user_message', { message: body })]);
      records.push({ threadId: id, taskName, projectName, rolloutPath, offset: (await fs.stat(rolloutPath)).size, lastActivityAt });
    }
    const index = { version: 1, generatedAt: '2026-09-01T00:07:00.000Z', tasks: records };
    const results = await searchTasks({ index, keyword: '  pay  ' });
    assert.deepEqual(results.map((item) => item.threadId), ['name', 'project-new', 'project-old', 'body']);
    assert.equal(results.every((item) => !Object.hasOwn(item, 'taskText') && !Object.hasOwn(item, 'resultText')), true);
    assert.deepEqual(await searchTasks({ index, keyword: '   ' }), []);
    assert.equal((await searchTasks({ index, keyword: 'pay', limit: 99 })).length, 4);
    assert.deepEqual((await searchTasks({ index, keyword: 'pay', limit: 2 })).map((item) => item.threadId), ['name', 'project-new']);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('writes atomically and backs up corrupt indexes without retaining conversation content', async () => {
  const paths = await fixture();
  try {
    const indexPath = path.join(paths.root, 'discord-task-index.json');
    const safeRecord = { threadId: 'root-1', rolloutPath: 'rollout.jsonl', offset: 10 };
    const index = { version: 1, generatedAt: '2026-09-01T00:00:00.000Z', tasks: [{ ...safeRecord, taskText: 'must not persist', resultText: 'must not persist' }] };
    await writeTaskIndexAtomic(indexPath, index);
    assert.deepEqual(await readTaskIndex(indexPath), { ...index, tasks: [safeRecord] });
    assert.equal((await fs.readFile(indexPath, 'utf8')).includes('must not persist'), false);
    assert.deepEqual((await fs.readdir(paths.root)).filter((name) => name.endsWith('.tmp')), []);

    await fs.writeFile(indexPath, '{ broken json with secret task text', 'utf8');
    assert.deepEqual(await readTaskIndex(indexPath), { version: 1, generatedAt: null, tasks: [] });
    const backups = (await fs.readdir(paths.root)).filter((name) => /^discord-task-index\.corrupt-[^:]+\.json$/.test(name));
    assert.equal(backups.length, 1);
    assert.equal(await fs.readFile(path.join(paths.root, backups[0]), 'utf8'), '{ broken json with secret task text');
    await assert.rejects(fs.access(indexPath));
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});
