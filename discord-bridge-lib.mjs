import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function compareSnowflakes(left, right) {
  const a = BigInt(String(left));
  const b = BigInt(String(right));
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createEmptyInboxState() {
  return {
    version: 2,
    initialized: false,
    cursors: {},
    processedMessageIds: [],
    pendingReplies: {},
  };
}

export async function initializeInboxCursors({ state, channelIds, getLatest }) {
  state.version = 2;
  state.cursors ??= {};
  state.processedMessageIds ??= [];
  state.pendingReplies ??= {};
  for (const channelId of channelIds.map(String)) {
    if (!state.cursors[channelId]) {
      state.cursors[channelId] = String(await getLatest(channelId));
    }
  }
  state.initialized = true;
  return state;
}

export function isActiveWriterError(error) {
  return /already has an active writer/i.test(String(error?.message ?? error ?? ''));
}

export function enqueuePendingReply(state, accepted, attemptedAt = new Date().toISOString(), encryptedText) {
  if (!String(encryptedText ?? '').trim()) throw new Error('Pending reply text must be encrypted before it is persisted');
  state.version = 2;
  state.pendingReplies ??= {};
  const messageId = String(accepted.messageId);
  const existing = state.pendingReplies[messageId];
  state.pendingReplies[messageId] = {
    messageId,
    referencedMessageId: String(accepted.referencedMessageId ?? ''),
    channelId: String(accepted.channelId),
    encryptedText: String(encryptedText),
    mapping: structuredClone(accepted.mapping),
    queuedAt: String(existing?.queuedAt ?? attemptedAt),
    lastAttemptAt: String(attemptedAt),
    attempts: Number(existing?.attempts ?? 0) + 1,
  };
  return state.pendingReplies[messageId];
}

export function getPendingReplies(state) {
  return Object.values(state?.pendingReplies ?? {}).sort((left, right) =>
    compareSnowflakes(left.messageId, right.messageId));
}

export async function migrateLegacyPendingReplies({ state, encryptText }) {
  for (const pending of Object.values(state?.pendingReplies ?? {})) {
    if (!Object.hasOwn(pending, 'text')) continue;
    try {
      const encryptedText = await encryptText(String(pending.text ?? ''));
      if (!encryptedText) throw new Error('empty ciphertext');
      pending.encryptedText = String(encryptedText);
      delete pending.text;
    } catch {
      throw new Error('Legacy pending reply encryption is unavailable; state was not rewritten');
    }
  }
  return state;
}

export function removePendingReply(state, messageId) {
  state.pendingReplies ??= {};
  delete state.pendingReplies[String(messageId)];
  return state;
}

export function recordInboxMessage(state, channelId, messageId, processed) {
  state.cursors ??= {};
  state.processedMessageIds ??= [];
  const current = String(state.cursors[channelId] ?? '0');
  if (compareSnowflakes(current, messageId) < 0) state.cursors[channelId] = String(messageId);
  if (processed && !state.processedMessageIds.map(String).includes(String(messageId))) {
    state.processedMessageIds.push(String(messageId));
    if (state.processedMessageIds.length > 2000) {
      state.processedMessageIds.splice(0, state.processedMessageIds.length - 2000);
    }
  }
  return state;
}

export function classifyReply(message, config, mappingState, inboxState) {
  const reject = (reason) => ({ accepted: false, reason });
  if (!message || typeof message !== 'object') return reject('invalid-message');
  if (message.guild_id !== undefined && message.guild_id !== null &&
      String(message.guild_id) !== String(config.discordGuildId ?? '')) return reject('wrong-guild');

  const channelId = String(message.channel_id ?? '');
  const allowedChannels = new Set([
    String(config.discordTaskChannelId ?? ''),
    String(config.discordConfirmationChannelId ?? ''),
  ]);
  if (!allowedChannels.has(channelId)) return reject('wrong-channel');
  if (channelId === String(config.discordQuotaChannelId ?? '')) return reject('quota-channel');

  const author = message.author ?? {};
  if (author.bot) return reject('bot-author');
  if (String(author.id ?? '') !== String(config.discordAllowedUserId ?? '')) return reject('unauthorized-user');

  const messageId = String(message.id ?? '');
  if ((inboxState?.processedMessageIds ?? []).map(String).includes(messageId)) return reject('duplicate-message');

  const text = String(message.content ?? '').trim();
  if (!text) return reject('empty-text');

  const reference = message.message_reference;
  const referencedMessageId = String(reference?.message_id ?? '');
  if (!referencedMessageId) return reject('not-a-reply');
  if (reference?.guild_id && String(reference.guild_id) !== String(config.discordGuildId ?? '')) return reject('reference-wrong-guild');
  if (reference?.channel_id && String(reference.channel_id) !== channelId) return reject('reference-wrong-channel');

  const mapped = mappingState?.messages?.[referencedMessageId];
  if (!mapped) return reject('unknown-reference');
  if (String(mapped.channelId ?? '') !== channelId) return reject('mapping-channel-mismatch');
  if (!['user-task-complete', 'user-task-confirmation-required'].includes(String(mapped.eventName ?? ''))) {
    return reject('mapping-event-not-actionable');
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(mapped.threadId ?? ''))) return reject('invalid-thread-id');

  return {
    accepted: true,
    messageId,
    referencedMessageId,
    channelId,
    text,
    mapping: mapped,
  };
}

