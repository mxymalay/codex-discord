import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMAND_NAMES } from '../discord-commands-lib.mjs';
import {
  cancelContinuationPersisted,
  createContinuationRequest,
  createEmptyInboxState,
  enqueueContinuation,
  listContinuations,
} from '../discord-bridge-lib.mjs';
import {
  createInteractionRestClient,
  createInteractionRouter,
  paginateMarkdown,
  renderHelp,
  renderContinuationQueue,
  renderQuota,
  renderSearchResults,
  renderSystemStatus,
  renderTaskList,
  renderTaskDetail,
} from '../discord-interactions.mjs';

const NOW = Date.parse('2026-09-01T04:00:00.000Z');

function task(number, overrides = {}) {
  return {
    threadId: `root-${number}`,
    projectId: 'project-1',
    projectName: number % 2 ? 'POS' : 'Bridge',
    taskName: `门店任务 ${number}`,
    status: 'completed',
    createdAt: '2026-09-01T01:00:00.000Z',
    lastActivityAt: `2026-09-01T03:${String(number % 60).padStart(2, '0')}:00.000Z`,
    runtimeMs: 65_000,
    rolloutPath: `C:\\private\\rollout-${number}.jsonl`,
    offset: 10,
    ...overrides,
  };
}

function identity(userId = '333', guildId = '222') {
  return { guild_id: guildId, member: { user: { id: userId } } };
}

function commandInteraction(name, options = {}, overrides = {}) {
  return {
    id: overrides.id ?? `command-${name}`,
    token: overrides.token ?? 'interaction-token-must-not-be-stored',
    application_id: '111',
    type: 2,
    ...identity(overrides.userId, overrides.guildId),
    data: {
      name,
      options: Object.entries(options).map(([optionName, value]) => ({ name: optionName, type: 3, value })),
    },
  };
}

function autocompleteInteraction(name, focused, overrides = {}) {
  const optionName = name === '新建任务' ? '项目' : '任务';
  return {
    id: overrides.id ?? `autocomplete-${name}`,
    token: overrides.token ?? 'autocomplete-token-must-not-be-stored',
    type: 4,
    ...identity(overrides.userId, overrides.guildId),
    data: { name, options: [{ name: optionName, type: 3, value: focused, focused: true }] },
  };
}

function modalSubmit(customId, text, overrides = {}) {
  return {
    id: overrides.id ?? 'modal-submit-1',
    token: overrides.token ?? 'modal-token-must-not-be-stored',
    type: 5,
    ...identity(overrides.userId, overrides.guildId),
    data: {
      custom_id: customId,
      components: [{ components: [{ custom_id: overrides.fieldId ?? '任务内容', value: text }] }],
    },
  };
}

function componentInteraction(customId, overrides = {}) {
  return {
    id: overrides.id ?? 'component-1',
    token: overrides.token ?? 'component-token-must-not-be-stored',
    type: 3,
    ...identity(overrides.userId, overrides.guildId),
    data: { custom_id: customId, component_type: 2 },
  };
}

function projectCatalog(projects, events = []) {
  return {
    snapshotChoices(focused = '') {
      events.push('snapshot-choices');
      const query = String(focused).toLocaleLowerCase();
      const saved = projects
        .filter((project) => !query || project.name.toLocaleLowerCase().includes(query))
        .slice(0, 24)
        .map((project) => ({ name: project.name, value: project.id }));
      return [...saved, { name: '无项目', value: '__projectless__' }];
    },
    snapshotGetById(id) {
      events.push('snapshot-get');
      return projects.find((project) => project.id === id) ?? null;
    },
    choices() { throw new Error('refreshing choices must not run during an Interaction'); },
    getById() { throw new Error('refreshing lookup must not run during an Interaction'); },
    async refresh() {
      events.push('refresh');
      return projects.map((project) => structuredClone(project));
    },
  };
}

function deterministicRandom() {
  let value = 0;
  return (size) => {
    assert.equal(size, 12);
    value += 1;
    return Buffer.alloc(size, value);
  };
}

function makeDependencies(overrides = {}) {
  const responses = [];
  const edits = [];
  const projects = overrides.projects ?? [{ id: 'project-1', name: 'POS', roots: ['C:\\saved\\POS'] }];
  const events = overrides.events ?? [];
  const taskIndex = overrides.taskIndex ?? { generatedAt: new Date(NOW).toISOString(), tasks: [task(1), task(2)] };
  const dependencies = {
    config: overrides.config ?? { discordGuildId: '222', discordAllowedUserId: '333' },
    taskIndex,
    projectCatalog: overrides.projectCatalog ?? projectCatalog(projects, events),
    projectlessRoot: 'C:\\safe\\Discord Tasks',
    worktreeRoot: 'C:\\safe\\worktrees',
    creationState: overrides.creationState ?? { createdTasksByInteraction: {} },
    persistCreationState: overrides.persistCreationState ?? (async () => { events.push('persist'); }),
    createNewTaskOnce: overrides.createNewTaskOnce ?? (async () => ({
      status: 'started',
      threadId: 'thread-created-1',
      turnId: 'turn-1',
      taskName: '生成中',
      workspace: { mode: 'worktree', cwd: 'C:\\safe\\worktrees\\operation-1', branchName: 'codex/discord-test' },
    })),
    readTaskDetail: overrides.readTaskDetail ?? (async (record) => ({
      ...record,
      contentAvailable: true,
      taskText: '检查支付流程',
      resultText: '完成',
      markdown: '## 原始任务\n检查支付流程\n\n## 最新结果\n完成',
    })),
    searchTasks: overrides.searchTasks ?? (async ({ index, keyword, limit }) =>
      index.tasks.filter((item) => item.taskName.includes(keyword)).slice(0, limit)),
    getQuotaState: overrides.getQuotaState ?? (async () => null),
    getSystemStatus: overrides.getSystemStatus ?? (() => ({ gateway: { state: 'ready' } })),
    runQuickHealthChecks: overrides.runQuickHealthChecks ?? (async () => [{ key: 'quick', label: '快速检查', ok: true, latencyMs: 1, detail: '正常' }]),
    runFullHealthChecks: overrides.runFullHealthChecks ?? (async () => [{ key: 'full', label: '完整检查', ok: true, latencyMs: 1, detail: '正常' }]),
    getQueue: overrides.getQueue ?? (() => []),
    dispatchContinuation: overrides.dispatchContinuation ?? (async () => ({ status: 'started', turnId: 'turn-continued' })),
    cancelContinuation: overrides.cancelContinuation ?? (() => ({ status: 'cancelled' })),
    persistContinuationState: overrides.persistContinuationState ?? (async () => {}),
    respond: overrides.respond ?? (async (body) => { responses.push(body); }),
    editOriginal: overrides.editOriginal ?? (async (body) => { edits.push(body); }),
    randomBytes: overrides.randomBytes ?? deterministicRandom(),
    now: overrides.now ?? (() => NOW),
    uiState: overrides.uiState ?? new Map(),
    ...overrides,
  };
  return { dependencies, responses, edits, events, taskIndex };
}

