import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createEmptyRolloutWatcherState,
  dispatchNotificationViaPowerShell,
  initializeRolloutWatcherState,
  pollDiscordOriginEvents,
  pollRolloutCompletions,
  readRolloutWatcherState,
  writeRolloutWatcherState,
} from '../rollout-completion-watcher-lib.mjs';
import { createEmptyInboxState } from '../discord-bridge-lib.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function sessionMeta() {
  return {
    timestamp: '2026-09-01T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: threadId,
      cwd: 'C:\\workspace\\demo',
      thread_source: 'user',
    },
  };
}

function taskStarted() {
  return {
    timestamp: '2026-09-01T00:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: turnId },
  };
}

function turnContext(model = 'gpt-5.6-sol', effort = 'ultra') {
  return {
    timestamp: '2026-09-01T00:00:01.100Z',
    type: 'turn_context',
    payload: { turn_id: turnId, model, effort },
  };
}

function userMessage(text = '请检查 Discord 通知为什么漏发') {
  return {
    timestamp: '2026-09-01T00:00:02.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: text },
  };
}

function taskComplete(message = '已经完成修复。') {
  return {
    timestamp: '2026-09-01T00:00:10.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: turnId, last_agent_message: message },
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-watcher-'));
  const sessionsRoot = path.join(root, 'sessions');
  const statePath = path.join(root, 'rollout-watcher-state.json');
  const rolloutPath = path.join(sessionsRoot, '2026', '09', '01', `rollout-${threadId}.jsonl`);
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  return { root, sessionsRoot, statePath, rolloutPath };
}

test('baselines existing bytes but preserves the active turn context for the next completion', async () => {
  const paths = await fixture();
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), turnContext(), userMessage()].map(jsonLine).join(''), 'utf8');
    const state = createEmptyRolloutWatcherState();
    await initializeRolloutWatcherState({ sessionsRoot: paths.sessionsRoot, state });

    const tracked = state.files[path.resolve(paths.rolloutPath)];
    assert.equal(state.initialized, true);
    assert.equal(tracked.threadId, threadId);
    assert.equal(tracked.cwd, 'C:\\workspace\\demo');
    assert.equal(tracked.activeTurnId, turnId);
    assert.equal(Object.hasOwn(tracked, 'inputMessages'), false);
    assert.equal(JSON.stringify(state).includes('请检查 Discord 通知为什么漏发'), false);
    assert.equal(tracked.offset, (await fs.stat(paths.rolloutPath)).size);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('waits for a complete JSONL line and grace period, then dispatches one standard notification', async () => {
  const paths = await fixture();
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), turnContext(), userMessage()].map(jsonLine).join(''), 'utf8');
    const state = createEmptyRolloutWatcherState();
    await initializeRolloutWatcherState({ sessionsRoot: paths.sessionsRoot, state });
    const dispatched = [];
    const completeLine = JSON.stringify(taskComplete());

    await fs.appendFile(paths.rolloutPath, completeLine, 'utf8');
    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'),
      graceMs: 5_000,
      dispatchNotification: async (notification) => dispatched.push(notification),
    });
    assert.equal(dispatched.length, 0, 'an incomplete JSONL line must not be consumed');

    await fs.appendFile(paths.rolloutPath, '\n', 'utf8');
    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:12.000Z'),
      graceMs: 5_000,
      dispatchNotification: async (notification) => dispatched.push(notification),
    });
    assert.equal(dispatched.length, 0, 'the fallback must give the native hook time to deliver first');
    assert.equal(JSON.stringify(state.pending).includes('请检查 Discord 通知为什么漏发'), false);
    assert.equal(JSON.stringify(state.pending).includes('已经完成修复。'), false);

    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:16.000Z'),
      graceMs: 5_000,
      dispatchNotification: async (notification) => dispatched.push(notification),
    });
    assert.deepEqual(dispatched, [{
      type: 'agent-turn-complete',
      'thread-id': threadId,
      'turn-id': turnId,
      cwd: 'C:\\workspace\\demo',
      'input-messages': ['请检查 Discord 通知为什么漏发'],
      'last-assistant-message': '已经完成修复。',
      model: 'gpt-5.6-sol',
      'reasoning-effort': 'ultra',
    }]);

    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:30.000Z'),
      graceMs: 5_000,
      dispatchNotification: async (notification) => dispatched.push(notification),
    });
    assert.equal(dispatched.length, 1, 'a completed turn must not be dispatched twice');
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('persists an unfinished turn so a guard restart still catches its later completion', async () => {
  const paths = await fixture();
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage('重启后也要提醒')].map(jsonLine).join(''), 'utf8');
    const beforeRestart = createEmptyRolloutWatcherState();
    await initializeRolloutWatcherState({ sessionsRoot: paths.sessionsRoot, state: beforeRestart });
    await writeRolloutWatcherState(paths.statePath, beforeRestart);
    const stored = await fs.readFile(paths.statePath, 'utf8');
    assert.equal(stored.includes('重启后也要提醒'), false);
    assert.equal(stored.includes('重启后的任务已完成。'), false);

    await fs.appendFile(paths.rolloutPath, jsonLine(taskComplete('重启后的任务已完成。')), 'utf8');
    const afterRestart = await readRolloutWatcherState(paths.statePath);
    const dispatched = [];
    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state: afterRestart,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'),
      graceMs: 5_000,
      dispatchNotification: async (notification) => dispatched.push(notification),
    });

    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0]['input-messages'], ['重启后也要提醒']);
    assert.equal(dispatched[0]['last-assistant-message'], '重启后的任务已完成。');
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('terminal watcher never queues or dispatches a child-agent completion', async () => {
  const paths = await fixture();
  const childMeta = {
    ...sessionMeta(),
    payload: {
      ...sessionMeta().payload,
      thread_source: 'subagent',
      parent_thread_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      source: { subagent: { name: 'worker' } },
    },
  };
  const beforeComplete = [childMeta, taskStarted(), userMessage('内部子任务')].map(jsonLine).join('');
  try {
    await fs.writeFile(paths.rolloutPath, beforeComplete, 'utf8');
    const state = createEmptyRolloutWatcherState();
    await initializeRolloutWatcherState({ sessionsRoot: paths.sessionsRoot, state });
    await fs.appendFile(paths.rolloutPath, jsonLine(taskComplete('内部结果不得通知')), 'utf8');
    const dispatched = [];
    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'),
      graceMs: 0,
      retryMs: 0,
      dispatchNotification: async (notification) => dispatched.push(notification),
    });
    assert.deepEqual(dispatched, []);
    assert.deepEqual(state.pending, {});
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('streams only exact-root commentary and sanitized tool lifecycle to the persisted source channel', async () => {
  const paths = await fixture();
  const secretOutput = 'RAW-OUTPUT-CANARY webhook https://discord.com/api/webhooks/123/secret';
  const entries = [
    sessionMeta(),
    taskStarted(),
    {
      timestamp: '2026-09-01T00:00:02.000Z', type: 'event_msg',
      payload: {
        type: 'agent_message', phase: 'commentary',
        message: '正在检查 C:\\Users\\Jane Doe\\Private Project\\key.txt D:/Profiles/Jane Doe/secret.txt \\\\private-server\\hidden share\\file.txt /var/lib/Private Project/key.txt API_KEY="multi word canary" ```js\nUNFINISHED-CODE-CANARY',
      },
    },
    {
      timestamp: '2026-09-01T00:00:02.100Z', type: 'response_item',
      payload: {
        type: 'message', role: 'assistant', phase: 'commentary',
        content: [{ type: 'output_text', text: '正在检查 C:\\Users\\private-user\\secret API_KEY=canary-secret-value ```js\nconst token = "sk-secret";\n``` @everyone' }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
    {
      timestamp: '2026-09-01T00:00:02.200Z', type: 'event_msg',
      payload: { type: 'agent_message', phase: 'commentary', message: '第二步正在核对最新状态。' },
    },
    {
      timestamp: '2026-09-01T00:00:03.000Z', type: 'response_item',
      payload: {
        type: 'custom_tool_call', call_id: 'call-safe-1', name: 'exec_command', status: 'completed',
        input: secretOutput,
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
    {
      timestamp: '2026-09-01T00:00:04.000Z', type: 'response_item',
      payload: {
        type: 'custom_tool_call_output', call_id: 'call-safe-1', output: secretOutput,
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
    {
      timestamp: '2026-09-01T00:00:05.000Z', type: 'event_msg',
      payload: { type: 'sub_agent_activity', turn_id: turnId, message: secretOutput },
    },
  ];
  const state = createEmptyInboxState();
  state.discordTurnOrigins[turnId] = {
    threadId, guildId: '222222222222222222', channelId: '777777777777777777', source: 'new-task',
    createdAt: '2026-09-01T00:00:01.000Z', rolloutCursor: 0, deliveredEventIds: [], deliveryState: 'pending',
  };
  const sent = [];
  const snapshots = [];
  try {
    await fs.writeFile(paths.rolloutPath, entries.map(jsonLine).join(''), 'utf8');
    await pollDiscordOriginEvents({
      sessionsRoot: paths.sessionsRoot,
      inboxState: state,
      persistInboxState: async (snapshot) => { snapshots.push(structuredClone(snapshot)); },
      dispatchMessage: async (message) => {
        sent.push(structuredClone(message));
        return { id: `message-${sent.length}` };
      },
    });

    assert.deepEqual(sent.map((item) => item.kind), ['started', 'commentary', 'tool-start', 'tool-complete']);
    assert.equal(sent.every((item) => item.channelId === '777777777777777777'), true);
    assert.equal(sent.every((item) => /^\d{1,25}$/u.test(item.nonce) && item.enforceNonce === true), true);
    const serialized = JSON.stringify({ sent, snapshots });
    assert.equal(serialized.includes('Jane Doe'), false);
    assert.equal(serialized.includes('Private Project'), false);
    assert.equal(serialized.includes('D:/Profiles'), false);
    assert.equal(serialized.includes('sk-secret'), false);
    assert.equal(serialized.includes('canary-secret-value'), false);
    assert.equal(serialized.includes('private-server'), false);
    assert.equal(serialized.includes('/var/lib/Private Project'), false);
    assert.equal(serialized.includes('multi word canary'), false);
    assert.equal(serialized.includes('UNFINISHED-CODE-CANARY'), false);
    assert.equal(serialized.includes('RAW-OUTPUT-CANARY'), false);
    assert.equal(serialized.includes('COMPLETE-AFTER-CANARY'), false);
    assert.equal(serialized.includes('sub_agent_activity'), false);
    assert.match(sent[1].content, /详细进度包含本机或敏感内容，已隐藏/u);
    assert.match(sent[1].content, /第二步正在核对最新状态/u);
    assert.equal(state.discordTurnOrigins[turnId].deliveredEventIds.length, 4);
    assert.ok(state.discordTurnOrigins[turnId].rolloutCursor > 0);
    assert.match(state.discordTurnOrigins[turnId].rolloutFingerprint, /^[a-f0-9]{64}$/u);

    await pollDiscordOriginEvents({
      sessionsRoot: paths.sessionsRoot, inboxState: structuredClone(snapshots.at(-1)),
      persistInboxState: async () => {}, dispatchMessage: async (message) => { sent.push(message); },
    });
    assert.equal(sent.length, 4, 'a persisted cursor must not replay successful progress after restart');
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('suspicious commentary is default-denied to one fixed coarse progress message', async () => {
  const samples = [
    '查看 "/home/alice/private key.txt"', '查看 `/srv/top/secret.env`', '检查 C:/Users/Jane/private.txt',
    '检查 "D:\\Private Folder\\key.txt"', '检查 \\\\server\\private share\\key.txt',
    'curl -H "Authorization: Bearer abc def" https://example.test/x', 'node tool.js --password hunter2',
    'AKIAABCDEFGHIJKLMNOP', 'ghp_abcdefghijklmnopqrstuvwxyz123456', 'xoxb-1234567890-secretvalue',
    '[点此](https://private.example/path)', '```js\nconst secret = 1;', 'const secret = process.env.KEY;',
    'powershell -File tool.ps1 -Token private-value',
    '源码 const total = 1;', '正在运行 npm test -- --runInBand',
    '路径：C:/Users/Jane Doe/notes.txt', '路径 [C:\\Users\\Jane Doe\\notes.txt]',
    '路径：/home/alice/private notes.txt',
  ];
  for (const [index, sample] of samples.entries()) {
    const paths = await fixture();
    const state = createEmptyInboxState();
    state.discordTurnOrigins[turnId] = {
      threadId, guildId: '222222222222222222', channelId: '777777777777777777', source: 'slash',
      createdAt: '2026-09-01T00:00:01.000Z', rolloutCursor: 0, deliveredEventIds: [], deliveryState: 'pending',
    };
    const sent = [];
    try {
      await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), {
        type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: sample },
      }].map(jsonLine).join(''), 'utf8');
      await pollDiscordOriginEvents({
        sessionsRoot: paths.sessionsRoot, inboxState: state, persistInboxState: async () => {},
        nowMs: Date.parse('2026-09-01T00:00:19.000Z'),
        dispatchMessage: async (message) => { sent.push(message); return { id: `m-${index}` }; },
      });
      const commentary = sent.find((item) => item.kind === 'commentary');
      assert.equal(commentary.content, [
        '## 任务进行中…',
        '',
        '### demo · 未命名任务',
        '',
        '### 任务进度',
        '',
        '正在处理任务（详细进度包含本机或敏感内容，已隐藏）。',
        '',
        '### **运行时间**',
        '',
        '已运行 18 秒',
      ].join('\n'));
      assert.equal(JSON.stringify(sent).includes(sample), false);
    } finally {
      await fs.rm(paths.root, { recursive: true, force: true });
    }
  }
});

test('formats every active Discord-origin progress message with the requested task identity and elapsed runtime', async () => {
  const paths = await fixture();
  const state = createEmptyInboxState();
  state.discordTurnOrigins[turnId] = {
    threadId, guildId: '222222222222222222', channelId: '777777777777777777', source: 'slash',
    createdAt: '2026-09-01T00:00:00.000Z', rolloutCursor: 0, deliveredEventIds: [], deliveryState: 'pending',
  };
  const sent = [];
  const meta = sessionMeta();
  meta.payload.cwd = 'C:\\workspace\\new-chat';
  try {
    await fs.writeFile(paths.rolloutPath, [
      meta,
      taskStarted(),
      turnContext(),
      {
        timestamp: '2026-09-01T00:00:05.000Z', type: 'event_msg',
        payload: { type: 'agent_message', phase: 'commentary', message: '这很有价值。我先核对实际稳定时长、有没有新增转储……' },
      },
    ].map(jsonLine).join(''), 'utf8');

    await pollDiscordOriginEvents({
      sessionsRoot: paths.sessionsRoot,
      inboxState: state,
      taskIndex: { tasks: [{ threadId, projectName: null, taskName: '诊断电脑故障和终端自启' }] },
      nowMs: Date.parse('2026-09-01T00:00:19.000Z'),
      persistInboxState: async () => {},
      dispatchMessage: async (message) => { sent.push(message); return { id: `message-${sent.length}` }; },
    });

    assert.equal(sent[0].content.includes('任务已开始'), false);
    assert.equal(sent[1].content, [
      '## 任务进行中…',
      '',
      '### new-chat · 诊断电脑故障和终端自启',
      '',
      '### 任务进度',
      '',
      '这很有价值。我先核对实际稳定时长、有没有新增转储……',
      '',
      '### **运行时间**',
      '',
      '已运行 18 秒',
      '',
      '由 5.6 Sol Ultra 支持',
    ].join('\n'));
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('keeps elapsed runtime anchored to task start after earlier progress was already delivered', async () => {
  const paths = await fixture();
  const state = createEmptyInboxState();
  state.discordTurnOrigins[turnId] = {
    threadId, guildId: '222222222222222222', channelId: '777777777777777777', source: 'slash',
    createdAt: '2026-09-01T00:00:00.000Z', rolloutCursor: 0, deliveredEventIds: [], deliveryState: 'pending',
  };
  const sent = [];
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted()].map(jsonLine).join(''), 'utf8');
    const options = {
      sessionsRoot: paths.sessionsRoot,
      inboxState: state,
      taskIndex: { tasks: [{ threadId, projectName: 'new-chat', taskName: '诊断电脑故障和终端自启' }] },
      persistInboxState: async () => {},
      dispatchMessage: async (message) => { sent.push(message); return { id: '777777777777777901' }; },
    };
    await pollDiscordOriginEvents({ ...options, nowMs: Date.parse('2026-09-01T00:00:05.000Z') });
    await fs.appendFile(paths.rolloutPath, jsonLine({
      timestamp: '2026-09-01T00:00:18.000Z', type: 'event_msg',
      payload: { type: 'agent_message', phase: 'commentary', message: '第二次进度。' },
    }), 'utf8');
    await pollDiscordOriginEvents({ ...options, nowMs: Date.parse('2026-09-01T00:00:19.000Z') });

    assert.match(sent.at(-1).content, /已运行 18 秒$/u);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('drops unsent intermediate progress when the exact turn is already complete', async () => {
  const paths = await fixture();
  const state = createEmptyInboxState();
  state.discordTurnOrigins[turnId] = {
    threadId, guildId: '222222222222222222', channelId: '777777777777777777', source: 'slash',
    createdAt: '2026-09-01T00:00:00.000Z', rolloutCursor: 0, deliveredEventIds: [], deliveryState: 'pending',
  };
  const sent = [];
  try {
    await fs.writeFile(paths.rolloutPath, [
      sessionMeta(), taskStarted(),
      { timestamp: '2026-09-01T00:00:05.000Z', type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '迟到进度不得发送' } },
      taskComplete('最终结果已经发送'),
    ].map(jsonLine).join(''), 'utf8');

    await pollDiscordOriginEvents({
      sessionsRoot: paths.sessionsRoot, inboxState: state,
      taskIndex: { tasks: [{ threadId, projectName: '项目', taskName: '任务' }] },
      nowMs: Date.parse('2026-09-01T00:00:11.000Z'),
      persistInboxState: async () => {},
      dispatchMessage: async (message) => { sent.push(message); return { id: `message-${sent.length}` }; },
    });

    assert.deepEqual(sent, []);
    assert.equal(state.discordTurnOrigins[turnId].rolloutCursor, (await fs.stat(paths.rolloutPath)).size);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('failed source-channel send advances only through prior successes and retries with the same deterministic nonce', async () => {
  const paths = await fixture();
  const state = createEmptyInboxState();
  state.discordTurnOrigins[turnId] = {
    threadId, guildId: '222222222222222222', channelId: '777777777777777777', source: 'slash',
    createdAt: '2026-09-01T00:00:01.000Z', rolloutCursor: 0, deliveredEventIds: [], deliveryState: 'pending',
  };
  const calls = [];
  let failCommentary = true;
  try {
    await fs.writeFile(paths.rolloutPath, [
      sessionMeta(), taskStarted(),
      { timestamp: '2026-09-01T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '继续处理中' } },
    ].map(jsonLine).join(''), 'utf8');
    const dispatchMessage = async (message) => {
      calls.push(structuredClone(message));
      if (message.kind === 'commentary' && failCommentary) throw new Error('temporary Discord failure');
      return { id: `message-${calls.length}` };
    };
    await assert.rejects(() => pollDiscordOriginEvents({
      sessionsRoot: paths.sessionsRoot, inboxState: state, persistInboxState: async () => {}, dispatchMessage,
    }), /temporary Discord failure/);
    assert.deepEqual(state.discordTurnOrigins[turnId].deliveredEventIds.length, 1);
    const failedNonce = calls.at(-1).nonce;

    failCommentary = false;
    await pollDiscordOriginEvents({
      sessionsRoot: paths.sessionsRoot, inboxState: state, persistInboxState: async () => {}, dispatchMessage,
    });
    assert.equal(calls.at(-1).kind, 'commentary');
    assert.equal(calls.at(-1).nonce, failedNonce);
    assert.equal(state.discordTurnOrigins[turnId].deliveredEventIds.length, 2);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('a durable progress intent preserves A and later sends B after A state commit fails', async () => {
  const paths = await fixture();
  const state = createEmptyInboxState();
  state.discordTurnOrigins[turnId] = {
    threadId, guildId: '222222222222222222', channelId: '777777777777777777', source: 'slash',
    createdAt: '2026-09-01T00:00:01.000Z', rolloutCursor: 0, deliveredEventIds: [], deliveryState: 'pending',
  };
  const calls = [];
  const discordMessages = new Map();
  let failCommentaryCommit = true;
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), {
      type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '第一段安全进度' },
    }].map(jsonLine).join(''), 'utf8');
    const persistInboxState = async (snapshot) => {
      if (failCommentaryCommit && snapshot.discordTurnOrigins[turnId].deliveredEventIds.length === 2) {
        failCommentaryCommit = false;
        throw new Error('state commit unavailable');
      }
    };
    const dispatchMessage = async (message) => {
      calls.push(structuredClone(message));
      if (!discordMessages.has(message.nonce)) discordMessages.set(message.nonce, structuredClone(message));
      return { id: `message-${message.nonce}` };
    };
    await assert.rejects(() => pollDiscordOriginEvents({
      sessionsRoot: paths.sessionsRoot, inboxState: state, persistInboxState, dispatchMessage,
    }), /progress persistence failed/u);
    await fs.appendFile(paths.rolloutPath, jsonLine({
      type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '第二段安全进度' },
    }), 'utf8');
    await pollDiscordOriginEvents({ sessionsRoot: paths.sessionsRoot, inboxState: state, persistInboxState, dispatchMessage });
    await pollDiscordOriginEvents({ sessionsRoot: paths.sessionsRoot, inboxState: state, persistInboxState, dispatchMessage });
    const attempts = calls.filter((item) => item.kind === 'commentary');
    assert.equal(attempts.length, 3);
    assert.equal(attempts[1].nonce, attempts[0].nonce);
    assert.notEqual(attempts[2].nonce, attempts[0].nonce);
    assert.equal(attempts.every((item) => item.enforceNonce === true), true);
    const uniqueCommentary = [...discordMessages.values()].filter((item) => item.kind === 'commentary');
    assert.equal(uniqueCommentary.length, 2);
    assert.match(uniqueCommentary[0].content, /第一段安全进度/u);
    assert.doesNotMatch(uniqueCommentary[0].content, /第二段安全进度/u);
    assert.match(uniqueCommentary[1].content, /第二段安全进度/u);
    assert.equal(state.discordTurnOrigins[turnId].rolloutCursor, (await fs.stat(paths.rolloutPath)).size);
    assert.equal(state.discordTurnOrigins[turnId].progressDispatch, undefined);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('terminal delivery drops unsent B after retrying a sent A intent', async () => {
  const paths = await fixture();
  const inboxState = createEmptyInboxState();
  inboxState.discordTurnOrigins[turnId] = {
    threadId, guildId: '222222222222222222', channelId: '777777777777777777', source: 'slash',
    createdAt: '2026-09-01T00:00:01.000Z', rolloutCursor: 0, deliveredEventIds: [], deliveryState: 'pending',
  };
  const watcherState = createEmptyRolloutWatcherState();
  const discordMessages = new Map();
  const finalNotifications = [];
  let failACommit = true;
  const persistInboxState = async (snapshot) => {
    if (failACommit && snapshot.discordTurnOrigins[turnId].deliveredEventIds.length === 2) {
      failACommit = false;
      throw new Error('ack unavailable');
    }
  };
  const dispatchMessage = async (message) => {
    if (!discordMessages.has(message.nonce)) discordMessages.set(message.nonce, structuredClone(message));
    return { id: `m-${message.nonce}` };
  };
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), {
      type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '进度 A' },
    }].map(jsonLine).join(''), 'utf8');
    await initializeRolloutWatcherState({ sessionsRoot: paths.sessionsRoot, state: watcherState, inboxState });

    await assert.rejects(() => pollDiscordOriginEvents({
      sessionsRoot: paths.sessionsRoot, inboxState, persistInboxState, dispatchMessage,
    }), /progress persistence failed/u);
    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot, state: watcherState, inboxState, persistInboxState,
      nowMs: Date.parse('2026-09-01T00:00:10.000Z'), graceMs: 0, retryMs: 0,
      dispatchNotification: async (notification) => finalNotifications.push(notification),
    });

    await fs.appendFile(paths.rolloutPath, [{
      type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '进度 B' },
    }, taskComplete('最终完成')].map(jsonLine).join(''), 'utf8');
    await pollDiscordOriginEvents({ sessionsRoot: paths.sessionsRoot, inboxState, persistInboxState, dispatchMessage });
    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot, state: watcherState, inboxState, persistInboxState,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'), graceMs: 0, retryMs: 0,
      dispatchNotification: async (notification) => finalNotifications.push(notification),
    });
    await pollDiscordOriginEvents({ sessionsRoot: paths.sessionsRoot, inboxState, persistInboxState, dispatchMessage });

    const delivered = [...discordMessages.values()];
    assert.deepEqual(delivered.map((item) => item.kind), ['started', 'commentary']);
    assert.match(delivered[1].content, /进度 A/u);
    assert.equal(JSON.stringify(delivered).includes('进度 B'), false);
    assert.equal(finalNotifications.length, 1);
    assert.equal(inboxState.discordTurnOrigins[turnId].deliveryState, 'terminal-delivered');
    assert.equal(inboxState.discordTurnOrigins[turnId].progressDispatch, undefined);
    assert.equal(inboxState.discordTurnOrigins[turnId].rolloutCursor, (await fs.stat(paths.rolloutPath)).size);
  } finally { await fs.rm(paths.root, { recursive: true, force: true }); }
});

test('one failed origin stays pending without blocking progress for another Discord task', async () => {
  const paths = await fixture();
  const otherThreadId = '33333333-3333-4333-8333-333333333333';
  const otherTurnId = '44444444-4444-4444-8444-444444444444';
  const otherRollout = path.join(path.dirname(paths.rolloutPath), `rollout-${otherThreadId}.jsonl`);
  const state = createEmptyInboxState();
  state.discordTurnOrigins[turnId] = {
    threadId, guildId: '222222222222222222', channelId: '777777777777777777', source: 'slash',
    createdAt: '2026-09-01T00:00:01.000Z', rolloutCursor: 0, deliveredEventIds: [], deliveryState: 'pending',
  };
  state.discordTurnOrigins[otherTurnId] = {
    threadId: otherThreadId, guildId: '222222222222222222', channelId: '888888888888888888', source: 'reply',
    createdAt: '2026-09-01T00:00:01.000Z', rolloutCursor: 0, deliveredEventIds: [], deliveryState: 'pending',
  };
  const calls = [];
  try {
    await fs.writeFile(paths.rolloutPath, [
      sessionMeta(), taskStarted(),
      { type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '第一个任务进度' } },
    ].map(jsonLine).join(''), 'utf8');
    await fs.writeFile(otherRollout, [
      { ...sessionMeta(), payload: { ...sessionMeta().payload, id: otherThreadId } },
      { ...taskStarted(), payload: { ...taskStarted().payload, turn_id: otherTurnId } },
      { type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '第二个任务仍应收到' } },
    ].map(jsonLine).join(''), 'utf8');

    await assert.rejects(() => pollDiscordOriginEvents({
      sessionsRoot: paths.sessionsRoot, inboxState: state, persistInboxState: async () => {},
      dispatchMessage: async (message) => {
        calls.push(structuredClone(message));
        if (message.channelId === '777777777777777777' && message.kind === 'commentary') {
          throw new Error('first origin unavailable');
        }
        return { id: `message-${calls.length}` };
      },
    }), /first origin unavailable/u);

    assert.equal(calls.some((item) => item.channelId === '888888888888888888' && item.kind === 'commentary'), true);
    assert.equal(state.discordTurnOrigins[turnId].deliveredEventIds.length, 1);
    assert.equal(state.discordTurnOrigins[otherTurnId].deliveredEventIds.length, 2);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('origin progress fails closed for ambiguous and child rollouts', async () => {
  const paths = await fixture();
  const duplicate = path.join(path.dirname(paths.rolloutPath), `rollout-copy-${threadId}.jsonl`);
  const child = path.join(path.dirname(paths.rolloutPath), 'rollout-child.jsonl');
  const state = createEmptyInboxState();
  state.discordTurnOrigins[turnId] = {
    threadId, guildId: '222222222222222222', channelId: '777777777777777777', source: 'reply',
    createdAt: '2026-09-01T00:00:01.000Z', rolloutCursor: 0, deliveredEventIds: [], deliveryState: 'pending',
  };
  const rootLines = [sessionMeta(), taskStarted(), {
    type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '不得在歧义时发送' },
  }].map(jsonLine).join('');
  const sent = [];
  try {
    await fs.writeFile(paths.rolloutPath, rootLines, 'utf8');
    await fs.writeFile(duplicate, rootLines, 'utf8');
    await fs.writeFile(child, [
      { ...sessionMeta(), payload: { ...sessionMeta().payload, thread_source: 'subagent', parent_thread_id: threadId, source: { subagent: { name: 'worker' } } } },
      taskStarted(),
      { type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: 'CHILD-CANARY' } },
    ].map(jsonLine).join(''), 'utf8');
    await pollDiscordOriginEvents({
      sessionsRoot: paths.sessionsRoot, inboxState: state, persistInboxState: async () => {},
      dispatchMessage: async (message) => { sent.push(message); },
    });
    assert.deepEqual(sent, []);
    assert.equal(state.discordTurnOrigins[turnId].rolloutCursor, 0);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('keeps a failed fallback pending and retries it later', async () => {
  const paths = await fixture();
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage(), taskComplete()].map(jsonLine).join(''), 'utf8');
    const state = createEmptyRolloutWatcherState();
    await initializeRolloutWatcherState({ sessionsRoot: paths.sessionsRoot, state });
    state.files[path.resolve(paths.rolloutPath)].offset = Buffer.byteLength(
      [sessionMeta(), taskStarted(), userMessage()].map(jsonLine).join(''),
    );
    let attempts = 0;
    const dispatchNotification = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary Discord failure');
    };

    await assert.rejects(() => pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'),
      graceMs: 5_000,
      dispatchNotification,
    }), /temporary Discord failure/);
    assert.equal(Object.keys(state.pending).length, 1);

    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:30.000Z'),
      graceMs: 5_000,
      dispatchNotification,
    });
    assert.equal(attempts, 2);
    assert.equal(Object.keys(state.pending).length, 0);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('reconstructs current user response items without injected context, cross-turn text or mirrored duplicates', async () => {
  const paths = await fixture();
  const response = (texts, kinds, overrides = {}) => ({
    type: 'response_item', payload: {
      type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })),
      ...(kinds ? { internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: kinds } } : {}),
      ...overrides,
    },
  });
  const entries = [
    sessionMeta(), taskStarted(), turnContext('gpt-5.6-sol', 'high'),
    response(['plugin context', 'environment context'], ['plugins.recommendations', 'environments.environment_context']),
    response(['internal goal summary'], ['goal.internal_context']),
    response(['<environment_context>unlabelled context</environment_context>']),
    userMessage('<codex_internal_context>legacy injected context</codex_internal_context>'),
    response(['other turn text'], ['user.text'], { internal_chat_message_metadata_passthrough: { turn_id: 'other-turn', content_item_kinds: ['user.text'] } }),
    response(['developer text'], ['user.text'], {role:'developer'}),
    response(['tool output'], ['user.text'], {role:'tool'}),
    response(['assistant commentary'], ['user.text'], {role:'assistant', phase:'commentary'}),
    response(['first real input'], ['user.text']), userMessage('first real input'),
    response(['hidden context', 'second real input'], ['environments.environment_context', 'user.text']),
    response(['first real input'], ['user.text']),
    { type:'response_item', payload:{type:'message',role:'user',content:[{type:'input_image',image_url:'IMAGE-CANARY'},{type:'input_text',text:'latest real input'}],internal_chat_message_metadata_passthrough:{turn_id:turnId,content_item_kinds:['user.image','user.text']}} },
    taskComplete('exact final assistant result'),
    response(['later turn text'], ['user.text'], {internal_chat_message_metadata_passthrough:{turn_id:'later-turn',content_item_kinds:['user.text']}}),
  ];
  try {
    await fs.writeFile(paths.rolloutPath, entries.map(jsonLine).join(''), 'utf8');
    const state=createEmptyRolloutWatcherState();state.initialized=true;
    const captured=[];
    await pollRolloutCompletions({sessionsRoot:paths.sessionsRoot,state,nowMs:Date.parse('2026-09-01T00:00:20.000Z'),graceMs:0,retryMs:0,dispatchNotification:async(value)=>captured.push(value)});
    assert.equal(captured.length,1);
    assert.deepEqual(captured[0]['input-messages'], ['first real input','second real input','first real input','latest real input']);
    assert.equal(captured[0]['last-assistant-message'],'exact final assistant result');
    assert.equal(captured[0].model,'gpt-5.6-sol');
    assert.equal(captured[0]['reasoning-effort'],'high');
    assert.doesNotMatch(JSON.stringify(state), /first real input|latest real input|exact final assistant result/);
  } finally { await fs.rm(paths.root,{recursive:true,force:true}); }
});

