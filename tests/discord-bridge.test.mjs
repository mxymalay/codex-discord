import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCodexAppServerMessages,
  classifyReply,
  compareSnowflakes,
  createEmptyInboxState,
  discordRequest,
  enqueuePendingReply,
  getPendingReplies,
  initializeInboxCursors,
  isActiveWriterError,
  recordInboxMessage,
  removePendingReply,
  resolveCodexExecutable,
} from '../discord-bridge-lib.mjs';

const config = {
  discordGuildId: '222222222222222222',
  discordAllowedUserId: '333333333333333333',
  discordTaskChannelId: '444444444444444444',
  discordConfirmationChannelId: '555555555555555555',
  discordQuotaChannelId: '666666666666666666',
};

const mapping = {
  version: 1,
  messages: {
    '777777777777777701': {
      threadId: '11111111-1111-4111-8111-111111111111',
      cwd: 'C:\\workspace\\demo',
      channelId: config.discordConfirmationChannelId,
      eventName: 'user-task-confirmation-required',
    },
  },
};

function makeMessage(overrides = {}) {
  return {
    id: '777777777777777801',
    guild_id: config.discordGuildId,
    channel_id: config.discordConfirmationChannelId,
    author: { id: config.discordAllowedUserId, bot: false },
    content: '可以，但先备份，只做前两项。',
    message_reference: {
      guild_id: config.discordGuildId,
      channel_id: config.discordConfirmationChannelId,
      message_id: '777777777777777701',
    },
    ...overrides,
  };
}

test('accepts arbitrary text only when replying to a mapped task message', () => {
  const result = classifyReply(makeMessage(), config, mapping, createEmptyInboxState());
  assert.equal(result.accepted, true);
  assert.equal(result.text, '可以，但先备份，只做前两项。');
  assert.equal(result.mapping.threadId, '11111111-1111-4111-8111-111111111111');
});

test('accepts REST-fetched replies when Discord omits the optional guild id', () => {
  const message = makeMessage();
  delete message.guild_id;
  const result = classifyReply(message, config, mapping, createEmptyInboxState());
  assert.equal(result.accepted, true);
});

test('rejects unauthorized, unmapped, empty, duplicate, bot, and quota messages', async (t) => {
  const cases = [
    ['wrong user', { author: { id: '777777777777777901', bot: false } }],
    ['bot author', { author: { id: config.discordAllowedUserId, bot: true } }],
    ['not a reply', { message_reference: null }],
    ['unknown reference', { message_reference: { message_id: '777777777777777999' } }],
    ['empty text', { content: '   ' }],
    ['wrong guild', { guild_id: '777777777777777902' }],
    ['quota channel', { channel_id: config.discordQuotaChannelId }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, () => {
      assert.equal(classifyReply(makeMessage(overrides), config, mapping, createEmptyInboxState()).accepted, false);
    });
  }

  const duplicateState = createEmptyInboxState();
  duplicateState.processedMessageIds.push('777777777777777801');
  assert.equal(classifyReply(makeMessage(), config, mapping, duplicateState).accepted, false);
});

test('rejects a mapping whose notification channel does not match the reply channel', () => {
  const wrongChannelMapping = structuredClone(mapping);
  wrongChannelMapping.messages['777777777777777701'].channelId = config.discordTaskChannelId;
  assert.equal(classifyReply(makeMessage(), config, wrongChannelMapping, createEmptyInboxState()).accepted, false);
});

test('builds initialize, resume, and turn requests without creating a new thread', () => {
  const messages = buildCodexAppServerMessages({
    threadId: '11111111-1111-4111-8111-111111111111',
    cwd: 'C:\\workspace\\demo',
    text: '重新检查一次，只修改显示格式。',
  });
  assert.deepEqual(messages.map((message) => message.method), ['initialize', 'initialized', 'thread/resume', 'turn/start']);
  assert.equal(messages.some((message) => message.method === 'thread/start'), false);
  assert.equal(messages[2].params.threadId, '11111111-1111-4111-8111-111111111111');
  assert.equal(messages[2].params.cwd, 'C:\\workspace\\demo');
  assert.deepEqual(messages[3].params.input, [{ type: 'text', text: '重新检查一次，只修改显示格式。' }]);
});

test('orders Discord Snowflakes numerically', () => {
  const values = ['777777777777777801', '777777777777777702', '777777777777777710'];
  assert.deepEqual(values.sort(compareSnowflakes), [
    '777777777777777702',
    '777777777777777710',
    '777777777777777801',
  ]);
});

