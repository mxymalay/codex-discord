import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,mkdir,rm,symlink,readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deployMac, buildMacControlApp, MAC_DEPLOY_FILES } from '../deploy-macos.mjs';
const exec=promisify(execFile);
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function fixture() {
  const root=await mkdtemp(path.join(os.tmpdir(),'mac-deploy-'));
  const source=path.join(root,'source'),live=path.join(root,'live'),desktop=path.join(root,'desktop');
  for(const p of [source,live,desktop])await mkdir(p);
  for(const file of MAC_DEPLOY_FILES){const target=path.join(source,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,'new-runtime');}
  await writeFile(path.join(source,'README.md'),'# Codex Discord 私有命令控制台\n');
  for(const file of ['config.json','discord-token.dpapi','discord-inbox-state.json','unknown.txt']){await writeFile(path.join(live,file),'preserve');await writeFile(path.join(source,file),'never-copy');}
  const builder=async({outputDirectory})=>{const target=path.join(outputDirectory,'Codex Discord 控制台.app','Contents','MacOS');await mkdir(target,{recursive:true});await writeFile(path.join(target,'CodexDiscordControl'),'binary',{mode:0o755});};
  return {root,source,live,desktop,builder};
}

test('isolated deploy copies allowlist, builds app, and preserves private and unknown bytes',async()=>{
  const f=await fixture();try{
    const result=await deployMac({sourceRoot:f.source,liveRoot:f.live,desktopPath:f.desktop,skipLiveActions:true,buildApp:f.builder});
    assert.equal(result.ok,true);
    assert.equal(await readFile(path.join(f.live,'discord-macos-control.mjs'),'utf8'),'new-runtime');
    for(const file of ['config.json','discord-token.dpapi','discord-inbox-state.json','unknown.txt'])assert.equal(await readFile(path.join(f.live,file),'utf8'),'preserve');
    assert.deepEqual(await readdir(f.desktop),[]);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('failed file commit restores exact old bytes and leaves backups',async()=>{
  const f=await fixture();try{
    const target=path.join(f.live,MAC_DEPLOY_FILES[0]);await writeFile(target,'original');
    await assert.rejects(deployMac({sourceRoot:f.source,liveRoot:f.live,desktopPath:f.desktop,skipLiveActions:true,buildApp:f.builder,afterCommit:async n=>{if(n===3)throw Error('injected');}}),/injected/);
    assert.equal(await readFile(target,'utf8'),'original');
    assert.equal(await readFile(path.join(f.live,'config.json'),'utf8'),'preserve');
    assert.ok((await readdir(path.join(f.live,'.codex-discord-backups'))).length>0);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('deployment rejects symlink escapes before writes',async()=>{
  const f=await fixture();try{
    await rm(path.join(f.source,MAC_DEPLOY_FILES[0]));await symlink(path.join(f.live,'config.json'),path.join(f.source,MAC_DEPLOY_FILES[0]));
    await assert.rejects(deployMac({sourceRoot:f.source,liveRoot:f.live,desktopPath:f.desktop,skipLiveActions:true,buildApp:f.builder}),/symlink|boundary/);
    assert.equal((await readdir(f.live)).length,4);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('failed live update restores service choice, old command definitions and files',async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.live,MAC_DEPLOY_FILES[0]),'original');
    let running=true,enabled=false,registrations=[];
    const control=async action=>{if(action==='status')return {ok:true,service:{running,autoStartEnabled:enabled}};if(action==='stop-temporary')running=false;if(action==='start-temporary')running=true;return {ok:true};};
    await assert.rejects(deployMac({sourceRoot:f.source,liveRoot:f.live,desktopPath:f.desktop,buildApp:f.builder,control,register:async()=>{registrations.push(await readFile(path.join(f.live,MAC_DEPLOY_FILES[0]),'utf8'));if(registrations.length===1)throw Error('register-failed');}}),/register-failed/);
    assert.equal(running,true);assert.equal(enabled,false);assert.deepEqual(registrations,['new-runtime','original']);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('native app builds and reports actual process identity and signed desktop status without quit', {skip:process.platform!=='darwin',timeout:90000},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mac-native-'));
  try {
    const result=await buildMacControlApp({sourceRoot:repo,outputDirectory:root,nodePath:process.execPath});
    const info=JSON.parse((await exec(result.executable,['--process-info',String(process.pid)])).stdout);
    assert.equal(info.pid,process.pid);assert.equal(info.uid,process.getuid());assert.ok(info.startToken);assert.ok(info.argv.includes('--test')||info.argv.some(x=>x.includes('discord-macos-deploy')));
    const desktop=JSON.parse((await exec(result.executable,['--desktop-status'])).stdout);
    assert.equal(desktop.ok,true);assert.equal(typeof desktop.desktop.running,'boolean');
    const invalid=await exec(result.executable,['--not-valid']).catch(x=>x);assert.notEqual(invalid.code,0);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('concurrent deployments reject the second writer before any live file mutation',async()=>{
  const f=await fixture();let release,entered;const gate=new Promise(resolve=>{release=resolve;});const began=new Promise(resolve=>{entered=resolve;});
  let first;
  try{
    first=deployMac({sourceRoot:f.source,liveRoot:f.live,desktopPath:f.desktop,skipLiveActions:true,buildApp:async opts=>{entered();await gate;await f.builder(opts);}});
    await began;
    await assert.rejects(deployMac({sourceRoot:f.source,liveRoot:f.live,desktopPath:f.desktop,skipLiveActions:true,buildApp:f.builder}),/deployment-locked/);
    assert.equal(await readFile(path.join(f.live,'config.json'),'utf8'),'preserve');
  }finally{release();if(first)await first;await rm(f.root,{recursive:true,force:true});}
});

test('cleanup preserves an unknown file added to a deployment stage',async()=>{
  const f=await fixture();let retained;
  try{
    await deployMac({sourceRoot:f.source,liveRoot:f.live,desktopPath:f.desktop,skipLiveActions:true,buildApp:f.builder,afterCommit:async n=>{if(n!==1)return;const name=(await readdir(f.live)).find(x=>x.startsWith('.codex-discord-deploy.')&&x.endsWith('.stage'));retained=path.join(f.live,name,'external-sentinel.txt');await writeFile(retained,'do-not-delete');}});
    assert.equal(await readFile(retained,'utf8'),'do-not-delete');
  }finally{await rm(f.root,{recursive:true,force:true});}
});