test('legacy and unlabelled response inputs preserve the last real message across repeated text', async () => {
  const paths=await fixture();
  const response=(text)=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
  try {
    await fs.writeFile(paths.rolloutPath,[sessionMeta(),taskStarted(),
      response('<recommended_plugins>context</recommended_plugins>'),
      userMessage('A'),response('A'),userMessage('B'),response('A'),taskComplete(),
    ].map(jsonLine).join(''),'utf8');
    const state=createEmptyRolloutWatcherState();state.initialized=true;
    const captured=[];
    await pollRolloutCompletions({sessionsRoot:paths.sessionsRoot,state,nowMs:Date.parse('2026-09-01T00:00:20.000Z'),graceMs:0,retryMs:0,dispatchNotification:async(value)=>captured.push(value)});
    assert.deepEqual(captured[0]['input-messages'],['A','B','A']);
  } finally { await fs.rm(paths.root,{recursive:true,force:true}); }
});

test('one failed terminal dispatch preserves its retry while later completions are delivered and the error propagates', async () => {
  const paths=await fixture();
  const laterTurn='33333333-3333-4333-8333-333333333333';
  try {
    await fs.writeFile(paths.rolloutPath,[sessionMeta(),taskStarted(),userMessage('first'),taskComplete(),
      {...taskStarted(),payload:{type:'task_started',turn_id:laterTurn}},userMessage('later'),
      {...taskComplete(),timestamp:'2026-09-01T00:00:11.000Z',payload:{type:'task_complete',turn_id:laterTurn,last_agent_message:'later result'}},
    ].map(jsonLine).join(''),'utf8');
    const state=createEmptyRolloutWatcherState();state.initialized=true;
    const attempts=[];
    const failed=new Error('isolated-first-dispatch-failure');
    await assert.rejects(()=>pollRolloutCompletions({sessionsRoot:paths.sessionsRoot,state,nowMs:Date.parse('2026-09-01T00:00:20.000Z'),graceMs:0,retryMs:10_000,
      dispatchNotification:async(value)=>{attempts.push(value['turn-id']);if(value['turn-id']===turnId)throw failed;},
    }),(error)=>error===failed);
    assert.deepEqual(attempts,[turnId,laterTurn]);
    assert.deepEqual(Object.keys(state.pending),[turnId]);
    await pollRolloutCompletions({sessionsRoot:paths.sessionsRoot,state,nowMs:Date.parse('2026-09-01T00:00:21.000Z'),graceMs:0,retryMs:10_000,dispatchNotification:async()=>assert.fail('failed item retried before its deadline')});
    await pollRolloutCompletions({sessionsRoot:paths.sessionsRoot,state,nowMs:Date.parse('2026-09-01T00:00:30.000Z'),graceMs:0,retryMs:10_000,dispatchNotification:async(value)=>attempts.push(value['turn-id'])});
    assert.deepEqual(attempts,[turnId,laterTurn,turnId]);
    assert.deepEqual(state.pending,{});
  } finally { await fs.rm(paths.root,{recursive:true,force:true}); }
});

