import { promises as fs } from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAC_APP_NAME,invokeMacControlAction } from './discord-macos-control-lib.mjs';
const exec=promisify(execFile);
export const MAC_DEPLOY_FILES=Object.freeze([
  'discord-bridge.mjs','discord-bridge-lib.mjs','discord-commands-lib.mjs','discord-interactions.mjs','discord-gateway-lib.mjs','discord-health-lib.mjs','discord-task-create-lib.mjs','discord-task-index-lib.mjs','rollout-completion-watcher-lib.mjs','codex-takeover-lib.mjs','discord-control-client.mjs','discord-runtime-lib.mjs','discord-paths-lib.mjs','discord-notification-control.mjs',
  'dispatcher.ps1','discord-config.ps1','discord-secret.ps1','discord-notification-control.ps1','discord-state.ps1','discord-http.ps1','task-delivery-state.ps1','get-discord-token.ps1','protect-discord-pending-reply.ps1','unprotect-discord-pending-reply.ps1','save-discord-token.ps1','activate-discord-bot.ps1','setup.ps1','repair-notify.ps1','watch-notify.ps1','discord-migration.ps1','export-discord-migration.ps1','import-discord-migration.ps1','discord-macos-notify-guard.mjs',
  'discord-macos-control-lib.mjs','discord-macos-control.mjs','deploy-macos.mjs','install-macos.mjs','control-app/CodexDiscordControl.m','assets/codex-discord-control.png',
]);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,p)=>p===root||p.startsWith(root+path.sep);
async function directory(root){const result=path.resolve(root),stat=await fs.lstat(result);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('directory-boundary-invalid');return {path:await fs.realpath(result),dev:stat.dev,ino:stat.ino};}
async function sameDirectory(identity){const now=await directory(identity.path);if(now.dev!==identity.dev||now.ino!==identity.ino)throw Error('directory-identity-changed');}
async function safePath(root,relative) {
  if(path.isAbsolute(relative)||relative.split(/[\\/]/).some(x=>x==='..'))throw Error('file-boundary-invalid');
  const target=path.resolve(root,relative);if(!inside(root,target))throw Error('file-boundary-invalid');
  let at=root;
  for(const segment of path.relative(root,target).split(path.sep)){
    at=path.join(at,segment);try{const stat=await fs.lstat(at);if(stat.isSymbolicLink())throw Error('file-symlink-boundary');}catch(error){if(error.code==='ENOENT')break;throw error;}
  }
  return target;
}
async function snapshot(file) {
  try{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink())throw Error('destination-is-not-file');const bytes=await fs.readFile(file);return {hash:hash(bytes),bytes,mode:s.mode&0o777};}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function fileEquals(file,expected) {const current=await snapshot(file);return current?.hash===expected?.hash;}
async function leaves(root,prefix=''){const entries=await fs.readdir(path.join(root,prefix),{withFileTypes:true}),result=[];for(const e of entries){const relative=path.join(prefix,e.name);if(e.isSymbolicLink())throw Error('app-build-symlink');if(e.isDirectory())result.push(...await leaves(root,relative));else if(e.isFile())result.push(relative);else throw Error('app-build-invalid-file');}return result;}
const xml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));

