import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { callCodexDesktopTool, resolveCodexExecutable, resolvePowerShellExecutable } from '../discord-bridge-lib.mjs';
import { runCodexControlAction } from '../discord-control-client.mjs';
import { resolveCodexHome, codexRouterEndpoint, listDesktopEndpoints, findExecutable } from '../discord-runtime-lib.mjs';
import { validateConfig } from '../discord-bridge.mjs';

test('a repository checkout uses CODEX_HOME or the user home, not its parent', () => {
  assert.equal(resolveCodexHome({ environment: {}, toolDir: '/src/checkout', homeDirectory: '/Users/test' }), path.join('/Users/test', '.codex'));
  assert.equal(resolveCodexHome({ environment: { CODEX_HOME: '/data/codex' }, toolDir: '/src/mobile-notify' }), path.normalize('/data/codex'));
  assert.throws(() => resolveCodexHome({ environment: { CODEX_HOME: 'relative' } }), /absolute/);
  assert.equal(codexRouterEndpoint({ platform: 'win32' }), '\\\\.\\pipe\\codex-ipc');
  assert.equal(codexRouterEndpoint({ platform: 'darwin', environment: { CODEX_HOME: '/data/codex' } }), path.join('/data/codex', 'ipc', 'ipc.sock'));
});

test('bridge accepts POSIX task roots while retaining legacy Windows configuration templates', () => {
  const base = { discordApplicationId:'111111111111111111', discordGuildId:'222222222222222222',
    discordAllowedUserId:'333333333333333333', discordTaskChannelId:'444444444444444444',
    discordConfirmationChannelId:'555555555555555555', discordQuotaChannelId:'666666666666666666', discordTokenPath:'./secret' };
  const mac = { ...base, discordProjectlessRoot: '/Users/test/Discord Tasks', discordWorktreeRoot: '/Users/test/.codex/worktrees' };
  validateConfig(mac);
  assert.equal(mac.discordProjectlessRoot, '/Users/test/Discord Tasks');
  assert.equal(mac.discordWorktreeRoot, '/Users/test/.codex/worktrees');
  assert.throws(() => validateConfig({ ...mac, discordWorktreeRoot: 'relative/path' }), /absolute/);
  const windows = { ...base, discordProjectlessRoot:'C:\\Users\\test\\Tasks', discordWorktreeRoot:'D:\\worktrees' };
  validateConfig(windows);
  assert.equal(windows.discordWorktreeRoot, 'D:\\worktrees');
});

test('desktop discovery rejects regular files, symlinks, and sockets owned by another user', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp('/tmp/cd-discovery-');
  const server = net.createServer();
  try {
    await new Promise((resolve) => server.listen(path.join(root, 'real.sock'), resolve));
    await fs.writeFile(path.join(root, 'file.sock'), 'fake');
    await fs.symlink(path.join(root, 'real.sock'), path.join(root, 'alias.sock'));
    assert.deepEqual(await listDesktopEndpoints({ socketDirectory: root }), [path.join(root, 'real.sock')]);
    assert.deepEqual(await listDesktopEndpoints({ socketDirectory: root, userId: process.getuid() + 1 }), []);
  } finally { await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});

test('macOS resolves a bundled CLI and explicit PowerShell with a minimal login PATH', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-runtime-'));
  try {
    const codex = path.join(root, 'ChatGPT.app', 'Contents', 'Resources', 'codex');
    const pwsh = path.join(root, 'PowerShell 7', 'pwsh');
    for (const executable of [codex, pwsh]) {
      await fs.mkdir(path.dirname(executable), { recursive: true });
      await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    }
    assert.equal(await resolveCodexExecutable({ platform: 'darwin', localAppData: '', environment: { PATH: '' }, applicationRoots: [root] }), codex);
    assert.equal(await resolvePowerShellExecutable({ platform: 'darwin', programFiles: '', environment: { PATH: '', CODEX_DISCORD_PWSH_PATH: pwsh } }), pwsh);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('macOS rejects an explicitly configured CLI without execute permission', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-noexec-'));
  try {
    const file = path.join(root, 'codex'); await fs.writeFile(file, 'not executable', { mode: 0o600 });
    await assert.rejects(() => resolveCodexExecutable({ configuredPath: file, platform: 'darwin' }), /executable.*unavailable/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Windows executable discovery adds executable suffixes without selecting shell scripts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-pathext-'));
  try {
    await fs.writeFile(path.join(root, 'pwsh.exe'), 'fixture');
    assert.equal(await findExecutable('pwsh', { platform: 'win32', environment: { PATH: root, PATHEXT: '.COM;.EXE;.BAT;.CMD' } }), path.join(root, 'pwsh.exe'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('desktop tools use framed JSON on macOS Unix sockets', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp('/tmp/cd-ipc-');
  const socketPath = path.join(root, 'desktop.sock');
  const observed = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4 || buffer.length < buffer.readUInt32LE(0) + 4) return;
      const request = JSON.parse(buffer.subarray(4).toString());
      observed.push(request.method);
      const result = request.method === 'tools/list'
        ? { tools: [{ name: 'read_thread' }, { name: 'send_message_to_thread' }] }
        : { success: true, contentItems: [{ type: 'inputText', text: '{"turns":[]}' }] };
      const response = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      const header = Buffer.alloc(4); header.writeUInt32LE(response.length);
      socket.write(header); socket.end(response);
    });
  });
  try {
    await new Promise((resolve) => server.listen(socketPath, resolve));
    const response = await callCodexDesktopTool({ tool: 'read_thread', args: { threadId: 'fixture' }, listPipes: async () => [socketPath] });
    assert.equal(response.success, true);
    assert.deepEqual(observed, ['tools/list', 'tools/call']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('macOS control runs the Node adapter as one fixed action with spaced paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord control '));
  try {
    const controlPath = path.join(root, 'control.mjs');
    await fs.writeFile(controlPath, 'console.log(JSON.stringify({ok:true,argv:process.argv.slice(2)}));');
    const result = await runCodexControlAction({ action: 'status', controlPath });
    assert.deepEqual(result, { ok: true, argv: ['--action', 'status'] });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