test('task autocomplete returns at most 25 authorized in-memory root tasks without detail reads', async () => {
  const detailReads = [];
  const { dependencies, responses, edits } = makeDependencies({
    taskIndex: { tasks: Array.from({ length: 40 }, (_, index) => task(index)) },
    readTaskDetail: async (record) => { detailReads.push(record); throw new Error('must not run'); },
  });
  const router = createInteractionRouter(dependencies);

  await router.handle(autocompleteInteraction('任务详情', '门店'));

  assert.equal(responses[0].type, 8);
  assert.equal(responses[0].data.choices.length, 25);
  assert.equal(responses[0].data.choices.every((item) => item.value.startsWith('root-')), true);
  assert.deepEqual(detailReads, []);
});

test('autocomplete fails closed and unauthorized requests receive no task or project choices', async () => {
  const { dependencies, responses, events } = makeDependencies();
  const router = createInteractionRouter(dependencies);

  await router.handle(autocompleteInteraction('任务详情', '', { userId: '999' }));
  await router.handle(autocompleteInteraction('新建任务', '', { guildId: '999' }));

  assert.deepEqual(responses, [
    { type: 8, data: { choices: [] } },
    { type: 8, data: { choices: [] } },
  ]);
  assert.deepEqual(events, []);
});

test('project autocomplete is cache-only, includes no-project, and stays within 25 choices', async () => {
  const projects = Array.from({ length: 30 }, (_, index) => ({
    id: `project-${index}`,
    name: `Project ${index}`,
    roots: [`C:\\saved\\${index}`],
  }));
  const { dependencies, responses, events } = makeDependencies({ projects });
  const router = createInteractionRouter(dependencies);

  await router.handle(autocompleteInteraction('新建任务', ''));

  assert.equal(responses[0].type, 8);
  assert.equal(responses[0].data.choices.length, 25);
  assert.equal(responses[0].data.choices.at(-1).value, '__projectless__');
  assert.deepEqual(events, ['snapshot-choices']);
});

test('project autocomplete converts a broken cache read into immediate zero choices', async () => {
  const { dependencies, responses } = makeDependencies({
    projectCatalog: {
      snapshotChoices() { throw new Error('Token secret C:\\private\\catalog'); },
      snapshotGetById() { return null; },
      async refresh() { throw new Error('not called'); },
    },
  });
  const router = createInteractionRouter(dependencies);

  await router.handle(autocompleteInteraction('新建任务', ''));

  assert.deepEqual(responses, [{ type: 8, data: { choices: [] } }]);
});

test('autocomplete rejects unsupported commands and clamps every Discord choice field', async () => {
  const long = '项目'.repeat(80);
  const projects = [{ id: 'p'.repeat(100), name: long, roots: ['C:\\saved\\long'] }];
  const { dependencies, responses } = makeDependencies({ projects });
  const router = createInteractionRouter(dependencies);

  await router.handle(autocompleteInteraction('系统状态', ''));
  await router.handle(autocompleteInteraction('新建任务', ''));

  assert.deepEqual(responses[0], { type: 8, data: { choices: [] } });
  assert.equal(responses[1].data.choices.every((choice) => choice.name.length <= 100 && choice.value.length <= 100), true);
});

test('initial command callbacks are always ephemeral and mention-safe', async () => {
  const invocations = [
    commandInteraction('任务列表'),
    commandInteraction('任务详情', { 任务: 'root-1' }),
    commandInteraction('任务搜索', { 关键词: '门店' }),
    commandInteraction('继续任务', { 任务: 'root-1' }),
    commandInteraction('继续队列'),
    commandInteraction('额度'),
    commandInteraction('系统状态'),
    commandInteraction('系统测试'),
    commandInteraction('帮助'),
    commandInteraction('任务搜索', { 关键词: '   ' }),
  ];
  const { dependencies, responses } = makeDependencies();
  const router = createInteractionRouter(dependencies);

  for (const interaction of invocations) await router.handle(interaction);

  assert.equal(responses.length, invocations.length);
  for (const response of responses) {
    assert.equal([4, 5, 9].includes(response.type), true);
    if (response.type !== 9) {
      assert.equal(response.data.flags & 64, 64);
      assert.deepEqual(response.data.allowed_mentions, { parse: [] });
    }
  }
});

test('system test defaults to quick mode and never invokes full outbound probes', async () => {
  let quickCalls = 0;
  let fullCalls = 0;
  const { dependencies, responses, edits } = makeDependencies({
    runQuickHealthChecks: async () => {
      quickCalls += 1;
      return [{ key: 'gateway', label: 'Gateway', ok: true, latencyMs: 7, detail: '在线' }];
    },
    runFullHealthChecks: async () => { fullCalls += 1; return []; },
  });

  await createInteractionRouter(dependencies).handle(commandInteraction('系统测试'));

  assert.equal(quickCalls, 1);
  assert.equal(fullCalls, 0);
  assert.equal(responses[0].type, 5);
  assert.equal(responses[0].data.flags & 64, 64);
  assert.match(edits[0].content, /快速系统测试/u);
  assert.match(edits[0].content, /Gateway/u);
});

test('full system test invokes all-probe orchestration and keeps the final report private', async () => {
  let fullCalls = 0;
  const { dependencies, responses, edits } = makeDependencies({
    runFullHealthChecks: async () => {
      fullCalls += 1;
      return [
        { key: 'task-probe', label: '任务通知', ok: true, latencyMs: 11, detail: '已发送' },
        { key: 'confirmation-probe', label: '确认通知', ok: false, latencyMs: 12, detail: '发送失败' },
        { key: 'quota-probe', label: '额度通知', ok: true, latencyMs: 13, detail: '已发送' },
      ];
    },
  });

  await createInteractionRouter(dependencies).handle(commandInteraction('系统测试', { 类型: '完整' }));

  assert.equal(fullCalls, 1);
  assert.equal(responses[0].type, 5);
  assert.deepEqual(responses[0].data.allowed_mentions, { parse: [] });
  assert.match(edits[0].content, /完整系统测试/u);
  assert.match(edits[0].content, /确认通知.*失败/u);
  assert.deepEqual(edits[0].allowed_mentions, { parse: [] });
});

test('task list uses an embed-safe body even when indexed display names are oversized', async () => {
  const huge = '超长名称'.repeat(1_000);
  const { dependencies, responses } = makeDependencies({
    taskIndex: { tasks: Array.from({ length: 10 }, (_, index) => task(index, { projectName: huge, taskName: huge })) },
  });
  const router = createInteractionRouter(dependencies);

  await router.handle(commandInteraction('任务列表'));

  assert.equal(responses[0].data.content, undefined);
  assert.equal(responses[0].data.embeds[0].description.length <= 3_800, true);
});

test('search result renderer bounds untrusted query and display names for an embed', () => {
  const huge = '超长'.repeat(5_000);
  const rendered = renderSearchResults(
    Array.from({ length: 10 }, (_, index) => task(index, { projectName: huge, taskName: huge })),
    huge,
  );
  assert.equal(rendered.length <= 3_800, true);
});

