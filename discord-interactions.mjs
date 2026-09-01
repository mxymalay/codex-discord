import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import path from 'node:path';

import { COMMAND_NAMES, authorizeInteraction, ephemeral } from './discord-commands-lib.mjs';
import { NO_PROJECT, resolveProjectSelection } from './discord-task-create-lib.mjs';

const DISCORD_API = 'https://discord.com/api/v10';
const UI_TTL_MS = 15 * 60_000;
const EMBED_MARKDOWN_LIMIT = 3_800;
const INITIAL_MESSAGE_RESPONSE_TYPES = new Set([4, 5]);
const STATUS_LABELS = Object.freeze({
  pending: '等待中',
  running: '运行中',
  'confirmation-required': '待确认',
  completed: '已完成',
  failed: '失败',
});

function isSuccessful(response) {
  if (typeof response?.ok === 'boolean') return response.ok;
  const status = Number(response?.status);
  return status >= 200 && status < 300;
}

function privatePayload(payload) {
  return ephemeral(payload ?? {});
}

function privateResponse(payload, type = 4) {
  return { type, data: privatePayload(payload) };
}

function mentionSafePayload(payload) {
  const data = typeof payload === 'string' ? { content: payload } : { ...(payload ?? {}) };
  delete data.flags;
  return { ...data, allowed_mentions: { parse: [] } };
}

function normalizeCallback(body) {
  const type = Number(body?.type);
  if (INITIAL_MESSAGE_RESPONSE_TYPES.has(type)) return { ...body, data: privatePayload(body?.data) };
  if (type === 7) return { ...body, data: mentionSafePayload(body?.data) };
  return body;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function retryPolicy(policy, defaults) {
  const configuredElapsed = Number(policy?.maxElapsedMs);
  const maxElapsedMs = policy?.maxElapsedMs === undefined || !Number.isFinite(configuredElapsed)
    ? defaults.maxElapsedMs
    : Math.min(defaults.maxElapsedMs, Math.max(0, configuredElapsed));
  return {
    maxAttempts: boundedInteger(policy?.maxAttempts, defaults.maxAttempts, 1, defaults.maxAttempts),
    maxElapsedMs,
  };
}

async function retryAfterMilliseconds(response, now) {
  try {
    const details = typeof response?.json === 'function' ? await response.json() : null;
    const seconds = Number(details?.retry_after);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  } catch {
    // Retry-After remains available when Discord does not return JSON.
  }
  const header = response?.headers?.get?.('Retry-After');
  const seconds = Number(header);
  if (String(header ?? '').trim() && Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(String(header ?? ''));
  return Number.isFinite(date) ? Math.max(0, date - Number(now())) : null;
}

async function fetchAttempt(fetchImpl, url, method, body, {
  remainingMs,
  parseRetryAfter,
  now,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeoutImpl(() => {
      timedOut = true;
      reject(new Error('Discord interaction request failed: timeout'));
      controller.abort();
    }, remainingMs);
  });
  const request = (async () => {
    const response = await fetchImpl(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const status = Number(response?.status);
    if (status === 429 && parseRetryAfter) {
      return { response, retryAfterMs: await retryAfterMilliseconds(response, now) };
    }
    if (!isSuccessful(response) || status === 204) return { response, value: null };
    try {
      const value = typeof response?.json === 'function' ? await response.json() : null;
      return { response, value };
    } catch {
      return { response, value: null };
    }
  })();
  try {
    return await Promise.race([request, timeout]);
  } catch {
    if (timedOut || controller.signal.aborted) {
      throw new Error('Discord interaction request failed: timeout');
    }
    throw new Error('Discord interaction request failed: network');
  } finally {
    clearTimeoutImpl(timeoutId);
  }
}

async function discordRequest(fetchImpl, url, method, body, {
  now,
  sleepImpl,
  policy,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  const startedAt = Number(now());
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const elapsedBeforeRequest = Math.max(0, Number(now()) - startedAt);
    if (attempt > 1 && elapsedBeforeRequest >= policy.maxElapsedMs) {
      throw new Error('Discord interaction request failed: 429');
    }
    const remainingMs = Math.max(0, policy.maxElapsedMs - elapsedBeforeRequest);
    const result = await fetchAttempt(fetchImpl, url, method, body, {
      remainingMs,
      parseRetryAfter: attempt < policy.maxAttempts,
      now,
      setTimeoutImpl,
      clearTimeoutImpl,
    });
    const status = Number(result.response?.status);
    if (status === 429 && attempt < policy.maxAttempts) {
      const delay = result.retryAfterMs;
      const remainingAfterParse = policy.maxElapsedMs - Math.max(0, Number(now()) - startedAt);
      if (delay === null || !Number.isFinite(delay) || delay < 0 || delay >= remainingAfterParse) {
        throw new Error('Discord interaction request failed: 429');
      }
      await sleepImpl(delay);
      if (Math.max(0, Number(now()) - startedAt) >= policy.maxElapsedMs) {
        throw new Error('Discord interaction request failed: 429');
      }
      continue;
    }
    if (!isSuccessful(result.response)) {
      throw new Error(`Discord interaction request failed: ${status || 'unknown'}`);
    }
    return result.value;
  }
  throw new Error('Discord interaction request failed: retry-limit');
}

/**
 * Create stateless Discord Interaction REST helpers. Interaction tokens are
 * accepted only as call arguments and are never retained by the returned
 * client.
 */
export function createInteractionRestClient({
  applicationId,
  fetchImpl = fetch,
  now = Date.now,
  sleepImpl = defaultSleep,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  callbackRetry,
  webhookRetry,
} = {}) {
  const appId = encodeURIComponent(String(applicationId ?? ''));
  const callbackPolicy = retryPolicy(callbackRetry, { maxAttempts: 2, maxElapsedMs: 2_800 });
  const webhookPolicy = retryPolicy(webhookRetry, { maxAttempts: 3, maxElapsedMs: 30_000 });
  return {
    callback(interaction, body) {
      const id = encodeURIComponent(String(interaction?.id ?? ''));
      const token = encodeURIComponent(String(interaction?.token ?? ''));
      return discordRequest(fetchImpl, `${DISCORD_API}/interactions/${id}/${token}/callback`, 'POST', normalizeCallback(body), {
        now, sleepImpl, setTimeoutImpl, clearTimeoutImpl, policy: callbackPolicy,
      });
    },
    editOriginal(interaction, payload) {
      const token = encodeURIComponent(String(interaction?.token ?? ''));
      return discordRequest(fetchImpl, `${DISCORD_API}/webhooks/${appId}/${token}/messages/@original`, 'PATCH', mentionSafePayload(payload), {
        now, sleepImpl, setTimeoutImpl, clearTimeoutImpl, policy: webhookPolicy,
      });
    },
    followup(interaction, payload) {
      const token = encodeURIComponent(String(interaction?.token ?? ''));
      return discordRequest(fetchImpl, `${DISCORD_API}/webhooks/${appId}/${token}?wait=true`, 'POST', privatePayload(payload), {
        now, sleepImpl, setTimeoutImpl, clearTimeoutImpl, policy: webhookPolicy,
      });
    },
  };
}

function fenceLine(line) {
  const match = String(line).match(/^ {0,3}```([^`]*)\s*\n?$/u);
  return match ? match[1].trim() : null;
}

