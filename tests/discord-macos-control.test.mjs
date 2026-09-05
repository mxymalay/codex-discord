import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeMacControlAction, makeLaunchAgent, validateLaunchAgent, readMacHealth, validateRuntimeIdentity } from '../discord-macos-control-lib.mjs';

function machine({ enabled = false, running = false, mode = 'temporary', installed = true } = {}) {
  const state = { taskInstalled: installed, taskDefinitionCurrent: true, autoStartEnabled: enabled, running, taskRunning: running && mode === 'scheduled', runtime: running ? { mode } : null, notificationsEnabled:true };
  return { state, operations: {
    serviceStatus: async () => structuredClone(state),
    install: async () => { state.taskInstalled = true; state.taskDefinitionCurrent = true; },
    setEnabled: async (v) => { state.autoStartEnabled = v; },
    stop: async () => { state.running = false; state.taskRunning = false; state.runtime = null; },
    start: async (mode) => { state.running = true; state.taskRunning = mode === 'scheduled'; state.runtime = { mode }; },
    desktopStatus: async () => ({ running: false, processCount: 0 }),
    setNotificationsEnabled: async value => {const previous=state.notificationsEnabled;state.notificationsEnabled=value;return previous;},
    restoreNotificationsEnabled: async value => {state.notificationsEnabled=value;},
  } };
}

test('temporary lifecycle never changes disabled login choice or installs a missing agent', async () => {
  const {state, operations} = machine({ installed: false });
  assert.equal((await invokeMacControlAction('start-temporary', { operations })).ok, true);
  assert.deepEqual([state.running, state.autoStartEnabled, state.taskInstalled, state.runtime.mode], [true, false, false, 'temporary']);
  assert.equal((await invokeMacControlAction('stop-temporary', { operations })).ok, true);
  assert.deepEqual([state.running, state.autoStartEnabled, state.taskInstalled], [false, false, false]);
});

test('both stop modes disable notifications before stopping and again after the startup race settles',async()=>{
  for(const action of ['stop-temporary','disable-long-term']) {
    const {state,operations}=machine({enabled:true,running:true,mode:'scheduled'});
    const changes=[];
    const original=operations.setNotificationsEnabled;
    operations.setNotificationsEnabled=async value=>{changes.push(value);return original(value);};
    const stop=operations.stop;
    operations.stop=async()=>{assert.equal(state.notificationsEnabled,false);state.notificationsEnabled=true;await stop();};
    const result=await invokeMacControlAction(action,{operations});
    assert.equal(result.ok,true);
    assert.equal(state.notificationsEnabled,false);
    assert.deepEqual(changes,[false,false]);
    assert.equal(state.autoStartEnabled,action==='stop-temporary');
  }
});

test('both start modes enable notifications and failed starts restore the prior setting',async()=>{
  for(const action of ['start-temporary','enable-long-term'])for(const failure of [false,'throw','timeout']) {
    const {state,operations}=machine();state.notificationsEnabled=false;
    const start=operations.start;
    operations.start=async mode=>{
      assert.equal(state.notificationsEnabled,true);
      if(failure==='throw')throw Error('fixture start failed');
      if(!failure)await start(mode);
    };
    const result=await invokeMacControlAction(action,{operations,pollAttempts:1});
    assert.equal(result.ok,!failure);
    assert.equal(state.notificationsEnabled,!failure);
  }
});

test('failed or incomplete stops mute a raced supervisor again and report any final mute failure',async()=>{
  for(const action of ['stop-temporary','disable-long-term'])for(const failure of ['throw','timeout'])for(const muteFails of [false,true]) {
    const {state,operations}=machine({enabled:true,running:true,mode:'scheduled'});
    const set=operations.setNotificationsEnabled;let writes=0;
    operations.setNotificationsEnabled=async value=>{
      writes++;
      if(writes===2&&muteFails)throw Error('fixture mute failed');
      return set(value);
    };
    operations.stop=async()=>{
      assert.equal(state.notificationsEnabled,false);
      state.notificationsEnabled=true;
      if(failure==='throw')throw Error('fixture stop failed');
    };
    const result=await invokeMacControlAction(action,{operations,pollAttempts:1});
    assert.equal(result.ok,false);
    assert.equal(result.errorCategory,muteFails?'notification-disable-failed':failure==='throw'?'control-action-failed':'service-action-incomplete');
    assert.equal(state.notificationsEnabled,muteFails);
    assert.equal(writes,2);
  }
});