test('retires a proven inter-agent-only root turn without claiming a notification delivery', async () => {
  const paths=await fixture();
  try {
    await fs.writeFile(paths.rolloutPath,[{...sessionMeta(),payload:{...sessionMeta().payload,id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',thread_source:'subagent',parent_thread_id:'inherited-parent'}},sessionMeta(),taskStarted(),
      {type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'internal environment'}]}},
      {type:'inter_agent_communication_metadata',payload:{kind:'synthetic-agent-result'}},
      {type:'response_item',payload:{type:'agent_message',message:'internal agent response'}},
      taskComplete('internal automatic follow-up'),
    ].map(jsonLine).join(''),'utf8');
    const state=createEmptyRolloutWatcherState();state.initialized=true;
    await pollRolloutCompletions({sessionsRoot:paths.sessionsRoot,state,nowMs:Date.parse('2026-09-01T00:00:20.000Z'),graceMs:0,retryMs:0,
      dispatchNotification:async()=>assert.fail('internal-only completion must not be delivered'),
    });
    assert.deepEqual(state.pending,{});
    assert.equal(state.suppressedInternalTurnCount,1);
    assert.equal(state.lastSuppressedReason,'inter-agent-only-turn');
    assert.doesNotMatch(JSON.stringify(state),/internal automatic follow-up|internal agent response/);
  } finally { await fs.rm(paths.root,{recursive:true,force:true}); }
});

