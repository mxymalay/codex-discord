import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp,writeFile,readFile,mkdir,rm,symlink,readdir,readlink,lstat,realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deployMac, buildMacControlApp, createMacDesktopShortcut, MAC_DEPLOY_FILES } from '../deploy-macos.mjs';
import * as macControl from '../discord-macos-control-lib.mjs';
import { installMac } from '../install-macos.mjs';
const exec=promisify(execFile);
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function fixture() {
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'mac-deploy-')));
  const source=path.join(root,'source'),live=path.join(root,'live'),desktop=path.join(root,'desktop');
  for(const p of [source,live,desktop])await mkdir(p);
  for(const file of MAC_DEPLOY_FILES){const target=path.join(source,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,'new-runtime');}
  await writeFile(path.join(source,'README.md'),'# Codex Discord 私有命令控制台\n');
  for(const file of ['config.json','discord-token.dpapi','discord-inbox-state.json','unknown.txt']){await writeFile(path.join(live,file),'preserve');await writeFile(path.join(source,file),'never-copy');}
  const builder=async({outputDirectory})=>{const target=path.join(outputDirectory,'Codex Discord 控制台.app','Contents','MacOS');await mkdir(target,{recursive:true});await writeFile(path.join(target,'CodexDiscordControl'),'binary',{mode:0o755});};
  return {root,source,live,desktop,builder};
}

const desktopName='码驿 · CodexRelay 控制台.app';
const legacyName='Codex Discord 控制台.app';
const mockControl=async action=>action==='status'?{ok:true,service:{running:false,autoStartEnabled:false}}:{ok:true};
const deployFixture=(f,extra={})=>deployMac({sourceRoot:f.source,liveRoot:f.live,desktopPath:f.desktop,buildApp:f.builder,control:mockControl,register:async()=>{},...extra});

test('CodexRelay source marker and desktop name preserve installed native identity',async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.source,'README.md'),'# 码驿 · CodexRelay\n');
    const result=await deployFixture(f);
    assert.equal(macControl.MAC_APP_NAME,legacyName);
    assert.equal(macControl.MAC_DESKTOP_APP_NAME,desktopName);
    assert.equal(result.appPath,path.join(f.live,legacyName));
    assert.equal(macControl.macNativePath(f.live),path.join(f.live,legacyName,'Contents','MacOS','CodexDiscordControl'));
    assert.match(macControl.macAgentLabel(f.live,123),/^com\.openai\.codex-discord\.123\./);
    assert.equal(await readlink(path.join(f.desktop,desktopName)),result.appPath);
    assert.deepEqual(await readdir(f.desktop),[desktopName]);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('CodexRelay marker rejects a lookalike project heading',async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.source,'README.md'),'# CodexRelayUnexpected\n');
    await assert.rejects(deployFixture(f),/repository-marker-invalid/);
    assert.deepEqual(await readdir(f.desktop),[]);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('CodexRelay interim source marker remains compatible',async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.source,'README.md'),'# CodexRelay\n');
    assert.equal((await deployFixture(f)).ok,true);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('CodexRelay desktop migration removes only the old link owned by this installation',async()=>{
  const f=await fixture();try{
    await symlink(path.join(f.live,legacyName),path.join(f.desktop,legacyName));
    await deployFixture(f);
    assert.deepEqual(await readdir(f.desktop),[desktopName]);
    assert.equal(await readlink(path.join(f.desktop,desktopName)),path.join(f.live,legacyName));
  }finally{await rm(f.root,{recursive:true,force:true});}
});

for(const kind of ['file','link'])test(`CodexRelay preserves an unowned legacy desktop ${kind}`,async()=>{
  const f=await fixture();try{
    const old=path.join(f.desktop,legacyName),foreign=path.join(f.root,'foreign.app');
    if(kind==='file')await writeFile(old,'unowned');else await symlink(foreign,old);
    await deployFixture(f);
    assert.equal(kind==='file'?await readFile(old,'utf8'):await readlink(old),kind==='file'?'unowned':foreign);
    assert.equal(await readlink(path.join(f.desktop,desktopName)),path.join(f.live,legacyName));
  }finally{await rm(f.root,{recursive:true,force:true});}
});