test('list, search, receipts, and detail metadata cannot inject structural Markdown or new lines', async () => {
  const hostile = task(1, {
    projectName: 'Project\n# injected **bold**',
    taskName: 'Task\n```js\nsecret',
    status: 'running\n> quote',
    contentAvailable: true,
    taskText: '# full task Markdown\n```js\nconst ok = true;\n```',
    resultText: '**full result Markdown**',
  });
  const rendered = renderSearchResults([hostile], 'query\n# heading');
  assert.equal(rendered.includes('\n# injected'), false);
  assert.equal(rendered.includes('\n```js'), false);
  assert.equal(rendered.includes('**bold**'), false);
  const list = renderTaskList([hostile]);
  assert.equal(list.includes('\n# injected'), false);
  assert.equal(list.includes('\n```js'), false);
  assert.equal(list.includes('**bold**'), false);
  const detail = renderTaskDetail(hostile);
  assert.match(detail, /# full task Markdown\n```js\nconst ok = true;/);
  assert.match(detail, /\*\*full result Markdown\*\*/);
  assert.equal(detail.includes('\n# injected'), false);

  const huge = 'X\n# injected **bold**'.repeat(1_000);
  const { dependencies, responses, edits } = makeDependencies({
    projects: [{ id: 'project-1', name: huge, roots: ['C:\\saved\\POS'] }],
    createNewTaskOnce: async () => ({
      status: 'started', threadId: 'created-12345678', taskName: huge,
      workspace: { mode: 'worktree', worktreePath: `C:\\safe\\${huge}`, branchName: 'codex/discord-test' },
    }),
  });
  const router = createInteractionRouter(dependencies);
  await router.handle(commandInteraction('新建任务', { 项目: 'project-1' }));
  await router.handle(modalSubmit(responses.shift().data.custom_id, 'create'));
  assert.equal(edits[0].content.length <= 2_000, true);
  assert.equal(edits[0].content.includes('\n# injected'), false);
  assert.equal(edits[0].content.includes('**bold**'), false);
});

test('Discord REST client posts callbacks and private follow-ups and patches the original route', async () => {
  const calls = [];
  const client = createInteractionRestClient({
    applicationId: '111',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response('{}', { status: 200 });
    },
  });
  const interaction = { id: 'interaction/1', token: 'token/value' };

  await client.callback(interaction, { type: 5, data: { flags: 64, allowed_mentions: { parse: [] } } });
  await client.editOriginal(interaction, { content: 'edited @everyone' });
  await client.followup(interaction, { content: 'follow-up @everyone' });

  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ['https://discord.com/api/v10/interactions/interaction%2F1/token%2Fvalue/callback', 'POST'],
    ['https://discord.com/api/v10/webhooks/111/token%2Fvalue/messages/@original', 'PATCH'],
    ['https://discord.com/api/v10/webhooks/111/token%2Fvalue?wait=true', 'POST'],
  ]);
  const callback = JSON.parse(calls[0].options.body);
  const edit = JSON.parse(calls[1].options.body);
  const followup = JSON.parse(calls[2].options.body);
  assert.equal(callback.data.flags & 64, 64);
  assert.equal(followup.flags & 64, 64);
  assert.equal(Object.hasOwn(edit, 'flags'), false);
  for (const payload of [callback.data, edit, followup]) assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test('Discord REST retries 429s within distinct callback and webhook budgets', async () => {
  let clock = 1_000;
  const sleeps = [];
  const responses = [
    new Response(JSON.stringify({ retry_after: 0.25 }), { status: 429, headers: { 'Content-Type': 'application/json' } }),
    new Response(null, { status: 204 }),
    new Response('', { status: 429, headers: { 'Retry-After': '1.5' } }),
    new Response('{}', { status: 200 }),
  ];
  const client = createInteractionRestClient({
    applicationId: '111',
    now: () => clock,
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
    fetchImpl: async () => responses.shift(),
  });
  const interaction = { id: '1', token: 'token-must-not-leak' };

  await client.callback(interaction, { type: 5, data: {} });
  await client.editOriginal(interaction, { content: 'done' });

  assert.deepEqual(sleeps, [250, 1_500]);
  assert.equal(responses.length, 0);
});

test('callback 429 retry never exceeds the acknowledgement deadline and failures are sanitized', async () => {
  let calls = 0;
  const client = createInteractionRestClient({
    applicationId: '111',
    now: () => 10_000,
    sleepImpl: async () => { throw new Error('must not sleep'); },
    fetchImpl: async () => {
      calls += 1;
      return new Response('token-must-not-leak C:\\private', {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '999' },
      });
    },
  });
  await assert.rejects(
    () => client.callback({ id: '1', token: 'token-must-not-leak' }, { type: 4, data: { content: 'x' } }),
    (error) => error.message === 'Discord interaction request failed: 429'
      && !/token|private/iu.test(error.message),
  );
  assert.equal(calls, 1);
});

test('callback retry budget includes slow retry_after response parsing', async () => {
  let clock = 0;
  let calls = 0;
  const sleeps = [];
  const client = createInteractionRestClient({
    applicationId: '111',
    now: () => clock,
    callbackRetry: { maxElapsedMs: 2_800 },
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        headers: new Headers(),
        async json() {
          clock = 2_400;
          return { retry_after: 0.5 };
        },
      };
    },
  });

  await assert.rejects(
    () => client.callback({ id: '1', token: 'parse-secret' }, { type: 5, data: {} }),
    /Discord interaction request failed: 429/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test('callback rejects a successful JSON response completed beyond the elapsed budget', async () => {
  let clock = 0;
  let timerCleared = false;
  const client = createInteractionRestClient({
    applicationId: '111',
    now: () => clock,
    callbackRetry: { maxElapsedMs: 100 },
    setTimeoutImpl: () => 'blocked-timer',
    clearTimeoutImpl: (timer) => { assert.equal(timer, 'blocked-timer'); timerCleared = true; },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      async json() {
        clock = 101;
        return { token: 'success-parse-secret' };
      },
    }),
  });

  await assert.rejects(
    () => client.callback({ id: '1', token: 'success-parse-secret' }, { type: 5, data: {} }),
    (error) => error.message === 'Discord interaction request failed: timeout'
      && !error.message.includes('success-parse-secret'),
  );
  assert.equal(timerCleared, true);
});

test('a zero elapsed budget still accepts an immediate synchronous success', async () => {
  const client = createInteractionRestClient({
    applicationId: '111',
    now: () => 0,
    callbackRetry: { maxElapsedMs: 0 },
    setTimeoutImpl: () => 'blocked-timer',
    clearTimeoutImpl: () => {},
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  assert.deepEqual(
    await client.callback({ id: '1', token: 'zero-success' }, { type: 5, data: {} }),
    { ok: true },
  );
});

test('callback rechecks elapsed time after an oversleep before sending a retry', async () => {
  let clock = 0;
  let calls = 0;
  const sleeps = [];
  const client = createInteractionRestClient({
    applicationId: '111',
    now: () => clock,
    callbackRetry: { maxElapsedMs: 500 },
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); clock = 600; },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ retry_after: 0.25 }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await assert.rejects(
    () => client.callback({ id: '1', token: 'sleep-secret' }, { type: 5, data: {} }),
    /Discord interaction request failed: 429/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, [250]);
});

test('an explicit zero elapsed budget sends the initial request but disables every retry', async () => {
  let calls = 0;
  let parseCalls = 0;
  let timerCalls = 0;
  const sleeps = [];
  const client = createInteractionRestClient({
    applicationId: '111',
    callbackRetry: { maxElapsedMs: 0 },
    setTimeoutImpl: (callback, milliseconds) => {
      timerCalls += 1;
      return setTimeout(callback, milliseconds);
    },
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        async json() {
          parseCalls += 1;
          return { retry_after: 0 };
        },
      };
    },
  });

  await assert.rejects(
    () => client.callback({ id: '1', token: 'zero-secret' }, { type: 5, data: {} }),
    /Discord interaction request failed: 429/,
  );
  assert.equal(calls, 1);
  assert.equal(parseCalls, 0);
  assert.equal(timerCalls, 0);
  assert.deepEqual(sleeps, []);
});

