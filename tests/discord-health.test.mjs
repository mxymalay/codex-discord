import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computeEffectivePermissions,
  probeTemporaryAtomicWrite,
  renderHealthReport,
  runFullHealthChecks,
  runQuickHealthChecks,
} from '../discord-health-lib.mjs';

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const EMBED_LINKS = 1n << 14n;

function makeHealthDependencies({ failKind = '', writes = [] } = {}) {
  const guild = { id: 'guild-1', owner_id: 'owner-1' };
  const member = { user: { id: 'member-1' }, roles: ['role-1'] };
  const roles = [
    { id: 'guild-1', permissions: String(VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS) },
    { id: 'role-1', permissions: '0' },
  ];
  const channels = new Map([
    ['task-channel', { id: 'task-channel', guild_id: 'guild-1', permission_overwrites: [] }],
    ['confirmation-channel', { id: 'confirmation-channel', guild_id: 'guild-1', permission_overwrites: [] }],
    ['quota-channel', { id: 'quota-channel', guild_id: 'guild-1', permission_overwrites: [] }],
  ]);
  return {
    config: {
      discordGuildId: 'guild-1',
      discordTaskChannelId: 'task-channel',
      discordConfirmationChannelId: 'confirmation-channel',
      discordQuotaChannelId: 'quota-channel',
    },
    loadToken: async () => 'private-token-value',
    getGatewayState: async () => ({ state: 'ready', lastHeartbeatAckAt: '2026-09-01T00:00:00Z' }),
    getGuild: async () => guild,
    getMember: async () => member,
    getRoles: async () => roles,
    getChannel: async (channelId) => channels.get(channelId),
    readTaskIndex: async () => ({ version: 1, tasks: [] }),
    readContinuationState: async () => ({ version: 2, pendingContinuations: {}, processedInteractions: [] }),
    probeAtomicWrite: async () => ({ directory: 'temporary' }),
    readQuotaState: async () => ({ observedAt: '2026-09-01T00:00:00Z', limits: [] }),
    readRolloutWatcherState: async () => ({ files: { rollout: { offset: 12 } }, lastProgressAt: '2026-09-01T00:00:00Z' }),
    persistState: async (...args) => { writes.push(args); },
    runDispatcherProbe: async (kind) => {
      if (kind === failKind) throw new Error(`C:\\Users\\private\\${kind} webhook https://example.invalid/private`);
    },
    now: (() => {
      let value = 100;
      return () => { value += 5; return value; };
    })(),
  };
}

test('effective permissions apply everyone, combined-role, and member overwrites in Discord order', () => {
  const guild = { id: 'guild-1', owner_id: 'owner-1' };
  const member = { user: { id: 'member-1' }, roles: ['role-a', 'role-b'] };
  const roles = [
    { id: 'guild-1', permissions: String(VIEW_CHANNEL | SEND_MESSAGES) },
    { id: 'role-a', permissions: String(EMBED_LINKS) },
    { id: 'role-b', permissions: '0' },
  ];
  const channel = { permission_overwrites: [
    { id: 'guild-1', type: 0, deny: String(SEND_MESSAGES), allow: '0' },
    { id: 'role-a', type: 0, deny: String(VIEW_CHANNEL), allow: String(SEND_MESSAGES) },
    { id: 'role-b', type: 0, deny: String(EMBED_LINKS), allow: '0' },
    { id: 'member-1', type: 1, deny: '0', allow: String(VIEW_CHANNEL) },
  ] };

  assert.equal(computeEffectivePermissions({ guild, member, roles, channel }), VIEW_CHANNEL | SEND_MESSAGES);
});

test('guild owner and administrator bypass channel overwrites', () => {
  const denied = { permission_overwrites: [{ id: 'guild-1', type: 0, deny: String((1n << 50n) - 1n), allow: '0' }] };
  const roles = [{ id: 'guild-1', permissions: '0' }, { id: 'admin', permissions: String(1n << 3n) }];
  const owner = computeEffectivePermissions({ guild: { id: 'guild-1', owner_id: 'owner-1' }, member: { user: { id: 'owner-1' }, roles: [] }, roles, channel: denied });
  const admin = computeEffectivePermissions({ guild: { id: 'guild-1', owner_id: 'owner-1' }, member: { user: { id: 'member-1' }, roles: ['admin'] }, roles, channel: denied });
  assert.notEqual(owner & SEND_MESSAGES, 0n);
  assert.notEqual(admin & EMBED_LINKS, 0n);
});

