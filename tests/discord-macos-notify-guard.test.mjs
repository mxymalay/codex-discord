import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {findExecutable} from '../discord-runtime-lib.mjs';
import {invokeMacNotifyGuard, makeMacNotifyGuardAgent, validateOwnedMacNotifyGuardAgent} from '../discord-macos-notify-guard.mjs';
const exec = promisify(execFile);
const guardCompilerTimeoutMs = 60000;
async function prepareGuardSignalHandler(toolDir,powerShellPath) {
  const compiler=path.join(toolDir,'compile-dummy-guard.ps1');
  const assembly=path.join(toolDir,'dummy-guard.dll');
  await fs.writeFile(compiler,`$ErrorActionPreference = 'Stop'
Add-Type -OutputAssembly (Join-Path $PSScriptRoot 'dummy-guard.dll') -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Threading;
public static class DelayedGuardExit {
  private static PosixSignalRegistration handler;
  public static void Install(){handler=PosixSignalRegistration.Create(PosixSignal.SIGTERM, context=>{context.Cancel=true;new Thread(()=>{Thread.Sleep(1200);Environment.Exit(0);}).Start();});}
}
'@
`);
  const startedAt=Date.now();
  try {
    await exec(powerShellPath,['-NoProfile','-File',compiler],{timeout:guardCompilerTimeoutMs,killSignal:'SIGKILL'});
  } catch(error) {
    assert.fail(`Isolated signal-handler compilation failed (setup budget ${guardCompilerTimeoutMs}ms, PowerShell ${powerShellPath}, code ${error.code}, signal ${error.signal}).\n${String(error.stdout||'').slice(-6000)}\n${String(error.stderr||'').slice(-6000)}`);
  }
  assert.ok((await fs.stat(assembly)).size>0,'fixture compiler did not produce its signal-handler assembly');
  return Date.now()-startedAt;
}
async function waitForUnloaded(target) {
  for(let attempt=0;attempt<100;attempt++) {
    try { await exec('/bin/launchctl',['print',target]); }
    catch { return; }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error('Isolated test job did not finish unloading');
}
async function watcherDiagnostics({target,marker,phases,log,powerShellPath,firstPathExecutable,execCommand=exec}) {
  const read=async file=>(await fs.readFile(file,'utf8').catch(error=>`unavailable (${error.code})`)).slice(-12000);
  let launchd;
  try {
    const output=(await execCommand('/bin/launchctl',['print',target],{timeout:5000})).stdout;
    // launchctl also prints inherited environment variables. Keep only this
    // fixture's lifecycle fields and executable, never its full environment.
    launchd=output.split(/\r?\n/).filter(line=>/^\s*(?:path|program|state|pid|runs|last exit code|last terminating signal|reason|active count|spawn type|minimum runtime|exit timeout) = /.test(line)).join('\n');
    const args=output.match(/^\s*arguments = \{\r?\n\s*([^\r\n]+)/m);
    if(args)launchd+=`\narguments[0] = ${args[1].trim()}`;
    const currentPid=output.match(/^\s*pid = (\d+)$/m)?.[1];
    if(currentPid) {
      const processInfo=await execCommand('/bin/ps',['-p',currentPid,'-o','pid=,ppid=,uid=,state=,etime=,comm='],{timeout:5000}).then(result=>result.stdout.trim(),error=>`unavailable (${error.code})`);
      launchd+=`\nprocess (pid ppid uid state elapsed executable): ${processInfo}`;
    }
  } catch(error) { launchd=`unavailable (${error.code}): ${String(error.stderr||'').slice(-2000)}`; }
  return `Selected PowerShell: ${powerShellPath}\nResolved PowerShell: ${await fs.realpath(powerShellPath).catch(error=>`unavailable (${error.code})`)}\nFirst pwsh on PATH: ${firstPathExecutable}\nlaunchd:\n${launchd}\nReadiness marker:\n${await read(marker)}\nDummy watcher phases:\n${await read(phases)}\nDummy watcher log:\n${await read(log)}`;
}
async function waitForWatcherReady({marker,pid,codexHome,...diagnostics}) {
  const deadline=Date.now()+20000;
  while(Date.now()<deadline) {
    let value;
    try { value=JSON.parse(await fs.readFile(marker,'utf8')); }
    catch(error) { if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error; }
    if(value?.pid===pid) {
      assert.equal(value.codexHome,codexHome,'watcher did not receive its configured environment');
      return;
    }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.fail(`Isolated watcher did not become ready for reported PID ${pid} within 20 seconds.\n${await watcherDiagnostics({marker,...diagnostics})}`);
}

test('watcher failure diagnostics retain restart and executable evidence without inherited environment', async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-guard-diagnostics-'));
  try {
    const marker=path.join(root,'marker'),phases=path.join(root,'phases'),log=path.join(root,'log');
    await fs.writeFile(marker,JSON.stringify({pid:502,codexHome:root}));
    await fs.writeFile(phases,'pid=502 phase=entered\n');await fs.writeFile(log,'');
    const output=await watcherDiagnostics({target:'gui/501/isolated',marker,phases,log,powerShellPath:process.execPath,firstPathExecutable:'/first/runtime/pwsh',execCommand:async(command,args)=>{
      if(command==='/bin/ps') { assert.deepEqual(args,['-p','502','-o','pid=,ppid=,uid=,state=,etime=,comm=']);return {stdout:'502 1 501 S 00:01 /actual/runtime/pwsh\n'}; }
      assert.deepEqual(args,['print','gui/501/isolated']);
      return {stdout:'state = running\npid = 502\nruns = 2\nlast exit code = 1\nprogram = /actual/runtime/pwsh\narguments = {\n /actual/runtime/pwsh\n -NoProfile\n}\nenvironment = {\n SECRET = must-not-appear\n}\n'};
    }});
    for(const evidence of ['pid = 502','runs = 2','last exit code = 1','arguments[0] = /actual/runtime/pwsh','First pwsh on PATH: /first/runtime/pwsh','phase=entered','Dummy watcher log:'])assert.ok(output.includes(evidence),evidence);
    assert.ok(!output.includes('SECRET'));assert.ok(!output.includes('must-not-appear'));
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('notification guard targets only the PowerShell watcher and persists its native environment', () => {
  const toolDir=path.resolve('/tmp/a & b/mobile-notify'),powerShellPath=path.resolve('/opt/pwsh');
  const spec=makeMacNotifyGuardAgent({toolDir,powerShellPath,uid:501,environment:{CODEX_HOME:path.dirname(toolDir),CODEX_DISCORD_KEYCHAIN:path.resolve('/tmp/secure.keychain'),BOT_TOKEN:'must-not-persist'}});
  assert.deepEqual(spec.value.ProgramArguments,[powerShellPath,'-NoProfile','-File',path.join(toolDir,'watch-notify.ps1')]);
  assert.equal(spec.value.EnvironmentVariables.CODEX_HOME,path.dirname(toolDir));
  assert.equal(spec.value.EnvironmentVariables.CODEX_DISCORD_KEYCHAIN,path.resolve('/tmp/secure.keychain'));
  assert.equal(spec.value.EnvironmentVariables.BOT_TOKEN,undefined);
  assert.match(spec.xml,/a &amp; b/);
  assert.ok(validateOwnedMacNotifyGuardAgent(spec.value,spec));
  const stale=structuredClone(spec.value);stale.ProgramArguments[0]=path.resolve('/removed/runtime/pwsh');
  assert.ok(validateOwnedMacNotifyGuardAgent(stale,spec),'a moved PowerShell installation should remain repairable');
  const substituted=structuredClone(spec.value);substituted.ProgramArguments[3]=path.join(toolDir,'discord-bridge.mjs');
  assert.equal(validateOwnedMacNotifyGuardAgent(substituted,spec),false);
});

test('real launchd guard enables, repairs, and disables only an isolated dummy watcher', {skip:process.platform!=='darwin',timeout:90000+guardCompilerTimeoutMs}, async(t)=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'codex-notify-guard-')));
  const toolDir=path.join(root,'mobile-notify'),home=path.join(root,'test-home');
  const powerShellPath=await findExecutable(process.env.CODEX_DISCORD_PWSH_PATH||'pwsh');
  const firstPathExecutable=await findExecutable('pwsh');
  assert.ok(powerShellPath,'PowerShell 7 is required for the real guard test');
  await fs.mkdir(toolDir);await fs.mkdir(home);
  const options={toolDir,home,powerShellPath,environment:{PATH:process.env.PATH,CODEX_HOME:root},pollMs:50,pollAttempts:100};
  const spec=makeMacNotifyGuardAgent({...options,uid:process.getuid()});
  const plist=path.join(home,'Library','LaunchAgents',`${spec.label}.plist`),target=`gui/${process.getuid()}/${spec.label}`;
  const marker=path.join(toolDir,'dummy-guard.json');
  const ready=pid=>waitForWatcherReady({marker,phases:path.join(toolDir,'dummy-guard-phases.log'),log:path.join(toolDir,'notify-guard.log'),target,powerShellPath,firstPathExecutable,pid,codexHome:options.environment.CODEX_HOME});
  try {
    // Roslyn cold compilation has a separate setup budget. The launchd readiness
    // deadline below still measures a real PowerShell process, DLL load and environment.
    const compilationMs=await prepareGuardSignalHandler(toolDir,powerShellPath);
    t.diagnostic(`Signal-handler fixture compiled in ${compilationMs}ms (setup budget ${guardCompilerTimeoutMs}ms); watcher readiness remains 20000ms.`);
    // launchctl bootout returns before a terminating process disappears. A
    // deliberate delay makes that real lifecycle boundary deterministic.
    // Exercise a six-second cold startup independently of host compilation speed.
    await fs.writeFile(path.join(toolDir,'watch-notify.ps1'),`$ErrorActionPreference = 'Stop'
function Write-Phase([string]$phase) { [IO.File]::AppendAllText((Join-Path $PSScriptRoot 'dummy-guard-phases.log'), ('{0:o} pid={1} phase={2}' -f [DateTime]::UtcNow, $PID, $phase) + [Environment]::NewLine) }
Write-Phase 'entered'
$firstStart = Join-Path $PSScriptRoot 'first-start'
if (-not (Test-Path -LiteralPath $firstStart)) {
  [IO.File]::WriteAllText($firstStart, 'started')
  Start-Sleep -Milliseconds 6000
}
Write-Phase 'delay-complete'
Add-Type -Path (Join-Path $PSScriptRoot 'dummy-guard.dll')
Write-Phase 'assembly-loaded'
[DelayedGuardExit]::Install()
Write-Phase 'signal-handler-installed'
[IO.File]::WriteAllText((Join-Path $PSScriptRoot "dummy-guard.json"),(@{pid=$PID;codexHome=$env:CODEX_HOME} | ConvertTo-Json))
while ($true) { Start-Sleep 1 }
`);
    await fs.writeFile(path.join(toolDir,'discord-bridge.mjs'),'import fs from "node:fs";fs.writeFileSync(new URL("./bridge-started.txt",import.meta.url),"unexpected bridge start");\n');
    let result=await invokeMacNotifyGuard('status',options);
    assert.equal(result.ok,true);assert.equal(result.service.installed,false);
    result=await invokeMacNotifyGuard('enable',options);
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.service.enabled,true);assert.equal(result.service.running,true);
    await ready(result.service.pid);
    const firstPid=result.service.pid;
    result=await invokeMacNotifyGuard('enable',options);
    assert.equal(result.ok,true);assert.equal(result.service.pid,firstPid,'repeat enable should preserve the running watcher');
    await exec('/bin/launchctl',['bootout',target]);
    await waitForUnloaded(target);
    const stale=makeMacNotifyGuardAgent({...options,powerShellPath:'/removed/runtime/pwsh',uid:process.getuid()});
    await fs.writeFile(plist,stale.xml,{mode:0o600});
    result=await invokeMacNotifyGuard('enable',options);
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.service.definitionCurrent,true);
    await ready(result.service.pid);
    const beforeUpdatePid=result.service.pid;
    options.environment.CODEX_HOME=path.join(root,'reconfigured-home');
    result=await invokeMacNotifyGuard('enable',options);
    assert.equal(result.ok,true,JSON.stringify(result));assert.notEqual(result.service.pid,beforeUpdatePid,'changed saved environment should restart the watcher');
    await ready(result.service.pid);
    result=await invokeMacNotifyGuard('disable',options);
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.service.installed,false);assert.equal(result.service.running,false);
    await assert.rejects(fs.access(plist));
    await assert.rejects(fs.access(path.join(toolDir,'bridge-started.txt')));
    await fs.writeFile(plist,spec.xml,{mode:0o600});
    const otherPlist=path.join(root,'other-job-definition.plist');
    await fs.writeFile(otherPlist,spec.xml,{mode:0o600});
    await exec('/bin/launchctl',['enable',target]);
    await exec('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,otherPlist]);
    result=await invokeMacNotifyGuard('disable',options);
    assert.equal(result.ok,false,'a different loaded definition must not be stopped');
    assert.equal(result.errorCategory,'untrusted-loaded-notify-guard');
    await exec('/bin/launchctl',['print',target]);
    await exec('/bin/launchctl',['bootout',target]);
    await waitForUnloaded(target);
    const hostile=spec.xml.replaceAll('watch-notify.ps1','discord-bridge.mjs');
    await fs.writeFile(plist,hostile,{mode:0o600});
    for(const action of ['enable','disable']) { result=await invokeMacNotifyGuard(action,options);assert.equal(result.ok,false,'unowned job definition must be rejected'); }
    assert.equal(await fs.readFile(plist,'utf8'),hostile,'guard changed a substituted job definition');
  } finally {
    try{await exec('/bin/launchctl',['bootout',target]);}catch{}
    try{await waitForUnloaded(target);}catch{}
    try{await exec('/bin/launchctl',['enable',target]);}catch{}
    await fs.rm(root,{recursive:true,force:true});
  }
});