test('first run baselines channels while later runs preserve cursors for offline catch-up', async () => {
  const state = createEmptyInboxState();
  const calls = [];
  await initializeInboxCursors({
    state,
    channelIds: [config.discordTaskChannelId, config.discordConfirmationChannelId],
    getLatest: async (channelId) => {
      calls.push(channelId);
      return channelId === config.discordTaskChannelId ? '777777777777777820' : '777777777777777830';
    },
  });
  assert.equal(state.initialized, true);
  assert.equal(state.cursors[config.discordTaskChannelId], '777777777777777820');
  assert.equal(state.cursors[config.discordConfirmationChannelId], '777777777777777830');
  assert.equal(calls.length, 2);

  await initializeInboxCursors({
    state,
    channelIds: [config.discordTaskChannelId, config.discordConfirmationChannelId],
    getLatest: async () => {
      throw new Error('existing cursors must not be replaced');
    },
  });
});

test('records processed messages and advances channel cursor monotonically', () => {
  const state = createEmptyInboxState();
  state.initialized = true;
  state.cursors[config.discordTaskChannelId] = '777777777777777801';
  recordInboxMessage(state, config.discordTaskChannelId, '777777777777777820', true);
  recordInboxMessage(state, config.discordTaskChannelId, '777777777777777810', false);
  assert.equal(state.cursors[config.discordTaskChannelId], '777777777777777820');
  assert.deepEqual(state.processedMessageIds, ['777777777777777820']);
});

test('Discord REST requests always send the required Bot user agent', async () => {
  let observedHeaders;
  const result = await discordRequest({
    token: 'test-token',
    route: '/users/@me',
    fetchImpl: async (_url, options) => {
      observedHeaders = options.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'bot-id' }),
      };
    },
  });

  assert.deepEqual(result, { id: 'bot-id' });
  assert.equal(observedHeaders.Authorization, 'Bot test-token');
  assert.match(observedHeaders['User-Agent'], /^DiscordBot \(.+, \d+\.\d+\.\d+\)$/);
});

test('queues an active-writer reply for later delivery without losing its task mapping', () => {
  const state = createEmptyInboxState();
  const accepted = classifyReply(makeMessage(), config, mapping, state);
  const now = '2026-08-31T10:00:00.000Z';

  assert.equal(isActiveWriterError(new Error('Codex App Server rejected thread/resume: thread already has an active writer')), true);
  assert.equal(isActiveWriterError(new Error('Codex App Server rejected thread/resume: task not found')), false);

  enqueuePendingReply(state, accepted, now);
  const pending = getPendingReplies(state);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].messageId, accepted.messageId);
  assert.equal(pending[0].text, accepted.text);
  assert.equal(pending[0].mapping.threadId, accepted.mapping.threadId);
  assert.equal(pending[0].attempts, 1);
  assert.equal(pending[0].lastAttemptAt, now);

  enqueuePendingReply(state, accepted, '2026-08-31T10:01:00.000Z');
  assert.equal(getPendingReplies(state)[0].attempts, 2);
  assert.equal(getPendingReplies(state)[0].lastAttemptAt, '2026-08-31T10:01:00.000Z');

  removePendingReply(state, accepted.messageId);
  assert.deepEqual(getPendingReplies(state), []);
});

test('resolves the newest installed Codex executable when the scheduled-task PATH is minimal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-bridge-cli-'));
  try {
    const older = path.join(root, 'OpenAI', 'Codex', 'bin', 'older', 'codex.exe');
    const newest = path.join(root, 'OpenAI', 'Codex', 'bin', 'newest', 'codex.exe');
    await fs.mkdir(path.dirname(older), { recursive: true });
    await fs.mkdir(path.dirname(newest), { recursive: true });
    await fs.writeFile(older, 'old');
    await fs.writeFile(newest, 'new');
    const oldTime = new Date('2026-08-01T00:00:00Z');
    const newTime = new Date('2026-08-31T00:00:00Z');
    await fs.utimes(older, oldTime, oldTime);
    await fs.utimes(newest, newTime, newTime);

    assert.equal(await resolveCodexExecutable({ configuredPath: 'codex', localAppData: root }), newest);
    assert.equal(await resolveCodexExecutable({ configuredPath: older, localAppData: root }), older);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resolves PowerShell 7 instead of legacy Windows PowerShell for UTF-8 notification scripts', async () => {
  const bridgeLib = await import('../discord-bridge-lib.mjs');
  assert.equal(typeof bridgeLib.resolvePowerShellExecutable, 'function',
    'Discord bridge must expose a PowerShell 7 resolver');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-bridge-pwsh-'));
  try {
    const pwsh = path.join(root, 'PowerShell', '7', 'pwsh.exe');
    await fs.mkdir(path.dirname(pwsh), { recursive: true });
    await fs.writeFile(pwsh, 'pwsh');

    assert.equal(
      await bridgeLib.resolvePowerShellExecutable({ programFiles: root }),
      pwsh,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
