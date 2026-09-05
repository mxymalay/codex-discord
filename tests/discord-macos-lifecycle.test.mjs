import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {buildMacControlApp} from '../deploy-macos.mjs';
import {createMacControlOperations,invokeMacControlAction,macAgentLabel} from '../discord-macos-control-lib.mjs';
const exec=promisify(execFile),repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('native launchd and detached supervisor satisfy all four service modes with a local dummy bridge', {skip:process.platform!=='darwin',timeout:90000}, async(t)=>{
  try{await exec('/bin/launchctl',['print',`gui/${process.getuid()}`]);}catch{t.skip('No launchd GUI domain is available for this test user');return;}
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'codex-discord-lifecycle-'))),toolDir=path.join(root,'tool');
  await fs.mkdir(toolDir);let ops;
  try {
    for(const name of ['discord-macos-control-lib.mjs','discord-macos-control.mjs','discord-notification-control.mjs'])await fs.copyFile(path.join(repo,name),path.join(toolDir,name));
    const configPath=path.join(toolDir,'config.json');
    const config=async()=>JSON.parse(await fs.readFile(configPath,'utf8'));
    const runSupervisor=()=>new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[path.join(toolDir,'discord-macos-control.mjs'),'--supervisor','temporary'],{detached:true,stdio:'ignore'});
      child.once('error',reject);child.once('exit',code=>resolve(code));
    });
    await fs.writeFile(configPath,JSON.stringify({enabled:false,unrelated:{value:'retained'}}),{mode:0o600});
    await fs.writeFile(path.join(toolDir,'discord-bridge.mjs'),"import fs from 'node:fs';import {spawn} from 'node:child_process';if(fs.existsSync(new URL('./resist',import.meta.url))){const child=spawn(process.execPath,['-e',`process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`],{stdio:'ignore'});fs.writeFileSync(new URL('./resistant.pid',import.meta.url),String(child.pid));}fs.writeFileSync(new URL('./dummy.pid',import.meta.url),String(process.pid));setInterval(()=>{},1000);\n");
    await buildMacControlApp({sourceRoot:repo,outputDirectory:toolDir,nodePath:process.execPath});
    const operationFailures=[];
    ops=Object.fromEntries(Object.entries(await createMacControlOperations({toolDir,home:root})).map(([name,operation])=>[name,async(...args)=>{
      try{return await operation(...args);}catch(error){operationFailures.push(`${name}: ${error.stack}\n${error.stderr||''}`);throw error;}
    }]));
    const action=async name=>{
      const result=await invokeMacControlAction(name,{toolDir,operations:ops,pollAttempts:50,pollMs:100});
      if(!result.ok){
        const log=await fs.readFile(path.join(toolDir,'discord-bridge-guard.log'),'utf8').catch(()=>'(unavailable)');
        const loaded=await exec('/bin/launchctl',['print',`gui/${process.getuid()}/${macAgentLabel(toolDir)}`]).then(({stdout})=>stdout.split('\n').filter(line=>/^\t(?:path|program|working directory|state|pid|active count|last exit code|runs) = /.test(line)).join('\n')).catch(()=>'(unloaded)');
        assert.fail(`${name}: ${JSON.stringify(result)}\n${operationFailures.join('\n')}\nIsolated supervisor log:\n${log.slice(-12000)}\nIsolated launchd state:\n${loaded}`);
      }
      assert.deepEqual(await config(),{enabled:['start-temporary','enable-long-term'].includes(name),unrelated:{value:'retained'}});
      return result;
    };
    await fs.writeFile(path.join(toolDir,'resist'),'1');
    let v=await action('start-temporary');assert.equal(v.service.autoStartEnabled,false);assert.equal(v.service.runtime.mode,'temporary');
    await new Promise(resolve=>setTimeout(resolve,300));const resistantPid=Number(await fs.readFile(path.join(toolDir,'resistant.pid'),'utf8'));
    assert.ok(await ops.getInfo(resistantPid));v=await action('stop-temporary');assert.equal(v.service.running,false);assert.equal(v.service.taskInstalled,false);assert.equal(await ops.getInfo(resistantPid),null);await fs.unlink(path.join(toolDir,'resist'));
    v=await action('enable-long-term');assert.equal(v.service.autoStartEnabled,true);assert.equal(v.service.runtime.mode,'scheduled');
    await fs.writeFile(configPath,JSON.stringify({...await config(),enabled:false}));
    const oldPid=v.service.runtime.processId;process.kill(oldPid,'SIGKILL');let restarted=null;for(let i=0;i<100;i++){const current=await ops.serviceStatus();if(current.running&&current.runtime.processId!==oldPid){restarted=current;break;}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(restarted,'launchd did not restart a crashed owned supervisor');
    assert.equal((await config()).enabled,true,'a genuine scheduled supervisor launch resumes notifications');
    v=await action('stop-temporary');assert.equal(v.service.running,false);assert.equal(v.service.autoStartEnabled,true);
    v=await action('start-temporary');assert.equal(v.service.runtime.mode,'scheduled');
    v=await action('disable-long-term');assert.equal(v.service.running,false);assert.equal(v.service.autoStartEnabled,false);
    v=await action('start-temporary');assert.equal(v.service.runtime.mode,'temporary');assert.equal(v.service.autoStartEnabled,false);
    const dummyChild=async previous=>{
      for(let i=0;i<150;i++){
        const pid=Number(await fs.readFile(path.join(toolDir,'dummy.pid'),'utf8'));
        if(pid!==previous&&(await ops.getInfo(pid))?.ppid===v.service.runtime.processId)return pid;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.fail('owned dummy bridge did not start');
    };
    const firstChild=await dummyChild();
    await fs.writeFile(configPath,JSON.stringify({...await config(),enabled:false}));
    process.kill(firstChild,'SIGKILL');await dummyChild(firstChild);
    assert.equal((await config()).enabled,false,'bridge retries within one supervisor do not re-enable notifications');
    assert.equal(await runSupervisor(),0);
    assert.equal((await config()).enabled,false,'a duplicate supervisor without singleton ownership cannot re-enable notifications');
    v=await action('enable-long-term');assert.equal(v.service.runtime.mode,'scheduled');assert.equal(v.service.autoStartEnabled,true);
    v=await action('disable-long-term');assert.equal(v.service.running,false);
    const runtimePath=path.join(toolDir,'discord-bridge-runtime.json');
    await fs.rm(runtimePath,{force:true});await fs.mkdir(runtimePath);
    assert.notEqual(await runSupervisor(),0);
    assert.equal((await config()).enabled,false,'failed supervisor initialization restores the prior notification setting');
    await fs.rmdir(runtimePath);
  }finally{
    try{await ops?.stop();}catch{}
    const target=`gui/${process.getuid()}/${macAgentLabel(toolDir)}`;
    try{await exec('/bin/launchctl',['bootout',target]);}catch{}
    try{await exec('/bin/launchctl',['enable',target]);}catch{}
    await fs.rm(root,{recursive:true,force:true});
  }
});