test('an initial notification gate failure still stops the owned service and retries muting',async()=>{
  for(const action of ['stop-temporary','disable-long-term'])for(const persistent of [false,true]) {
    const {state,operations}=machine({enabled:true,running:true,mode:'scheduled'});
    const set=operations.setNotificationsEnabled;let writes=0;
    operations.setNotificationsEnabled=async value=>{
      writes++;
      if(writes===1||persistent)throw Error('fixture config unavailable');
      return set(value);
    };
    const result=await invokeMacControlAction(action,{operations,pollAttempts:1});
    assert.equal(state.running,false,'owned service was not stopped after the initial mute failed');
    assert.equal(state.autoStartEnabled,action==='stop-temporary');
    assert.equal(state.notificationsEnabled,persistent);
    assert.equal(result.ok,!persistent);
    if(persistent)assert.equal(result.errorCategory,'notification-disable-failed');
    assert.equal(writes,2);
  }
});

test('a failed start reports when its prior notification setting cannot be restored',async()=>{
  const second=machine();second.operations.start=async()=>{throw Error('fixture start failed');};
  second.operations.restoreNotificationsEnabled=async()=>{throw Error('fixture restore failed');};
  assert.equal((await invokeMacControlAction('start-temporary',{operations:second.operations})).errorCategory,'notification-restore-failed');
});

test('a failed initial notification update prevents starting a service',async()=>{
  const {state,operations}=machine();let started=false;
  operations.setNotificationsEnabled=async()=>{throw Error('fixture config unavailable');};
  operations.start=async()=>{started=true;};
  const result=await invokeMacControlAction('start-temporary',{operations});
  assert.equal(result.ok,false);
  assert.equal(started,false);
  assert.equal(state.running,false);
});

test('desktop stop and status do not change notification configuration',async()=>{
  const {operations}=machine();
  operations.setNotificationsEnabled=async()=>{assert.fail('desktop/status changed notifications');};
  operations.stopDesktop=async()=>({ok:true,alreadyStopped:true});
  assert.equal((await invokeMacControlAction('stop-codex',{operations})).ok,true);
  assert.equal((await invokeMacControlAction('status',{operations})).ok,true);
});

test('temporary stop preserves enabled login choice and long-term enable migrates temporary supervisor', async () => {
  const a = machine({ enabled: true, running: true, mode: 'scheduled' });
  await invokeMacControlAction('stop-temporary', { operations: a.operations });
  assert.deepEqual([a.state.running, a.state.autoStartEnabled], [false, true]);
  const b = machine({ running: true, mode: 'temporary' });
  assert.equal((await invokeMacControlAction('enable-long-term', { operations: b.operations })).ok, true);
  assert.deepEqual([b.state.running, b.state.autoStartEnabled, b.state.runtime.mode], [true, true, 'scheduled']);
  assert.equal((await invokeMacControlAction('disable-long-term', { operations: b.operations })).ok, true);
  assert.deepEqual([b.state.running, b.state.autoStartEnabled], [false, false]);
});

test('failed service mutation cannot report success and invalid actions perform no operation', async () => {
  const {operations} = machine(); operations.start = async () => {};
  assert.equal((await invokeMacControlAction('start-temporary', {operations})).ok, false);
  assert.deepEqual(await invokeMacControlAction('evil', {operations: {}}), {ok:false, action:'invalid', errorCategory:'invalid-action'});
});

test('launch agent validates exact argv and working directory and escapes XML', () => {
  const spec = makeLaunchAgent({toolDir:'/tmp/a & b', nodePath:'/opt/node', uid:501});
  assert.match(spec.xml, /a &amp; b/);
  assert.equal(validateLaunchAgent(spec.value, spec), true);
  assert.equal(validateLaunchAgent({...spec.value, ProgramArguments:['/bin/sh','-c','arbitrary']}, spec), false);
  assert.equal(validateLaunchAgent({...spec.value, WorkingDirectory:'/tmp/other'}, spec), false);
});

