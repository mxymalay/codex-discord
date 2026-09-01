import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildTaskIndex,
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

test('indexes sidebar user roots, uses the last sidebar title, and excludes every non-root form', async () => {
  const paths = await fixture();
  try {
    await writeJsonl(paths.sessionIndexPath, [
      { id: 'root-1', thread_name: '旧标题' },
      { id: 'child-source', thread_name: 'source child' },
      { id: 'child-parent', thread_name: 'parented child' },
      { id: 'child-session', thread_name: 'session child' },
      { id: 'root-1', thread_name: '主任务' },
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
