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
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage()].map(jsonLine).join(''), 'utf8');
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
    await fs.writeFile(paths.rolloutPath, [sessionMeta(), taskStarted(), userMessage()].map(jsonLine).join(''), 'utf8');
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
    taskComplete('最终结果由完成通知发送。'),
    {
      timestamp: '2026-09-01T00:00:11.000Z', type: 'event_msg',
      payload: { type: 'agent_message', phase: 'commentary', message: 'COMPLETE-AFTER-CANARY' },
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
    assert.match(sent[1].content, /本机路径/);
    assert.match(sent[1].content, /代码内容已省略/);
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

test('terminal fallback enriches an exact persisted origin and marks delivery only after success', async () => {
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
    await assert.rejects(() => pollRolloutCompletions({
      sessionsRoot: paths.sessionsRoot,
      state,
      nowMs: Date.parse('2026-09-01T00:00:20.000Z'),
      graceMs: 5_000,
      dispatchNotification: async () => {},
    }), /Rollout content is unavailable/);
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
