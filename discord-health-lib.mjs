import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const EMBED_LINKS = 1n << 14n;
const REQUIRED_CHANNEL_PERMISSIONS = VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS;
const ALL_PERMISSIONS = (1n << 63n) - 1n;

function permissionBits(value) {
  try {
    return BigInt(String(value ?? '0'));
  } catch {
    return 0n;
  }
}

function overwriteType(overwrite) {
  const value = String(overwrite?.type ?? '').toLocaleLowerCase('en-US');
  if (value === '0' || value === 'role') return 'role';
  if (value === '1' || value === 'member') return 'member';
  return '';
}

function applyOverwrite(permissions, overwrite) {
  return (permissions & ~permissionBits(overwrite?.deny)) | permissionBits(overwrite?.allow);
}

export function computeEffectivePermissions({ guild, member, roles, channel } = {}) {
  const guildId = String(guild?.id ?? '');
  const memberId = String(member?.user?.id ?? member?.id ?? '');
  if (memberId && memberId === String(guild?.owner_id ?? '')) return ALL_PERMISSIONS;

  const memberRoleIds = new Set((Array.isArray(member?.roles) ? member.roles : []).map(String));
  let permissions = 0n;
  for (const role of Array.isArray(roles) ? roles : []) {
    const roleId = String(role?.id ?? '');
    if (roleId === guildId || memberRoleIds.has(roleId)) permissions |= permissionBits(role?.permissions);
  }
  if ((permissions & ADMINISTRATOR) !== 0n) return ALL_PERMISSIONS;

  const overwrites = Array.isArray(channel?.permission_overwrites) ? channel.permission_overwrites : [];
  const everyone = overwrites.find((item) => overwriteType(item) === 'role' && String(item?.id ?? '') === guildId);
  if (everyone) permissions = applyOverwrite(permissions, everyone);

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites) {
    if (overwriteType(overwrite) !== 'role' || !memberRoleIds.has(String(overwrite?.id ?? ''))) continue;
    roleAllow |= permissionBits(overwrite?.allow);
    roleDeny |= permissionBits(overwrite?.deny);
  }
  permissions = (permissions & ~roleDeny) | roleAllow;

  const memberOverwrite = overwrites.find((item) => overwriteType(item) === 'member' && String(item?.id ?? '') === memberId);
  if (memberOverwrite) permissions = applyOverwrite(permissions, memberOverwrite);
  return permissions;
}