export async function buildMacControlApp({sourceRoot,outputDirectory,nodePath=process.execPath,toolDir=outputDirectory}) {
  if(process.platform!=='darwin')throw Error('macos-build-required');
  const app=path.join(outputDirectory,MAC_APP_NAME),contents=path.join(app,'Contents'),macos=path.join(contents,'MacOS'),resources=path.join(contents,'Resources');
  await fs.mkdir(macos,{recursive:true});await fs.mkdir(resources,{recursive:true});
  const executable=path.join(macos,'CodexDiscordControl');
  await exec('/usr/bin/xcrun',['clang','-fobjc-arc','-fblocks','-O2','-Werror','-Wno-incompatible-pointer-types','-framework','Cocoa','-framework','Security',path.join(sourceRoot,'control-app','CodexDiscordControl.m'),'-o',executable],{timeout:60000,maxBuffer:65536});
  const iconSource=path.join(sourceRoot,'assets','codex-discord-control.png');
  try {
    const iconset=path.join(outputDirectory,'.codex-control-icon.iconset');await fs.mkdir(iconset);
    for(const size of [16,32,128,256,512])for(const scale of [1,2])await exec('/usr/bin/sips',['-z',String(size*scale),String(size*scale),iconSource,'--out',path.join(iconset,`icon_${size}x${size}${scale===2?'@2x':''}.png`)],{timeout:10000,maxBuffer:1000});
    await exec('/usr/bin/iconutil',['-c','icns',iconset,'-o',path.join(resources,'CodexDiscordControl.icns')],{timeout:10000,maxBuffer:1000});
    for(const item of await fs.readdir(iconset))await fs.unlink(path.join(iconset,item));await fs.rmdir(iconset);
  } catch(error){throw Error(`control-icon-build-failed: ${error.code||'invalid-icon'}`);}
  const environmentKeys=['PATH','CODEX_HOME','CODEX_DISCORD_PWSH_PATH','CODEX_DISCORD_CODEX_PATH','CODEX_DISCORD_KEYCHAIN'];
  const environmentXml=environmentKeys.filter(key=>process.env[key]).map(key=>`<key>${xml(key)}</key><string>${xml(process.env[key])}</string>`).join('');
  const info=`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleName</key><string>Codex Discord 控制台</string><key>CFBundleIdentifier</key><string>com.openai.codex-discord.control</string><key>CFBundleExecutable</key><string>CodexDiscordControl</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string><key>CFBundleIconFile</key><string>CodexDiscordControl</string><key>NSHighResolutionCapable</key><true/><key>CodexDiscordEnvironment</key><dict>${environmentXml}</dict><key>CodexDiscordNodePath</key><string>${xml(await fs.realpath(nodePath))}</string><key>CodexDiscordToolDir</key><string>${xml(path.resolve(toolDir))}</string></dict></plist>`;
  await fs.writeFile(path.join(contents,'Info.plist'),info,{mode:0o644});
  await exec('/usr/bin/codesign',['--force','--sign','-',app],{timeout:30000,maxBuffer:65536});
  await exec('/usr/bin/codesign',['--verify','--strict',app],{timeout:30000,maxBuffer:65536});
  return {app,executable};
}

async function registerCommands(live,nodePath) {
  await new Promise((resolve,reject)=>{
    const child=spawn(nodePath,[path.join(live,'discord-bridge.mjs'),'--register-commands','--once'],{cwd:live,stdio:['ignore','pipe','pipe'],detached:true});
    let bytes=0,settled=false;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);if(error){try{process.kill(-child.pid,'SIGKILL');}catch{}reject(Error('command-registration-failed'));}else resolve();};
    const timer=setTimeout(()=>finish(true),30000);
    const read=chunk=>{bytes+=chunk.length;if(bytes>65536)finish(true);};child.stdout.on('data',read);child.stderr.on('data',read);child.once('error',()=>finish(true));child.once('close',code=>finish(code!==0));
  });
}