function splitLongToken(token, capacity) {
  const pieces = [];
  let rest = token;
  while (rest.length > capacity) {
    pieces.push(rest.slice(0, capacity));
    rest = rest.slice(capacity);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** Split Markdown without leaving an unbalanced triple-backtick fence. */
export function paginateMarkdown(text, maximumLength = EMBED_MARKDOWN_LIMIT) {
  const maximum = Math.floor(Number(maximumLength));
  if (!Number.isFinite(maximum) || maximum < 32) throw new RangeError('Markdown page limit must be at least 32');
  const source = String(text ?? '').replace(/\r\n?/gu, '\n');
  if (!source) return [''];

  const rawTokens = source.match(/[^\n]*\n|[^\n]+$/gu) ?? [''];
  const tokens = [];
  let preprocessingFenceOpen = false;
  for (const token of rawTokens) {
    const language = fenceLine(token);
    if (language === null) {
      tokens.push(token);
      continue;
    }
    if (!preprocessingFenceOpen && token.length + (token.endsWith('\n') ? 3 : 4) > maximum) {
      tokens.push('```\n', `${language}\n`);
      preprocessingFenceOpen = true;
      continue;
    }
    tokens.push(token);
    preprocessingFenceOpen = !preprocessingFenceOpen;
  }
  const pages = [];
  let current = '';
  let openFence = null;

  const closing = () => openFence === null ? '' : `${current.endsWith('\n') ? '' : '\n'}\`\`\``;
  const flush = () => {
    if (!current) return;
    const suffix = closing();
    pages.push(`${current}${suffix}`);
    current = openFence === null ? '' : `\`\`\`${openFence}\n`;
  };

  for (const token of tokens) {
    const language = fenceLine(token);
    const nextFence = language === null ? openFence : (openFence === null ? language : null);
    const nextClosingLength = nextFence === null ? 0 : (token.endsWith('\n') ? 3 : 4);
    if (current && current.length + token.length + nextClosingLength > maximum) flush();

    const currentClosingReserve = openFence === null ? 0 : 4;
    const capacity = maximum - current.length - currentClosingReserve;
    if (language === null && token.length > capacity) {
      let remaining = token;
      while (remaining) {
        const reserve = openFence === null ? 0 : 4;
        const available = maximum - current.length - reserve;
        if (available <= 0) {
          flush();
          continue;
        }
        const [piece] = splitLongToken(remaining, available);
        current += piece;
        remaining = remaining.slice(piece.length);
        if (remaining) flush();
      }
      continue;
    }

    current += token;
    openFence = nextFence;
  }
  if (current) {
    const suffix = closing();
    pages.push(`${current}${suffix}`);
  }
  return pages.length ? pages : [''];
}

function text(value, fallback = '未知') {
  const normalized = String(value ?? '').replaceAll('\u0000', '').trim();
  return normalized || fallback;
}

function displayText(value, fallback, maximum = 80) {
  const valueText = text(value, fallback);
  return valueText.length <= maximum ? valueText : `${valueText.slice(0, maximum - 1)}…`;
}

function metadataText(value, fallback = '未知', maximum = 80) {
  const singleLine = text(value, fallback).replace(/\s+/gu, ' ');
  const escaped = singleLine.replace(/([\\`*_{}\[\]()#+.!|>~-])/gu, '\\$1');
  return escaped.length <= maximum ? escaped : `${escaped.slice(0, Math.max(0, maximum - 1))}…`;
}

function plainLabel(value, fallback = '未知', maximum = 80) {
  return displayText(text(value, fallback).replace(/\s+/gu, ' '), fallback, maximum);
}

function formatTimestamp(value) {
  const milliseconds = Date.parse(String(value ?? ''));
  if (!Number.isFinite(milliseconds)) return '未知';
  return new Date(milliseconds).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function formatDuration(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return '未知';
  if (value < 60_000) return '不足1分钟';
  const minutes = Math.floor(value / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainder = minutes % 60;
  return [days ? `${days}天` : '', hours ? `${hours}小时` : '', remainder && !days ? `${remainder}分钟` : ''].filter(Boolean).join('') || '不足1分钟';
}

function statusLabel(value) {
  return STATUS_LABELS[String(value ?? '')] ?? text(value);
}

export function renderTaskList(tasks, { status = '全部' } = {}) {
  const desired = String(status ?? '全部');
  const values = (Array.isArray(tasks) ? tasks : [])
    .filter((item) => desired === '全部' || statusLabel(item?.status) === desired)
    .slice(0, 10);
  if (!values.length) return `## 最近任务\n没有符合“${metadataText(desired, '全部')}”条件的主任务。`;
  return [
    `## 最近任务（${metadataText(desired, '全部')}）`,
    ...values.map((item, index) => [
      `${index + 1}. **${metadataText(item?.projectName, '无项目')} / ${metadataText(item?.taskName, '未命名任务')}**`,
      `   状态：${metadataText(statusLabel(item?.status))}｜最后活动：${formatTimestamp(item?.lastActivityAt)}｜运行时间：${formatDuration(item?.runtimeMs)}`,
    ].join('\n')),
  ].join('\n');
}

export function renderTaskDetail(detail) {
  if (!detail) return '任务不存在或已不再是侧边栏主任务。';
  const taskText = text(detail.taskText, detail.contentAvailable === false ? '内容暂不可用，请稍后重试。' : '（无可用内容）');
  const resultText = text(detail.resultText, detail.contentAvailable === false ? '内容暂不可用，请稍后重试。' : '（暂无结果）');
  return [
    `# ${metadataText(detail.taskName, '未命名任务', 200)}`,
    `项目：${metadataText(detail.projectName, '无项目', 200)}`,
    `状态：${metadataText(statusLabel(detail.status), '未知', 100)}`,
    `任务 ID：…${metadataText(text(detail.threadId).slice(-8), '未知', 16)}`,
    `开始时间：${formatTimestamp(detail.startedAt ?? detail.createdAt)}`,
    `最后活动：${formatTimestamp(detail.lastActivityAt)}`,
    `运行时间：${formatDuration(detail.runtimeMs)}`,
    '',
    '## 原始任务',
    taskText,
    '',
    '## 最新结果',
    resultText,
  ].join('\n');
}

export function renderSearchResults(results, keyword) {
  const values = (Array.isArray(results) ? results : []).slice(0, 10);
  if (!values.length) return `没有找到与“${metadataText(keyword, '', 100)}”匹配的主任务。`;
  return [
    `## 搜索结果：${metadataText(keyword, '', 100)}`,
    ...values.map((item, index) =>
      `${index + 1}. **${metadataText(item?.projectName, '无项目')} / ${metadataText(item?.taskName, '未命名任务')}**｜${metadataText(statusLabel(item?.status))}｜${formatTimestamp(item?.lastActivityAt)}`),
  ].join('\n');
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percent(value) {
  const number = finiteNumber(value);
  return number === null ? '未知' : number.toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: false });
}

function quotaAverageRate(limit, observedMs) {
  const resetsAt = finiteNumber(limit?.resetsAt);
  const windowMinutes = finiteNumber(limit?.windowMinutes);
  const used = finiteNumber(limit?.usedPercent);
  if (resetsAt === null || resetsAt <= 0 || windowMinutes === null || windowMinutes <= 0 || used === null) return null;
  const resetMs = resetsAt * 1_000;
  const elapsedHours = (observedMs - (resetMs - windowMinutes * 60_000)) / 3_600_000;
  if (!(elapsedHours > 0) || observedMs >= resetMs) return null;
  return Math.max(0, Math.min(100, used)) / elapsedHours;
}

function exhaustion(remaining, rate, resetMs, observedMs) {
  if (remaining !== null && remaining <= 0.001) return '额度已经用完。';
  if (remaining === null || rate === null || rate <= 0) return '暂时无法估算何时用完。';
  const hours = remaining / rate;
  if (!Number.isFinite(hours) || hours <= 0) return '暂时无法估算何时用完。';
  let result = `约 ${formatDuration(hours * 3_600_000)}后用完。`;
  if (Number.isFinite(resetMs) && resetMs > observedMs && observedMs + hours * 3_600_000 >= resetMs) {
    result += '该时间晚于下次更新，本周期预计用不完。';
  }
  return result;
}

export function renderQuota(state, { nowMs = Date.now() } = {}) {
  const weekly = (Array.isArray(state?.limits) ? state.limits : [])
    .find((item) => Number(item?.windowMinutes) === 10_080) ?? state?.limits?.[0];
  const observedMs = Date.parse(String(state?.observedAt ?? ''));
  if (!weekly || !Number.isFinite(observedMs)) return '暂无可用的 Codex 周额度快照。';

  const remaining = finiteNumber(weekly.remainingPercent);
  const previous = finiteNumber(weekly.previousRemainingPercent);
  const lastChangeMs = Date.parse(String(weekly.lastChangeAt ?? state.observedAt));
  const currentRate = finiteNumber(weekly.currentUsageRatePerHour ?? weekly.lastUsageRatePerHour);
  const previousRate = finiteNumber(weekly.previousUsageRatePerHour);
  const averageRate = quotaAverageRate(weekly, observedMs);
  const resetSeconds = finiteNumber(weekly.resetsAt);
  const resetMs = resetSeconds === null ? Number.NaN : resetSeconds * 1_000;
  const age = Number(nowMs) - observedMs;
  let trend = '暂时无法比较使用速度。';
  if (currentRate !== null && previousRate !== null && previousRate > 0) {
    const tolerance = Math.max(0.05, Math.max(Math.abs(currentRate), Math.abs(previousRate)) * 0.1);
    trend = Math.abs(currentRate - previousRate) <= tolerance
      ? '这次和上次使用速度基本一致。'
      : (currentRate > previousRate ? '这次比上次用得更快！' : '这次比上次用得更慢！');
  } else {
    const acceleration = finiteNumber(weekly.lastAccelerationPerHourSquared);
    if (acceleration !== null && Math.abs(acceleration) > 0.05) {
      trend = acceleration > 0 ? '这次使用速度变得更快！' : '这次使用速度变得更慢！';
    }
  }
  const transition = previous === null ? `当前剩余：${percent(remaining)}%` : `额度：${percent(previous)}% → ${percent(remaining)}%`;
  const resetText = Number.isFinite(resetMs) && resetMs > Number(nowMs)
    ? formatDuration(resetMs - Number(nowMs))
    : '未知或已经到期';
  return [
    '## Codex 周额度',
    transition,
    `距上次变化：${Number.isFinite(lastChangeMs) ? formatDuration(Math.max(0, Number(nowMs) - lastChangeMs)) : '未知'}`,
    trend,
    `距下次更新还有：${resetText}`,
    `如果以当前速度连续，${exhaustion(remaining, currentRate, resetMs, observedMs)}`,
    `如果以重置至今平均速度，${exhaustion(remaining, averageRate, resetMs, observedMs)}`,
    `快照时间：${formatTimestamp(state.observedAt)}${age > 15 * 60_000 ? '（数据已过期）' : ''}`,
  ].join('\n');
}

function safeCategory(value) {
  const candidate = String(value ?? '').trim().toLocaleLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(candidate) ? candidate : '无';
}

function stateName(value) {
  const candidate = String(value?.state ?? value ?? '').trim().toLocaleLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,31}$/u.test(candidate) ? candidate : '未知';
}

export function renderSystemStatus(status = {}) {
  const index = status.index ?? {};
  const quota = status.quota ?? {};
  const category = safeCategory(status.latestErrorCategory ?? status.gateway?.lastError ?? status.rollout?.lastError);
  return [
    '## 系统状态',
    `Gateway：${stateName(status.gateway)}`,
    `Discord REST：${stateName(status.discordRest)}`,
    `通知监听：${stateName(status.notificationListener)}｜最近成功：${formatTimestamp(status.notificationListener?.lastSuccessAt)}`,
    `完成补发：${stateName(status.rollout)}｜最近推进：${formatTimestamp(status.rollout?.lastProgressAt)}`,
    `任务索引：${finiteNumber(index.count) ?? 0} 项｜生成时间：${formatTimestamp(index.generatedAt)}`,
    `继续队列：${finiteNumber(status.queueCount) ?? 0} 项`,
    `额度快照：${formatTimestamp(quota.observedAt)}`,
    `最近错误类别：${category}`,
  ].join('\n');
}

export function renderHelp() {
  const descriptions = {
    任务列表: '查看最近主任务，可按状态筛选。',
    任务详情: '选择主任务并查看完整任务与最新结果。',
    任务搜索: '按关键词搜索项目、标题和任务正文。',
    新建任务: '从已保存项目或“无项目”创建持久任务。Git 项目自动使用隔离工作树，非 Git 项目使用保存目录。',
    继续任务: '选择主任务并发送新的多行指令。',
    继续队列: '查看或取消尚未开始的继续请求。',
    额度: '查看最后一份本机官方周额度快照。',
    系统状态: '查看 Gateway、监听、索引、队列与额度状态。',
    系统测试: '执行快速检查，或执行三路完整通知测试。',
    帮助: '显示本帮助。',
  };
  return [
    '# Codex Discord 命令帮助',
    ...COMMAND_NAMES.map((name) => `- /${name} — ${descriptions[name]}`),
    '',
    '所有消息结果仅调用者可见，并且不会触发 Discord mentions。',
    '电脑或 Bot 离线时命令不可执行；已有本地队列会在电脑恢复并登录后继续处理。',
  ].join('\n');
}

function optionValue(interaction, name) {
  return interaction?.data?.options?.find((option) => option?.name === name)?.value;
}

function focusedValue(interaction) {
  return interaction?.data?.options?.find((option) => option?.focused)?.value ?? '';
}

function userId(interaction) {
  return String(interaction?.member?.user?.id ?? interaction?.user?.id ?? '');
}

function guildId(interaction) {
  return String(interaction?.guild_id ?? '');
}

function nowValue(dependencies) {
  const value = typeof dependencies.now === 'function' ? dependencies.now() : Date.now();
  return value instanceof Date ? value.getTime() : Number(value);
}

function makeStateId(dependencies) {
  const bytes = (dependencies.randomBytes ?? cryptoRandomBytes)(12);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('Random byte source must return bytes');
  if (bytes.length !== 12) throw new Error('UI state IDs require 96 random bits');
  return Buffer.from(bytes).toString('base64url');
}

function projectRoots(project) {
  return (Array.isArray(project?.roots) ? project.roots : []).map((root) => typeof root === 'string' ? root : root?.path).map(String);
}

function projectFingerprint(project) {
  if (!project) return null;
  return createHash('sha256').update(JSON.stringify({
    id: String(project.id ?? ''),
    name: String(project.name ?? ''),
    roots: projectRoots(project),
  })).digest('base64url');
}

function cachedProject(dependencies, selectionId) {
  if (selectionId === NO_PROJECT) return { id: NO_PROJECT, name: '无项目', roots: [] };
  if (typeof dependencies.projectCatalog?.snapshotGetById === 'function') return dependencies.projectCatalog.snapshotGetById(selectionId);
  return (dependencies.cachedProjects ?? []).find((project) => String(project?.id ?? '') === selectionId) ?? null;
}

function taskChoices(dependencies, focused) {
  const query = String(focused ?? '').trim().normalize('NFKC').toLocaleLowerCase();
  return (dependencies.taskIndex?.tasks ?? [])
    .filter((task) => {
      if (!query) return true;
      return [task?.taskName, task?.projectName, statusLabel(task?.status)]
        .some((value) => String(value ?? '').normalize('NFKC').toLocaleLowerCase().includes(query));
    })
    .slice(0, 25)
    .map((task) => ({
      name: `${text(task?.projectName, '无项目')} / ${text(task?.taskName, '未命名任务')} · ${statusLabel(task?.status)}`.slice(0, 100),
      value: String(task.threadId),
    }));
}

function projectChoices(dependencies, focused) {
  if (typeof dependencies.projectCatalog?.snapshotChoices === 'function') {
    try {
      const choices = dependencies.projectCatalog.snapshotChoices(focused);
      return (Array.isArray(choices) ? choices : []).slice(0, 25);
    } catch {
      return [];
    }
  }
  const query = String(focused ?? '').trim().toLocaleLowerCase();
  const saved = (dependencies.cachedProjects ?? [])
    .filter((project) => !query || String(project?.name ?? '').toLocaleLowerCase().includes(query))
    .slice(0, 24)
    .map((project) => ({ name: String(project.name), value: String(project.id) }));
  return [...saved, { name: '无项目', value: NO_PROJECT }];
}

function normalizeChoices(choices) {
  return (Array.isArray(choices) ? choices : []).flatMap((choice) => {
    const name = String(choice?.name ?? '').trim();
    const value = String(choice?.value ?? '').trim();
    if (!name || !value || value.length > 100) return [];
    return [{ name: name.slice(0, 100), value }];
  }).slice(0, 25);
}

function findTask(dependencies, threadId) {
  const wanted = String(threadId ?? '').toLocaleLowerCase();
  return (dependencies.taskIndex?.tasks ?? []).find((task) => String(task?.threadId ?? '').toLocaleLowerCase() === wanted) ?? null;
}

function pageComponents(stateId, page, total) {
  if (total <= 1) return [];
  return [{
    type: 1,
    components: [
      { type: 2, style: 2, label: '上一页', custom_id: `page:${stateId}:prev`, disabled: page <= 0 },
      { type: 2, style: 2, label: `${page + 1}/${total}`, custom_id: `page:${stateId}:noop`, disabled: true },
      { type: 2, style: 2, label: '下一页', custom_id: `page:${stateId}:next`, disabled: page >= total - 1 },
    ],
  }];
}

function pagePayload(stateId, state) {
  return mentionSafePayload({
    embeds: [{ description: state.pages[state.page] }],
    components: pageComponents(stateId, state.page, state.pages.length),
  });
}

function createPageState(dependencies, pages, interaction) {
  if (pages.length <= 1) return { stateId: null, payload: privatePayload({ embeds: [{ description: pages[0] }] }) };
  const stateId = makeStateId(dependencies);
  const state = {
    kind: 'page', userId: userId(interaction), guildId: guildId(interaction), pages, page: 0,
    expiresAt: nowValue(dependencies) + UI_TTL_MS,
  };
  dependencies.uiState.set(stateId, state);
  return { stateId, payload: pagePayload(stateId, state) };
}

function detailButtons(dependencies, tasks, interaction) {
  const buttons = [];
  for (const task of (Array.isArray(tasks) ? tasks : []).slice(0, 10)) {
    const stateId = makeStateId(dependencies);
    dependencies.uiState.set(stateId, {
      kind: 'detail',
      userId: userId(interaction),
      guildId: guildId(interaction),
      threadId: String(task.threadId),
      expiresAt: nowValue(dependencies) + UI_TTL_MS,
    });
    buttons.push({ type: 2, style: 2, label: `查看：${plainLabel(task.taskName, '未命名任务', 77)}`, custom_id: `detail:${stateId}` });
  }
  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) rows.push({ type: 1, components: buttons.slice(index, index + 5) });
  return rows;
}

function safeWorkspaceName(workspace) {
  const candidate = String(workspace?.worktreePath ?? workspace?.cwd ?? '').replace(/\0/gu, '');
  if (!candidate) return '未知';
  if (/^[a-z]:\\users\\[^\\/]+[\\/]?$/iu.test(candidate) || /^\/home\/[^/]+\/?$/u.test(candidate)) {
    return '…/用户目录';
  }
  const win = path.win32.basename(candidate);
  const posix = path.posix.basename(candidate);
  const base = win.length <= posix.length ? win : posix;
  return `…/${metadataText(base.replace(/[<>@]/gu, ''), '工作目录', 120)}`;
}

function creationReceipt(result, selection) {
  const suffix = metadataText(text(result?.threadId).slice(-8), '未知', 16);
  const projectName = metadataText(selection?.projectName, '无项目', 240);
  const taskName = metadataText(result?.taskName, '生成中', 500);
  const mode = result?.workspace?.mode === 'worktree' ? 'Git 隔离工作树' : '保存目录';
  let receipt;
  if (result?.status === 'first-turn-failed') {
    receipt = `任务线程已保留，但首轮启动失败。\n项目：${projectName}\n任务：${taskName}\n任务 ID：…${suffix}\n运行方式：${mode}\n工作目录：${safeWorkspaceName(result?.workspace)}`;
  } else {
    receipt = `任务创建成功。\n项目：${projectName}\n任务：${taskName}\n任务 ID：…${suffix}\n运行方式：${mode}\n工作目录：${safeWorkspaceName(result?.workspace)}`;
  }
  return receipt.length <= 2_000 ? receipt : `${receipt.slice(0, 1_999)}…`;
}

function insertCreatedTask(dependencies, result, selection) {
  if (!result?.threadId) return;
  if (typeof dependencies.insertTask === 'function') {
    dependencies.insertTask(result, selection);
    return;
  }
  const tasks = dependencies.taskIndex?.tasks;
  if (!Array.isArray(tasks)) return;
  const key = String(result.threadId).toLocaleLowerCase();
  if (tasks.some((task) => String(task?.threadId ?? '').toLocaleLowerCase() === key)) return;
  const createdAt = new Date(nowValue(dependencies)).toISOString();
  tasks.unshift({
    threadId: String(result.threadId),
    projectId: selection?.projectId ?? null,
    projectName: selection?.projectName ?? '无项目',
    taskName: result.taskName ?? '生成中',
    status: result.status === 'first-turn-failed' ? 'failed' : 'running',
    createdAt,
    lastActivityAt: createdAt,
    startedAt: createdAt,
    completedAt: null,
    runtimeMs: 0,
    rolloutPath: null,
    offset: 0,
    worktreePath: result.workspace?.worktreePath ?? null,
    worktreeBranch: result.workspace?.branchName ?? null,
  });
}

function modalText(interaction) {
  for (const row of interaction?.data?.components ?? []) {
    for (const component of row?.components ?? []) {
      if (component?.custom_id === '任务内容') return String(component?.value ?? '');
    }
  }
  return '';
}

async function respond(dependencies, interaction, body) {
  await dependencies.respond?.(body, interaction);
  return body;
}

async function editOriginal(dependencies, interaction, payload) {
  const body = mentionSafePayload(payload);
  await dependencies.editOriginal?.(body, interaction);
  return body;
}

async function defer(dependencies, interaction) {
  return respond(dependencies, interaction, privateResponse({}, 5));
}

async function renderDetailInteraction(dependencies, interaction, record) {
  await defer(dependencies, interaction);
  try {
    const detail = await dependencies.readTaskDetail(record);
    const pages = paginateMarkdown(renderTaskDetail(detail));
    const { payload } = createPageState(dependencies, pages, interaction);
    return editOriginal(dependencies, interaction, payload);
  } catch {
    return editOriginal(dependencies, interaction, { content: '任务详情暂不可用，请稍后重试。' });
  }
}

async function handleCommand(dependencies, interaction) {
  const name = String(interaction?.data?.name ?? '');
  if (name === '任务列表') {
    const status = String(optionValue(interaction, '状态') ?? '全部');
    const matching = (dependencies.taskIndex?.tasks ?? []).filter((item) => status === '全部' || statusLabel(item?.status) === status).slice(0, 10);
    return respond(dependencies, interaction, privateResponse({
      embeds: [{ description: renderTaskList(matching, { status }) }],
      components: detailButtons(dependencies, matching, interaction),
    }));
  }
  if (name === '任务详情') {
    const record = findTask(dependencies, optionValue(interaction, '任务'));
    if (!record) return respond(dependencies, interaction, privateResponse('任务不存在或已不再是侧边栏主任务。'));
    return renderDetailInteraction(dependencies, interaction, record);
  }
  if (name === '任务搜索') {
    const keyword = String(optionValue(interaction, '关键词') ?? '');
    if (!keyword.trim()) return respond(dependencies, interaction, privateResponse('关键词不能为空。'));
    await defer(dependencies, interaction);
    try {
      const results = await dependencies.searchTasks({ index: dependencies.taskIndex, keyword, limit: 10 });
      return editOriginal(dependencies, interaction, {
        embeds: [{ description: renderSearchResults(results, keyword) }],
        components: detailButtons(dependencies, results, interaction),
      });
    } catch {
      return editOriginal(dependencies, interaction, { content: '任务搜索失败，请稍后重试。' });
    }
  }
  if (name === '新建任务') {
    const selectionId = String(optionValue(interaction, '项目') ?? '');
    const project = cachedProject(dependencies, selectionId);
    if (!project) return respond(dependencies, interaction, privateResponse('项目选择无效，请重新执行 /新建任务。'));
    const stateId = makeStateId(dependencies);
    dependencies.uiState.set(stateId, {
      kind: 'new-task',
      userId: userId(interaction),
      guildId: guildId(interaction),
      selectionId,
      projectFingerprint: projectFingerprint(project),
      expiresAt: nowValue(dependencies) + UI_TTL_MS,
    });
    return respond(dependencies, interaction, {
      type: 9,
      data: {
        custom_id: `new:${stateId}`,
        title: '新建 Codex 任务',
        components: [{
          type: 1,
          components: [{
            type: 4,
            custom_id: '任务内容',
            label: '任务内容',
            style: 2,
            min_length: 1,
            max_length: 4_000,
            required: true,
          }],
        }],
      },
    });
  }
  if (name === '额度') {
    await defer(dependencies, interaction);
    try {
      const state = await dependencies.getQuotaState();
      return editOriginal(dependencies, interaction, { content: renderQuota(state, { nowMs: nowValue(dependencies) }) });
    } catch {
      return editOriginal(dependencies, interaction, { content: '额度快照暂不可用，请稍后重试。' });
    }
  }
  if (name === '系统状态') {
    try {
      const provided = await dependencies.getSystemStatus();
      const queue = dependencies.getQueue?.();
      const queueCount = Array.isArray(queue) ? queue.length : 0;
      const status = {
        ...provided,
        index: provided?.index ?? { generatedAt: dependencies.taskIndex?.generatedAt, count: dependencies.taskIndex?.tasks?.length ?? 0 },
        queueCount: provided?.queueCount ?? queueCount,
      };
      return respond(dependencies, interaction, privateResponse(renderSystemStatus(status)));
    } catch {
      return respond(dependencies, interaction, privateResponse('系统状态暂不可用，请稍后重试。'));
    }
  }
  if (name === '帮助') return respond(dependencies, interaction, privateResponse(renderHelp()));
  if (name === '继续任务') return respond(dependencies, interaction, privateResponse('请选择任务后提交继续内容；继续队列功能将在下一阶段接入。'));
  if (name === '继续队列') return respond(dependencies, interaction, privateResponse('当前没有等待发送的继续请求。'));
  if (name === '系统测试') return respond(dependencies, interaction, privateResponse('系统测试功能将在健康检查阶段接入。'));
  return respond(dependencies, interaction, privateResponse('未知命令。'));
}

async function authoritativeProjects(dependencies) {
  if (typeof dependencies.refreshProjects === 'function') return dependencies.refreshProjects();
  if (typeof dependencies.projectCatalog?.refresh === 'function') return dependencies.projectCatalog.refresh();
  throw new Error('Project refresh unavailable');
}

function modalStateError(dependencies, interaction, state) {
  const now = nowValue(dependencies);
  if (!state || state.kind !== 'new-task') return '此表单已过期或无效，请重新执行 /新建任务。';
  if (now >= state.expiresAt) return '此表单已过期，请重新执行 /新建任务。';
  if (state.userId !== userId(interaction) || state.guildId !== guildId(interaction)) return '此表单不属于当前用户或服务器，无权提交。';
  return null;
}

async function handleModal(dependencies, submissions, interaction) {
  const customId = String(interaction?.data?.custom_id ?? '');
  const match = customId.match(/^new:([A-Za-z0-9_-]{16})$/u);
  const stateId = match?.[1];
  const state = stateId ? dependencies.uiState.get(stateId) : null;
  const invalid = modalStateError(dependencies, interaction, state);
  if (invalid) return respond(dependencies, interaction, privateResponse(invalid));

  const taskText = modalText(interaction);
  if (taskText.length < 1 || taskText.length > 4_000) {
    return respond(dependencies, interaction, privateResponse('任务内容必须为 1–4000 个字符。'));
  }
  await defer(dependencies, interaction);

  let submission = submissions.get(stateId);
  if (!submission) {
    const submissionInteractionId = String(interaction.id);
    const promise = (async () => {
      let projects;
      try {
        projects = await authoritativeProjects(dependencies);
      } catch {
        return '项目目录刷新失败，请稍后重新执行 /新建任务。';
      }
      const refreshedProject = state.selectionId === NO_PROJECT
        ? { id: NO_PROJECT, name: '无项目', roots: [] }
        : (Array.isArray(projects) ? projects : []).find((project) => String(project?.id ?? '') === state.selectionId);
      if (!refreshedProject || projectFingerprint(refreshedProject) !== state.projectFingerprint) {
        return '项目已删除或发生变化，请重新执行 /新建任务。';
      }

      let selection;
      try {
        selection = resolveProjectSelection({
          projects: Array.isArray(projects) ? projects : [],
          selectionId: state.selectionId,
          projectlessRoot: dependencies.projectlessRoot,
        });
      } catch {
        return '项目已删除或发生变化，请重新执行 /新建任务。';
      }

      let result;
      try {
        result = await dependencies.createNewTaskOnce({
          state: dependencies.creationState,
          interactionId: submissionInteractionId,
          selection,
          worktreeRoot: dependencies.worktreeRoot,
          text: taskText,
          codexPath: dependencies.codexPath,
          processCwd: dependencies.processCwd,
          clientFactory: dependencies.clientFactory,
          gitRunner: dependencies.gitRunner,
          fileSystem: dependencies.fileSystem,
          persistState: dependencies.persistCreationState,
          now: new Date(nowValue(dependencies)),
        });
      } catch {
        return '任务创建失败；未创建可继续的任务。请检查系统状态后重试。';
      }
      insertCreatedTask(dependencies, result, selection);
      return creationReceipt(result, selection);
    })();
    submission = { interactionId: submissionInteractionId, promise };
    submissions.set(stateId, submission);
    promise.then((receipt) => { submission.receipt = receipt; }).catch(() => {});
  }
  const receipt = submission.receipt ?? await submission.promise;
  return editOriginal(dependencies, interaction, { content: receipt });
}

function componentStateError(dependencies, interaction, state) {
  if (!state) return '内容已过期或按钮无效，请重新执行命令。';
  if (nowValue(dependencies) >= state.expiresAt) return '内容已过期，请重新执行命令。';
  if (state.userId !== userId(interaction) || state.guildId !== guildId(interaction)) return '此按钮不属于当前用户或服务器。';
  return null;
}

async function handleComponent(dependencies, interaction) {
  const customId = String(interaction?.data?.custom_id ?? '');
  const pageMatch = customId.match(/^page:([A-Za-z0-9_-]{16}):(prev|next|noop)$/u);
  if (pageMatch) {
    const state = dependencies.uiState.get(pageMatch[1]);
    const invalid = componentStateError(dependencies, interaction, state);
    if (invalid || state?.kind !== 'page') return respond(dependencies, interaction, privateResponse(invalid ?? '内容已过期或按钮无效，请重新执行命令。'));
    if (pageMatch[2] === 'prev') state.page = Math.max(0, state.page - 1);
    if (pageMatch[2] === 'next') state.page = Math.min(state.pages.length - 1, state.page + 1);
    return respond(dependencies, interaction, { type: 7, data: pagePayload(pageMatch[1], state) });
  }

  const detailMatch = customId.match(/^detail:([A-Za-z0-9_-]{16})$/u);
  if (detailMatch) {
    const state = dependencies.uiState.get(detailMatch[1]);
    const invalid = componentStateError(dependencies, interaction, state);
    if (invalid || state?.kind !== 'detail') return respond(dependencies, interaction, privateResponse(invalid ?? '内容已过期或按钮无效，请重新执行命令。'));
    const record = findTask(dependencies, state.threadId);
    if (!record) return respond(dependencies, interaction, privateResponse('任务不存在或已不再是侧边栏主任务。'));
    return renderDetailInteraction(dependencies, interaction, record);
  }
  return respond(dependencies, interaction, privateResponse('内容已过期或按钮无效，请重新执行命令。'));
}

/** Create the private, single-user Interaction router. */
export function createInteractionRouter(dependencies = {}) {
  dependencies.uiState ??= new Map();
  const submissions = new Map();

  return {
    async handle(interaction) {
      const authorization = authorizeInteraction(interaction, dependencies.config);
      if (!authorization.allowed) {
        if (Number(interaction?.type) === 4) {
          return respond(dependencies, interaction, { type: 8, data: { choices: [] } });
        }
        return respond(dependencies, interaction, privateResponse('此交互无权使用或不可用。'));
      }
      if (Number(interaction?.type) === 4) {
        const commandName = String(interaction?.data?.name ?? '');
        let choices = [];
        if (commandName === '新建任务') choices = projectChoices(dependencies, focusedValue(interaction));
        if (commandName === '任务详情' || commandName === '继续任务') choices = taskChoices(dependencies, focusedValue(interaction));
        return respond(dependencies, interaction, { type: 8, data: { choices: normalizeChoices(choices) } });
      }
      if (Number(interaction?.type) === 2) return handleCommand(dependencies, interaction);
      if (Number(interaction?.type) === 5) return handleModal(dependencies, submissions, interaction);
      if (Number(interaction?.type) === 3) return handleComponent(dependencies, interaction);
      return respond(dependencies, interaction, privateResponse('不支持的交互类型。'));
    },
    sweepExpiredUiState(at = nowValue(dependencies)) {
      let removed = 0;
      for (const [stateId, state] of dependencies.uiState) {
        if (Number(at) >= Number(state?.expiresAt)) {
          dependencies.uiState.delete(stateId);
          submissions.delete(stateId);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

export async function dispatchCommand(interaction, dependencies) {
  return createInteractionRouter(dependencies).handle(interaction);
}

export async function dispatchModal(interaction, dependencies) {
  return createInteractionRouter(dependencies).handle(interaction);
}
