import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import path from 'node:path';

import { COMMAND_NAMES, authorizeInteraction, ephemeral, validNewTaskModelEffort } from './discord-commands-lib.mjs';
import { cancelContinuationPersisted as cancelPersistedContinuation, createContinuationRequest } from './discord-bridge-lib.mjs';
import { renderHealthReport, runFullHealthChecks, runQuickHealthChecks } from './discord-health-lib.mjs';
import { NO_PROJECT, resolveProjectSelection } from './discord-task-create-lib.mjs';
import { supportText } from './rollout-completion-watcher-lib.mjs';
import {
  buildTakeoverSnapshot,
  createTakeoverUiState,
  hasNewActiveTasks,
  validateTakeoverUiState,
} from './codex-takeover-lib.mjs';

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

async function untimedInitialRequest(fetchImpl, url, method, body) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Discord interaction request failed: network');
  }
  const status = Number(response?.status);
  if (!isSuccessful(response)) {
    throw new Error(`Discord interaction request failed: ${status || 'unknown'}`);
  }
  if (status === 204) return null;
  try {
    return typeof response?.json === 'function' ? await response.json() : null;
  } catch {
    return null;
  }
}

async function discordRequest(fetchImpl, url, method, body, {
  now,
  sleepImpl,
  policy,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  if (policy.maxElapsedMs === 0) {
    return untimedInitialRequest(fetchImpl, url, method, body);
  }
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
    if (Math.max(0, Number(now()) - startedAt) > policy.maxElapsedMs) {
      throw new Error('Discord interaction request failed: timeout');
    }
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
  const singleLine = text(value, fallback).replace(/@/gu, '＠').replace(/\s+/gu, ' ');
  const escaped = singleLine.replace(/([\\`*_{}\[\]()#+.!|>~-])/gu, '\\$1');
  return escaped.length <= maximum ? escaped : `${escaped.slice(0, Math.max(0, maximum - 1))}…`;
}

function markdownBodyValue(value, fallback = '未知', maximum = 20_000) {
  const normalized = text(value, fallback).replace(/\r\n?/gu, '\n').replace(/@/gu, '＠');
  const escaped = normalized.replace(/([\\`*_{}\[\]()#+.!|>~-])/gu, '\\$1');
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

/** Render a takeover risk list without exposing thread IDs, PIDs, or paths. */
export function renderTakeoverPreview(snapshot, {
  desktopRunning = false,
  indexAvailable = true,
  newTasksDetected = false,
} = {}) {
  if (!desktopRunning) return { content: 'Codex 桌面端未运行，无需退出。' };
  if (!indexAvailable) {
    return {
      embeds: [{
        description: '## Codex 正在运行\n\n⚠️ 任务清单不可用。为安全起见，本次不会退出，也未提供退出确认。',
      }],
    };
  }
  const lines = (Array.isArray(snapshot?.items) ? snapshot.items : []).map((item, index) => {
    const status = item?.status === 'confirmation-required' ? '待确认' : '正在执行';
    const target = item?.target ? '，目标任务' : '';
    return `${index + 1}. ${metadataText(item?.taskName, '未命名任务', 200)}（${status}${target}）`;
  });
  const remaining = Math.max(0, Math.floor(Number(snapshot?.remaining) || 0));
  if (remaining > 0) lines.push(`另有 ${remaining} 个任务未列出。`);
  return {
    embeds: [{
      description: [
        '## Codex 正在运行',
        newTasksDetected ? '⚠️ 检测到新活动任务，原确认已失效。请重新核对后再次确认。' : '',
        lines.length ? lines.join('\n') : '未检测到运行中主任务。',
        '⚠️ 强制退出可能中断以上桌面任务。',
      ].filter(Boolean).join('\n\n'),
    }],
  };
}

function taskListValues(tasks, { status = '全部' } = {}) {
  const desired = String(status ?? '全部');
  return (Array.isArray(tasks) ? tasks : [])
    .filter((item) => desired === '全部' || statusLabel(item?.status) === desired)
    .sort((left, right) => Number(right?.status === 'running') - Number(left?.status === 'running'))
    .slice(0, 10);
}

function taskListLines(values) {
  return values.map((item, index) => [
    `${index + 1}. **项目：** ${metadataText(item?.projectName, '无项目')}`,
    `   **任务：** ${metadataText(item?.taskName, '未命名任务')}`,
    `   **状态：** ${metadataText(statusLabel(item?.status))}｜**最后活动：** ${formatTimestamp(item?.lastActivityAt)}｜**运行时间：** ${formatDuration(item?.runtimeMs)}`,
  ].join('\n'));
}

export function renderTaskList(tasks, { status = '全部' } = {}) {
  const desired = String(status ?? '全部');
  const values = taskListValues(tasks, { status: desired });
  const running = values.filter((item) => item?.status === 'running');
  const recent = values.filter((item) => item?.status !== 'running');
  return [
    '## 进行中的任务',
    ...(running.length ? taskListLines(running) : ['当前没有进行中的任务。']),
    '',
    desired === '全部' ? '## 最近任务' : `## 最近任务（${metadataText(desired, '全部')}）`,
    ...(recent.length ? taskListLines(recent) : [`没有符合“${metadataText(desired, '全部')}”条件的最近主任务。`]),
  ].join('\n');
}

function continuationStatusLabel(status) {
  return ({
    queued: '等待发送',
    'takeover-claimed': '接管处理中',
    resuming: '正在连接',
    submitting: '正在提交启动请求',
    attempting: '正在尝试',
    'start-submitted': '启动请求已提交',
    'start-uncertain': '启动结果不确定',
    'confirmed-start': '已开始',
    acknowledging: '已开始，正在回执',
    delivered: '已送达',
    cancelled: '已取消',
    failed: '失败',
  })[String(status ?? '')] ?? '未知';
}

function continuationSummaryText(value) {
  const safe = String(value ?? '')
    .replace(/@/gu, '＠')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/[*_`#>|~[\]{}()\\]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return displayText(safe, '（无可用摘要）', 120);
}

function continuationQueueView(items, taskIndex = null) {
  const values = Array.isArray(items) ? items : [];
  if (!values.length) return { description: '## 继续队列\n当前没有继续请求。', displayed: [] };
  const tasks = Array.isArray(taskIndex?.tasks) ? taskIndex.tasks : [];
  const priorityStatuses = ['start-uncertain', 'start-submitted', 'submitting', 'attempting', 'takeover-claimed', 'resuming', 'acknowledging', 'confirmed-start', 'queued'];
  const priorityStatusSet = new Set(priorityStatuses);
  const ordered = [
    ...priorityStatuses.flatMap((status) => values.filter((item) => item?.status === status)),
    ...values.filter((item) => !priorityStatusSet.has(item?.status)),
  ];
  const candidates = ordered.slice(0, 20);
  const entryText = (item, index) => {
      const task = tasks.find((candidate) => String(candidate?.threadId ?? '').toLocaleLowerCase() === String(item?.threadId ?? '').toLocaleLowerCase());
      const projectName = item?.projectName ?? task?.projectName ?? '无项目';
      const taskName = item?.taskName ?? task?.taskName ?? `任务 …${String(item?.threadId ?? '').slice(-8)}`;
      return [
        `${index + 1}.`,
        `**项目：** ${metadataText(projectName, '无项目')}`,
        `**任务：** ${metadataText(taskName, '未命名任务')}`,
        `**内容：** ${metadataText(continuationSummaryText(item?.summary), '（无可用摘要）', 140)}`,
        `**状态：** ${continuationStatusLabel(item?.status)}`,
        `**队列编号：** …${metadataText(String(item?.queueId ?? '').slice(-8), '未知', 16)}`,
      ].join('\n\n');
    };
  const displayed = [];
  let description = '## 继续队列';
  for (let index = 0; index < candidates.length; index += 1) {
    const entry = entryText(candidates[index], index);
    const omittedAfter = values.length - displayed.length - 1;
    const separator = displayed.length ? '\n\n---\n\n' : '\n\n';
    const omittedText = omittedAfter > 0 ? `\n\n…另有 ${omittedAfter} 项未显示。` : '';
    if (`${description}${separator}${entry}${omittedText}`.length > EMBED_MARKDOWN_LIMIT) break;
    description += `${separator}${entry}`;
    displayed.push(candidates[index]);
  }
  const omitted = values.length - displayed.length;
  if (omitted > 0) description += `\n\n…另有 ${omitted} 项未显示。`;
  return { description, displayed };
}

export function renderContinuationQueue(items, taskIndex = null) {
  return continuationQueueView(items, taskIndex).description;
}

export function renderTaskDetail(detail) {
  if (!detail) return '任务不存在或已不再是侧边栏主任务。';
  const taskText = markdownBodyValue(detail.taskText, detail.contentAvailable === false ? '内容暂不可用，请稍后重试。' : '（无可用内容）');
  const resultText = markdownBodyValue(detail.resultText, detail.contentAvailable === false ? '内容暂不可用，请稍后重试。' : '（暂无结果）');
  return [
    `# ${metadataText(detail.taskName, '未命名任务', 200)}`,
    `**项目：** ${metadataText(detail.projectName, '无项目', 200)}`,
    `**任务：** ${metadataText(detail.taskName, '未命名任务', 200)}`,
    `**状态：** ${metadataText(statusLabel(detail.status), '未知', 100)}`,
    `**任务 ID：** …${metadataText(text(detail.threadId).slice(-8), '未知', 16)}`,
    `**开始时间：** ${formatTimestamp(detail.startedAt ?? detail.createdAt)}`,
    `**最后活动：** ${formatTimestamp(detail.lastActivityAt)}`,
    `**运行时间：** ${formatDuration(detail.runtimeMs)}`,
    '',
    '## 原始任务',
    taskText,
    '',
    '## 最新结果',
    resultText,
  ].join('\n');
}

function taskStatusCard(detail) {
  const status = String(detail?.status ?? '');
  const presentation = ({
    running: ['Codex 任务进行中…', 9807270],
    'confirmation-required': ['Codex 任务待确认', 15965202],
    completed: ['Codex 任务已完成', 3066993],
    failed: ['Codex 任务失败', 15158332],
  })[status] ?? ['Codex 任务等待中', 9807270];
  const fields = [
    { name: '项目名', value: metadataText(detail?.projectName, '无项目', 1_024), inline: true },
    { name: '任务名', value: metadataText(detail?.taskName, '未命名任务', 1_024), inline: true },
    { name: '任务', value: markdownBodyValue(detail?.taskText, '（无可用内容）', 1_024), inline: false },
  ];
  const resultLabel = status === 'confirmation-required' ? '待确认' : ['completed', 'failed'].includes(status) ? '结果' : '';
  if (resultLabel) {
    fields.push({ name: resultLabel, value: markdownBodyValue(detail?.resultText, '（暂无结果）', 1_024), inline: false });
  }
  const footer = supportText({ model: detail?.model, effort: detail?.reasoningEffort });
  return {
    title: presentation[0],
    color: presentation[1],
    fields,
    ...(footer ? { footer: { text: footer } } : {}),
  };
}

export function renderSearchResults(results, keyword) {
  const values = (Array.isArray(results) ? results : []).slice(0, 10);
  if (!values.length) return `没有找到与“${metadataText(keyword, '', 100)}”匹配的主任务。`;
  return [
    `## 搜索结果：${metadataText(keyword, '', 100)}`,
    ...values.map((item, index) => [
      `${index + 1}. **项目：** ${metadataText(item?.projectName, '无项目')}`,
      `   **任务：** ${metadataText(item?.taskName, '未命名任务')}`,
      `   **状态：** ${metadataText(statusLabel(item?.status))}｜**最后活动：** ${formatTimestamp(item?.lastActivityAt)}`,
    ].join('\n')),
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
  const transition = previous === null
    ? `**额度：** 当前剩余 ${percent(remaining)}%`
    : `**额度：** ${percent(previous)}% → ${percent(remaining)}%`;
  const resetText = Number.isFinite(resetMs) && resetMs > Number(nowMs)
    ? formatDuration(resetMs - Number(nowMs))
    : '未知或已经到期';
  return [
    '## Codex 周额度',
    transition,
    `**距上次变化：** ${Number.isFinite(lastChangeMs) ? formatDuration(Math.max(0, Number(nowMs) - lastChangeMs)) : '未知'}`,
    `**使用速度：** ${trend}`,
    `**距下次更新还有：** ${resetText}`,
    `**按当前速度：** ${exhaustion(remaining, currentRate, resetMs, observedMs)}`,
    `**按重置至今平均速度：** ${exhaustion(remaining, averageRate, resetMs, observedMs)}`,
    `**快照时间：** ${formatTimestamp(state.observedAt)}${age > 15 * 60_000 ? '（数据已过期）' : ''}`,
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
  const timestamps = status.timestamps ?? {};
  const category = safeCategory(status.latestErrorCategory ?? status.gateway?.lastError ?? status.rollout?.lastError);
  return [
    '## 系统状态',
    `**Gateway：** ${stateName(status.gateway)}`,
    `**Discord REST：** ${stateName(status.discordRest)}`,
    `**通知监听：** ${stateName(status.notificationListener)}｜**最近成功：** ${formatTimestamp(status.notificationListener?.lastSuccessAt)}`,
    `**完成补发：** ${stateName(status.rollout)}｜**最近推进：** ${formatTimestamp(status.rollout?.lastProgressAt)}`,
    `**任务索引：** ${finiteNumber(index.count) ?? 0} 项｜**生成时间：** ${formatTimestamp(index.generatedAt)}`,
    `**继续队列：** ${finiteNumber(status.queueCount) ?? 0} 项`,
    `**额度快照：** ${formatTimestamp(quota.observedAt)}`,
    `**命令注册：** ${formatTimestamp(timestamps.lastRegistrationAt)}｜**索引更新：** ${formatTimestamp(timestamps.lastIndexUpdateAt)}`,
    `**Gateway 事件：** ${formatTimestamp(timestamps.lastGatewayEventAt)}｜**rollout 推进：** ${formatTimestamp(timestamps.lastRolloutProgressAt)}`,
    `**通知发送：** ${formatTimestamp(timestamps.lastNotificationSentAt)}｜**任务创建：** ${formatTimestamp(timestamps.lastTaskCreationAt)}｜**队列重试：** ${formatTimestamp(timestamps.lastQueueRetryAt)}`,
    `**最近错误类别：** ${category}`,
  ].join('\n');
}

export function renderHelp() {
  const descriptions = {
    任务列表: '查看进行中与最近主任务；进行中的任务始终置顶。',
    任务详情: '选择主任务并查看完整任务与最新结果；运行中可停止当前一轮。',
    任务搜索: '按关键词搜索项目、标题和任务正文。',
    新建任务: '从已保存项目或“无项目”创建持久任务，并可首次选择模型与推理强度；Git 项目使用隔离工作树。',
    继续任务: '选择主任务并发送新的多行指令，优先转向指定任务。',
    继续队列: '查看或取消尚未开始的继续请求。',
    额度: '查看最后一份本机官方周额度快照。',
    系统状态: '查看 Gateway、监听、索引、队列与额度状态。',
    系统测试: '执行快速检查，或执行三路完整通知测试。',
    退出codex: '先查看可能中断的主任务，再通过一次性确认安全退出 Codex 桌面端。',
    帮助: '显示本帮助。',
  };
  return [
    '# Codex Discord 命令帮助',
    ...COMMAND_NAMES.map((name) => `- **/${name}** — ${descriptions[name]}`),
    '',
    '### 远程接管',
    '- 长按回复与 `/继续任务` 共用同一流程：先转向指定任务；遇到写入者占用时安全排队，并可停止该任务当前一轮后立即继续。',
    '- 续接成功回执带“查看当前运行状态”按钮，可实时查看进行中、待确认或已完成卡片。',
    '- 精确停止失败时才会显示退出整个 Codex 的最终兜底；不会自动退出，也不会停止其他任务。',
    '- `/退出codex` 会先列出可能中断的主任务，只有你再次确认后才退出 Codex 桌面端；风险清单变化时必须重新确认。',
    '- 从 Discord 新建或继续的任务，其待确认和最终结果会回到发起任务的原频道；不转发 commentary、工具调用或其他过程信息。',
    '',
    '### 本机服务',
    '- Codex 桌面端可以关闭，但电脑必须保持 Windows 用户已登录、处于唤醒状态并已联网；关机、休眠或 Bot 离线时命令不可执行。',
    '- `Codex Discord 控制台` 提供临时开启、临时停止、长期开启、长期停用。临时开启或停止不改变长期自启设置。',
    '',
    '所有消息结果仅调用者可见，并且不会触发 Discord mentions。',
    '已有本地队列会在电脑恢复、登录并联网后继续处理。Markdown 结构由 Bot 生成，任务值会转义、截断且禁用 mentions。',
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

function channelId(interaction) {
  return String(interaction?.channel_id ?? '');
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

export function createTaskStatusRow(dependencies, { threadId, userId: ownerUserId, guildId: ownerGuildId }) {
  const stateId = makeStateId(dependencies);
  dependencies.uiState.set(stateId, {
    kind: 'task-status',
    userId: String(ownerUserId),
    guildId: String(ownerGuildId),
    threadId: String(threadId),
    expiresAt: nowValue(dependencies) + UI_TTL_MS,
  });
  return {
    type: 1,
    components: [{ type: 2, style: 2, label: '查看当前运行状态', custom_id: `task-status:${stateId}` }],
  };
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

function pageComponents(stateId, page, total, extraComponents = []) {
  const rows = [];
  if (total > 1) {
    rows.push({
      type: 1,
      components: [
        { type: 2, style: 2, label: '上一页', custom_id: `page:${stateId}:prev`, disabled: page <= 0 },
        { type: 2, style: 2, label: `${page + 1}/${total}`, custom_id: `page:${stateId}:noop`, disabled: true },
        { type: 2, style: 2, label: '下一页', custom_id: `page:${stateId}:next`, disabled: page >= total - 1 },
      ],
    });
  }
  return [...rows, ...extraComponents];
}

function pagePayload(stateId, state) {
  return mentionSafePayload({
    embeds: [{ description: state.pages[state.page] }],
    components: pageComponents(stateId, state.page, state.pages.length, state.extraComponents),
  });
}

function createPageState(dependencies, pages, interaction, extraComponents = []) {
  if (pages.length <= 1) {
    return { stateId: null, payload: privatePayload({ embeds: [{ description: pages[0] }], components: extraComponents }) };
  }
  const stateId = makeStateId(dependencies);
  const state = {
    kind: 'page', userId: userId(interaction), guildId: guildId(interaction), pages, page: 0,
    extraComponents,
    expiresAt: nowValue(dependencies) + UI_TTL_MS,
  };
  dependencies.uiState.set(stateId, state);
  return { stateId, payload: pagePayload(stateId, state) };
}

function createStopCurrentButton(dependencies, interaction, task) {
  if (task?.status !== 'running') return null;
  const stateId = makeStateId(dependencies);
  dependencies.uiState.set(stateId, {
    kind: 'stop-current',
    userId: userId(interaction),
    guildId: guildId(interaction),
    threadId: String(task.threadId),
    expiresAt: nowValue(dependencies) + UI_TTL_MS,
  });
  return { type: 2, style: 4, label: '停止当前运行', custom_id: `stop-current:${stateId}` };
}

function createContinueTargetButton(dependencies, interaction, task) {
  const stateId = makeStateId(dependencies);
  dependencies.uiState.set(stateId, {
    kind: 'continue-target',
    userId: userId(interaction),
    guildId: guildId(interaction),
    threadId: String(task.threadId),
    expiresAt: nowValue(dependencies) + UI_TTL_MS,
  });
  const stopButton = createStopCurrentButton(dependencies, interaction, task);
  return {
    type: 1,
    components: [
      { type: 2, style: 1, label: '继续任务', custom_id: `continue-open:${stateId}` },
      stopButton,
    ].filter(Boolean),
  };
}

function detailButtons(dependencies, tasks, interaction) {
  const rows = [];
  const values = (Array.isArray(tasks) ? tasks : []).slice(0, 10);
  for (let index = 0; index < values.length; index += 2) {
    const buttons = [];
    for (const task of values.slice(index, index + 2)) {
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
    rows.push({ type: 1, components: buttons });
  }
  return rows;
}

function continuationQueuePayload(dependencies, interaction) {
  const queue = dependencies.getQueue?.();
  const values = Array.isArray(queue) ? queue : [];
  const view = continuationQueueView(values, dependencies.taskIndex);
  const buttons = [];
  for (const item of view.displayed.filter((candidate) => candidate?.status === 'queued')) {
    const stateId = makeStateId(dependencies);
    dependencies.uiState.set(stateId, {
      kind: 'cancel-continuation',
      userId: userId(interaction),
      guildId: guildId(interaction),
      queueId: String(item.queueId),
      expiresAt: nowValue(dependencies) + UI_TTL_MS,
    });
    buttons.push({
      type: 2,
      style: 4,
      label: `取消 …${String(item.queueId).slice(-8)}`,
      custom_id: `cancel:${stateId}`,
    });
  }
  const components = [];
  for (let index = 0; index < buttons.length; index += 5) {
    components.push({ type: 1, components: buttons.slice(index, index + 5) });
  }
  return mentionSafePayload({
    embeds: [{ description: view.description }],
    components,
  });
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
    receipt = `## 任务创建结果\n任务线程已保留，但首轮启动失败。\n**项目：** ${projectName}\n**任务：** ${taskName}\n**状态：** 首轮启动失败\n**任务 ID：** …${suffix}\n**运行方式：** ${mode}\n**工作目录：** ${safeWorkspaceName(result?.workspace)}`;
  } else if (result?.status === 'start-uncertain') {
    receipt = `## 任务创建结果\n任务可能已经启动，但本地状态尚未确认；请勿重复提交。\n**项目：** ${projectName}\n**任务：** ${taskName}\n**状态：** 等待自动恢复确认\n**任务 ID：** …${suffix}\n**运行方式：** ${mode}\n**工作目录：** ${safeWorkspaceName(result?.workspace)}`;
  } else {
    receipt = `## 任务创建结果\n任务创建成功。\n**项目：** ${projectName}\n**任务：** ${taskName}\n**状态：** 正在运行\n**任务 ID：** …${suffix}\n**运行方式：** ${mode}\n**工作目录：** ${safeWorkspaceName(result?.workspace)}`;
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

function modalText(interaction, fieldId = '任务内容') {
  for (const row of interaction?.data?.components ?? []) {
    for (const component of row?.components ?? []) {
      if (component?.custom_id === fieldId) return String(component?.value ?? '');
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

async function recordCreationReceiptOutcome(dependencies, interaction, outcome) {
  try {
    await dependencies.recordCreationReceiptOutcome?.(String(interaction?.id ?? ''), outcome);
  } catch {
    // Receipt delivery already happened (or already failed); persistence cannot safely be retried here.
  }
}

async function deliverCreationReceipt(dependencies, interaction, receipt) {
  const body = mentionSafePayload({ content: receipt });
  try {
    const message = await dependencies.editOriginal?.(body, interaction);
    await recordCreationReceiptOutcome(dependencies, interaction, {
      status: 'original-edited',
      ...(message?.id ? { messageId: String(message.id) } : {}),
    });
    return body;
  } catch {
    const fallback = privatePayload({ content: receipt });
    try {
      if (typeof dependencies.followup !== 'function') throw new Error('Follow-up delivery unavailable');
      const message = await dependencies.followup(fallback, interaction);
      await recordCreationReceiptOutcome(dependencies, interaction, {
        status: 'followup-sent',
        ...(message?.id ? { messageId: String(message.id) } : {}),
      });
      return fallback;
    } catch {
      const failed = { status: 'failed', errorCategory: 'creation-receipt-delivery-failed' };
      await recordCreationReceiptOutcome(dependencies, interaction, failed);
      return privatePayload({ content: '任务已处理，但 Discord 回执发送失败；请使用 /任务列表 查询结果。' });
    }
  }
}

async function defer(dependencies, interaction) {
  return respond(dependencies, interaction, privateResponse({}, 5));
}

async function deferMessageUpdate(dependencies, interaction) {
  return respond(dependencies, interaction, { type: 6 });
}

function takeoverComponents(stateId) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 4, label: '确认强制退出', custom_id: `takeover-confirm:${stateId}` },
      { type: 2, style: 2, label: '取消', custom_id: `takeover-cancel:${stateId}` },
    ],
  }];
}

function continuationTakeoverComponents(stateId) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 4, label: '中断当前运行并立即继续', custom_id: `takeover-continue:${stateId}` },
        { type: 2, style: 1, label: '取消排队', custom_id: `takeover-queue-cancel:${stateId}` },
      ],
    },
    {
      type: 1,
      components: [{ type: 2, style: 2, label: '保持排队', custom_id: `takeover-keep:${stateId}` }],
    },
  ];
}

function continuationGlobalFallbackComponents(stateId) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 4, label: '退出整个 Codex 并立即继续', custom_id: `takeover-global:${stateId}` },
        { type: 2, style: 1, label: '取消排队', custom_id: `takeover-queue-cancel:${stateId}` },
      ],
    },
    {
      type: 1,
      components: [{ type: 2, style: 2, label: '保持排队', custom_id: `takeover-keep:${stateId}` }],
    },
  ];
}

function queuedTakeoverUnavailable(reason = 'untrusted') {
  const detail = reason === 'index-unavailable'
    ? '当前任务清单不可用，无法安全确认会中断哪些桌面任务。'
    : '当前无法确认占用者是 Codex 桌面端。';
  return {
    content: `目标任务正被其他写入者占用，继续请求已安全排队。${detail}占用者可能是其他 CLI 或插件，因此不会提供强制退出；请求将保持排队。`,
    components: [],
  };
}

export async function inspectQueuedTakeover(dependencies, targetThreadId) {
  const [indexResult, statusResult] = await Promise.allSettled([
    Promise.resolve().then(() => dependencies.refreshTaskIndex()),
    Promise.resolve().then(() => dependencies.getCodexControlStatus()),
  ]);
  const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
  if (!status?.ok || typeof status?.desktop?.running !== 'boolean' || !status.desktop.running) {
    return { available: false, payload: queuedTakeoverUnavailable() };
  }
  const index = indexResult.status === 'fulfilled' ? indexResult.value : null;
  if (!Array.isArray(index?.tasks)) {
    return { available: false, payload: queuedTakeoverUnavailable('index-unavailable') };
  }
  return {
    available: true,
    snapshot: buildTakeoverSnapshot(index, { targetThreadId }),
  };
}

function continuationTakeoverStateAndPayload(dependencies, {
  queueId,
  targetThreadId,
  snapshot,
  ownerUserId,
  ownerGuildId,
  messageId = null,
  newTasksDetected = false,
}) {
  const stateId = makeStateId(dependencies);
  const state = {
    ...createTakeoverUiState({
      id: stateId,
      kind: 'takeover-continue',
      userId: ownerUserId,
      guildId: ownerGuildId,
      targetThreadId,
      queueId,
      snapshot,
      nowMs: nowValue(dependencies),
    }),
    messageId: messageId == null ? null : String(messageId),
  };
  const payload = mentionSafePayload({
    content: '目标任务正被其他写入者占用，继续请求已安全排队。请核对下列桌面任务后选择是否接管。',
    ...renderTakeoverPreview(snapshot, { desktopRunning: true, newTasksDetected }),
    components: continuationTakeoverComponents(stateId),
  });
  return { stateId, state, payload };
}

async function publishContinuationTakeover(dependencies, interaction, {
  queueId,
  targetThreadId,
  snapshot,
  messageId = null,
  newTasksDetected = false,
}) {
  const { stateId, state, payload } = continuationTakeoverStateAndPayload(dependencies, {
    queueId,
    targetThreadId,
    snapshot,
    ownerUserId: userId(interaction),
    ownerGuildId: guildId(interaction),
    messageId,
    newTasksDetected,
  });
  dependencies.uiState.set(stateId, state);
  try {
    const reply = await dependencies.editOriginal?.(payload, interaction);
    const boundMessageId = state.messageId || String(reply?.id ?? '');
    if (!boundMessageId) {
      dependencies.uiState.delete(stateId);
      return editOriginal(dependencies, interaction, queuedTakeoverUnavailable());
    }
    state.messageId = boundMessageId;
    return payload;
  } catch {
    dependencies.uiState.delete(stateId);
    throw new Error('Continuation takeover response failed');
  }
}

export async function publishContinuationTakeoverMessage(dependencies, {
  queueId,
  targetThreadId,
  snapshot,
  userId: ownerUserId,
  guildId: ownerGuildId,
  channelId,
  replyToMessageId,
}) {
  const { stateId, state, payload } = continuationTakeoverStateAndPayload(dependencies, {
    queueId,
    targetThreadId,
    snapshot,
    ownerUserId,
    ownerGuildId,
  });
  dependencies.uiState.set(stateId, state);
  try {
    const reply = await dependencies.sendMessage({ channelId, replyToMessageId, ...payload });
    const messageId = String(reply?.id ?? '');
    if (!messageId) throw new Error('Discord response did not include a message ID');
    state.messageId = messageId;
    return payload;
  } catch (error) {
    dependencies.uiState.delete(stateId);
    throw error;
  }
}

async function publishContinuationGlobalFallback(dependencies, interaction, state, {
  snapshot = state.snapshot,
  newTasksDetected = false,
} = {}) {
  const stateId = makeStateId(dependencies);
  const fallback = {
    ...createTakeoverUiState({
      id: stateId,
      kind: 'takeover-global-fallback',
      userId: userId(interaction),
      guildId: guildId(interaction),
      targetThreadId: state.targetThreadId,
      queueId: state.queueId,
      snapshot,
      nowMs: nowValue(dependencies),
    }),
    messageId: String(interaction?.message?.id ?? state.messageId ?? ''),
  };
  if (!fallback.messageId) {
    return editOriginal(dependencies, interaction, {
      content: '无法建立最终兜底确认；请求已保持排队。',
      components: [],
    });
  }
  dependencies.uiState.set(stateId, fallback);
  return editOriginal(dependencies, interaction, mentionSafePayload({
    content: '未能确认已停止目标任务的当前运行。为避免误伤其他任务，没有退出 Codex；如仍需立即继续，可选择最终兜底。',
    ...renderTakeoverPreview(snapshot, { desktopRunning: true, newTasksDetected }),
    components: continuationGlobalFallbackComponents(stateId),
  }));
}

async function publishTakeoverConfirmation(dependencies, interaction, snapshot, {
  messageId = null,
  newTasksDetected = false,
} = {}) {
  const stateId = makeStateId(dependencies);
  const state = {
    ...createTakeoverUiState({
      id: stateId,
      kind: 'takeover-exit',
      userId: userId(interaction),
      guildId: guildId(interaction),
      snapshot,
      nowMs: nowValue(dependencies),
    }),
    messageId: messageId == null ? null : String(messageId),
  };
  dependencies.uiState.set(stateId, state);
  const payload = mentionSafePayload({
    ...renderTakeoverPreview(snapshot, { desktopRunning: true, newTasksDetected }),
    components: takeoverComponents(stateId),
  });
  try {
    const reply = await dependencies.editOriginal?.(payload, interaction);
    const boundMessageId = state.messageId || String(reply?.id ?? '');
    if (!boundMessageId) {
      dependencies.uiState.delete(stateId);
      return editOriginal(dependencies, interaction, {
        content: '无法创建安全的退出确认，请重新执行 /退出codex。',
        components: [],
      });
    }
    state.messageId = boundMessageId;
    return payload;
  } catch {
    dependencies.uiState.delete(stateId);
    throw new Error('Takeover confirmation response failed');
  }
}

async function beginTakeoverExit(dependencies, interaction) {
  await defer(dependencies, interaction);
  const [indexResult, statusResult] = await Promise.allSettled([
    Promise.resolve().then(() => dependencies.refreshTaskIndex()),
    Promise.resolve().then(() => dependencies.getCodexControlStatus()),
  ]);
  const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
  if (!status?.ok || typeof status?.desktop?.running !== 'boolean') {
    return editOriginal(dependencies, interaction, { content: 'Codex 桌面端状态暂不可用；本次未执行退出。' });
  }
  if (!status.desktop.running) {
    return editOriginal(dependencies, interaction, renderTakeoverPreview(null, { desktopRunning: false }));
  }
  const index = indexResult.status === 'fulfilled' ? indexResult.value : null;
  if (!Array.isArray(index?.tasks)) {
    return editOriginal(dependencies, interaction, renderTakeoverPreview(null, {
      desktopRunning: true,
      indexAvailable: false,
    }));
  }
  return publishTakeoverConfirmation(dependencies, interaction, buildTakeoverSnapshot(index));
}

function takeoverStateError(dependencies, interaction, state) {
  const validated = validateTakeoverUiState(state, {
    kind: 'takeover-exit',
    userId: userId(interaction),
    guildId: guildId(interaction),
    nowMs: nowValue(dependencies),
  });
  if (!validated.ok) {
    if (validated.reason === 'expired') return '此退出确认已过期，请重新执行 /退出codex。';
    if (['wrong-user', 'wrong-guild'].includes(validated.reason)) return '此退出确认不属于当前用户或服务器，无权执行。';
    return '此退出确认已使用、过期或无效，请重新执行 /退出codex。';
  }
  const componentMessageId = String(interaction?.message?.id ?? '');
  if (!state.messageId || componentMessageId !== String(state.messageId)) {
    return '此退出确认不属于当前消息或已失效。';
  }
  return null;
}

async function cancelTakeoverExit(dependencies, interaction, stateId) {
  const state = dependencies.uiState.get(stateId);
  const invalid = takeoverStateError(dependencies, interaction, state);
  if (invalid) {
    if (state && nowValue(dependencies) >= Number(state.expiresAt)) dependencies.uiState.delete(stateId);
    return respond(dependencies, interaction, privateResponse(invalid));
  }
  dependencies.uiState.delete(stateId);
  return respond(dependencies, interaction, {
    type: 7,
    data: mentionSafePayload({ content: '已取消退出 Codex。', components: [] }),
  });
}

async function confirmTakeoverExit(dependencies, routerState, interaction, stateId) {
  const state = dependencies.uiState.get(stateId);
  const invalid = takeoverStateError(dependencies, interaction, state);
  if (invalid) {
    if (state && nowValue(dependencies) >= Number(state.expiresAt)) dependencies.uiState.delete(stateId);
    return respond(dependencies, interaction, privateResponse(invalid));
  }

  dependencies.uiState.delete(stateId);
  if (routerState.takeoverInProgress) {
    return respond(dependencies, interaction, privateResponse('另一个退出操作正在执行；本确认未重复执行。'));
  }
  routerState.takeoverInProgress = true;
  try {
    await deferMessageUpdate(dependencies, interaction);
    const [indexResult, statusResult] = await Promise.allSettled([
      Promise.resolve().then(() => dependencies.refreshTaskIndex()),
      Promise.resolve().then(() => dependencies.getCodexControlStatus()),
    ]);
    const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
    if (!status?.ok || typeof status?.desktop?.running !== 'boolean') {
      return editOriginal(dependencies, interaction, { content: 'Codex 桌面端状态暂不可用；本次未执行退出。', components: [] });
    }
    if (!status.desktop.running) {
      return editOriginal(dependencies, interaction, { content: 'Codex 桌面端已经退出，无需再次操作。', components: [] });
    }
    const index = indexResult.status === 'fulfilled' ? indexResult.value : null;
    if (!Array.isArray(index?.tasks)) {
      return editOriginal(dependencies, interaction, {
        ...renderTakeoverPreview(null, { desktopRunning: true, indexAvailable: false }),
        components: [],
      });
    }
    const currentSnapshot = buildTakeoverSnapshot(index, { targetThreadId: state.targetThreadId });
    if (hasNewActiveTasks(state.snapshot, currentSnapshot)) {
      return publishTakeoverConfirmation(dependencies, interaction, currentSnapshot, {
        messageId: interaction?.message?.id,
        newTasksDetected: true,
      });
    }
    let result;
    try {
      result = await dependencies.stopCodexDesktop();
    } catch {
      result = null;
    }
    if (!result?.ok) {
      return editOriginal(dependencies, interaction, { content: '退出 Codex 失败；未确认桌面端已停止，请稍后重试。', components: [] });
    }
    return editOriginal(dependencies, interaction, { content: 'Codex 桌面端已退出。', components: [] });
  } finally {
    routerState.takeoverInProgress = false;
  }
}

function continuationTakeoverStateError(dependencies, interaction, state, kind = 'takeover-continue') {
  const validated = validateTakeoverUiState(state, {
    kind,
    userId: userId(interaction),
    guildId: guildId(interaction),
    nowMs: nowValue(dependencies),
  });
  if (!validated.ok) {
    if (validated.reason === 'expired') return '此接管建议已过期，请重新执行 /继续任务。';
    if (['wrong-user', 'wrong-guild'].includes(validated.reason)) return '此接管建议不属于当前用户或服务器，无权执行。';
    return '此接管建议已使用、过期或无效，请重新执行 /继续任务。';
  }
  const componentMessageId = String(interaction?.message?.id ?? '');
  if (!state.messageId || componentMessageId !== String(state.messageId)) {
    return '此接管建议不属于当前消息或已失效。';
  }
  if (!state.queueId || !state.targetThreadId) return '此接管建议缺少安全绑定，已拒绝执行。';
  return null;
}

async function keepContinuationQueued(dependencies, interaction, stateId) {
  const state = dependencies.uiState.get(stateId);
  const kind = state?.kind === 'takeover-global-fallback' ? 'takeover-global-fallback' : 'takeover-continue';
  const invalid = continuationTakeoverStateError(dependencies, interaction, state, kind);
  if (invalid) {
    if (state && nowValue(dependencies) >= Number(state.expiresAt)) dependencies.uiState.delete(stateId);
    return respond(dependencies, interaction, privateResponse(invalid));
  }
  dependencies.uiState.delete(stateId);
  await deferMessageUpdate(dependencies, interaction);
  return editOriginal(dependencies, interaction, {
    content: '请求保持排队，可通过 /继续队列 查看或取消。',
    components: [],
  });
}

async function cancelTakeoverQueue(dependencies, interaction, stateId) {
  const state = dependencies.uiState.get(stateId);
  const kind = state?.kind === 'takeover-global-fallback' ? 'takeover-global-fallback' : 'takeover-continue';
  const invalid = continuationTakeoverStateError(dependencies, interaction, state, kind);
  if (invalid) {
    if (state && nowValue(dependencies) >= Number(state.expiresAt)) dependencies.uiState.delete(stateId);
    return respond(dependencies, interaction, privateResponse(invalid));
  }
  dependencies.uiState.delete(stateId);
  await deferMessageUpdate(dependencies, interaction);
  let result;
  try {
    const cancelledAt = new Date(nowValue(dependencies)).toISOString();
    result = typeof dependencies.cancelContinuationPersisted === 'function'
      ? await dependencies.cancelContinuationPersisted(state.queueId, cancelledAt)
      : await cancelPersistedContinuation({
        state: dependencies.continuationState,
        queueId: state.queueId,
        now: cancelledAt,
        persistState: dependencies.persistContinuationState,
      });
  } catch {
    result = { status: 'failed' };
  }
  const content = result?.status === 'cancelled'
    ? '已取消排队；这条继续内容不会发送到 Codex。'
    : result?.status === 'already-started'
      ? '该请求已经开始，无法再取消排队。'
      : '取消排队失败，请通过 /继续队列 检查当前状态。';
  return editOriginal(dependencies, interaction, { content, components: [] });
}

async function stopCurrentTask(dependencies, interaction, stateId) {
  const state = dependencies.uiState.get(stateId);
  const invalid = componentStateError(dependencies, interaction, state);
  if (invalid || state?.kind !== 'stop-current') {
    return respond(dependencies, interaction, privateResponse(invalid ?? '停止按钮已失效，请刷新任务列表。'));
  }
  dependencies.uiState.delete(stateId);
  await deferMessageUpdate(dependencies, interaction);
  let result;
  try {
    result = await dependencies.interruptTask({ threadId: state.threadId });
  } catch {
    result = null;
  }
  const content = result?.ok
    ? '已停止该任务的当前运行。任务本身仍保留，可稍后继续。'
    : result?.reason === 'not-running'
      ? '该任务当前已不在运行，无需停止。'
      : '未能确认已停止该任务的当前运行，请刷新任务列表后重试。';
  return editOriginal(dependencies, interaction, { content, components: [] });
}

function continuationTakeoverResult(result, action = '目标任务的当前运行已停止') {
  if (result?.status === 'started') {
    const suffix = result?.turnId ? `本轮 ID：…${String(result.turnId).slice(-8)}` : '';
    return `${action}，目标任务已开始继续执行。${suffix}`;
  }
  if (result?.status === 'queued') {
    return `${action}，但目标任务仍被占用；请求将继续排队。`;
  }
  if (result?.status === 'uncertain') {
    return `${action}，但目标任务的启动结果不确定；为避免重复执行不会自动重试，请打开原任务确认实际状态。`;
  }
  return `${action}，但目标任务没有成功立即继续；请通过 /继续队列 查看当前状态。`;
}

async function confirmContinuationTakeover(dependencies, routerState, interaction, stateId) {
  const state = dependencies.uiState.get(stateId);
  const invalid = continuationTakeoverStateError(dependencies, interaction, state);
  if (invalid) {
    if (state && nowValue(dependencies) >= Number(state.expiresAt)) dependencies.uiState.delete(stateId);
    return respond(dependencies, interaction, privateResponse(invalid));
  }

  dependencies.uiState.delete(stateId);
  if (routerState.takeoverInProgress) {
    return respond(dependencies, interaction, privateResponse('另一个任务控制操作正在执行；本请求未重复执行。'));
  }
  routerState.takeoverInProgress = true;
  try {
    await deferMessageUpdate(dependencies, interaction);
    let claim;
    try {
      claim = await dependencies.claimContinuationTakeover({
        queueId: state.queueId,
        targetThreadId: state.targetThreadId,
      });
    } catch {
      claim = { status: 'failed', reason: 'state-persist-failed' };
    }
    if (claim?.status !== 'claimed') {
      const content = claim?.status === 'unavailable'
        ? '队列状态已变化，目标请求可能已经取消或由其他处理器接管；未中断任务，也未重复执行。'
        : '无法安全锁定目标队列；未中断任务，目标请求将保持排队。';
      return editOriginal(dependencies, interaction, { content, components: [] });
    }
    let interrupted;
    try {
      interrupted = await dependencies.interruptTask({ threadId: state.targetThreadId });
    } catch {
      interrupted = null;
    }
    if (!interrupted?.ok && interrupted?.reason !== 'not-running') {
      let release;
      try {
        release = await dependencies.releaseContinuationTakeoverClaim(claim);
      } catch {
        release = { status: 'failed' };
      }
      if (release?.status === 'queued' && interrupted?.reason === 'interrupt-not-confirmed') {
        return publishContinuationGlobalFallback(dependencies, interaction, state);
      }
      if (release?.status === 'queued') {
        return editOriginal(dependencies, interaction, {
          content: '无法确认目标任务由 Codex 桌面端占用；没有退出 Codex，请求将保持排队。',
          components: [],
        });
      }
      return editOriginal(dependencies, interaction, {
        content: '未能确认已停止目标任务的当前运行；队列锁定状态暂不可用，请通过 /继续队列 检查。',
        components: [],
      });
    }
    let result;
    try {
      result = await dependencies.retryContinuation(claim);
    } catch {
      result = { status: 'failed' };
    }
    const components = result?.status === 'started' ? [createTaskStatusRow(dependencies, {
      threadId: state.targetThreadId,
      userId: userId(interaction),
      guildId: guildId(interaction),
    })] : [];
    return editOriginal(dependencies, interaction, {
      content: continuationTakeoverResult(result),
      components,
    });
  } finally {
    routerState.takeoverInProgress = false;
  }
}

async function confirmContinuationGlobalFallback(dependencies, routerState, interaction, stateId) {
  const state = dependencies.uiState.get(stateId);
  const invalid = continuationTakeoverStateError(dependencies, interaction, state, 'takeover-global-fallback');
  if (invalid) {
    if (state && nowValue(dependencies) >= Number(state.expiresAt)) dependencies.uiState.delete(stateId);
    return respond(dependencies, interaction, privateResponse(invalid));
  }
  dependencies.uiState.delete(stateId);
  if (routerState.takeoverInProgress) {
    return respond(dependencies, interaction, privateResponse('另一个任务控制操作正在执行；本请求未重复执行。'));
  }
  routerState.takeoverInProgress = true;
  try {
    await deferMessageUpdate(dependencies, interaction);
    const [indexResult, statusResult] = await Promise.allSettled([
      Promise.resolve().then(() => dependencies.refreshTaskIndex()),
      Promise.resolve().then(() => dependencies.getCodexControlStatus()),
    ]);
    const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
    const index = indexResult.status === 'fulfilled' ? indexResult.value : null;
    if (!status?.ok || typeof status?.desktop?.running !== 'boolean' || !Array.isArray(index?.tasks)) {
      return editOriginal(dependencies, interaction, queuedTakeoverUnavailable(!Array.isArray(index?.tasks) ? 'index-unavailable' : 'untrusted'));
    }
    const currentSnapshot = buildTakeoverSnapshot(index, { targetThreadId: state.targetThreadId });
    if (status.desktop.running && hasNewActiveTasks(state.snapshot, currentSnapshot)) {
      return publishContinuationGlobalFallback(dependencies, interaction, state, {
        snapshot: currentSnapshot,
        newTasksDetected: true,
      });
    }
    let claim;
    try {
      claim = await dependencies.claimContinuationTakeover({
        queueId: state.queueId,
        targetThreadId: state.targetThreadId,
      });
    } catch {
      claim = { status: 'failed' };
    }
    if (claim?.status !== 'claimed') {
      return editOriginal(dependencies, interaction, {
        content: '队列状态已变化或暂时无法锁定；未退出 Codex，也未重复执行。',
        components: [],
      });
    }
    if (status.desktop.running) {
      let stopped;
      try {
        stopped = await dependencies.stopCodexDesktop();
      } catch {
        stopped = null;
      }
      if (!stopped?.ok) {
        let release;
        try {
          release = await dependencies.releaseContinuationTakeoverClaim(claim);
        } catch {
          release = null;
        }
        return editOriginal(dependencies, interaction, {
          content: release?.status === 'queued'
            ? '退出整个 Codex 失败；目标请求已恢复为保持排队。'
            : '退出整个 Codex 失败；无法确认队列已恢复，请通过 /继续队列 检查当前状态。',
          components: [],
        });
      }
    }
    let result;
    try {
      result = await dependencies.retryContinuation(claim);
    } catch {
      result = { status: 'failed' };
    }
    const components = result?.status === 'started' ? [createTaskStatusRow(dependencies, {
      threadId: state.targetThreadId,
      userId: userId(interaction),
      guildId: guildId(interaction),
    })] : [];
    return editOriginal(dependencies, interaction, {
      content: continuationTakeoverResult(result, '整个 Codex 已退出'),
      components,
    });
  } finally {
    routerState.takeoverInProgress = false;
  }
}

async function openContinuationModal(dependencies, interaction, record) {
  const stateId = makeStateId(dependencies);
  dependencies.uiState.set(stateId, {
    kind: 'continue-task',
    userId: userId(interaction),
    guildId: guildId(interaction),
    threadId: String(record.threadId),
    expiresAt: nowValue(dependencies) + UI_TTL_MS,
  });
  return respond(dependencies, interaction, {
    type: 9,
    data: {
      custom_id: `continue:${stateId}`,
      title: '继续 Codex 任务',
      components: [{
        type: 1,
        components: [{
          type: 4,
          custom_id: '继续内容',
          label: '继续内容',
          style: 2,
          min_length: 1,
          max_length: 4_000,
          required: true,
        }],
      }],
    },
  });
}

async function renderDetailInteraction(dependencies, interaction, record) {
  await defer(dependencies, interaction);
  try {
    const detail = await dependencies.readTaskDetail(record);
    const pages = paginateMarkdown(renderTaskDetail(detail));
    const continueRow = createContinueTargetButton(dependencies, interaction, record);
    const { payload } = createPageState(dependencies, pages, interaction, [continueRow]);
    return editOriginal(dependencies, interaction, payload);
  } catch {
    return editOriginal(dependencies, interaction, { content: '任务详情暂不可用，请稍后重试。' });
  }
}

async function renderTaskStatusInteraction(dependencies, interaction, stateId) {
  const state = dependencies.uiState.get(stateId);
  const invalid = componentStateError(dependencies, interaction, state);
  if (invalid || state?.kind !== 'task-status') {
    return respond(dependencies, interaction, privateResponse(invalid ?? '状态按钮已失效，请重新继续任务。'));
  }
  await defer(dependencies, interaction);
  try {
    const refreshed = await dependencies.refreshTaskIndex();
    const record = (refreshed?.tasks ?? dependencies.taskIndex?.tasks ?? [])
      .find((item) => String(item?.threadId ?? '').toLocaleLowerCase() === String(state.threadId).toLocaleLowerCase());
    if (!record) return editOriginal(dependencies, interaction, { content: '任务已不在当前主任务列表中。' });
    const detail = await dependencies.readTaskDetail(record);
    return editOriginal(dependencies, interaction, { embeds: [taskStatusCard(detail)] });
  } catch {
    return editOriginal(dependencies, interaction, { content: '当前运行状态暂不可用，请稍后重试。' });
  }
}

async function handleCommand(dependencies, interaction) {
  const name = String(interaction?.data?.name ?? '');
  if (name === '任务列表') {
    const status = String(optionValue(interaction, '状态') ?? '全部');
    const matching = taskListValues(dependencies.taskIndex?.tasks, { status });
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
    const model = String(optionValue(interaction, '模型') ?? '');
    const effort = String(optionValue(interaction, '推理强度') ?? '');
    if (!validNewTaskModelEffort(model, effort)) {
      return respond(dependencies, interaction, privateResponse('所选模型不支持该推理强度，请重新选择。'));
    }
    const project = cachedProject(dependencies, selectionId);
    if (!project) return respond(dependencies, interaction, privateResponse('项目选择无效，请重新执行 /新建任务。'));
    const stateId = makeStateId(dependencies);
    dependencies.uiState.set(stateId, {
      kind: 'new-task',
      userId: userId(interaction),
      guildId: guildId(interaction),
      selectionId,
      model: model || undefined,
      effort: effort || undefined,
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
  if (name === '继续任务') {
    const record = findTask(dependencies, optionValue(interaction, '任务'));
    if (!record) return respond(dependencies, interaction, privateResponse('任务不存在或已不再是侧边栏主任务。'));
    return openContinuationModal(dependencies, interaction, record);
  }
  if (name === '继续队列') {
    return respond(dependencies, interaction, { type: 4, data: privatePayload(continuationQueuePayload(dependencies, interaction)) });
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
  if (name === '退出codex') return beginTakeoverExit(dependencies, interaction);
  if (name === '帮助') return respond(dependencies, interaction, privateResponse(renderHelp()));
  if (name === '系统测试') {
    const mode = optionValue(interaction, '类型') === '完整' ? '完整' : '快速';
    await defer(dependencies, interaction);
    try {
      const runner = mode === '完整'
        ? (dependencies.runFullHealthChecks ?? runFullHealthChecks)
        : (dependencies.runQuickHealthChecks ?? runQuickHealthChecks);
      const checks = await runner(dependencies.healthDependencies ?? dependencies);
      return editOriginal(dependencies, interaction, { content: renderHealthReport(checks, { mode }) });
    } catch {
      return editOriginal(dependencies, interaction, { content: `${mode}系统测试暂不可用，请稍后重试。` });
    }
  }
  return respond(dependencies, interaction, privateResponse('未知命令。'));
}

async function authoritativeProjects(dependencies) {
  if (typeof dependencies.refreshProjects === 'function') return dependencies.refreshProjects();
  if (typeof dependencies.projectCatalog?.refresh === 'function') return dependencies.projectCatalog.refresh();
  throw new Error('Project refresh unavailable');
}

function modalStateError(dependencies, interaction, state, kind = 'new-task') {
  const now = nowValue(dependencies);
  const command = kind === 'continue-task' ? '/继续任务' : '/新建任务';
  if (!state || state.kind !== kind) return `此表单已过期或无效，请重新执行 ${command}。`;
  if (now >= state.expiresAt) return `此表单已过期，请重新执行 ${command}。`;
  if (state.userId !== userId(interaction) || state.guildId !== guildId(interaction)) return '此表单不属于当前用户或服务器，无权提交。';
  return null;
}

function continuationReceipt(result) {
  if (result?.status === 'started') {
    return `## 继续任务结果\n**状态：** 已开始继续执行${result?.turnId ? `\n**本轮 ID：** …${String(result.turnId).slice(-8)}` : ''}`;
  }
  if (result?.status === 'queued') {
    return `## 继续任务结果\n**状态：** 已排队\n目标任务释放后会自动送达。\n**队列编号：** …${String(result?.queueId ?? '').slice(-8)}`;
  }
  if (result?.status === 'uncertain') {
    return '## 继续任务结果\n**状态：** 启动结果不确定\n为避免重复执行不会自动重试，请打开原任务确认实际状态。';
  }
  return '## 继续任务结果\n**状态：** 续接失败\n没有成功续接原 Codex 任务；不会新建任务，请稍后重试。';
}

async function handleContinueModal(dependencies, submissions, interaction, stateId, state) {
  const invalid = modalStateError(dependencies, interaction, state, 'continue-task');
  if (invalid) return respond(dependencies, interaction, privateResponse(invalid));
  const continuationText = modalText(interaction, '继续内容');
  if (!continuationText.trim() || continuationText.length > 4_000) {
    return respond(dependencies, interaction, privateResponse('继续内容必须为 1–4000 个字符，且不能为空。'));
  }
  await defer(dependencies, interaction);

  let submission = submissions.get(stateId);
  if (!submission) {
    const submissionInteractionId = String(interaction.id);
    const promise = (async () => {
      const record = findTask(dependencies, state.threadId);
      if (!record) {
        return {
          result: { status: 'failed', reason: 'not-found' },
          payload: { content: '任务不存在或已不再是侧边栏主任务，未发送继续内容。' },
        };
      }
      let request;
      try {
        request = createContinuationRequest({
          source: 'slash',
          requestId: submissionInteractionId,
          threadId: record.threadId,
          cwd: record.worktreePath,
          text: continuationText,
          guildId: guildId(interaction),
          channelId: channelId(interaction),
          projectId: record.projectId,
          projectName: record.projectName,
          createdAt: new Date(nowValue(dependencies)).toISOString(),
        });
      } catch {
        return {
          result: { status: 'failed', reason: 'invalid-request' },
          payload: { content: '继续内容无效，未发送。' },
        };
      }
      let result;
      try {
        result = await dependencies.dispatchContinuation(request);
      } catch {
        result = { status: 'failed' };
      }
      const components = result?.status === 'started' ? [createTaskStatusRow(dependencies, {
        threadId: record.threadId,
        userId: userId(interaction),
        guildId: guildId(interaction),
      })] : [];
      return {
        result,
        payload: { content: continuationReceipt(result), components },
        targetThreadId: String(record.threadId),
      };
    })();
    submission = { interactionId: submissionInteractionId, promise };
    submissions.set(stateId, submission);
    promise.then((outcome) => { submission.outcome = outcome; }).catch(() => {});
  }
  const outcome = submission.outcome ?? await submission.promise;
  if (outcome?.result?.status === 'queued' && outcome?.result?.reason === 'active-writer') {
    submission.takeoverPromise ??= (async () => {
      const inspection = await inspectQueuedTakeover(dependencies, outcome.targetThreadId);
      if (!inspection.available) return editOriginal(dependencies, interaction, inspection.payload);
      return publishContinuationTakeover(dependencies, interaction, {
        queueId: outcome.result.queueId,
        targetThreadId: outcome.targetThreadId,
        snapshot: inspection.snapshot,
      });
    })();
    return submission.takeoverPromise;
  }
  return editOriginal(dependencies, interaction, outcome.payload);
}

async function handleModal(dependencies, submissions, interaction) {
  const customId = String(interaction?.data?.custom_id ?? '');
  const continueMatch = customId.match(/^continue:([A-Za-z0-9_-]{16})$/u);
  if (continueMatch) {
    const continueState = dependencies.uiState.get(continueMatch[1]);
    return handleContinueModal(dependencies, submissions, interaction, continueMatch[1], continueState);
  }
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
          model: state.model,
          effort: state.effort,
          codexPath: dependencies.codexPath,
          processCwd: dependencies.processCwd,
          clientFactory: dependencies.clientFactory,
          gitRunner: dependencies.gitRunner,
          fileSystem: dependencies.fileSystem,
          persistState: dependencies.persistCreationState,
          now: new Date(nowValue(dependencies)),
          discordOrigin: {
            guildId: guildId(interaction),
            channelId: channelId(interaction),
            source: 'new-task',
            projectId: selection.projectId,
            projectName: selection.projectName,
          },
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
  return deliverCreationReceipt(dependencies, interaction, receipt);
}

function componentStateError(dependencies, interaction, state) {
  if (!state) return '内容已过期或按钮无效，请重新执行命令。';
  if (nowValue(dependencies) >= state.expiresAt) return '内容已过期，请重新执行命令。';
  if (state.userId !== userId(interaction) || state.guildId !== guildId(interaction)) return '此按钮不属于当前用户或服务器。';
  return null;
}

async function handleComponent(dependencies, interaction, routerState) {
  const customId = String(interaction?.data?.custom_id ?? '');
  const takeoverContinue = customId.match(/^takeover-continue:([A-Za-z0-9_-]{16})$/u);
  if (takeoverContinue) {
    return confirmContinuationTakeover(dependencies, routerState, interaction, takeoverContinue[1]);
  }
  const takeoverGlobal = customId.match(/^takeover-global:([A-Za-z0-9_-]{16})$/u);
  if (takeoverGlobal) {
    return confirmContinuationGlobalFallback(dependencies, routerState, interaction, takeoverGlobal[1]);
  }
  const takeoverQueueCancel = customId.match(/^takeover-queue-cancel:([A-Za-z0-9_-]{16})$/u);
  if (takeoverQueueCancel) return cancelTakeoverQueue(dependencies, interaction, takeoverQueueCancel[1]);
  const takeoverKeep = customId.match(/^takeover-keep:([A-Za-z0-9_-]{16})$/u);
  if (takeoverKeep) return keepContinuationQueued(dependencies, interaction, takeoverKeep[1]);
  const takeoverConfirm = customId.match(/^takeover-confirm:([A-Za-z0-9_-]{16})$/u);
  if (takeoverConfirm) return confirmTakeoverExit(dependencies, routerState, interaction, takeoverConfirm[1]);
  const takeoverCancel = customId.match(/^takeover-cancel:([A-Za-z0-9_-]{16})$/u);
  if (takeoverCancel) return cancelTakeoverExit(dependencies, interaction, takeoverCancel[1]);
  const cancelMatch = customId.match(/^cancel:([A-Za-z0-9_-]{16})$/u);
  if (cancelMatch) {
    const state = dependencies.uiState.get(cancelMatch[1]);
    const invalid = componentStateError(dependencies, interaction, state);
    if (invalid || state?.kind !== 'cancel-continuation') {
      return respond(dependencies, interaction, privateResponse(invalid ?? '内容已过期或按钮无效，请重新执行命令。'));
    }
    await defer(dependencies, interaction);
    let result;
    try {
      const cancelledAt = new Date(nowValue(dependencies)).toISOString();
      if (typeof dependencies.cancelContinuationPersisted === 'function') {
        result = await dependencies.cancelContinuationPersisted(state.queueId, cancelledAt);
      } else if (dependencies.continuationState) {
        result = await cancelPersistedContinuation({
          state: dependencies.continuationState,
          queueId: state.queueId,
          now: cancelledAt,
          persistState: dependencies.persistContinuationState,
        });
      } else {
        throw new Error('Atomic continuation cancellation is unavailable');
      }
    } catch {
      return editOriginal(dependencies, interaction, { content: '取消失败，队列状态未更改；请稍后重试。' });
    }
    return editOriginal(dependencies, interaction, continuationQueuePayload(dependencies, interaction));
  }
  const taskStatus = customId.match(/^task-status:([A-Za-z0-9_-]{16})$/u);
  if (taskStatus) return renderTaskStatusInteraction(dependencies, interaction, taskStatus[1]);
  const stopCurrent = customId.match(/^stop-current:([A-Za-z0-9_-]{16})$/u);
  if (stopCurrent) return stopCurrentTask(dependencies, interaction, stopCurrent[1]);
  const continueMatch = customId.match(/^continue-open:([A-Za-z0-9_-]{16})$/u);
  if (continueMatch) {
    const state = dependencies.uiState.get(continueMatch[1]);
    const invalid = componentStateError(dependencies, interaction, state);
    if (invalid || state?.kind !== 'continue-target') {
      return respond(dependencies, interaction, privateResponse(invalid ?? '内容已过期或按钮无效，请重新执行命令。'));
    }
    const record = findTask(dependencies, state.threadId);
    if (!record) return respond(dependencies, interaction, privateResponse('任务不存在或已不再是侧边栏主任务。'));
    return openContinuationModal(dependencies, interaction, record);
  }
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

function isStateMutationInteraction(interaction) {
  const type = Number(interaction?.type);
  const name = String(interaction?.data?.name ?? '');
  const customId = String(interaction?.data?.custom_id ?? '');
  if ([2, 4].includes(type)) return ['新建任务', '继续任务'].includes(name);
  if (type === 5) return customId.startsWith('new:') || customId.startsWith('continue:');
  if (type === 3) {
    return customId.startsWith('cancel:') || customId.startsWith('continue-open:') ||
      customId.startsWith('takeover-continue:') || customId.startsWith('takeover-global:') ||
      customId.startsWith('takeover-queue-cancel:') || customId.startsWith('stop-current:');
  }
  return false;
}

/** Create the private, single-user Interaction router. */
export function createInteractionRouter(dependencies = {}) {
  dependencies.uiState ??= new Map();
  const submissions = new Map();
  const routerState = { takeoverInProgress: false };

  return {
    async handle(interaction) {
      const authorization = authorizeInteraction(interaction, dependencies.config);
      if (!authorization.allowed) {
        if (Number(interaction?.type) === 4) {
          return respond(dependencies, interaction, { type: 8, data: { choices: [] } });
        }
        return respond(dependencies, interaction, privateResponse('此交互无权使用或不可用。'));
      }
      if (dependencies.mutationDisabledCategory === 'continuation-state-corrupt' && isStateMutationInteraction(interaction)) {
        if (Number(interaction?.type) === 4) {
          return respond(dependencies, interaction, { type: 8, data: { choices: [] } });
        }
        return respond(dependencies, interaction, privateResponse('续接状态暂不可用；Bot 当前为只读模式，请修复本机状态后重试。'));
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
      if (Number(interaction?.type) === 3) return handleComponent(dependencies, interaction, routerState);
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
