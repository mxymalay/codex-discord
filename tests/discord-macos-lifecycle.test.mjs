import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildMacControlApp} from '../deploy-macos.mjs';
import {createMacControlOperations,invokeMacControlAction,macAgentLabel} from '../discord-macos-control-lib.mjs';
const exec=promisify(execFile),repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('native launchd and detached supervisor satisfy all four service modes with a local dummy bridge', {skip:process.platform!=='darwin',timeout:90000}, async(t)=>{
  try{await exec('/bin/launchctl',['print',`gui/${process.getuid()}`]);}catch{t.skip('No launchd GUI domain is available for this test user');return;}
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'codex-discord-lifecycle-'))),toolDir=path.join(root,'tool');
  await fs.mkdir(toolDir);let ops;
  try {
    for(const name of ['discord-macos-control-lib.mjs','discord-macos-control.mjs'])await fs.copyFile(path.join(repo,name),path.join(toolDir,name));
    await fs.writeFile(path.join(toolDir,'discord-bridge.mjs'),"import fs from 'node:fs';import {spawn} from 'node:child_process';if(fs.existsSync(new URL('./resist',import.meta.url))){const child=spawn(process.execPath,['-e',`process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`],{stdio:'ignore'});fs.writeFileSync(new URL('./resistant.pid',import.meta.url),String(child.pid));}fs.writeFileSync(new URL('./dummy.pid',import.meta.url),String(process.pid));setInterval(()=>{},1000);\n");
    await buildMacControlApp({sourceRoot:repo,outputDirectory:toolDir,nodePath:process.execPath});
    ops=await createMacControlOperations({toolDir,home:root});
    const action=async name=>{const result=await invokeMacControlAction(name,{toolDir,operations:ops,pollAttempts:50,pollMs:100});assert.equal(result.ok,true,`${name}: ${JSON.stringify(result)}`);return result;};
    await fs.writeFile(path.join(toolDir,'resist'),'1');
    let v=await action('start-temporary');assert.equal(v.service.autoStartEnabled,false);assert.equal(v.service.runtime.mode,'temporary');
    await new Promise(resolve=>setTimeout(resolve,300));const resistantPid=Number(await fs.readFile(path.join(toolDir,'resistant.pid'),'utf8'));
    assert.ok(await ops.getInfo(resistantPid));v=await action('stop-temporary');assert.equal(v.service.running,false);assert.equal(v.service.taskInstalled,false);assert.equal(await ops.getInfo(resistantPid),null);await fs.unlink(path.join(toolDir,'resist'));
    v=await action('enable-long-term');assert.equal(v.service.autoStartEnabled,true);assert.equal(v.service.runtime.mode,'scheduled');
    const oldPid=v.service.runtime.processId;process.kill(oldPid,'SIGKILL');let restarted=null;for(let i=0;i<100;i++){const current=await ops.serviceStatus();if(current.running&&current.runtime.processId!==oldPid){restarted=current;break;}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(restarted,'launchd did not restart a crashed owned supervisor');
    v=await action('stop-temporary');assert.equal(v.service.running,false);assert.equal(v.service.autoStartEnabled,true);
    v=await action('start-temporary');assert.equal(v.service.runtime.mode,'scheduled');
    v=await action('disable-long-term');assert.equal(v.service.running,false);assert.equal(v.service.autoStartEnabled,false);
    v=await action('start-temporary');assert.equal(v.service.runtime.mode,'temporary');assert.equal(v.service.autoStartEnabled,false);
    v=await action('enable-long-term');assert.equal(v.service.runtime.mode,'scheduled');assert.equal(v.service.autoStartEnabled,true);
    v=await action('disable-long-term');assert.equal(v.service.running,false);
  }finally{
    try{await ops?.stop();}catch{}
    const target=`gui/${process.getuid()}/${macAgentLabel(toolDir)}`;
    try{await exec('/bin/launchctl',['bootout',target]);}catch{}
    try{await exec('/bin/launchctl',['enable',target]);}catch{}
    await fs.rm(root,{recursive:true,force:true});
  }
});