test('a hanging abort-aware fetch is bounded, clears its timer, and reports only timeout', async () => {
  const activeTimers = new Set();
  let clearCalls = 0;
  const setTimeoutImpl = (callback, milliseconds) => {
    const timer = setTimeout(() => {
      activeTimers.delete(timer);
      callback();
    }, milliseconds);
    activeTimers.add(timer);
    return timer;
  };
  const clearTimeoutImpl = (timer) => {
    clearCalls += 1;
    activeTimers.delete(timer);
    clearTimeout(timer);
  };
  let receivedSignal;
  const client = createInteractionRestClient({
    applicationId: '111',
    callbackRetry: { maxElapsedMs: 20 },
    setTimeoutImpl,
    clearTimeoutImpl,
    fetchImpl: async (url, options) => {
      receivedSignal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(new Error(`aborted ${url} token-hang-secret`));
        }, { once: true });
      });
    },
  });

  await assert.rejects(
    () => client.callback({ id: 'hang-id', token: 'token-hang-secret' }, { type: 5, data: {} }),
    (error) => error.message === 'Discord interaction request failed: timeout'
      && !/hang-id|token-hang-secret/iu.test(error.message),
  );
  assert.equal(receivedSignal instanceof AbortSignal, true);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(activeTimers.size, 0);
  assert.equal(clearCalls, 1);
});

test('webhook 429 retries are attempt-bounded and accept HTTP-date Retry-After', async () => {
  let clock = Date.parse('2026-09-01T00:00:00Z');
  const sleeps = [];
  let calls = 0;
  const client = createInteractionRestClient({
    applicationId: '111',
    now: () => clock,
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
    fetchImpl: async () => {
      calls += 1;
      return new Response('', { status: 429, headers: { 'Retry-After': new Date(clock + 1_000).toUTCString() } });
    },
  });
  await assert.rejects(
    () => client.followup({ token: 'secret' }, { content: 'x' }),
    /Discord interaction request failed: 429/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1_000, 1_000]);
});

test('Discord REST errors expose only a sanitized category', async () => {
  const client = createInteractionRestClient({
    applicationId: '111',
    fetchImpl: async () => new Response('Token secret-token C:\\private\\path', { status: 403 }),
  });
  await assert.rejects(
    () => client.editOriginal({ id: '1', token: 'secret-token' }, { content: 'x' }),
    (error) => error.message === 'Discord interaction request failed: 403' && !error.message.includes('secret-token'),
  );
});

test('deferred query failures are edited into private sanitized errors', async () => {
  for (const [command, options, override] of [
    ['任务详情', { 任务: 'root-1' }, { readTaskDetail: async () => { throw new Error('Token detail-secret C:\\private\\detail'); } }],
    ['任务搜索', { 关键词: '门店' }, { searchTasks: async () => { throw new Error('Token search-secret C:\\private\\search'); } }],
    ['额度', {}, { getQuotaState: async () => { throw new Error('Token quota-secret C:\\private\\quota'); } }],
  ]) {
    const { dependencies, responses, edits } = makeDependencies(override);
    const router = createInteractionRouter(dependencies);

    await router.handle(commandInteraction(command, options));

    assert.equal(responses[0].type, 5);
    assert.equal(Object.hasOwn(edits[0], 'flags'), false);
    assert.deepEqual(edits[0].allowed_mentions, { parse: [] });
    assert.match(edits[0].content, /失败|不可用|稍后/);
    assert.equal(/secret|private|Token/u.test(edits[0].content), false);
  }
});