test('empty input without complete proof of an internal-only turn remains retryable', async (t) => {
  for(const variant of ['no-agent-evidence','other-turn-agent-evidence','user-message-present','malformed-line','oversized-line','compacted','interleaved-turn','missing-completion-id','conflicting-root-metadata']) {
    await t.test(variant,async()=>{
      const paths=await fixture();
      try {
        const evidence=[
          {type:'inter_agent_communication_metadata',payload:{}},
          {type:'response_item',payload:{type:'agent_message',message:'agent result'}},
        ];
        const middle=variant==='no-agent-evidence'?[]:evidence;
        if(variant==='other-turn-agent-evidence'){evidence[0].payload.turn_id='other-turn';evidence[1].payload.internal_chat_message_metadata_passthrough={turn_id:'other-turn'};}
        if(variant==='user-message-present')middle.push({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_image',image_url:'private-image'}],internal_chat_message_metadata_passthrough:{turn_id:turnId,content_item_kinds:['user.image']}}});
        if(variant==='compacted')middle.push({type:'compacted',payload:{}});
        if(variant==='interleaved-turn')middle.push({type:'event_msg',payload:{type:'task_started',turn_id:'other-turn'}});
        if(variant==='conflicting-root-metadata')middle.push({...sessionMeta(),payload:{...sessionMeta().payload,id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}});
        const unreadableLine=variant==='malformed-line'?'{broken-json}\n':variant==='oversized-line'?jsonLine({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'x'.repeat(8*1024*1024)}]}}):'';
        const completed=taskComplete();if(variant==='missing-completion-id')delete completed.payload.turn_id;
        await fs.writeFile(paths.rolloutPath,[sessionMeta(),taskStarted(),...middle].map(jsonLine).join('')+unreadableLine+jsonLine(completed),'utf8');
        const state=createEmptyRolloutWatcherState();state.initialized=true;
        await assert.rejects(()=>pollRolloutCompletions({sessionsRoot:paths.sessionsRoot,state,nowMs:Date.parse('2026-09-01T00:00:20.000Z'),graceMs:0,retryMs:0,
          dispatchNotification:async(notification)=>{assert.deepEqual(notification['input-messages'],[]);throw new Error('ambiguous-empty-input-retry');},
        }),/ambiguous-empty-input-retry/);
        assert.equal(Object.hasOwn(state.pending,turnId),true);
        assert.equal(state.suppressedInternalTurnCount,undefined);
      } finally { await fs.rm(paths.root,{recursive:true,force:true}); }
    });
  }
});

