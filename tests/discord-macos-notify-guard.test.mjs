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
async function waitForUnloaded(target) {
  for(let attempt=0;attempt<100;attempt++) {
    try { await exec('/bin/launchctl',['print',target]); }
    catch { return; }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error('Isolated test job did not finish unloading');
}

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

test('real launchd guard enables, repairs, and disables only an isolated dummy watcher', {skip:process.platform!=='darwin',timeout:45000}, async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'codex-notify-guard-')));
  const toolDir=path.join(root,'mobile-notify'),home=path.join(root,'test-home');
  const powerShellPath=await findExecutable(process.env.CODEX_DISCORD_PWSH_PATH||'pwsh');
  assert.ok(powerShellPath,'PowerShell 7 is required for the real guard test');
  await fs.mkdir(toolDir);await fs.mkdir(home);
  const options={toolDir,home,powerShellPath,environment:{PATH:process.env.PATH,CODEX_HOME:root},pollMs:50,pollAttempts:100};
  const spec=makeMacNotifyGuardAgent({...options,uid:process.getuid()});
  const plist=path.join(home,'Library','LaunchAgents',`${spec.label}.plist`),target=`gui/${process.getuid()}/${spec.label}`;
  const marker=path.join(toolDir,'dummy-guard.json');
  try {
    // launchctl bootout returns before a terminating process disappears. A
    // deliberate delay makes that real lifecycle boundary deterministic.
    await fs.writeFile(path.join(toolDir,'watch-notify.ps1'),`Add-Type @'
using System;using System.Runtime.InteropServices;using System.Threading;
public static class DelayedGuardExit {
  private static PosixSignalRegistration handler;
  public static void Install(){handler=PosixSignalRegistration.Create(PosixSignal.SIGTERM, context=>{context.Cancel=true;new Thread(()=>{Thread.Sleep(1200);Environment.Exit(0);}).Start();});}
}
'@
[DelayedGuardExit]::Install()
[IO.File]::WriteAllText((Join-Path $PSScriptRoot "dummy-guard.json"),(@{pid=$PID;codexHome=$env:CODEX_HOME} | ConvertTo-Json))
while ($true) { Start-Sleep 1 }
`);
    await fs.writeFile(path.join(toolDir,'discord-bridge.mjs'),'import fs from "node:fs";fs.writeFileSync(new URL("./bridge-started.txt",import.meta.url),"unexpected bridge start");\n');
    let result=await invokeMacNotifyGuard('status',options);
    assert.equal(result.ok,true);assert.equal(result.service.installed,false);
    result=await invokeMacNotifyGuard('enable',options);
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.service.enabled,true);assert.equal(result.service.running,true);
    let saved;for(let n=0;n<100;n++){try{saved=JSON.parse(await fs.readFile(marker,'utf8'));break;}catch{}await new Promise(r=>setTimeout(r,50));}
    assert.equal(saved?.codexHome,root);
    const firstPid=result.service.pid;
    result=await invokeMacNotifyGuard('enable',options);
    assert.equal(result.ok,true);assert.equal(result.service.pid,firstPid,'repeat enable should preserve the running watcher');
    await exec('/bin/launchctl',['bootout',target]);
    await waitForUnloaded(target);
    const stale=makeMacNotifyGuardAgent({...options,powerShellPath:'/removed/runtime/pwsh',uid:process.getuid()});
    await fs.writeFile(plist,stale.xml,{mode:0o600});
    result=await invokeMacNotifyGuard('enable',options);
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.service.definitionCurrent,true);
    let replacementReady=false;for(let n=0;n<100;n++){try{if(JSON.parse(await fs.readFile(marker,'utf8')).pid===result.service.pid){replacementReady=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
    assert.ok(replacementReady,'replacement watcher did not install its delayed shutdown handler');
    const beforeUpdatePid=result.service.pid;
    options.environment.CODEX_HOME=path.join(root,'reconfigured-home');
    result=await invokeMacNotifyGuard('enable',options);
    assert.equal(result.ok,true,JSON.stringify(result));assert.notEqual(result.service.pid,beforeUpdatePid,'changed saved environment should restart the watcher');
    let updatedReady=false;for(let n=0;n<100;n++){try{const markerValue=JSON.parse(await fs.readFile(marker,'utf8'));if(markerValue.pid===result.service.pid){assert.equal(markerValue.codexHome,options.environment.CODEX_HOME);updatedReady=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
    assert.ok(updatedReady,'updated watcher did not install its delayed shutdown handler');
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
