import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const launcherPath = new URL('../update-windows.cmd', import.meta.url);
const nativeWindows = process.platform === 'win32';

test('the ZIP launcher diagnoses its missing sibling before checking PowerShell', async () => {
  const source = await readFile(launcherPath, 'utf8');
  const runtimeCheck = source.indexOf('where pwsh.exe');
  assert.ok(runtimeCheck >= 0, 'the launcher still checks its PowerShell dependency');
  const preflight = source.slice(0, runtimeCheck);
  assert.match(preflight, /if not exist\s+"%~dp0update-windows\.ps1"\s+\([\s\S]*?\bexit \/b [1-9]\d*/i,
    'opening a lone CMD from inside a ZIP must stop before invoking PowerShell');
  assert.match(preflight, /Extract All/i, 'the error explains the Windows ZIP extraction action');
  assert.match(preflight, /extracted folder/i, 'the error says where to run the launcher afterward');
});

async function invokeFixture({ script, omitPowerShell = false } = {}) {
  // Spaces and parentheses reproduce ordinary Explorer extraction paths.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex launcher (ZIP) '));
  try {
    const launcher = path.join(directory, 'update-windows.cmd');
    await writeFile(launcher, await readFile(launcherPath));
    if (script !== undefined) await writeFile(path.join(directory, 'update-windows.ps1'), script);
    const environment = { ...process.env };
    if (omitPowerShell) {
      for (const key of Object.keys(environment)) {
        if (key.toLowerCase() === 'path') delete environment[key];
      }
      environment.PATH = path.join(process.env.SystemRoot, 'System32');
    }
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${launcher}""`], {
      cwd: directory, env: environment, encoding: 'utf8', input: '\r\n',
      windowsHide: true, windowsVerbatimArguments: true, timeout: 15_000,
    });
    assert.equal(result.error, undefined, `isolated launcher did not finish: ${result.error?.message}`);
    return { exitCode: result.status, output: result.stdout + result.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('native Windows: opening only the CMD shows extraction guidance and fails', { skip: !nativeWindows }, async () => {
  const result = await invokeFixture({ omitPowerShell: true });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Missing update-windows\.ps1/i);
  assert.match(result.output, /Extract All/i);
  assert.match(result.output, /extracted folder/i);
  assert.doesNotMatch(result.output, /PowerShell 7 is required|Usage: pwsh/i);
});

test('native Windows: a complete folder still explains a missing PowerShell dependency', { skip: !nativeWindows }, async () => {
  const result = await invokeFixture({ script: "throw 'the fixture must not be launched'", omitPowerShell: true });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /PowerShell 7 is required/i);
  assert.doesNotMatch(result.output, /Missing update-windows\.ps1|fixture must not be launched/i);
});

for (const exitCode of [0, 23]) {
  test(`native Windows: an extracted launcher preserves script exit code ${exitCode}`, { skip: !nativeWindows }, async () => {
    const result = await invokeFixture({ script: `Write-Output 'isolated updater fixture reached'\nexit ${exitCode}\n` });
    assert.equal(result.exitCode, exitCode);
    assert.match(result.output, /isolated updater fixture reached/);
    assert.doesNotMatch(result.output, /Missing update-windows\.ps1|Extract All/i);
    if (exitCode !== 0) assert.match(result.output, /Update failed/i);
  });
}