test('reconstructs a huge pending rollout without a whole-file read', { concurrency: false }, async () => {
  const paths = await fixture();
  const largeThreadId = '33333333-3333-4333-8333-333333333333';
  const largeTurnId = '44444444-4444-4444-8444-444444444444';
  const largeRollout = path.join(paths.root, 'rollout-large.jsonl');
  const originalReadFile = fs.readFile;
  try {
    const largeMeta = { ...sessionMeta(), payload: { ...sessionMeta().payload, id: largeThreadId } };
    const largeStart = { ...taskStarted(), payload: { ...taskStarted().payload, turn_id: largeTurnId } };
    const largeInput = { ...userMessage('超大任务也要完成通知'), payload: { ...userMessage('超大任务也要完成通知').payload } };
    const largeComplete = { ...taskComplete('超大任务已完成'), payload: { ...taskComplete('超大任务已完成').payload, turn_id: largeTurnId } };
    await fs.writeFile(largeRollout, [largeMeta, largeStart, largeInput].map(jsonLine).join(''), 'utf8');
    await fs.truncate(largeRollout, 20 * 1024 * 1024);
    await fs.appendFile(largeRollout, `\n${jsonLine(largeComplete)}`, 'utf8');
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage(), taskComplete()].map(jsonLine).join(''), 'utf8');

    const state = createEmptyRolloutWatcherState();
    state.initialized = true;
    state.pending[largeTurnId] = {
      completedAtMs: 0, lastAttemptAtMs: 0, rolloutPath: largeRollout,
      threadId: largeThreadId, cwd: 'C:\\workspace\\large',
    };
    fs.readFile = async (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(largeRollout)) {
        throw Object.assign(new Error('whole-file read unavailable for large rollout'), { code: 'ERR_FS_FILE_TOO_LARGE' });
      }
      return originalReadFile(target, ...args);
    };

    const dispatched = [];
    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot, state,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'), graceMs: 0, retryMs: 0,
      dispatchNotification: async (notification) => dispatched.push(notification),
    });

    assert.deepEqual(dispatched.map((item) => item['turn-id']), [largeTurnId, turnId]);
    assert.equal(dispatched[0]['last-assistant-message'], '超大任务已完成');
    assert.deepEqual(state.pending, {});
  } finally {
    fs.readFile = originalReadFile;
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('an unreconstructable pending rollout does not block a later completion', async () => {
  const paths = await fixture();
  const brokenTurnId = '44444444-4444-4444-8444-444444444444';
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage(), taskComplete()].map(jsonLine).join(''), 'utf8');
    const state = createEmptyRolloutWatcherState();
    state.initialized = true;
    state.pending[brokenTurnId] = {
      completedAtMs: 0, lastAttemptAtMs: 0,
      rolloutPath: path.join(paths.root, 'missing-rollout.jsonl'),
      threadId: '33333333-3333-4333-8333-333333333333', cwd: '',
    };
    const dispatched = [];

    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot, state,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'), graceMs: 0, retryMs: 0,
      dispatchNotification: async (notification) => dispatched.push(notification),
    });

    assert.deepEqual(dispatched.map((item) => item['turn-id']), [turnId]);
    assert.equal(Object.hasOwn(state.pending, brokenTurnId), true);
    assert.equal(Object.hasOwn(state.pending, turnId), false);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('recovers an archived exact rollout locator and retains it when delivery must retry', async () => {
  const paths=await fixture();
  const archivedRoot=path.join(paths.root,'archived_sessions');
  const archivedPath=path.join(archivedRoot,path.basename(paths.rolloutPath));
  try {
    await fs.writeFile(paths.rolloutPath,[sessionMeta(),taskStarted(),userMessage('archived user task'),taskComplete('archived final result')].map(jsonLine).join(''),'utf8');
    const state=createEmptyRolloutWatcherState();await initializeRolloutWatcherState({sessionsRoot:paths.sessionsRoot,state});
    state.pending[turnId]={completedAtMs:0,lastAttemptAtMs:0,rolloutPath:paths.rolloutPath,threadId,cwd:'C:\\workspace\\demo'};
    await fs.mkdir(archivedRoot);await fs.rename(paths.rolloutPath,archivedPath);
    const historicalEntries=[sessionMeta(),taskStarted(),userMessage('unrelated historical user task'),taskComplete('historical final result')];
    historicalEntries[1].payload.turn_id='historical-turn';historicalEntries[3].payload.turn_id='historical-turn';
    await fs.writeFile(path.join(archivedRoot,'rollout-unrelated-history.jsonl'),historicalEntries.map(jsonLine).join(''),'utf8');
    let attempts=0;
    const dispatchNotification=async(notification)=>{
      attempts++;assert.equal(notification['turn-id'],turnId);assert.deepEqual(notification['input-messages'],['archived user task']);
      assert.equal(notification['last-assistant-message'],'archived final result');
      if(attempts===1)throw new Error('archived-delivery-retry');
    };
    await assert.rejects(()=>pollRolloutCompletions({sessionsRoot:paths.sessionsRoot,state,nowMs:Date.parse('2026-09-01T00:00:20.000Z'),graceMs:0,retryMs:0,dispatchNotification}),/archived-delivery-retry/);
    assert.equal(state.pending[turnId].rolloutPath,archivedPath);
    assert.doesNotMatch(JSON.stringify(state),/archived user task|archived final result/);
    await pollRolloutCompletions({sessionsRoot:paths.sessionsRoot,state,nowMs:Date.parse('2026-09-01T00:00:30.000Z'),graceMs:0,retryMs:0,dispatchNotification});
    assert.equal(attempts,2);assert.deepEqual(state.pending,{});
    await pollRolloutCompletions({sessionsRoot:paths.sessionsRoot,state,nowMs:Date.parse('2026-09-01T00:00:40.000Z'),graceMs:0,retryMs:0,dispatchNotification});
    assert.equal(attempts,2);assert.deepEqual(state.pending,{});
  } finally { await fs.rm(paths.root,{recursive:true,force:true}); }
});