test('quick health check is read-only and verifies send/embed permissions', async () => {
  const writes = [];
  const result = await runQuickHealthChecks(makeHealthDependencies({ writes }));
  assert.equal(result.every((item) => typeof item.ok === 'boolean'), true);
  assert.equal(result.every((item) => Number.isFinite(item.latencyMs)), true);
  assert.deepEqual(writes, []);
  assert.equal(result.find((item) => item.key === 'task-channel-permissions').ok, true);
  assert.equal(result.find((item) => item.key === 'confirmation-channel-permissions').ok, true);
  assert.equal(result.find((item) => item.key === 'quota-channel-permissions').ok, true);
  assert.equal(result.some((item) => item.detail.includes('private-token-value')), false);
});

test('atomic write probe uses and cleans only a newly-created temporary directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-health-parent-'));
  try {
    await fs.writeFile(path.join(root, 'real-state.json'), '{"keep":true}', 'utf8');
    await probeTemporaryAtomicWrite({ tempRoot: root });
    assert.equal(await fs.readFile(path.join(root, 'real-state.json'), 'utf8'), '{"keep":true}');
    assert.deepEqual(await fs.readdir(root), ['real-state.json']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('full check continues after one outbound channel failure and sanitizes its detail', async () => {
  const result = await runFullHealthChecks(makeHealthDependencies({ failKind: 'confirmation' }));
  assert.equal(result.find((item) => item.key === 'task-probe').ok, true);
  assert.equal(result.find((item) => item.key === 'confirmation-probe').ok, false);
  assert.equal(result.find((item) => item.key === 'quota-probe').ok, true);
  const detail = result.find((item) => item.key === 'confirmation-probe').detail;
  assert.equal(detail.includes('C:\\Users\\private'), false);
  assert.equal(detail.includes('https://'), false);
});

test('full check launches three independent PowerShell 7 dispatcher probes with argument arrays', async () => {
  const calls = [];
  const dependencies = makeHealthDependencies();
  delete dependencies.runDispatcherProbe;
  dependencies.powershellPath = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  dependencies.dispatcherPath = 'C:\\safe\\mobile-notify\\dispatcher.ps1';
  dependencies.spawnPowerShell = async (request) => {
    calls.push(request);
    return { exitCode: request.args.at(-1) === 'confirmation' ? 9 : 0, error: 'private output' };
  };

  const result = await runFullHealthChecks(dependencies);

  assert.deepEqual(calls.map((call) => call.executable), Array(3).fill(dependencies.powershellPath));
  assert.deepEqual(calls.map((call) => call.args), ['task', 'confirmation', 'quota'].map((kind) => [
    '-NoProfile', '-File', dependencies.dispatcherPath, '-MobileOnly', '-SystemTestEvent', kind,
  ]));
  assert.equal(calls.every((call) => call.shell === false), true);
  assert.equal(result.find((item) => item.key === 'confirmation-probe').ok, false);
  assert.equal(result.find((item) => item.key === 'quota-probe').ok, true);
});

test('health report bounds output and neutralizes mentions, paths, URLs, and structural Markdown', () => {
  const report = renderHealthReport(Array.from({ length: 30 }, (_, index) => ({
    key: `bad-${index}`,
    label: `# item ${index}`,
    ok: false,
    latencyMs: index,
    detail: '@everyone ``` C:\\Users\\private\\state.json https://example.invalid/private ' + 'x'.repeat(200),
  })), { mode: '完整' });
  assert.equal(report.length <= 1_900, true);
  assert.equal(report.includes('@everyone'), false);
  assert.equal(report.includes('C:\\Users\\private'), false);
  assert.equal(report.includes('https://'), false);
  assert.equal(report.includes('```'), false);
});
