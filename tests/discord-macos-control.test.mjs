import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeMacControlAction, makeLaunchAgent, validateLaunchAgent, readMacHealth, validateRuntimeIdentity } from '../discord-macos-control-lib.mjs';

function machine({ enabled = false, running = false, mode = 'temporary', installed = true } = {}) {
  const state = { taskInstalled: installed, taskDefinitionCurrent: true, autoStartEnabled: enabled, running, taskRunning: running && mode === 'scheduled', runtime: running ? { mode } : null };
  return { state, operations: {
    serviceStatus: async () => structuredClone(state),
    install: async () => { state.taskInstalled = true; state.taskDefinitionCurrent = true; },
    setEnabled: async (v) => { state.autoStartEnabled = v; },
    stop: async () => { state.running = false; state.taskRunning = false; state.runtime = null; },
    start: async (mode) => { state.running = true; state.taskRunning = mode === 'scheduled'; state.runtime = { mode }; },
    desktopStatus: async () => ({ running: false, processCount: 0 }),
  } };
}

test('temporary lifecycle never changes disabled login choice or installs a missing agent', async () => {
  const {state, operations} = machine({ installed: false });
  assert.equal((await invokeMacControlAction('start-temporary', { operations })).ok, true);
  assert.deepEqual([state.running, state.autoStartEnabled, state.taskInstalled, state.runtime.mode], [true, false, false, 'temporary']);
  assert.equal((await invokeMacControlAction('stop-temporary', { operations })).ok, true);
  assert.deepEqual([state.running, state.autoStartEnabled, state.taskInstalled], [false, false, false]);
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