test('archive recovery refuses uncertain, mismatched and unowned locator candidates', async(t)=>{
  for(const variant of ['different-basename','wrong-root','wrong-turn','ambiguous','valid-with-unreadable-candidate','outside-sessions','malformed','active-file-still-exists','symlink-archive-root','symlink-archive-directory']) {
    await t.test(variant,async()=>{
      const paths=await fixture();
      const archivedRoot=path.join(paths.root,'archived_sessions');
      try {
        await fs.mkdir(archivedRoot);
        let originalPath=paths.rolloutPath;
        if(variant==='outside-sessions')originalPath=path.join(paths.root,'outside',path.basename(paths.rolloutPath));
        const entries=[sessionMeta(),taskStarted(),userMessage(),taskComplete()];
        if(variant==='wrong-root')entries[0].payload.id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        if(variant==='wrong-turn'){entries[1].payload.turn_id='other-turn';entries[3].payload.turn_id='other-turn';}
        const basename=variant==='different-basename'?'rollout-other-name.jsonl':path.basename(paths.rolloutPath);
        const bytes=entries.map(jsonLine).join('')+(variant==='malformed'?'{broken-json}\n':'');
        await fs.writeFile(path.join(archivedRoot,basename),bytes,'utf8');
        if(variant.startsWith('symlink-archive')){
          const outside=path.join(paths.root,'outside-archive');
          await fs.rename(archivedRoot,outside);
          if(variant==='symlink-archive-root')await fs.symlink(outside,archivedRoot,process.platform==='win32'?'junction':'dir');
          else{await fs.mkdir(archivedRoot);await fs.symlink(outside,path.join(archivedRoot,'alias'),process.platform==='win32'?'junction':'dir');}
        }
        if(variant==='ambiguous'){await fs.mkdir(path.join(archivedRoot,'another'));await fs.writeFile(path.join(archivedRoot,'another',basename),bytes,'utf8');}
        if(variant==='valid-with-unreadable-candidate'){await fs.mkdir(path.join(archivedRoot,'another'));await fs.writeFile(path.join(archivedRoot,'another',basename),'{broken-json}\n','utf8');}
        if(variant==='active-file-still-exists')await fs.writeFile(originalPath,'{incomplete-original','utf8');
        const state=createEmptyRolloutWatcherState();state.initialized=true;
        state.pending[turnId]={completedAtMs:0,lastAttemptAtMs:0,rolloutPath:originalPath,threadId,cwd:''};
        await pollRolloutCompletions({sessionsRoot:paths.sessionsRoot,state,nowMs:Date.parse('2026-09-01T00:00:20.000Z'),graceMs:0,retryMs:0,dispatchNotification:async()=>assert.fail('unverified archive must not deliver')});
        assert.equal(state.pending[turnId].rolloutPath,originalPath);
      } finally { await fs.rm(paths.root,{recursive:true,force:true}); }
    });
  }
});