test('runtime ownership rejects PID reuse, foreign uid, changed argv and shared process groups', () => {
  const runtime = {version:1, processId:20, startToken:'55:66', toolDir:path.resolve('fixtures','bridge'), mode:'temporary', nodePath:'/opt/node'};
  const processInfo = {pid:20, uid:501, pgid:20, startToken:'55:66', executable:'/opt/node', argv:['/opt/node',path.resolve('fixtures','bridge','discord-macos-control.mjs'),'--supervisor','temporary']};
  assert.equal(validateRuntimeIdentity(runtime, processInfo, {toolDir:path.resolve('fixtures','bridge'), uid:501}), true);
  for (const patch of [{startToken:'55:67'}, {uid:502}, {pgid:1}, {argv:['/opt/node','other.mjs']}]) {
    assert.equal(validateRuntimeIdentity(runtime, {...processInfo,...patch}, {toolDir:path.resolve('fixtures','bridge'),uid:501}), false);
  }
});

test('health displays unknown when stale and queue count comes from persisted queued entries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mac-control-'));
  try {
    await writeFile(path.join(dir,'discord-inbox-state.json'),JSON.stringify({version:2,pendingContinuations:{a:{status:'queued'},b:{status:'started'}}}));
    await writeFile(path.join(dir,'discord-bridge-health.json'),JSON.stringify({version:1,observedAt:'2020-01-01',gateway:{state:'ready'},discordRest:{state:'ok'},queueCount:90}));
    const result = await readMacHealth(dir,true);
    assert.equal(result.queueCount,1); assert.equal(result.discord.state,'unknown');
    const a = machine();
    const status = await invokeMacControlAction('status',{toolDir:dir,operations:a.operations});
    assert.equal(status.codexDesktop.running,false); assert.equal(status.desktop.processCount,0);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('owned stale launch agent can be repaired while unrelated command identity is rejected', async () => {
  const {validateOwnedLaunchAgent}=await import('../discord-macos-control-lib.mjs');
  const spec=makeLaunchAgent({toolDir:path.resolve('fixtures','bridge'),nodePath:path.resolve('new','node'),uid:501,environment:{CODEX_DISCORD_KEYCHAIN:'/tmp/test.keychain'}});
  const old={...spec.value,ProgramArguments:[path.resolve('old','node'),path.resolve('fixtures','bridge','discord-macos-control.mjs'),'--supervisor','scheduled']};
  assert.equal(typeof validateOwnedLaunchAgent,'function');
  assert.equal(validateOwnedLaunchAgent(old,spec),true);assert.equal(validateLaunchAgent(old,spec),false);
  assert.equal(validateOwnedLaunchAgent({...old,ProgramArguments:[path.resolve('old','node'),'/tmp/other.mjs','--supervisor','scheduled']},spec),false);
  assert.equal(spec.value.EnvironmentVariables.CODEX_DISCORD_KEYCHAIN,'/tmp/test.keychain');
});


test('loaded launchd identity requires the saved argv and directory before service control',async()=>{
  const {validateLoadedLaunchAgent}=await import('../discord-macos-control-lib.mjs');
  const spec=makeLaunchAgent({toolDir:path.resolve('fixtures','bridge'),nodePath:path.resolve('node'),uid:501});
  const plist=path.resolve('fixtures','agent.plist'),v=spec.value;
  const output=`gui/501/${spec.label} = {\n\tpath = ${plist}\n\tprogram = ${v.ProgramArguments[0]}\n\targuments = {\n${v.ProgramArguments.map(arg=>`\t\t${arg}\n`).join('')}\t}\n\tworking directory = ${v.WorkingDirectory}\n}`;
  assert.equal(typeof validateLoadedLaunchAgent,'function');
  assert.equal(validateLoadedLaunchAgent(output,{agent:v,plist,uid:501}),true);
  assert.equal(validateLoadedLaunchAgent(output.replace('--supervisor','--arbitrary'),{agent:v,plist,uid:501}),false);
  assert.equal(validateLoadedLaunchAgent(output.replace(`path = ${plist}`,'path = /tmp/foreign.plist'),{agent:v,plist,uid:501}),false);
});
