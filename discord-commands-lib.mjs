/**
 * Discord application-command definitions and Guild command registration.
 *
 * This module deliberately uses only web platform APIs so the bridge can run
 * from the bundled Node runtime without installing third-party dependencies.
 */

export const COMMAND_NAMES = Object.freeze([
  '任务列表', '任务详情', '任务搜索', '新建任务', '继续任务', '继续队列', '额度', '系统状态', '系统测试', '退出Codex', '帮助',
]);

const STRING_OPTION = 3;
const CHAT_INPUT_COMMAND = 1;

function choice(name) {
  return { name, value: name };
}

function command(name, description, options = []) {
  const definition = { type: CHAT_INPUT_COMMAND, name, description };
  if (options.length > 0) definition.options = options;
  return definition;
}

function taskOption() {
  return {
    type: STRING_OPTION,
    name: '任务',
    description: '选择要查看的任务',
    required: true,
    autocomplete: true,
  };
}

/**
 * Return the complete desired state for the private Guild command set.
 * Guild PUT registration replaces this set atomically and is therefore
 * idempotent across bridge restarts.
 */
export function buildGuildCommandDefinitions() {
  return [
    command('任务列表', '查看最近的 Codex 任务', [{
      type: STRING_OPTION,
      name: '状态',
      description: '按任务状态筛选',
      required: false,
      choices: ['全部', '运行中', '待确认', '已完成', '失败'].map(choice),
    }]),
    command('任务详情', '查看任务完整详情', [taskOption()]),
    command('任务搜索', '搜索历史任务', [{
      type: STRING_OPTION,
      name: '关键词',
      description: '搜索任务内容',
      required: true,
    }]),
    command('新建任务', '从保存的项目创建 Codex 任务', [{
      type: STRING_OPTION,
      name: '项目',
      description: '选择保存的项目',
      required: true,
      autocomplete: true,
    }]),
    command('继续任务', '向已有任务发送新的内容', [taskOption()]),
    command('继续队列', '查看等待发送的继续请求'),
    command('额度', '查看 Codex 周额度'),
    command('系统状态', '查看 Discord Bot 与 Codex 桥接状态'),
    command('系统测试', '检查 Discord Bot 系统状态', [{
      type: STRING_OPTION,
      name: '类型',
      description: '选择测试范围',
      required: false,
      choices: ['快速', '完整'].map(choice),
    }]),
    command('退出Codex', '查看风险并退出 Codex 桌面端'),
    command('帮助', '查看命令帮助'),
  ];
}

function normalizeDiscordId(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return '';
  const id = String(value);
  if (id.length === 0 || id.trim() !== id || !/^\d+$/.test(id)) return '';
  return id;
}

/**
 * Check both tenancy boundaries before handling any interaction.
 */
export function authorizeInteraction(interaction, config) {
  const configuredGuildId = normalizeDiscordId(config?.discordGuildId);
  const configuredUserId = normalizeDiscordId(config?.discordAllowedUserId);
  const interactionGuildId = normalizeDiscordId(interaction?.guild_id);
  const interactionUserId = normalizeDiscordId(interaction?.member?.user?.id ?? interaction?.user?.id);

  if (!configuredGuildId || !configuredUserId || !interactionGuildId || !interactionUserId) {
    return { allowed: false, reason: 'invalid-identity' };
  }
  if (interactionGuildId !== configuredGuildId) {
    return { allowed: false, reason: 'wrong-guild' };
  }
  if (interactionUserId !== configuredUserId) {
    return { allowed: false, reason: 'wrong-user' };
  }
  return { allowed: true, reason: 'authorized' };
}

/**
 * Build a response visible only to the invoking Discord user. Mentions are
 * explicitly disabled even when content originates from a task transcript.
 */
export function ephemeral(contentOrPayload) {
  const data = typeof contentOrPayload === 'string'
    ? { content: contentOrPayload }
    : { ...(contentOrPayload ?? {}) };
  return {
    ...data,
    flags: 64,
    allowed_mentions: { parse: [] },
  };
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function responseJson(response) {
  if (typeof response?.json === 'function') return response.json();
  if (typeof response?.text === 'function') return JSON.parse(await response.text());
  return undefined;
}

function isSuccessful(response) {
  if (typeof response?.ok === 'boolean') return response.ok;
  const status = Number(response?.status);
  return status >= 200 && status < 300;
}

/**
 * Replace the current Guild command set. Discord's PUT endpoint is naturally
 * idempotent; a single rate-limit retry handles startup races and transient
 * Discord throttling without creating a retry loop.
 */
export async function registerGuildCommands({ token, applicationId, guildId, fetchImpl = fetch, sleepImpl = defaultSleep }) {
  const url = `https://discord.com/api/v10/applications/${encodeURIComponent(String(applicationId))}/guilds/${encodeURIComponent(String(guildId))}/commands`;
  const body = JSON.stringify(buildGuildCommandDefinitions());
  const options = {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${String(token)}`,
      'Content-Type': 'application/json',
    },
    body,
  };

  let retriedRateLimit = false;
  while (true) {
    let response;
    try {
      response = await fetchImpl(url, options);
    } catch {
      throw new Error('Discord command registration failed: network');
    }

    if (Number(response?.status) === 429 && !retriedRateLimit) {
      retriedRateLimit = true;
      let retryAfter = 0;
      try {
        const details = await responseJson(response);
        const value = Number(details?.retry_after);
        if (Number.isFinite(value) && value >= 0) retryAfter = value * 1000;
      } catch {
        // Discord's response body is advisory; retry immediately if it is not JSON.
      }
      await sleepImpl(retryAfter);
      continue;
    }

    if (!isSuccessful(response)) {
      throw new Error(`Discord command registration failed: ${Number(response?.status) || 'unknown'}`);
    }

    try {
      const parsed = await responseJson(response);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      throw new Error(`Discord command registration failed: ${Number(response?.status) || 'invalid-response'}`);
    }
  }
}