test('terminal fallback discards unsent progress and still delivers the final result', async () => {
  const paths = await fixture();
  const inboxState = createEmptyInboxState();
  inboxState.discordTurnOrigins[turnId] = {
    threadId, guildId: '222222222222222222', channelId: '777777777777777777', source: 'new-task',
    createdAt: '2026-09-01T00:00:01.000Z', rolloutCursor: 0, deliveredEventIds: [], deliveryState: 'pending',
  };
  const snapshots = [];
  const dispatched = [];
  try {
    const beforeComplete = [sessionMeta(), taskStarted(), userMessage()].map(jsonLine).join('');
    await fs.writeFile(paths.rolloutPath, `${beforeComplete}${jsonLine(taskComplete())}`, 'utf8');
    inboxState.discordTurnOrigins[turnId].progressDispatch = {
      eventId: 'a'.repeat(64), nonce: '123', start: 0, end: 1,
      kind: 'commentary', rolloutFingerprint: 'b'.repeat(64),
    };
    const state = createEmptyRolloutWatcherState();
    await initializeRolloutWatcherState({ sessionsRoot: paths.sessionsRoot, state });
    state.files[path.resolve(paths.rolloutPath)].offset = Buffer.byteLength(beforeComplete);

    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot, state,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'), graceMs: 0,
      inboxState,
      persistInboxState: async (snapshot) => { snapshots.push(structuredClone(snapshot)); },
      dispatchNotification: async (notification) => { dispatched.push(structuredClone(notification)); },
    });

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]['discord-origin-channel-id'], '777777777777777777');
    assert.equal(dispatched[0]['discord-guild-id'], '222222222222222222');
    assert.equal(inboxState.discordTurnOrigins[turnId].deliveryState, 'terminal-delivered');
    assert.equal(inboxState.discordTurnOrigins[turnId].progressDispatch, undefined);
    assert.equal(inboxState.discordTurnOrigins[turnId].rolloutCursor, (await fs.stat(paths.rolloutPath)).size);
    assert.equal(inboxState.discordTurnOrigins[turnId].terminalEventId.length, 64);
    assert.equal(Object.keys(state.pending).length, 0);
    assert.equal(snapshots.some((snapshot) => snapshot.discordTurnOrigins[turnId].deliveryState === 'terminal-dispatching'), true);

    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot, state: structuredClone(state),
      nowMs: Date.parse('2026-09-01T00:00:30.000Z'), graceMs: 0,
      inboxState: structuredClone(inboxState), persistInboxState: async () => {},
      dispatchNotification: async (notification) => { dispatched.push(structuredClone(notification)); },
    });
    assert.equal(dispatched.length, 1, 'a delivered Discord-origin terminal must not replay after restart polling');
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('a missing watcher state recovers an already-complete exact pending Discord origin once', async () => {
  const paths = await fixture();
  const inboxState = createEmptyInboxState();
  inboxState.discordTurnOrigins[turnId] = {
    threadId, guildId: '222222222222222222', channelId: '777777777777777777', source: 'new-task',
    createdAt: '2026-09-01T00:00:01.000Z', rolloutCursor: 0, deliveredEventIds: [], deliveryState: 'pending',
  };
  const dispatched = [];
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage(), taskComplete()].map(jsonLine).join(''), 'utf8');
    inboxState.discordTurnOrigins[turnId].rolloutCursor = (await fs.stat(paths.rolloutPath)).size;
    const state = createEmptyRolloutWatcherState();
    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot, state, inboxState, persistInboxState: async () => {},
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'), graceMs: 0, retryMs: 0,
      dispatchNotification: async (notification) => dispatched.push(structuredClone(notification)),
    });

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]['turn-id'], turnId);
    assert.equal(dispatched[0]['discord-origin-channel-id'], '777777777777777777');
    assert.equal(inboxState.discordTurnOrigins[turnId].deliveryState, 'terminal-delivered');

    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot, state: structuredClone(state), inboxState: structuredClone(inboxState),
      persistInboxState: async () => {}, nowMs: Date.parse('2026-09-01T00:00:30.000Z'), graceMs: 0, retryMs: 0,
      dispatchNotification: async (notification) => dispatched.push(structuredClone(notification)),
    });
    assert.equal(dispatched.length, 1);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('terminal origin send failure retains dispatch intent and retries without marking delivery', async () => {
  const paths = await fixture();
  const inboxState = createEmptyInboxState();
  inboxState.discordTurnOrigins[turnId] = {
    threadId, guildId: '222222222222222222', channelId: '777777777777777777', source: 'slash',
    createdAt: '2026-09-01T00:00:01.000Z', rolloutCursor: 0, deliveredEventIds: [], deliveryState: 'pending',
  };
  let attempts = 0;
  try {
    const beforeComplete = [sessionMeta(), taskStarted(), userMessage()].map(jsonLine).join('');
    await fs.writeFile(paths.rolloutPath, `${beforeComplete}${jsonLine(taskComplete())}`, 'utf8');
    inboxState.discordTurnOrigins[turnId].rolloutCursor = (await fs.stat(paths.rolloutPath)).size;
    const state = createEmptyRolloutWatcherState();
    await initializeRolloutWatcherState({ sessionsRoot: paths.sessionsRoot, state });
    state.files[path.resolve(paths.rolloutPath)].offset = Buffer.byteLength(beforeComplete);
    const dispatchNotification = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('origin unavailable');
    };
    await assert.rejects(() => pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot, state,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'), graceMs: 0,
      inboxState, persistInboxState: async () => {}, dispatchNotification,
    }), /origin unavailable/);
    assert.equal(inboxState.discordTurnOrigins[turnId].deliveryState, 'terminal-dispatching');
    assert.equal(Object.keys(state.pending).length, 1);

    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot, state,
      nowMs: Date.parse('2026-09-01T00:00:31.000Z'), graceMs: 0,
      inboxState, persistInboxState: async () => {}, dispatchNotification,
    });
    assert.equal(attempts, 2);
    assert.equal(inboxState.discordTurnOrigins[turnId].deliveryState, 'terminal-delivered');
    assert.equal(Object.keys(state.pending).length, 0);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('keeps only a sanitized locator when the canonical rollout is unavailable', async () => {
  const paths = await fixture();
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage(), taskComplete()].map(jsonLine).join(''), 'utf8');
    const state = createEmptyRolloutWatcherState();
    await initializeRolloutWatcherState({ sessionsRoot: paths.sessionsRoot, state });
    state.files[path.resolve(paths.rolloutPath)].offset = Buffer.byteLength(
      [sessionMeta(), taskStarted(), userMessage()].map(jsonLine).join(''),
    );
    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:12.000Z'),
      graceMs: 5_000,
      dispatchNotification: async () => { throw new Error('dispatch must wait for grace period'); },
    });
    await fs.rm(paths.rolloutPath);
    await pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'),
      graceMs: 5_000,
      dispatchNotification: async () => {},
    });
    assert.equal(Object.keys(state.pending).length, 1);
    assert.equal(JSON.stringify(state.pending).includes('请检查 Discord 通知为什么漏发'), false);
    assert.equal(JSON.stringify(state.pending).includes('已经完成修复。'), false);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('migrates legacy watcher state without retaining conversation content', async () => {
  const paths = await fixture();
  try {
    await fs.writeFile(paths.statePath, JSON.stringify({
      version: 1,
      initialized: true,
      files: {
        [paths.rolloutPath]: {
          offset: 42,
          threadId,
          cwd: 'C:\\workspace\\demo',
          activeTurnId: turnId,
          inputMessages: ['do not retain this'],
        },
      },
      pending: {
        [turnId]: { notification: { 'input-messages': ['do not retain this'], 'last-assistant-message': 'do not retain this' } },
      },
    }), 'utf8');
    const migrated = await readRolloutWatcherState(paths.statePath);
    assert.equal(migrated.version, 2);
    assert.equal(Object.hasOwn(migrated.files[paths.rolloutPath], 'inputMessages'), false);
    assert.deepEqual(migrated.pending, {});
    await writeRolloutWatcherState(paths.statePath, migrated);
    assert.equal((await fs.readFile(paths.statePath, 'utf8')).includes('do not retain this'), false);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('migrates a recoverable v1 pending completion to a locator and dispatches once', async () => {
  const paths = await fixture();
  try {
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage(), taskComplete()].map(jsonLine).join(''), 'utf8');
    await fs.writeFile(paths.statePath, JSON.stringify({ version: 1, initialized: true, files: {}, pending: {
      [turnId]: { completedAtMs: 0, lastAttemptAtMs: 0, notification: { 'thread-id': threadId, cwd: 'C:\\workspace\\demo', 'input-messages': ['legacy secret'], 'last-assistant-message': 'legacy result' } },
    } }), 'utf8');
    const state = await readRolloutWatcherState(paths.statePath, { sessionsRoot: paths.sessionsRoot });
    assert.equal(state.pending[turnId].rolloutPath, path.resolve(paths.rolloutPath));
    assert.equal(JSON.stringify(state.pending).includes('legacy secret'), false);
    const delivered = [];
    await pollRolloutCompletions({ sessionsRoot: paths.sessionsRoot, state, nowMs: Date.now() + 60_000, graceMs: 0, dispatchNotification: async (item) => delivered.push(item) });
    assert.equal(delivered.length, 1);
    assert.equal(Object.keys(state.pending).length, 0);
  } finally { await fs.rm(paths.root, { recursive: true, force: true }); }
});

test('does not migrate an ambiguous or missing v1 pending rollout locator', async () => {
  const paths = await fixture();
  try {
    const legacy = () => ({ version: 1, initialized: true, files: {}, pending: {
      [turnId]: { completedAtMs: 0, notification: { 'thread-id': threadId, cwd: 'C:\\workspace\\demo', 'last-assistant-message': 'do not retain' } },
    } });
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), taskComplete()].map(jsonLine).join(''), 'utf8');
    const second = path.join(paths.sessionsRoot, '2026', '09', '01', `rollout-copy-${threadId}.jsonl`);
    await fs.writeFile(second, [sessionMeta(), taskStarted(), taskComplete()].map(jsonLine).join(''), 'utf8');
    await fs.writeFile(paths.statePath, JSON.stringify(legacy()), 'utf8');
    let state = await readRolloutWatcherState(paths.statePath, { sessionsRoot: paths.sessionsRoot });
    assert.deepEqual(state.pending, {});
    await fs.rm(second);
    await fs.rm(paths.rolloutPath);
    await fs.writeFile(paths.statePath, JSON.stringify(legacy()), 'utf8');
    state = await readRolloutWatcherState(paths.statePath, { sessionsRoot: paths.sessionsRoot });
    assert.deepEqual(state.pending, {});
    await fs.writeFile(paths.rolloutPath, [
      {
        ...sessionMeta(),
        payload: {
          ...sessionMeta().payload,
          thread_source: 'subagent',
          parent_thread_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          source: { subagent: { name: 'worker' } },
        },
      },
      taskStarted(),
      taskComplete('child result'),
    ].map(jsonLine).join(''), 'utf8');
    await fs.writeFile(paths.statePath, JSON.stringify(legacy()), 'utf8');
    state = await readRolloutWatcherState(paths.statePath, { sessionsRoot: paths.sessionsRoot });
    assert.deepEqual(state.pending, {});
  } finally { await fs.rm(paths.root, { recursive: true, force: true }); }
});