export function buildCodexAppServerMessages({ threadId, cwd, text }) {
  const resumeParams = { threadId };
  const turnParams = {
    threadId,
    input: [{ type: 'text', text }],
  };
  if (cwd) {
    resumeParams.cwd = cwd;
    turnParams.cwd = cwd;
  }
  return [
    {
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'codex-discord-bridge',
          version: '1.0.0',
        },
      },
    },
    { method: 'initialized', params: {} },
    { method: 'thread/resume', id: 2, params: resumeParams },
    { method: 'turn/start', id: 3, params: turnParams },
  ];
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== null) return structuredClone(fallback);
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function resolveCodexExecutable({
  configuredPath = 'codex',
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
  const configured = String(configuredPath ?? '').trim() || 'codex';
  if (path.isAbsolute(configured)) {
    try {
      if ((await fs.stat(configured)).isFile()) return configured;
    } catch {
      // Continue to the installed Codex discovery path.
    }
  }

  if (localAppData) {
    const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    try {
      const entries = await fs.readdir(binRoot, { withFileTypes: true });
      const candidates = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(binRoot, entry.name, 'codex.exe');
        try {
          const info = await fs.stat(candidate);
          if (info.isFile()) candidates.push({ candidate, modified: info.mtimeMs });
        } catch {
          // An incomplete or concurrently replaced installation is ignored.
        }
      }
      candidates.sort((left, right) => right.modified - left.modified || right.candidate.localeCompare(left.candidate));
      if (candidates.length > 0) return candidates[0].candidate;
    } catch {
      // Fall back to the configured command when discovery is unavailable.
    }
  }
  return configured;
}

export async function resolvePowerShellExecutable({
  programFiles = process.env.ProgramFiles,
} = {}) {
  if (programFiles) {
    const installed = path.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
    try {
      if ((await fs.stat(installed)).isFile()) return installed;
    } catch {
      // Fall back to PATH when PowerShell 7 is installed elsewhere.
    }
  }
  return 'pwsh';
}