export function sanitizeHealthDetail(value, { secrets = [] } = {}) {
  let detail = String(value?.message ?? value ?? '未知错误');
  for (const secret of secrets) {
    const text = String(secret ?? '');
    if (text) detail = detail.split(text).join('[redacted]');
  }
  detail = detail
    .replace(/https?:\/\/[^\s)\]}]+/giu, '[redacted-url]')
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, '[local-path]')
    .replace(/\b(?:Bot\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/gu, '[redacted-token]')
    .replace(/@/gu, '@\u200b')
    .replace(/[*_`#>|~[\]{}()\\]/gu, '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return (detail || '无详细信息').slice(0, 240);
}

function clock(dependencies) {
  return typeof dependencies?.now === 'function' ? dependencies.now : () => performance.now();
}

async function captureCheck(dependencies, key, label, operation, { secrets = [], successDetail = '正常' } = {}) {
  const now = clock(dependencies);
  const startedAt = Number(now());
  try {
    const value = await operation();
    const endedAt = Number(now());
    return {
      check: {
        key,
        label,
        ok: true,
        latencyMs: Math.max(0, Number.isFinite(endedAt - startedAt) ? endedAt - startedAt : 0),
        detail: sanitizeHealthDetail(typeof successDetail === 'function' ? successDetail(value) : successDetail, { secrets }),
      },
      value,
    };
  } catch (error) {
    const endedAt = Number(now());
    return {
      check: {
        key,
        label,
        ok: false,
        latencyMs: Math.max(0, Number.isFinite(endedAt - startedAt) ? endedAt - startedAt : 0),
        detail: sanitizeHealthDetail(error, { secrets }),
      },
      value: undefined,
    };
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}不可读取或格式无效`);
  return value;
}

function requireFunction(value, label) {
  if (typeof value !== 'function') throw new Error(`${label}不可用`);
  return value;
}

function validateChannelPermissions({ guild, member, roles, channel }) {
  requireObject(channel, '频道');
  const permissions = computeEffectivePermissions({ guild, member, roles, channel });
  if ((permissions & REQUIRED_CHANNEL_PERMISSIONS) !== REQUIRED_CHANNEL_PERMISSIONS) {
    throw new Error('缺少查看频道、发送消息或嵌入链接权限');
  }
  return permissions;
}

export async function probeTemporaryAtomicWrite({ fileSystem = fs, tempRoot = os.tmpdir() } = {}) {
  const root = await fileSystem.mkdtemp(path.join(path.resolve(tempRoot), 'codex-discord-health-'));
  const staged = path.join(root, 'probe.json.tmp');
  const target = path.join(root, 'probe.json');
  try {
    await fileSystem.writeFile(staged, '{"ok":true}', 'utf8');
    await fileSystem.rename(staged, target);
    if (await fileSystem.readFile(target, 'utf8') !== '{"ok":true}') throw new Error('临时原子写校验失败');
    return { ok: true };
  } finally {
    await fileSystem.rm(root, { recursive: true, force: true });
  }
}

export async function runQuickHealthChecks(dependencies = {}) {
  const checks = [];
  const tokenResult = await captureCheck(dependencies, 'token-decryption', 'Bot Token', async () => {
    const token = String(await requireFunction(dependencies.loadToken, 'Token 解密')()).trim();
    if (!token) throw new Error('Token 解密结果为空');
    return token;
  }, { successDetail: '可解密' });
  checks.push(tokenResult.check);
  const token = tokenResult.value;

  const gatewayResult = await captureCheck(dependencies, 'gateway', 'Gateway', async () => {
    const state = requireObject(await requireFunction(dependencies.getGatewayState, 'Gateway 状态')(), 'Gateway 状态');
    if (!['ready', 'connected', 'online'].includes(String(state.state ?? '').toLocaleLowerCase('en-US'))) {
      throw new Error('Gateway 未在线');
    }
    return state;
  }, { successDetail: '在线' });
  checks.push(gatewayResult.check);

  let guild;
  let member;
  let roles;
  const restResult = await captureCheck(dependencies, 'discord-rest', 'Discord REST', async () => {
    if (!token) throw new Error('Token 不可用，无法检查 Discord REST');
    guild = requireObject(await requireFunction(dependencies.getGuild, '服务器读取')(token), '服务器');
    member = requireObject(await requireFunction(dependencies.getMember, '成员读取')(token), '成员');
    roles = await requireFunction(dependencies.getRoles, '角色读取')(token);
    if (!Array.isArray(roles)) throw new Error('角色列表格式无效');
    return { guild, member, roles };
  }, { secrets: [token], successDetail: '服务器、成员与角色可读' });
  checks.push(restResult.check);

  const channelSpecs = [
    ['task', '任务频道'],
    ['confirmation', '确认频道'],
    ['quota', '额度频道'],
  ];
  for (const [kind, label] of channelSpecs) {
    const property = `discord${kind[0].toUpperCase()}${kind.slice(1)}ChannelId`;
    const channelResult = await captureCheck(dependencies, `${kind}-channel-permissions`, `${label}权限`, async () => {
      if (!guild || !member || !roles) throw new Error('Discord REST 基础信息不可用');
      const channelId = String(dependencies.config?.[property] ?? '');
      if (!channelId) throw new Error(`${label}未配置`);
      const channel = await requireFunction(dependencies.getChannel, '频道读取')(channelId, token);
      validateChannelPermissions({ guild, member, roles, channel });
      return channel;
    }, { secrets: [token], successDetail: '可查看、发送并嵌入链接' });
    checks.push(channelResult.check);
  }

  const localChecks = [
    ['task-index', '任务索引', 'readTaskIndex', (value) => requireObject(value, '任务索引')],
    ['continuation-queue', '继续队列', 'readContinuationState', (value) => requireObject(value, '继续队列')],
    ['atomic-write', '临时原子写', 'probeAtomicWrite', (value) => value],
    ['quota-state', '额度状态', 'readQuotaState', (value) => requireObject(value, '额度状态')],
    ['rollout-watcher', '完成监听', 'readRolloutWatcherState', (value) => {
      const state = requireObject(value, '完成监听状态');
      const offsets = Object.values(state.files ?? {}).map((item) => Number(item?.offset));
      const hasOffsets = offsets.some((offset) => Number.isFinite(offset) && offset >= 0);
      const hasProgress = Number.isFinite(Date.parse(String(state.lastProgressAt ?? state.lastSuccessAt ?? '')));
      if (!hasOffsets && !hasProgress) throw new Error('完成监听没有有效偏移或进度时间');
      return state;
    }],
  ];
  for (const [key, label, method, validate] of localChecks) {
    const result = await captureCheck(dependencies, key, label, async () => {
      const operation = key === 'atomic-write' && typeof dependencies[method] !== 'function'
        ? () => probeTemporaryAtomicWrite({ fileSystem: dependencies.fileSystem, tempRoot: dependencies.tempRoot })
        : requireFunction(dependencies[method], label);
      const value = await operation();
      return validate(value);
    });
    checks.push(result.check);
  }
  return checks;
}

export async function runFullHealthChecks(dependencies = {}) {
  const checks = await runQuickHealthChecks(dependencies);
  for (const [kind, label] of [['task', '任务通知'], ['confirmation', '确认通知'], ['quota', '额度通知']]) {
    const result = await captureCheck(dependencies, `${kind}-probe`, label, async () => {
      const probe = typeof dependencies.runDispatcherProbe === 'function'
        ? await dependencies.runDispatcherProbe(kind)
        : await runPowerShellDispatcherProbe(dependencies, kind);
      if (Number(probe?.exitCode ?? 0) !== 0) throw new Error(probe?.error ?? `${label}发送失败`);
      return probe;
    }, { successDetail: '测试通知已发送' });
    checks.push(result.check);
  }
  return checks;
}

export async function runPowerShellDispatcherProbe(dependencies = {}, kind) {
  if (!['task', 'confirmation', 'quota'].includes(String(kind))) throw new Error('通知测试类型无效');
  const executable = String(dependencies.powershellPath ?? 'pwsh').trim();
  const dispatcherPath = String(dependencies.dispatcherPath ?? '').trim();
  if (!dispatcherPath) throw new Error('通知测试脚本路径未配置');
  const request = {
    executable,
    args: ['-NoProfile', '-File', dispatcherPath, '-MobileOnly', '-SystemTestEvent', String(kind)],
    shell: false,
    windowsHide: true,
  };
  if (typeof dependencies.spawnPowerShell === 'function') return dependencies.spawnPowerShell(request);
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({
      exitCode: Number.isInteger(code) ? code : 1,
      error: signal ? '通知测试进程被中断' : undefined,
    }));
  });
}

export function renderHealthReport(checks, { mode = '快速' } = {}) {
  const rows = (Array.isArray(checks) ? checks : []).map((item) => {
    const icon = item?.ok ? '✅' : '❌';
    const label = sanitizeHealthDetail(item?.label ?? item?.key ?? '检查项');
    const latency = Math.max(0, Math.round(Number(item?.latencyMs) || 0));
    const detail = sanitizeHealthDetail(item?.detail ?? '');
    return `${icon} **${label}** · ${latency}ms — ${detail}`;
  });
  const failures = (Array.isArray(checks) ? checks : []).filter((item) => !item?.ok).length;
  const report = [`## ${mode === '完整' ? '完整' : '快速'}系统测试`, `检查完成：${rows.length - failures} 项正常，${failures} 项失败。`, '', ...rows].join('\n');
  return report.length <= 1_900 ? report : `${report.slice(0, 1_899)}…`;
}