test('hands long notification JSON to the fallback dispatcher through a UTF-8 file', async () => {
  const paths = await fixture();
  try {
    const toolDir = path.join(paths.root, 'mobile-notify');
    const capturedPath = path.join(paths.root, 'captured.json');
    await fs.mkdir(toolDir, { recursive: true });
    await fs.writeFile(path.join(toolDir, 'dispatcher.ps1'), [
      'param([string]$NotificationFile, [switch]$MobileOnly, [switch]$FallbackInvocation)',
      '$raw = [System.IO.File]::ReadAllText($NotificationFile, [System.Text.Encoding]::UTF8)',
      '[System.IO.File]::WriteAllText($env:CODEX_WATCHER_CAPTURE, $raw, [System.Text.UTF8Encoding]::new($false))',
    ].join('\n'), 'utf8');
    const notification = {
      type: 'agent-turn-complete',
      'thread-id': threadId,
      'turn-id': turnId,
      cwd: 'C:\\workspace\\demo',
      'input-messages': ['长文本通知'],
      'last-assistant-message': `已完成。${'很长的结果。'.repeat(12_000)}`,
    };
    assert.ok(JSON.stringify(notification).length > 32_767);

    const previousCapture = process.env.CODEX_WATCHER_CAPTURE;
    process.env.CODEX_WATCHER_CAPTURE = capturedPath;
    try {
      await dispatchNotificationViaPowerShell({
        notification,
        toolDir,
        powershellPath: process.execPath.includes('node')
          ? (process.env.PWSH_PATH ?? 'pwsh')
          : 'pwsh',
      });
    } finally {
      if (previousCapture === undefined) delete process.env.CODEX_WATCHER_CAPTURE;
      else process.env.CODEX_WATCHER_CAPTURE = previousCapture;
    }

    assert.deepEqual(JSON.parse(await fs.readFile(capturedPath, 'utf8')), notification);
    assert.deepEqual((await fs.readdir(toolDir)).filter((name) => name.startsWith('.rollout-notification-')), []);
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});