export async function discordRequest({ token, route, method = 'GET', body, fetchImpl = fetch, maxRetries = 5 }) {
  const url = `https://discord.com/api/v10${route}`;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'DiscordBot (https://github.com/openai/codex, 1.0.0)',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429 && attempt < maxRetries) {
      const rateLimit = await response.json().catch(() => ({}));
      const delayMs = Math.max(250, Math.ceil(Number(rateLimit.retry_after ?? 1) * 1000));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    if (!response.ok) {
      throw new Error(`Discord API request failed with HTTP ${response.status}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }
  throw new Error('Discord API retry limit exceeded');
}

export async function getLatestDiscordMessageId({ token, channelId, fetchImpl = fetch }) {
  const messages = await discordRequest({
    token,
    route: `/channels/${channelId}/messages?limit=1`,
    fetchImpl,
  });
  return Array.isArray(messages) && messages.length > 0 ? String(messages[0].id) : '0';
}

export async function getDiscordMessagesAfter({ token, channelId, after = '0', fetchImpl = fetch }) {
  const messages = await discordRequest({
    token,
    route: `/channels/${channelId}/messages?after=${encodeURIComponent(after)}&limit=100`,
    fetchImpl,
  });
  return (Array.isArray(messages) ? messages : []).sort((a, b) => compareSnowflakes(a.id, b.id));
}

export async function sendDiscordReply({ token, channelId, replyToMessageId, content, fetchImpl = fetch }) {
  return discordRequest({
    token,
    route: `/channels/${channelId}/messages`,
    method: 'POST',
    fetchImpl,
    body: {
      content: String(content).slice(0, 2000),
      allowed_mentions: { parse: [] },
      message_reference: {
        message_id: replyToMessageId,
        channel_id: channelId,
        fail_if_not_exists: false,
      },
    },
  });
}

export async function loadDiscordToken({ toolDir, powershellPath = 'pwsh' }) {
  const helperPath = path.join(toolDir, 'get-discord-token.ps1');
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath, ['-NoProfile', '-File', helperPath], {
      cwd: toolDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => reject(new Error('Unable to start the Discord token helper')));
    child.on('close', (code) => {
      const token = stdout.trim();
      stdout = '';
      if (code !== 0 || !token) {
        reject(new Error('Unable to decrypt the Discord Bot token for this Windows account'));
        return;
      }
      resolve(token);
    });
  });
}

async function transformPendingReplyText({ toolDir, powershellPath = 'pwsh', scriptName, value }) {
  const helperPath = path.join(toolDir, scriptName);
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath, ['-NoProfile', '-File', helperPath], {
      cwd: toolDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => reject(new Error('Unable to start the Discord pending-reply secret helper')));
    child.on('close', (code) => {
      if (code !== 0 || !stdout) reject(new Error('Unable to process Discord pending-reply text for this Windows account'));
      else resolve(stdout);
    });
    child.stdin.end(String(value));
  });
}

export function encryptPendingReplyText({ toolDir, powershellPath = 'pwsh', text }) {
  return transformPendingReplyText({ toolDir, powershellPath, scriptName: 'protect-discord-pending-reply.ps1', value: text });
}

export function decryptPendingReplyText({ toolDir, powershellPath = 'pwsh', ciphertext }) {
  return transformPendingReplyText({ toolDir, powershellPath, scriptName: 'unprotect-discord-pending-reply.ps1', value: ciphertext });
}

export class AppServerClient {
  constructor({
    codexPath,
    cwd,
    spawnImpl = spawn,
    earlyCompletionMax = 100,
    earlyCompletionTtlMs = 5 * 60 * 1000,
    now = Date.now,
  }) {
    this.child = spawnImpl(codexPath, ['app-server', '--stdio'], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.pending = new Map();
    this.completedTurns = new Map();
    this.earlyCompletedTurns = new Map();
    this.earlyCompletionMax = Math.max(1, Number(earlyCompletionMax) || 1);
    this.earlyCompletionTtlMs = Math.max(1, Number(earlyCompletionTtlMs) || 1);
    this.now = now;
    this.closed = false;
    this.exitError = null;

    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.#handleLine(line));
    this.child.on('error', () => this.#closeWithError(new Error('Unable to start Codex App Server')));
    this.child.on('close', (code) => {
      if (!this.closed && code !== 0) this.#closeWithError(new Error(`Codex App Server exited with code ${code}`));
      else this.#closeWithError(null);
    });
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Codex App Server rejected ${pending.method}: ${message.error.message ?? 'unknown error'}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'turn/completed') {
      const turnId = String(message.params?.turn?.id ?? '');
      if (!turnId) return;
      const completion = this.completedTurns.get(turnId);
      if (completion) {
        this.completedTurns.delete(turnId);
        clearTimeout(completion.timer);
        completion.resolve(message.params);
      } else {
        this.#pruneEarlyCompletions();
        this.earlyCompletedTurns.delete(turnId);
        this.earlyCompletedTurns.set(turnId, {
          params: message.params,
          receivedAt: Number(this.now()),
        });
        while (this.earlyCompletedTurns.size > this.earlyCompletionMax) {
          this.earlyCompletedTurns.delete(this.earlyCompletedTurns.keys().next().value);
        }
      }
    }
  }

  #pruneEarlyCompletions() {
    const cutoff = Number(this.now()) - this.earlyCompletionTtlMs;
    for (const [turnId, completion] of this.earlyCompletedTurns) {
      if (completion.receivedAt > cutoff) continue;
      this.earlyCompletedTurns.delete(turnId);
    }
  }

  #closeWithError(error) {
    if (this.closed) return;
    this.closed = true;
    this.exitError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error('Codex App Server connection closed'));
    }
    this.pending.clear();
    for (const completion of this.completedTurns.values()) {
      clearTimeout(completion.timer);
      completion.reject(error ?? new Error('Codex App Server connection closed before turn completion'));
    }
    this.completedTurns.clear();
    this.earlyCompletedTurns.clear();
  }

  send(message) {
    if (this.closed) throw this.exitError ?? new Error('Codex App Server connection is closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(message, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const key = String(message.id);
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Codex App Server timed out waiting for ${message.method}`));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer, method: message.method });
      this.send(message);
    });
  }

  waitForTurn(turnId, timeoutMs = 24 * 60 * 60 * 1000) {
    this.#pruneEarlyCompletions();
    const early = this.earlyCompletedTurns.get(turnId);
    if (early) {
      this.earlyCompletedTurns.delete(turnId);
      return Promise.resolve(early.params);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.completedTurns.delete(turnId);
        reject(new Error('Codex turn completion timed out'));
      }, timeoutMs);
      this.completedTurns.set(turnId, { resolve, reject, timer });
    });
  }

  close() {
    if (this.closed) return;
    this.child.stdin.end();
    setTimeout(() => {
      if (!this.closed) this.child.kill();
    }, 2000).unref();
  }
}

export async function initializeAppServerClient(client) {
  await client.request({
    method: 'initialize',
    id: 1,
    params: { clientInfo: { name: 'codex-discord-bridge', version: '1.0.0' } },
  });
  client.send({ method: 'initialized', params: {} });
}

export async function resumeCodexThread({ threadId, cwd, processCwd = cwd, text, codexPath, clientFactory }) {
  const client = clientFactory
    ? clientFactory({ codexPath, cwd: processCwd })
    : new AppServerClient({ codexPath, cwd: processCwd });
  const messages = buildCodexAppServerMessages({ threadId, cwd, text });
  try {
    await initializeAppServerClient(client);
    const resumed = await client.request(messages[2]);
    const resumedThreadId = String(resumed?.thread?.id ?? '');
    if (resumedThreadId !== threadId) throw new Error('Codex App Server resumed a different thread');
    const started = await client.request(messages[3]);
    const turnId = String(started?.turn?.id ?? '');
    if (!turnId) throw new Error('Codex App Server did not return a turn ID');
    const completion = client.waitForTurn(turnId).finally(() => client.close());
    return { turnId, completion };
  } catch (error) {
    client.close();
    throw error;
  }
}
