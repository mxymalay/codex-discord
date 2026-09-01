import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMAND_NAMES } from '../discord-commands-lib.mjs';
import {
  createInteractionRestClient,
  createInteractionRouter,
  paginateMarkdown,
  renderHelp,
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
      components: [{ components: [{ custom_id: '任务内容', value: text }] }],
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
    getQueue: overrides.getQueue ?? (() => []),
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
    assert.equal([4, 5].includes(response.type), true);
    assert.equal(response.data.flags & 64, 64);
    assert.deepEqual(response.data.allowed_mentions, { parse: [] });
  }
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
    latestErrorCategory: 'gateway-timeout',
  });
  assert.match(text, /Gateway/);
  assert.match(text, /任务索引/);
  assert.match(text, /继续队列/);
  assert.match(text, /gateway-timeout/);
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
