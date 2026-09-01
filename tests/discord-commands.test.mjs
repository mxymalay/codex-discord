import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authorizeInteraction,
  buildGuildCommandDefinitions,
  ephemeral,
  registerGuildCommands,
} from '../discord-commands-lib.mjs';

test('defines exactly the approved ten Chinese guild commands', () => {
  const commands = buildGuildCommandDefinitions();
  assert.deepEqual(commands.map((item) => item.name), [
    '任务列表', '任务详情', '任务搜索', '新建任务', '继续任务', '继续队列', '额度', '系统状态', '系统测试', '帮助',
  ]);

  for (const command of commands) {
    assert.equal(command.type, 1);
    assert.equal(typeof command.description, 'string');
  }

  const list = commands.find((item) => item.name === '任务列表');
  assert.deepEqual(list.options[0], {
    type: 3,
    name: '状态',
    description: '按任务状态筛选',
    required: false,
    choices: [
      { name: '全部', value: '全部' },
      { name: '运行中', value: '运行中' },
      { name: '待确认', value: '待确认' },
      { name: '已完成', value: '已完成' },
      { name: '失败', value: '失败' },
    ],
  });

  const details = commands.find((item) => item.name === '任务详情');
  assert.deepEqual(details.options[0], {
    type: 3,
    name: '任务',
    description: '选择要查看的任务',
    required: true,
    autocomplete: true,
  });

  const search = commands.find((item) => item.name === '任务搜索');
  assert.deepEqual(search.options[0], {
    type: 3,
    name: '关键词',
    description: '搜索任务内容',
    required: true,
  });

  const create = commands.find((item) => item.name === '新建任务');
  assert.deepEqual(create.options[0], {
    type: 3,
    name: '项目',
    description: '选择保存的项目',
    required: true,
    autocomplete: true,
  });

  const resume = commands.find((item) => item.name === '继续任务');
  assert.deepEqual(resume.options[0], details.options[0]);

  const systemTest = commands.find((item) => item.name === '系统测试');
  assert.equal(systemTest.options[0].required, false);
  assert.deepEqual(systemTest.options[0].choices.map((item) => item.name), ['快速', '完整']);
});

test('registers commands with the guild PUT endpoint and sends definitions', async () => {
  const calls = [];
  const result = await registerGuildCommands({
    token: 'test-token', applicationId: '111', guildId: '222',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response('[]', { status: 200 });
    },
  });
  assert.deepEqual(result, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://discord.com/api/v10/applications/111/guilds/222/commands');
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].options.headers.Authorization, 'Bot test-token');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body).map((item) => item.name), [
    '任务列表', '任务详情', '任务搜索', '新建任务', '继续任务', '继续队列', '额度', '系统状态', '系统测试', '帮助',
  ]);
});

test('honors one guild registration retry after a rate limit', async () => {
  const calls = [];
  const result = await registerGuildCommands({
    token: 'test-token', applicationId: '111', guildId: '222',
    fetchImpl: async (_url, options) => {
      calls.push(options);
      if (calls.length === 1) return new Response(JSON.stringify({ message: 'slow down', retry_after: 0 }), { status: 429 });
      return new Response('[{"name":"任务列表"}]', { status: 200 });
    },
    sleepImpl: async (milliseconds) => assert.equal(milliseconds, 0),
  });
  assert.deepEqual(result, [{ name: '任务列表' }]);
  assert.equal(calls.length, 2);
});

test('sanitizes Discord registration failures', async () => {
  await assert.rejects(
    () => registerGuildCommands({
      token: 'super-secret-token', applicationId: '111', guildId: '222',
      fetchImpl: async () => new Response('forbidden', {
        status: 403,
        headers: { 'x-discord-error': 'Token super-secret-token leaked' },
      }),
    }),
    (error) => {
      assert.equal(error.message, 'Discord command registration failed: 403');
      assert.equal(error.message.includes('super-secret-token'), false);
      assert.equal(error.message.includes('x-discord-error'), false);
      return true;
    },
  );
});

test('requires both the configured guild and configured user', () => {
  const config = { discordGuildId: '222', discordAllowedUserId: '333' };
  assert.deepEqual(authorizeInteraction({ guild_id: '999', member: { user: { id: '333' } } }, config), {
    allowed: false, reason: 'wrong-guild',
  });
  assert.deepEqual(authorizeInteraction({ guild_id: '222', member: { user: { id: '999' } } }, config), {
    allowed: false, reason: 'wrong-user',
  });
  assert.deepEqual(authorizeInteraction({ guild_id: '222', member: { user: { id: '333' } } }, config), {
    allowed: true, reason: 'authorized',
  });
});

test('supports direct user interactions and private mention-safe responses', async () => {
  const config = { discordGuildId: '222', discordAllowedUserId: '333' };
  assert.equal(authorizeInteraction({ guild_id: '222', user: { id: '333' } }, config).allowed, true);
  assert.deepEqual(ephemeral('hello <@999>'), {
    content: 'hello <@999>',
    flags: 64,
    allowed_mentions: { parse: [] },
  });
  assert.deepEqual(ephemeral({ content: 'private', embeds: [{ title: 'safe' }] }), {
    content: 'private',
    embeds: [{ title: 'safe' }],
    flags: 64,
    allowed_mentions: { parse: [] },
  });
});
