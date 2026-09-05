import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployMac } from './deploy-macos.mjs';
import { MAC_APP_NAME } from './discord-macos-control-lib.mjs';

export async function installMac({sourceRoot=path.dirname(fileURLToPath(import.meta.url)),liveRoot=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'mobile-notify'),desktopPath=path.join(os.homedir(),'Desktop'),skipLiveActions=false}={}) {
  if(process.platform!=='darwin')throw Error('macos-required');
  await fs.mkdir(liveRoot,{recursive:true,mode:0o700});await fs.mkdir(desktopPath,{recursive:true});
  let configured=true;try{await fs.access(path.join(liveRoot,'config.json'));}catch{configured=false;}
  const result=await deployMac({sourceRoot,liveRoot,desktopPath,skipLiveActions:skipLiveActions||!configured});
  if(!configured){
    const config=JSON.parse(await fs.readFile(path.join(sourceRoot,'config.example.json'),'utf8'));
    config.discordTokenPath=path.join(liveRoot,'discord-token.keychain');config.discordProjectlessRoot=path.join(os.homedir(),'Documents','Codex','Discord Tasks');config.discordWorktreeRoot=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'worktrees','discord');
    await fs.writeFile(path.join(liveRoot,'config.json'),`${JSON.stringify(config,null,2)}\n`,{flag:'wx',mode:0o600});
  }
  if(!configured && !skipLiveActions){
    const target=path.join(desktopPath,MAC_APP_NAME),destination=path.join(await fs.realpath(liveRoot),MAC_APP_NAME);
    try{const stat=await fs.lstat(target);if(!stat.isSymbolicLink()||await fs.readlink(target)!==destination)throw Error('desktop-shortcut-unowned');}
    catch(error){if(error.code!=='ENOENT')throw error;await fs.symlink(destination,target);}
  }
  return {...result,configurationRequired:!configured};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),options={};
  try{for(let i=0;i<args.length;i++){const a=args[i];if(a==='--skip-live-actions')options.skipLiveActions=true;else if(['--source-root','--live-root','--desktop-path'].includes(a)&&args[i+1])options[{'--source-root':'sourceRoot','--live-root':'liveRoot','--desktop-path':'desktopPath'}[a]]=args[++i];else throw Error('invalid-install-argument');}process.stdout.write(`${JSON.stringify(await installMac(options))}\n`);}catch(error){process.stdout.write(`${JSON.stringify({ok:false,errorCategory:error.message})}\n`);process.exitCode=1;}
}
