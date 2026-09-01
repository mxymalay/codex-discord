import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runCodexControlAction, writeBridgeHealthAtomic } from '../discord-control-client.mjs';

function fakeChild({ stdout = '', stderr = '', exitCode = 0, error = null, neverClose = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = 0;
  child.kill = () => {
    child.killed += 1;
    child.emit('close', 1);
    return true;
  };
  if (!neverClose) {
    queueMicrotask(() => {
      if (child.killed > 0) return;
      if (error) child.emit('error', error);
      if (child.killed > 0) return;
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit('close', exitCode);
    });
  }
  return child;
}

function fakeSpawn(calls, fixture) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return fakeChild(fixture);
  };
}

test('control client permits one fixed action and parses exactly one JSON response', async () => {
  const calls = [];
  const result = await runCodexControlAction({
    action: 'status',
    powershellPath: 'pwsh.exe',
    controlPath: 'C:\\safe\\codex-control.ps1',
    spawnImpl: fakeSpawn(calls, { stdout: '{"ok":true,"action":"status"}\n' }),
  });

  assert.deepEqual(calls[0].args, ['-NoProfile', '-File', 'C:\\safe\\codex-control.ps1', '-Action', 'status']);
  assert.deepEqual(calls[0].options, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(result, { ok: true, action: 'status' });

  await assert.rejects(
    () => runCodexControlAction({ action: 'stop-codex; calc', powershellPath: 'pwsh.exe', controlPath: 'ignored', spawnImpl: fakeSpawn(calls, {}) }),
    /invalid control action/i,
  );
  assert.equal(calls.length, 1);
});

test('control client returns stable categories without subprocess output or paths', async () => {
  const secret = 'Token-should-never-appear C:\\private\\control.ps1';
  const fixtures = [
    ['spawn', () => { throw new Error(secret); }, 'control-spawn-failed'],
    ['child-error', fakeSpawn([], { error: new Error(secret) }), 'control-spawn-failed'],
    ['nonzero', fakeSpawn([], { stderr: secret, exitCode: 9 }), 'control-nonzero-exit'],
    ['invalid-json', fakeSpawn([], { stdout: secret }), 'control-invalid-json'],
    ['multiple-json', fakeSpawn([], { stdout: '{"ok":true}\n{"ok":true}' }), 'control-multiple-json'],
    ['oversize-output', fakeSpawn([], { stdout: 'x'.repeat(65 * 1024) }), 'control-output-too-large'],
  ];

  for (const [name, spawnImpl, errorCategory] of fixtures) {
    const result = await runCodexControlAction({ action: 'status', powershellPath: 'pwsh.exe', controlPath: 'C:\\safe\\codex-control.ps1', spawnImpl });
    assert.equal(result.ok, false, name);
    assert.equal(result.errorCategory, errorCategory, name);
    assert.equal(JSON.stringify(result).includes(secret), false, name);
    assert.equal(JSON.stringify(result).includes('C:\\safe'), false, name);
  }
});

test('control client times out by killing only its spawned child', async () => {
  const child = fakeChild({ neverClose: true });
  const result = await runCodexControlAction({
    action: 'status', powershellPath: 'pwsh.exe', controlPath: 'safe.ps1', timeoutMs: 1,
    spawnImpl: () => child,
  });
  assert.deepEqual(result, { ok: false, action: 'status', errorCategory: 'control-timeout' });
  assert.equal(child.killed, 1);
});

test('atomic health writer retains only allowlisted health fields and leaves no temp files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-bridge-health-'));
  const target = path.join(root, 'discord-bridge-health.json');
  try {
    await writeBridgeHealthAtomic(target, {
      gateway: { state: 'ready', lastError: 'Token must-not-appear' },
      discordRest: { state: 'ok', response: 'C:\\private\\path' },
      queueCount: 2,
      startedAt: '2026-09-01T00:00:00.000Z',
      lastActivityAt: '2026-09-01T00:00:01.000Z',
      latestErrorCategory: 'gateway-timeout',
    });
    const saved = JSON.parse(await fs.readFile(target, 'utf8'));
    assert.deepEqual(saved.gateway, { state: 'ready' });
    assert.deepEqual(saved.discordRest, { state: 'ok' });
    assert.equal(saved.queueCount, 2);
    assert.equal(saved.latestEventCategory, 'gateway-timeout');
    assert.equal(JSON.stringify(saved).includes('must-not-appear'), false);
    assert.equal(JSON.stringify(saved).includes('private'), false);
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('concurrent health writes leave one complete JSON snapshot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-bridge-health-concurrent-'));
  const target = path.join(root, 'discord-bridge-health.json');
  try {
    await Promise.all(Array.from({ length: 8 }, (_, queueCount) => writeBridgeHealthAtomic(target, { queueCount, gateway: { state: 'ready' } })));
    const saved = JSON.parse(await fs.readFile(target, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.gateway.state, 'ready');
    assert.ok(Number.isInteger(saved.queueCount));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('aborted health writes clean their temp file without committing after a newer generation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-bridge-health-abort-'));
  const target = path.join(root, 'discord-bridge-health.json');
  const controller = new AbortController();
  let releaseWrite;
  const renamed = [];
  const fsImpl = {
    async writeFile(file, contents) { await new Promise((resolve) => { releaseWrite = resolve; }); await fs.writeFile(file, contents, 'utf8'); },
    async rename(source, destination) { renamed.push(destination); await fs.rename(source, destination); },
    rm: fs.rm.bind(fs),
  };
  try {
    const oldWrite = writeBridgeHealthAtomic(target, { gateway: { state: 'ready' } }, {
      fsImpl, signal: controller.signal, shouldCommit: () => !controller.signal.aborted,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    releaseWrite();
    await oldWrite;
    assert.deepEqual(renamed, []);
    assert.equal((await fs.readdir(root)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