for(const kind of ['file','link'])test(`CodexRelay refuses an unowned new desktop ${kind} without removing the old link`,async()=>{
  const f=await fixture();try{
    const target=path.join(f.desktop,desktopName),foreign=path.join(f.root,'foreign.app'),destination=path.join(f.live,legacyName);
    await symlink(destination,path.join(f.desktop,legacyName));
    if(kind==='file')await writeFile(target,'unowned');else await symlink(foreign,target);
    await assert.rejects(deployFixture(f),/desktop-shortcut-unowned/);
    assert.equal(kind==='file'?await readFile(target,'utf8'):await readlink(target),kind==='file'?'unowned':foreign);
    assert.equal(await readlink(path.join(f.desktop,legacyName)),destination);
    assert.equal(await readFile(path.join(f.live,'config.json'),'utf8'),'preserve');
  }finally{await rm(f.root,{recursive:true,force:true});}
});

for(const alreadyNew of [false,true])test(`CodexRelay failed registration restores old desktop entry with existing new link=${alreadyNew}`,async()=>{
  const f=await fixture();try{
    const old=path.join(f.desktop,legacyName),target=path.join(f.desktop,desktopName),destination=path.join(f.live,legacyName);
    await symlink(destination,old);
    if(alreadyNew)await symlink(destination,target);
    const existing=alreadyNew?await lstat(target):null;
    let registrations=0;
    await assert.rejects(deployFixture(f,{register:async()=>{if(++registrations===1){assert.equal(await readlink(target),destination);await assert.rejects(lstat(old),{code:'ENOENT'});throw Error('registration-injected-failure');}}}),/registration-injected-failure/);
    assert.equal(await readlink(old),destination);
    if(alreadyNew){assert.equal(await readlink(target),destination);assert.equal((await lstat(target)).ino,existing.ino);}
    else await assert.rejects(lstat(target),{code:'ENOENT'});
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('CodexRelay rollback preserves a concurrently replaced new desktop link and reports incomplete restoration',async()=>{
  const f=await fixture();try{
    const old=path.join(f.desktop,legacyName),target=path.join(f.desktop,desktopName),destination=path.join(f.live,legacyName),foreign=path.join(f.root,'foreign.app');
    await symlink(destination,old);
    let registrations=0;
    await assert.rejects(deployFixture(f,{register:async()=>{if(++registrations===1){await rm(target);await symlink(foreign,target);throw Error('registration-injected-failure');}}}),/rollback-incomplete: shortcut-restore/);
    assert.equal(await readlink(old),destination);
    assert.equal(await readlink(target),foreign);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

for(const scenario of ['legacy-delete','new-link-rollback'])for(const kind of ['link','file'])test(`CodexRelay ${scenario} race preserves a foreign ${kind} replaced after validation`,async()=>{
  const f=await fixture();const originalUnlink=fs.unlink,originalRename=fs.rename;
  try{
    const target=path.join(f.desktop,desktopName),legacy=path.join(f.desktop,legacyName),destination=path.join(f.live,legacyName),foreign=path.join(f.root,'foreign.app');
    const victim=scenario==='legacy-delete'?legacy:target;
    if(scenario==='legacy-delete')await symlink(destination,legacy);
    const operation=scenario==='new-link-rollback'?await createMacDesktopShortcut({liveRoot:f.live,desktopPath:f.desktop}):null;
    let injected=false;
    const replace=async file=>{
      if(file!==victim||injected)return;injected=true;
      await originalUnlink(victim);
      if(kind==='link')await symlink(foreign,victim);else await writeFile(victim,'foreign-bytes');
    };
    fs.unlink=async(file,...args)=>{await replace(file);return originalUnlink(file,...args);};
    fs.rename=async(file,...args)=>{await replace(file);return originalRename(file,...args);};
    const error=await (operation?operation.rollback():createMacDesktopShortcut({liveRoot:f.live,desktopPath:f.desktop})).then(()=>null,error=>error);
    assert.equal(injected,true);
    assert.ok(error,'a replaced desktop object must fail the transaction');
    assert.equal(kind==='link'?await readlink(victim):await readFile(victim,'utf8'),kind==='link'?foreign:'foreign-bytes');
  }finally{fs.unlink=originalUnlink;fs.rename=originalRename;await rm(f.root,{recursive:true,force:true});}
});

test('CodexRelay quarantine cleanup failure preserves unknown files and the completed removal for rollback',async()=>{
  const f=await fixture();const originalRmdir=fs.rmdir;
  try{
    const legacy=path.join(f.desktop,legacyName),target=path.join(f.desktop,desktopName),destination=path.join(f.live,legacyName);
    await symlink(destination,legacy);
    let retained=null;
    fs.rmdir=async(file,...args)=>{
      if(!retained&&path.basename(file).startsWith('.codexrelay-shortcut.')){retained=path.join(file,'foreign-sentinel');await writeFile(retained,'preserve');}
      return originalRmdir(file,...args);
    };
    const operation=await createMacDesktopShortcut({liveRoot:f.live,desktopPath:f.desktop});
    fs.rmdir=originalRmdir;
    assert.ok(retained);assert.equal(await readFile(retained,'utf8'),'preserve');
    assert.equal(await readlink(target),destination);await assert.rejects(lstat(legacy),{code:'ENOENT'});
    await operation.rollback();
    assert.equal(await readlink(legacy),destination);await assert.rejects(lstat(target),{code:'ENOENT'});
    assert.equal(await readFile(retained,'utf8'),'preserve');
  }finally{fs.rmdir=originalRmdir;await rm(f.root,{recursive:true,force:true});}
});

test('CodexRelay fresh installer creates the new desktop entry without registering or starting an unconfigured service',{skip:process.platform!=='darwin'},async()=>{
  const f=await fixture();try{
    await rm(path.join(f.live,'config.json'));
    await writeFile(path.join(f.source,'config.example.json'),'{}');
    let deployments=0;
    const result=await installMac({sourceRoot:f.source,liveRoot:f.live,desktopPath:f.desktop,deploy:async options=>{
      deployments++;assert.equal(options.skipLiveActions,true);await f.builder({outputDirectory:f.live});return {ok:true};
    }});
    assert.equal(deployments,1);assert.equal(result.configurationRequired,true);
    assert.equal(await readlink(path.join(f.desktop,desktopName)),path.join(f.live,legacyName));
    assert.deepEqual(await readdir(f.desktop),[desktopName]);
    const config=JSON.parse(await readFile(path.join(f.live,'config.json'),'utf8'));
    assert.equal(config.discordTokenPath,path.join(f.live,'discord-token.keychain'));
  }finally{await rm(f.root,{recursive:true,force:true});}
});

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
    const plist=JSON.parse((await exec('/usr/bin/plutil',['-convert','json','-o','-',path.join(result.app,'Contents','Info.plist')])).stdout);
    assert.equal(plist.CFBundleName,'码驿 · CodexRelay 控制台');
    assert.equal(plist.CFBundleIdentifier,'com.openai.codex-discord.control');
    assert.equal(plist.CFBundleExecutable,'CodexDiscordControl');
    assert.equal(path.basename(result.app),legacyName);
    const source=await readFile(path.join(repo,'control-app','CodexDiscordControl.m'),'utf8');
    assert.ok(source.includes('self.window.title=@"码驿 · CodexRelay 控制台"'));
    assert.ok(source.includes('scheduledTimerWithTimeInterval:2.0'));
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