export async function deployMac({sourceRoot,liveRoot,desktopPath,skipLiveActions=false,nodePath=process.execPath,buildApp=buildMacControlApp,control,register,afterCommit}={}) {
  const source=await directory(sourceRoot),live=await directory(liveRoot),desktop=await directory(desktopPath);
  for(const [a,b] of [[source,live],[source,desktop],[live,desktop]])if(inside(a.path,b.path)||inside(b.path,a.path))throw Error('deployment-directories-overlap');
  const marker=await fs.readFile(await safePath(source.path,'README.md'),'utf8');if(!marker.startsWith('# Codex Discord 私有命令控制台'))throw Error('repository-marker-invalid');
  const manifest=[];
  for(const relative of MAC_DEPLOY_FILES){const sourceFile=await safePath(source.path,relative),dest=await safePath(live.path,relative),s=await snapshot(sourceFile);if(!s)throw Error(`required-source-missing: ${relative}`);await snapshot(dest);manifest.push({relative,source:sourceFile,hash:s.hash,mode:s.mode});}
  await safePath(live.path,MAC_APP_NAME);
  const id=randomUUID(),stage=path.join(live.path,`.codex-discord-deploy.${id}.stage`),backup=path.join(live.path,'.codex-discord-backups',`${new Date().toISOString().replace(/[:.]/g,'-')}-${id}`);
  // An interrupted deployment retains this lock for explicit recovery; never guess that an owner is dead.
  const lockPath=path.join(live.path,'.discord-macos-deploy.lock');let lockIdentity;
  try{await fs.mkdir(lockPath,{mode:0o700});lockIdentity=await directory(lockPath);}
  catch(error){if(error.code==='EEXIST')throw Error('deployment-locked');throw error;}
  const lockOwner=JSON.stringify({version:1,processId:process.pid,transactionId:id});
  try{await fs.writeFile(path.join(lockPath,'owner.json'),lockOwner,{mode:0o600,flag:'wx'});}
  catch(error){try{await sameDirectory(lockIdentity);await fs.rmdir(lockPath);}catch{}throw error;}
  const records=[],createdDirs=[];let prior=null,registrationAttempted=false,mutationAttempted=false,shortcut=null,stageIdentity=null,backupIdentity=null;
  control ||= action=>invokeMacControlAction(action,{toolDir:live.path});register ||= ()=>registerCommands(live.path,nodePath);
  async function mkdirTracked(dir){if(dir===live.path||dir===desktop.path)return;try{const s=await fs.lstat(dir);if(!s.isDirectory()||s.isSymbolicLink())throw Error('directory-boundary-invalid');}catch(error){if(error.code!=='ENOENT')throw error;await mkdirTracked(path.dirname(dir));await fs.mkdir(dir);createdDirs.push(await directory(dir));}}
  async function restoreService(){if(!prior)return;const result=await control(prior.autoStartEnabled?'enable-long-term':'disable-long-term');if(!result.ok)throw Error('service-restore-failed');if(!prior.running){const r=await control('stop-temporary');if(!r.ok)throw Error('service-restore-failed');}else if(!prior.autoStartEnabled){const r=await control('start-temporary');if(!r.ok)throw Error('service-restore-failed');}}
  async function assertRoots(){await sameDirectory(source);await sameDirectory(live);await sameDirectory(desktop);if(stageIdentity)await sameDirectory(stageIdentity);if(backupIdentity)await sameDirectory(backupIdentity);}
  try {
    await assertRoots();await fs.mkdir(stage,{mode:0o700});stageIdentity=await directory(stage);
    for(const entry of manifest){const to=path.join(stage,entry.relative);await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(entry.source,to);await fs.chmod(to,entry.mode);if(hash(await fs.readFile(to))!==entry.hash)throw Error('stage-hash-mismatch');}
    await buildApp({sourceRoot:source.path,outputDirectory:stage,nodePath,toolDir:live.path});
    for(const relative of await leaves(path.join(stage,MAC_APP_NAME))){const fullRelative=path.join(MAC_APP_NAME,relative);const s=await snapshot(path.join(stage,fullRelative));manifest.push({relative:fullRelative,hash:s.hash,mode:s.mode});await safePath(live.path,fullRelative);}
    await assertRoots();await mkdirTracked(path.dirname(backup));await fs.mkdir(backup,{mode:0o700});backupIdentity=await directory(backup);
    for(const entry of manifest){const dest=await safePath(live.path,entry.relative),old=await snapshot(dest);if(old){const to=path.join(backup,entry.relative);await fs.mkdir(path.dirname(to),{recursive:true});await fs.writeFile(to,old.bytes,{mode:old.mode,flag:'wx'});if(hash(await fs.readFile(to))!==old.hash)throw Error('backup-hash-mismatch');}records.push({...entry,dest,old,committed:false});}
    if(!skipLiveActions){const status=await control('status');if(!status.ok)throw Error('service-status-failed');prior=status.service;mutationAttempted=true;const stopped=await control('stop-temporary');if(!stopped.ok)throw Error('service-stop-failed');}
    for(const record of records){
      await assertRoots();await safePath(live.path,record.relative);if(!await fileEquals(record.dest,record.old))throw Error('destination-changed-before-commit');
      await mkdirTracked(path.dirname(record.dest));const temp=`${record.dest}.${id}.tmp`;
      try {await fs.copyFile(path.join(stage,record.relative),temp);await fs.chmod(temp,record.mode);if(hash(await fs.readFile(temp))!==record.hash)throw Error('commit-hash-mismatch');await assertRoots();await safePath(live.path,record.relative);if(!await fileEquals(record.dest,record.old))throw Error('destination-changed-before-commit');await fs.rename(temp,record.dest);record.committed=true;}finally{await fs.rm(temp,{force:true});}
      if(afterCommit)await afterCommit(records.filter(x=>x.committed).length);
    }
    if(!skipLiveActions){
      const target=path.join(desktop.path,MAC_APP_NAME),destination=path.join(live.path,MAC_APP_NAME);let old=null;
      try{const s=await fs.lstat(target);if(!s.isSymbolicLink())throw Error('desktop-shortcut-unowned');old=await fs.readlink(target);if(old!==destination)throw Error('desktop-shortcut-unowned');}catch(error){if(error.code!=='ENOENT')throw error;}
      shortcut={target,old,destination};const temp=path.join(desktop.path,`.codex-discord-shortcut.${id}.tmp`);await fs.symlink(destination,temp);await fs.rename(temp,target);
      registrationAttempted=true;await register();await restoreService();
    }
    return {ok:true,backupPath:backup,appPath:path.join(live.path,MAC_APP_NAME),fileCount:records.length};
  } catch(primary) {
    const rollbackErrors=[];
    if(mutationAttempted)try{const result=await control('stop-temporary');if(!result.ok)throw Error();}catch{rollbackErrors.push('service-stop');}
    if(shortcut)try{await sameDirectory(desktop);if(await fs.readlink(shortcut.target)!==shortcut.destination)throw Error();await fs.unlink(shortcut.target);if(shortcut.old!==null)await fs.symlink(shortcut.old,shortcut.target);}catch{rollbackErrors.push('shortcut-restore');}
    for(const record of records.toReversed())if(record.committed)try{
      await assertRoots();await safePath(live.path,record.relative);if(!await fileEquals(record.dest,{hash:record.hash}))throw Error('rollback-concurrent-change');
      if(record.old){const temp=`${record.dest}.${id}.rollback.tmp`;await fs.writeFile(temp,record.old.bytes,{mode:record.old.mode,flag:'wx'});await fs.rename(temp,record.dest);}else await fs.unlink(record.dest);
    }catch{rollbackErrors.push('file-restore');}
    if(registrationAttempted)try{await register();}catch{rollbackErrors.push('command-restore');}
    if(mutationAttempted)try{await restoreService();}catch{rollbackErrors.push('service-restore');}
    if(rollbackErrors.length)throw Error(`${primary.message}; rollback-incomplete: ${rollbackErrors.join(',')}`);throw primary;
  } finally {
    if(stageIdentity)try{
      await sameDirectory(stageIdentity);const directories=new Set();
      for(const entry of manifest){
        const file=await safePath(stage,entry.relative);
        if(await fileEquals(file,{hash:entry.hash}))await fs.unlink(file);
        let parent=path.dirname(file);while(parent!==stage&&inside(stage,parent)){directories.add(parent);parent=path.dirname(parent);}
      }
      for(const dir of [...directories].sort((a,b)=>b.length-a.length))try{await safePath(stage,path.relative(stage,dir));await fs.rmdir(dir);}catch{}
      await fs.rmdir(stage);
    }catch{}
    for(const d of createdDirs.toReversed())try{await sameDirectory(d);await fs.rmdir(d.path);}catch{}
    try{await sameDirectory(lockIdentity);if(await fs.readFile(path.join(lockPath,'owner.json'),'utf8')===lockOwner){await fs.unlink(path.join(lockPath,'owner.json'));await fs.rmdir(lockPath);}}catch{}
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),options={};
  try{
    for(let i=0;i<args.length;i++){const a=args[i];if(a==='--skip-live-actions')options.skipLiveActions=true;else if(['--source-root','--live-root','--desktop-path'].includes(a)&&args[i+1])options[{'--source-root':'sourceRoot','--live-root':'liveRoot','--desktop-path':'desktopPath'}[a]]=args[++i];else throw Error('invalid-deploy-argument');}
    const result=await deployMac(options);process.stdout.write(`${JSON.stringify(result)}\n`);
  }catch(error){process.stdout.write(`${JSON.stringify({ok:false,errorCategory:error.message})}\n`);process.exitCode=1;}
}