test('pagination honors the limit and balances fenced code blocks on every page', () => {
  const source = `intro @everyone\n\n\`\`\`js\n${'const value = 1; // long line\n'.repeat(100)}\`\`\`\noutro`;
  const pages = paginateMarkdown(source, 180);
  assert.equal(pages.length > 2, true);
  assert.equal(pages.every((page) => page.length <= 180), true);
  assert.equal(pages.every((page) => (page.match(/```/g) ?? []).length % 2 === 0), true);
  assert.match(pages.join('\n'), /@everyone/);
});

test('pagination keeps its hard limit for an oversized fenced-code info string', () => {
  const pages = paginateMarkdown(`\`\`\`${'language'.repeat(30)}\nvalue\n\`\`\``, 80);
  assert.equal(pages.every((page) => page.length <= 80), true);
  assert.equal(pages.every((page) => (page.match(/```/g) ?? []).length % 2 === 0), true);
});

test('new-task modal uses a random 96-bit state id and stores no token or path', async () => {
  const uiState = new Map();
  const { dependencies, responses } = makeDependencies({ uiState });
  const router = createInteractionRouter(dependencies);

  await router.handle(commandInteraction('新建任务', { 项目: 'project-1' }));

  const modal = responses[0];
  assert.equal(modal.type, 9);
  assert.equal(modal.data.components[0].components[0].style, 2);
  assert.equal(modal.data.components[0].components[0].min_length, 1);
  assert.equal(modal.data.components[0].components[0].max_length, 4000);
  const [, stateId] = modal.data.custom_id.split(':');
  assert.equal(Buffer.from(stateId, 'base64url').length, 12);
  assert.equal(uiState.size, 1);
  const serialized = JSON.stringify([...uiState.values()]);
  assert.equal(serialized.includes('interaction-token'), false);
  assert.equal(serialized.includes('C:\\saved\\POS'), false);
  assert.equal(serialized.includes('roots'), false);
  assert.equal([...uiState.values()][0].expiresAt, NOW + 15 * 60_000);
});

test('continue-task modal stores only authorized root identity and uses the required multiline input', async () => {
  const uiState = new Map();
  const { dependencies, responses } = makeDependencies({ uiState });

  await createInteractionRouter(dependencies).handle(commandInteraction('继续任务', { 任务: 'root-1' }));

  const modal = responses[0];
  assert.equal(modal.type, 9);
  assert.match(modal.data.custom_id, /^continue:[A-Za-z0-9_-]{16}$/u);
  const input = modal.data.components[0].components[0];
  assert.equal(input.custom_id, '继续内容');
  assert.equal(input.label, '继续内容');
  assert.equal(input.style, 2);
  assert.equal(input.min_length, 1);
  assert.equal(input.max_length, 4_000);
  const stored = [...uiState.values()][0];
  assert.deepEqual(Object.keys(stored).sort(), ['expiresAt', 'guildId', 'kind', 'threadId', 'userId']);
  assert.equal(stored.threadId, 'root-1');
  assert.equal(JSON.stringify(stored).includes('interaction-token'), false);
  assert.equal(JSON.stringify(stored).includes('rollout-1'), false);
});

test('continue modal defers, revalidates the root task, and duplicate delivery dispatches once', async () => {
  const events = [];
  const requests = [];
  const { dependencies, responses, edits } = makeDependencies({
    respond: async (body) => { events.push(`respond-${body.type}`); responses.push(body); },
    editOriginal: async (body) => { events.push('edit'); edits.push(body); },
    dispatchContinuation: async (request) => {
      events.push('dispatch');
      requests.push(request);
      return { status: 'queued', queueId: 'queue-12345678' };
    },
  });
  const router = createInteractionRouter(dependencies);
  await router.handle(commandInteraction('继续任务', { 任务: 'root-1' }));
  const customId = responses.shift().data.custom_id;
  events.length = 0;

  await Promise.all([
    router.handle(modalSubmit(customId, '重新检查一次', { fieldId: '继续内容', id: 'continue-submit-1' })),
    router.handle(modalSubmit(customId, '重新检查一次', { fieldId: '继续内容', id: 'continue-submit-redelivery' })),
  ]);

  assert.equal(events[0], 'respond-5');
  assert.equal(events.indexOf('dispatch') > events.lastIndexOf('respond-5'), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].source, 'slash');
  assert.equal(requests[0].requestId, 'continue-submit-1');
  assert.equal(requests[0].threadId, 'root-1');
  assert.equal(requests[0].text, '重新检查一次');
  assert.equal(Object.hasOwn(requests[0], 'interactionToken'), false);
  assert.match(edits[0].content, /已排队/);
  assert.match(edits[0].content, /12345678/);
});

test('continue command and modal reject unknown roots and blank text without dispatching', async () => {
  let dispatched = false;
  const { dependencies, responses } = makeDependencies({
    dispatchContinuation: async () => { dispatched = true; return { status: 'started' }; },
  });
  const router = createInteractionRouter(dependencies);

  await router.handle(commandInteraction('继续任务', { 任务: 'subagent-or-unknown' }));
  assert.match(responses.shift().data.content, /不存在|主任务/);

  await router.handle(commandInteraction('继续任务', { 任务: 'root-1' }));
  const customId = responses.shift().data.custom_id;
  await router.handle(modalSubmit(customId, '   ', { fieldId: '继续内容' }));
  assert.match(responses.shift().data.content, /1.?4000|不能为空/);
  assert.equal(dispatched, false);

  dependencies.taskIndex.tasks = [];
  await router.handle(modalSubmit(customId, '不能续接', { fieldId: '继续内容', id: 'removed-root' }));
  assert.equal(responses.shift().type, 5);
  assert.equal(dispatched, false);
});

test('continue UI reports an uncertain external start without claiming failure', async () => {
  const { dependencies, responses, edits } = makeDependencies({
    dispatchContinuation: async () => ({
      status: 'uncertain', queueId: 'queue-uncertain', reason: 'start-outcome-uncertain',
    }),
  });
  const router = createInteractionRouter(dependencies);
  await router.handle(commandInteraction('继续任务', { 任务: 'root-1' }));
  const modalId = responses.shift().data.custom_id;
  await router.handle(modalSubmit(modalId, 'continue', { fieldId: '继续内容', id: 'uncertain-submit' }));
  assert.equal(responses.shift().type, 5);
  assert.match(edits.shift().content, /启动结果不确定|请确认原任务/);

  const rendered = renderContinuationQueue([{
    queueId: 'queue-uncertain', source: 'reply', threadId: 'root-1', summary: 'continue',
    status: 'start-uncertain', createdAt: '2026-09-01T00:00:00Z',
  }]);
  assert.match(rendered, /启动结果不确定/);
  assert.equal(rendered.includes('状态：失败'), false);
});

test('continue queue renders safe summaries and atomically cancels then refreshes', async () => {
  const queue = [{
    queueId: 'queue-abcdef12345678',
    source: 'slash',
    threadId: 'root-1',
    summary: '@everyone\n' + '很长'.repeat(100),
    createdAt: '2026-09-01T00:00:00.000Z',
    lastAttemptAt: '2026-09-01T00:01:00.000Z',
    status: 'queued',
  }];
  const events = [];
  const { dependencies, responses, edits } = makeDependencies({
    getQueue: () => queue,
    cancelContinuationPersisted: async (_queueId, now) => {
      events.push(`cancel:${now}`);
      queue[0].status = 'cancelled';
      events.push('persist');
      return { status: 'cancelled' };
    },
  });
  const router = createInteractionRouter(dependencies);

  await router.handle(commandInteraction('继续队列'));

  const initial = responses.shift();
  assert.equal(initial.type, 4);
  assert.match(initial.data.embeds[0].description, /Slash 命令/);
  assert.match(initial.data.embeds[0].description, /12345678/);
  assert.equal(initial.data.embeds[0].description.includes('@everyone'), false);
  assert.equal(initial.data.embeds[0].description.length < 1_000, true);
  const cancelId = initial.data.components[0].components[0].custom_id;
  assert.match(cancelId, /^cancel:[A-Za-z0-9_-]{16}$/u);

  await router.handle(componentInteraction(cancelId));

  assert.deepEqual(events.map((item) => item.startsWith('cancel:') ? 'cancel' : item), ['cancel', 'persist']);
  assert.equal(responses.shift().type, 5);
  const refreshed = edits.shift();
  assert.match(refreshed.embeds[0].description, /已取消/);
  assert.equal(refreshed.components.length, 0);
});

test('cancel refuses to mutate through the legacy split update path', async () => {
  const queue = [{
    queueId: 'queue-unsafe-cancel', source: 'slash', threadId: 'root-1',
    summary: 'cancel me', status: 'queued', createdAt: '2026-09-01T00:00:00.000Z',
  }];
  let mutated = false;
  const { dependencies, responses, edits } = makeDependencies({
    getQueue: () => queue,
    cancelContinuationPersisted: undefined,
    cancelContinuation: () => { mutated = true; queue[0].status = 'cancelled'; return { status: 'cancelled' }; },
    persistContinuationState: async () => {},
  });
  const router = createInteractionRouter(dependencies);
  await router.handle(commandInteraction('继续队列'));
  const cancelId = responses.shift().data.components[0].components[0].custom_id;

  await router.handle(componentInteraction(cancelId));

  assert.equal(mutated, false);
  assert.equal(queue[0].status, 'queued');
  assert.equal(responses.shift().type, 5);
  const error = edits.shift();
  assert.match(error.content, /取消失败|稍后重试/);
});

test('cancel persistence failure restores state and returns only a sanitized ephemeral error', async () => {
  const continuationState = createEmptyInboxState();
  enqueueContinuation(continuationState, {
    ...createContinuationRequest({ source: 'slash', requestId: 'cancel-error', threadId: 'root-1', text: 'cancel me' }),
    encryptedText: 'opaque-ciphertext',
  });
  const before = structuredClone(continuationState);
  const { dependencies, responses, edits } = makeDependencies({
    continuationState,
    getQueue: () => listContinuations(continuationState),
    cancelContinuationPersisted: (queueId, now) => cancelContinuationPersisted({
      state: continuationState,
      queueId,
      now,
      persistState: async () => { throw new Error('C:\\private-user\\discord-inbox-state.json'); },
    }),
  });
  const router = createInteractionRouter(dependencies);
  await router.handle(commandInteraction('继续队列'));
  const cancelId = responses.shift().data.components[0].components[0].custom_id;

  await router.handle(componentInteraction(cancelId));

  assert.deepEqual(continuationState, before);
  assert.equal(responses.shift().type, 5);
  const error = edits.shift();
  assert.match(error.content, /取消失败|稍后重试/);
  assert.equal(error.content.includes('private-user'), false);
  assert.equal(error.content.includes('discord-inbox-state'), false);
});

test('queue body and cancel buttons use the same queued-first displayed collection', async () => {
  const queue = [
    ...Array.from({ length: 20 }, (_, index) => ({
      queueId: `terminal-${String(index).padStart(8, '0')}`, source: 'slash', threadId: 'root-1',
      summary: `terminal ${index}`, status: 'delivered', createdAt: '2026-09-01T00:00:00Z',
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      queueId: `queued-${String(index).padStart(8, '0')}`, source: 'slash', threadId: 'root-1',
      summary: `queued ${index}`, status: 'queued', createdAt: '2026-09-01T01:00:00Z',
    })),
  ];
  const uiState = new Map();
  const { dependencies, responses } = makeDependencies({ uiState, getQueue: () => queue });

  await createInteractionRouter(dependencies).handle(commandInteraction('继续队列'));

  const payload = responses[0].data;
  const description = payload.embeds[0].description;
  const cancelStates = [...uiState.values()].filter((state) => state.kind === 'cancel-continuation');
  assert.equal(cancelStates.length, 3);
  for (const state of cancelStates) assert.equal(description.includes(state.queueId.slice(-8)), true);
  assert.match(description, /另有 3 项未显示/);
});

test('continue queue truncation prioritizes every active and uncertain state over terminal history', async () => {
  const queue = [
    ...Array.from({ length: 20 }, (_, index) => ({
      queueId: `terminal-${String(index).padStart(8, '0')}`, source: 'slash', threadId: 'root-1',
      summary: `terminal ${index}`, status: 'delivered', createdAt: '2026-09-01T00:00:00Z',
    })),
    {
      queueId: 'risk-uncertain99', source: 'reply', threadId: 'root-1', summary: 'uncertain',
      status: 'start-uncertain', createdAt: '2026-09-01T01:00:00Z',
    },
    {
      queueId: 'live-attempting88', source: 'slash', threadId: 'root-1', summary: 'attempting',
      status: 'attempting', createdAt: '2026-09-01T01:01:00Z',
    },
    {
      queueId: 'live-queued7777', source: 'slash', threadId: 'root-1', summary: 'queued',
      status: 'queued', createdAt: '2026-09-01T01:02:00Z',
    },
  ];
  const uiState = new Map();
  const { dependencies, responses } = makeDependencies({ uiState, getQueue: () => queue });

  await createInteractionRouter(dependencies).handle(commandInteraction('继续队列'));

  const payload = responses[0].data;
  const description = payload.embeds[0].description;
  assert.equal(description.includes('risk-uncertain99'.slice(-8)), true);
  assert.match(description, /启动结果不确定/);
  assert.equal(description.includes('live-attempting88'.slice(-8)), true);
  assert.match(description, /正在尝试/);
  assert.equal(description.includes('live-queued7777'.slice(-8)), true);
  assert.match(description, /另有 3 项未显示/);
  const cancelStates = [...uiState.values()].filter((state) => state.kind === 'cancel-continuation');
  assert.deepEqual(cancelStates.map((state) => state.queueId), ['live-queued7777']);
  assert.equal(description.includes(cancelStates[0].queueId.slice(-8)), true);
});

test('queue truncation shows one uncertain start ahead of twenty ordinary queued requests', () => {
  const queue = [
    ...Array.from({ length: 20 }, (_, index) => ({
      queueId: `queued-risk-${String(index).padStart(8, '0')}`, source: 'slash', threadId: 'root-1',
      summary: `queued ${index}`, status: 'queued', createdAt: `2026-09-01T00:${String(index).padStart(2, '0')}:00Z`,
    })),
    {
      queueId: 'uncertain-priority-9999', source: 'reply', threadId: 'root-1',
      summary: 'must be visible', status: 'start-uncertain', createdAt: '2026-09-01T01:00:00Z',
    },
  ];
  const rendered = renderContinuationQueue(queue);
  assert.match(rendered, /must be visible/);
  assert.match(rendered, /启动结果不确定/);
  assert.match(rendered, /另有 1 项未显示/);
});

test('cancel component defers before persistence and edits the original response', async () => {
  const queue = [{
    queueId: 'queue-defer-cancel', source: 'slash', threadId: 'root-1', summary: 'cancel',
    status: 'queued', createdAt: '2026-09-01T00:00:00Z',
  }];
  const events = [];
  const { dependencies, responses, edits } = makeDependencies({
    getQueue: () => queue,
    respond: async (body) => { events.push(`respond:${body.type}`); responses.push(body); },
    editOriginal: async (body) => { events.push('edit'); edits.push(body); },
    cancelContinuationPersisted: async () => {
      events.push('cancel');
      queue[0].status = 'cancelled';
      return { status: 'cancelled' };
    },
  });
  const router = createInteractionRouter(dependencies);
  await router.handle(commandInteraction('继续队列'));
  const cancelId = responses.shift().data.components[0].components[0].custom_id;
  events.length = 0;
  await router.handle(componentInteraction(cancelId));
  assert.deepEqual(events, ['respond:5', 'cancel', 'edit']);
  assert.match(edits[0].embeds[0].description, /已取消/);
});

test('continuation queue renderer labels reply sources and omits full unsafe text', () => {
  const rendered = renderContinuationQueue([{
    queueId: 'queue-0000feedface', source: 'reply', threadId: 'root-9', projectName: 'POS', taskName: '支付',
    summary: '# heading\n' + '内容'.repeat(100), createdAt: '2026-09-01T00:00:00Z', status: 'queued',
  }]);
  assert.match(rendered, /通知回复/);
  assert.match(rendered, /feedface/);
  assert.equal(rendered.includes('# heading'), false);
  assert.equal(rendered.length < 1_000, true);
});

test('continuation queue renderer does not mark a short summary as truncated', () => {
  const rendered = renderContinuationQueue([{
    queueId: 'queue-short123', source: 'slash', threadId: 'root-1', summary: '短摘要', status: 'queued',
  }]);
  assert.match(rendered, /内容：短摘要\n/);
  assert.equal(rendered.includes('短摘…'), false);
});

test('continuation queue renderer stays within the Discord embed description limit', () => {
  const rendered = renderContinuationQueue(Array.from({ length: 20 }, (_, index) => ({
    queueId: `queue-${String(index).padStart(8, '0')}`,
    source: index % 2 ? 'reply' : 'slash',
    threadId: `root-${index}`,
    projectName: '项目'.repeat(80),
    taskName: '任务'.repeat(80),
    summary: '摘要'.repeat(80),
    createdAt: '2026-09-01T00:00:00Z',
    lastAttemptAt: '2026-09-01T00:01:00Z',
    status: 'queued',
  })));
  assert.equal(rendered.length <= 3_800, true);
});

test('initial new-task modal reads only the non-refreshing project snapshot', async () => {
  const calls = [];
  const { dependencies, responses } = makeDependencies({
    projectCatalog: {
      snapshotGetById(id) { calls.push(`snapshot:${id}`); return { id, name: 'Cached', roots: ['C:\\saved\\Cached'] }; },
      getById() { calls.push('refreshing-get'); throw new Error('must not run'); },
      refresh() { calls.push('refresh'); throw new Error('must not run'); },
    },
  });
  await createInteractionRouter(dependencies).handle(commandInteraction('新建任务', { 项目: 'project-1' }));
  assert.equal(responses[0].type, 9);
  assert.deepEqual(calls, ['snapshot:project-1']);
});

test('modal submission defers before authoritative refresh and creation, passes persistence, and inserts immediately', async () => {
  const events = [];
  let creationInput;
  const taskIndex = { generatedAt: new Date(NOW).toISOString(), tasks: [] };
  const { dependencies, responses, edits } = makeDependencies({
    events,
    taskIndex,
    respond: async (body) => { events.push(`respond-${body.type}`); responses.push(body); },
    editOriginal: async (body) => { events.push('edit'); edits.push(body); },
    createNewTaskOnce: async (input) => {
      events.push('create');
      creationInput = input;
      return {
        status: 'started',
        threadId: 'thread-created-1',
        turnId: 'turn-1',
        taskName: '生成中',
        workspace: {
          mode: 'worktree', cwd: 'C:\\Users\\private-user',
          worktreePath: 'C:\\Users\\private-user', branchName: 'codex/discord-test',
        },
      };
    },
  });
  const router = createInteractionRouter(dependencies);
  await router.handle(commandInteraction('新建任务', { 项目: 'project-1' }));
  const customId = responses.shift().data.custom_id;
  events.length = 0;

  await router.handle(modalSubmit(customId, '检查支付流程'));

  assert.deepEqual(events.slice(0, 3), ['respond-5', 'refresh', 'create']);
  assert.equal(typeof creationInput.persistState, 'function');
  assert.equal(creationInput.state, dependencies.creationState);
  assert.equal(creationInput.selection.projectId, 'project-1');
  assert.equal(creationInput.text, '检查支付流程');
  assert.equal(responses[0].type, 5);
  assert.equal(responses[0].data.flags & 64, 64);
  assert.deepEqual(responses[0].data.allowed_mentions, { parse: [] });
  assert.equal(Object.hasOwn(edits[0], 'flags'), false);
  assert.deepEqual(edits[0].allowed_mentions, { parse: [] });
  assert.equal(edits[0].content.includes('private-user'), false);
  assert.equal(taskIndex.tasks.length, 1);
  assert.equal(taskIndex.tasks[0].threadId, 'thread-created-1');
  assert.equal(taskIndex.tasks[0].worktreeBranch, 'codex/discord-test');
});

test('duplicate modal delivery creates and inserts exactly once', async () => {
  let createCount = 0;
  const taskIndex = { tasks: [] };
  const { dependencies, responses } = makeDependencies({
    taskIndex,
    createNewTaskOnce: async () => {
      createCount += 1;
      return { status: 'started', threadId: 'created-once', taskName: '生成中', workspace: { mode: 'local', cwd: 'C:\\safe\\POS' } };
    },
  });
  const router = createInteractionRouter(dependencies);
  await router.handle(commandInteraction('新建任务', { 项目: 'project-1' }));
  const customId = responses.shift().data.custom_id;
  const submit = modalSubmit(customId, '只创建一次');

  await Promise.all([
    router.handle(submit),
    router.handle(modalSubmit(customId, '只创建一次', { id: 'modal-submit-redelivery' })),
  ]);

  await router.handle(modalSubmit(customId, '只创建一次', { id: 'modal-submit-late-redelivery' }));

  assert.equal(createCount, 1);
  assert.equal(taskIndex.tasks.length, 1);
});

test('modal reauthorization and authoritative project deletion or change reject creation after defer', async () => {
  for (const mode of ['deleted', 'changed']) {
    let created = false;
    const projects = [{ id: 'project-1', name: 'POS', roots: ['C:\\saved\\POS'] }];
    const catalog = projectCatalog(projects);
    catalog.refresh = async () => mode === 'deleted'
      ? []
      : [{ id: 'project-1', name: 'POS', roots: ['C:\\saved\\Changed'] }];
    const { dependencies, responses, edits } = makeDependencies({
      projects,
      projectCatalog: catalog,
      createNewTaskOnce: async () => { created = true; throw new Error('must not create'); },
    });
    const router = createInteractionRouter(dependencies);
    await router.handle(commandInteraction('新建任务', { 项目: 'project-1' }));
    const customId = responses.shift().data.custom_id;

    await router.handle(modalSubmit(customId, '不得创建'));

    assert.equal(responses[0].type, 5);
    assert.equal(created, false);
    assert.match(edits[0].content, /项目.*变化|项目.*删除|重新执行/);
    assert.equal(Object.hasOwn(edits[0], 'flags'), false);
  }

  const { dependencies, responses } = makeDependencies();
  const router = createInteractionRouter(dependencies);
  await router.handle(commandInteraction('新建任务', { 项目: 'project-1' }));
  const customId = responses.shift().data.custom_id;
  dependencies.config.discordAllowedUserId = '444';
  await router.handle(modalSubmit(customId, '跨用户不得提交', { userId: '444' }));
  assert.match(responses[0].data.content, /无权|不可用/);
  assert.equal(responses[0].data.flags & 64, 64);
});

test('first-turn failure receipt retains the task id and workspace without claiming success', async () => {
  const { dependencies, responses, edits } = makeDependencies({
    createNewTaskOnce: async () => ({
      status: 'first-turn-failed',
      threadId: 'retained-thread-12345678',
      taskName: '生成中',
      workspace: { mode: 'worktree', cwd: 'C:\\safe\\worktrees\\retained' },
    }),
  });
  const router = createInteractionRouter(dependencies);
  await router.handle(commandInteraction('新建任务', { 项目: 'project-1' }));
  const customId = responses.shift().data.custom_id;

  await router.handle(modalSubmit(customId, '首轮失败'));

  assert.match(edits[0].content, /首轮.*失败/);
  assert.match(edits[0].content, /12345678/);
  assert.equal(edits[0].content.includes('创建成功'), false);
});

test('task detail reports no result explicitly', () => {
  const markdown = renderTaskDetail({
    ...task(1), contentAvailable: true, taskText: '仍在运行', resultText: '', markdown: '',
  });
  assert.match(markdown, /暂无结果/);
});

test('detail pagination buttons use random state and reject random, expired, and cross-user clicks', async () => {
  const uiState = new Map();
  const longResult = `\`\`\`js\n${'const value = 1;\n'.repeat(400)}\`\`\``;
  const { dependencies, responses, edits } = makeDependencies({
    uiState,
    readTaskDetail: async (record) => ({ ...record, contentAvailable: true, taskText: '长任务', resultText: longResult }),
  });
  const router = createInteractionRouter(dependencies);
  await router.handle(commandInteraction('任务详情', { 任务: 'root-1' }));
  assert.equal(responses.shift().type, 5);
  const first = edits.shift();
  const nextId = first.components[0].components.find((button) => button.label === '下一页').custom_id;
  const [, stateId] = nextId.split(':');
  assert.equal(Buffer.from(stateId, 'base64url').length, 12);

  await router.handle(componentInteraction(nextId));
  const update = responses.shift();
  assert.equal(update.type, 7);
  assert.equal(Object.hasOwn(update.data, 'flags'), false);
  assert.deepEqual(update.data.allowed_mentions, { parse: [] });

  await router.handle(componentInteraction('page:AAAAAAAAAAAAAAAA:next'));
  assert.match(responses.shift().data.content, /过期|无效/);

  dependencies.config.discordAllowedUserId = '444';
  await router.handle(componentInteraction(nextId, { userId: '444' }));
  assert.match(responses.shift().data.content, /过期|无效|不属于/);

  dependencies.config.discordAllowedUserId = '333';
  dependencies.now = () => NOW + 15 * 60_000;
  await router.handle(componentInteraction(nextId));
  assert.match(responses.shift().data.content, /过期/);
});

test('task detail continue button is protected and opens the shared continuation modal route', async () => {
  const uiState = new Map();
  const requests = [];
  const { dependencies, responses, edits } = makeDependencies({
    uiState,
    dispatchContinuation: async (request) => { requests.push(request); return { status: 'started', turnId: 'turn-detail' }; },
  });
  const router = createInteractionRouter(dependencies);
  await router.handle(commandInteraction('任务详情', { 任务: 'root-1' }));
  assert.equal(responses.shift().type, 5);
  const detail = edits.shift();
  const continueButton = detail.components.flatMap((row) => row.components).find((button) => button.label === '继续任务');
  assert.ok(continueButton);
  const buttonStateId = continueButton.custom_id.split(':')[1];
  assert.deepEqual(Object.keys(uiState.get(buttonStateId)).sort(), ['expiresAt', 'guildId', 'kind', 'threadId', 'userId']);

  await router.handle(componentInteraction(continueButton.custom_id, { userId: '444' }));
  assert.match(responses.shift().data.content, /不属于|无权/);

  await router.handle(componentInteraction(continueButton.custom_id));
  const modal = responses.shift();
  assert.equal(modal.type, 9);
  assert.match(modal.data.custom_id, /^continue:[A-Za-z0-9_-]{16}$/u);
  await router.handle(modalSubmit(modal.data.custom_id, '从详情继续', { fieldId: '继续内容', id: 'detail-continue-submit' }));
  assert.equal(responses.shift().type, 5);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].threadId, 'root-1');
});

test('sweep removes UI state at the exact fifteen-minute boundary', async () => {
  const uiState = new Map();
  const { dependencies, responses } = makeDependencies({ uiState });
  const router = createInteractionRouter(dependencies);
  await router.handle(commandInteraction('新建任务', { 项目: 'project-1' }));
  assert.equal(uiState.size, 1);
  assert.equal(router.sweepExpiredUiState(NOW + 15 * 60_000), 1);
  assert.equal(uiState.size, 0);
  responses.length = 0;
});

test('quota renderer handles no snapshot, stale data, trends, reset, and both projections', () => {
  assert.match(renderQuota(null, { nowMs: NOW }), /暂无.*额度|没有.*快照/);
  const text = renderQuota({
    observedAt: new Date(NOW - 16 * 60_000).toISOString(),
    limits: [{
      windowMinutes: 10080,
      remainingPercent: 42,
      previousRemainingPercent: 45,
      lastChangeAt: new Date(NOW - 60 * 60_000).toISOString(),
      lastUsageRatePerHour: 3,
      previousUsageRatePerHour: 2,
      usedPercent: 58,
      resetsAt: Math.floor((NOW + 24 * 60 * 60_000) / 1000),
    }],
  }, { nowMs: NOW });
  assert.match(text, /45%.*42%/s);
  assert.match(text, /过期|陈旧/);
  assert.match(text, /更快/);
  assert.match(text, /距下次/);
  assert.match(text, /当前速度/);
  assert.match(text, /平均速度/);
  assert.match(text, /快照时间/);
});

test('quota renderer uses the persisted acceleration when no previous rate sample remains', () => {
  const text = renderQuota({
    observedAt: new Date(NOW).toISOString(),
    limits: [{
      windowMinutes: 10080,
      remainingPercent: 80,
      usedPercent: 20,
      lastUsageRatePerHour: 2,
      lastAccelerationPerHourSquared: 0.5,
      resetsAt: Math.floor((NOW + 48 * 60 * 60_000) / 1000),
    }],
  }, { nowMs: NOW });
  assert.match(text, /更快/);
});

test('/额度 renders the production quota snapshot without mutating or persisting it', async () => {
  const quota = {
    observedAt: new Date(NOW).toISOString(),
    limits: [{
      key: 'codex|primary|10080', windowMinutes: 10080,
      remainingPercent: 42, previousRemainingPercent: 45, usedPercent: 58,
      resetsAt: Math.floor((NOW + 24 * 60 * 60_000) / 1_000),
      lastUsageRatePerHour: 2,
    }],
  };
  const before = structuredClone(quota);
  let persistCalls = 0;
  const { dependencies, responses, edits } = makeDependencies({
    getQuotaState: async () => quota,
    persistQuotaState: async () => { persistCalls += 1; },
  });
  await createInteractionRouter(dependencies).handle(commandInteraction('额度'));
  assert.equal(responses[0].type, 5);
  assert.match(edits[0].content, /45%.*42%/s);
  assert.deepEqual(quota, before);
  assert.equal(persistCalls, 0);
});

test('system status exposes sanitized categories without paths, tokens, or user text', () => {
  const text = renderSystemStatus({
    gateway: { state: 'ready', lastError: 'Token abc C:\\Users\\private\\secret.txt' },
    discordRest: { state: 'ok' },
    notificationListener: { state: 'ok', lastSuccessAt: '2026-09-01T03:00:00Z' },
    rollout: { state: 'ok', lastProgressAt: '2026-09-01T03:30:00Z' },
    index: { generatedAt: '2026-09-01T03:45:00Z', count: 2 },
    queueCount: 1,
    quota: { observedAt: '2026-09-01T03:50:00Z' },
    timestamps: {
      lastRegistrationAt: '2026-09-01T03:01:00Z',
      lastIndexUpdateAt: '2026-09-01T03:02:00Z',
      lastGatewayEventAt: '2026-09-01T03:03:00Z',
      lastRolloutProgressAt: '2026-09-01T03:04:00Z',
      lastNotificationSentAt: '2026-09-01T03:05:00Z',
      lastTaskCreationAt: '2026-09-01T03:06:00Z',
      lastQueueRetryAt: '2026-09-01T03:07:00Z',
    },
    latestErrorCategory: 'gateway-timeout',
  });
  assert.match(text, /Gateway/);
  assert.match(text, /任务索引/);
  assert.match(text, /继续队列/);
  assert.match(text, /gateway-timeout/);
  assert.match(text, /命令注册.*03:01/s);
  assert.match(text, /任务创建.*03:06/s);
  assert.match(text, /队列重试.*03:07/s);
  assert.equal(text.includes('abc'), false);
  assert.equal(text.includes('private'), false);
  assert.equal(text.includes('secret.txt'), false);
});

test('system status uses a component sanitized error category when no aggregate is supplied', () => {
  const text = renderSystemStatus({ gateway: { state: 'reconnecting', lastError: 'heartbeat-timeout' } });
  assert.match(text, /heartbeat-timeout/);
});

test('help names all ten commands and explains workspace routing and offline limitation', () => {
  const help = renderHelp();
  for (const commandName of COMMAND_NAMES) assert.match(help, new RegExp(`/${commandName}`));
  assert.match(help, /工作树/);
  assert.match(help, /无项目/);
  assert.match(help, /电脑.*离线.*不可执行|离线.*命令.*不可执行/);
});
