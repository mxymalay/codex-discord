import {promises as fs} from 'node:fs';
import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {promisify, isDeepStrictEqual} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {findExecutable, resolveCodexHome} from './discord-runtime-lib.mjs';

const exec=promisify(execFile);
const DEFAULT_DIR=path.dirname(fileURLToPath(import.meta.url));
const ENV_KEYS=['PATH','CODEX_HOME','CODEX_DISCORD_PWSH_PATH','CODEX_DISCORD_KEYCHAIN'];
const actions=new Set(['status','enable','disable']);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const escapeXml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const encode=value=>typeof value==='boolean'?`<${value}/>`:typeof value==='number'?`<integer>${value}</integer>`:Array.isArray(value)?`<array>${value.map(encode).join('')}</array>`:value&&typeof value==='object'?`<dict>${Object.entries(value).map(([k,v])=>`<key>${escapeXml(k)}</key>${encode(v)}`).join('')}</dict>`:`<string>${escapeXml(value)}</string>`;

export function makeMacNotifyGuardAgent({toolDir,powerShellPath,uid=process.getuid?.()??0,environment={}}) {
  toolDir=path.resolve(toolDir);
  const label=`com.openai.codex-discord.notify-guard.${uid}.${createHash('sha256').update(toolDir).digest('hex').slice(0,16)}`;
  const env={PATH:environment.PATH||'/usr/bin:/bin:/usr/sbin:/sbin'};
  for(const key of ENV_KEYS.slice(1))if(environment[key])env[key]=environment[key];
  env.CODEX_DISCORD_PWSH_PATH=powerShellPath;
  const value={Label:label,ProgramArguments:[powerShellPath,'-NoProfile','-File',path.join(toolDir,'watch-notify.ps1')],WorkingDirectory:toolDir,RunAtLoad:true,KeepAlive:true,ThrottleInterval:5,ProcessType:'Background',EnvironmentVariables:env,StandardOutPath:path.join(toolDir,'notify-guard.log'),StandardErrorPath:path.join(toolDir,'notify-guard.log')};
  return {label,value,xml:`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${encode(value)}</plist>\n`};
}

export function validateOwnedMacNotifyGuardAgent(value,spec) {
  return value?.Label===spec.label && value.WorkingDirectory===spec.value.WorkingDirectory &&
    Array.isArray(value.ProgramArguments) && value.ProgramArguments.length===4 && path.isAbsolute(value.ProgramArguments[0]||'') &&
    path.basename(value.ProgramArguments[0])==='pwsh' && JSON.stringify(value.ProgramArguments.slice(1))===JSON.stringify(spec.value.ProgramArguments.slice(1)) &&
    value.RunAtLoad===true && value.KeepAlive===true && value.ThrottleInterval===5 && value.ProcessType==='Background' &&
    value.StandardOutPath===spec.value.StandardOutPath && value.StandardErrorPath===spec.value.StandardErrorPath &&
    value.EnvironmentVariables && typeof value.EnvironmentVariables==='object' && !Array.isArray(value.EnvironmentVariables) &&
    Object.entries(value.EnvironmentVariables).every(([key,item])=>ENV_KEYS.includes(key)&&typeof item==='string') &&
    Object.keys(value).every(key=>Object.hasOwn(spec.value,key));
}

function loadedArguments(output) {
  const block=output.match(/^\s*arguments = \{\r?\n([\s\S]*?)^\s*\}/m);
  return block?block[1].split(/\r?\n/).map(value=>value.trim()).filter(Boolean):null;
}

export async function invokeMacNotifyGuard(action,{toolDir=DEFAULT_DIR,powerShellPath,home=os.homedir(),uid=process.getuid?.(),environment=process.env,pollAttempts=50,pollMs=100}={}) {
  if(!actions.has(action))return {ok:false,action:'invalid',errorCategory:'invalid-action'};
  if(process.platform!=='darwin')return {ok:false,action,errorCategory:'macos-required'};
  try {
    toolDir=await fs.realpath(toolDir);
    const selectedEnvironment={};for(const key of ENV_KEYS)if(environment[key])selectedEnvironment[key]=environment[key];
    const chosenPath=powerShellPath||environment.CODEX_DISCORD_PWSH_PATH;
    const available=await findExecutable(chosenPath||'pwsh',{environment,candidates:['/opt/homebrew/bin/pwsh','/usr/local/bin/pwsh','/usr/local/microsoft/powershell/7/pwsh']});
    const runtime=available?await fs.realpath(available):chosenPath||'/usr/local/bin/pwsh';
    if(!path.isAbsolute(runtime))throw Error('invalid-powershell-path');
    const identity=makeMacNotifyGuardAgent({toolDir,powerShellPath:runtime,uid,environment:selectedEnvironment});
    const domain=`gui/${uid}`,target=`${domain}/${identity.label}`;
    const agentsDir=path.join(home,'Library','LaunchAgents'),plist=path.join(agentsDir,`${identity.label}.plist`);
    const launch=async args=>(await exec('/bin/launchctl',args,{timeout:8000,maxBuffer:65536})).stdout;
    const readAgent=async()=>{
      try {
        const stat=await fs.lstat(plist);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o022)!==0||stat.size>65536)throw Error('untrusted-notify-guard');
        const value=JSON.parse((await exec('/usr/bin/plutil',['-convert','json','-o','-',plist],{timeout:5000,maxBuffer:65536})).stdout);
        if(!validateOwnedMacNotifyGuardAgent(value,identity))throw Error('untrusted-notify-guard');
        return value;
      } catch(error){if(error.code==='ENOENT')return null;throw error;}
    };
    let existing=await readAgent();
    const effectiveEnvironment={...existing?.EnvironmentVariables,...selectedEnvironment,CODEX_DISCORD_PWSH_PATH:runtime};
    effectiveEnvironment.CODEX_HOME=resolveCodexHome({toolDir,environment:effectiveEnvironment,homeDirectory:home});
    const desired=makeMacNotifyGuardAgent({toolDir,powerShellPath:runtime,uid,environment:effectiveEnvironment});
    const status=async()=>{
      const agent=await readAgent();let loaded=null,disabled=false;
      try{loaded=await launch(['print',target]);}catch{}
      if(loaded!==null) {
        // A matching on-disk plist is insufficient if a different definition
        // has already been loaded under the same launchd label.
        const loadedPath=loaded.match(/^\s*path = (.+)$/m)?.[1]?.trim();
        if(!agent||loadedPath!==plist||JSON.stringify(loadedArguments(loaded))!==JSON.stringify(agent.ProgramArguments))throw Error('untrusted-loaded-notify-guard');
      }
      if(agent){const output=await launch(['print-disabled',domain]);const quoted=identity.label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const setting=output.match(new RegExp(`"${quoted}"\\s*=>\\s*(true|false|enabled|disabled)`))?.[1];disabled=['true','disabled'].includes(setting);}
      const pid=Number(loaded?.match(/^\s*pid = (\d+)$/m)?.[1])||null;
      return {installed:!!agent,enabled:!!agent&&!disabled,loaded:loaded!==null,running:pid!==null,pid,definitionCurrent:!!agent&&isDeepStrictEqual(agent,desired.value)};
    };
    const waitForUnload=async()=>{
      // bootout acknowledges the request before a SIGTERM-handling watcher
      // exits. Keep its original plist until launchd drops the job, checking
      // the loaded definition on every poll rather than accepting a mismatch.
      for(let attempt=0;attempt<pollAttempts;attempt++) {
        if(!(await status()).loaded)return;
        if(attempt+1<pollAttempts)await pause(pollMs);
      }
      throw Error('notify-guard-stop-incomplete');
    };
    let before=await status();
    if(action==='status')return {ok:true,action,label:identity.label,service:before};
    if(action==='enable') {
      if(!available)throw Error('powershell-not-found');
      const watcher=await fs.lstat(path.join(toolDir,'watch-notify.ps1'));
      if(!watcher.isFile()||watcher.isSymbolicLink()||watcher.uid!==uid||(watcher.mode&0o022)!==0)throw Error('untrusted-notify-watcher');
      if(before.loaded&&!before.definitionCurrent){await launch(['bootout',target]);await waitForUnload();before={...before,loaded:false,running:false};}
      if(!before.definitionCurrent) {
        await fs.mkdir(agentsDir,{recursive:true,mode:0o700});
        const stat=await fs.lstat(agentsDir);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o022)!==0)throw Error('untrusted-launch-agent-directory');
        const temporary=`${plist}.${randomUUID()}.tmp`;
        try{await fs.writeFile(temporary,desired.xml,{mode:0o600,flag:'wx'});await fs.rename(temporary,plist);}finally{await fs.rm(temporary,{force:true});}
      }
      await launch(['enable',target]);
      if(!before.loaded)await launch(['bootstrap',domain,plist]);
      else if(!before.running)await launch(['kickstart',target]);
    } else {
      if(existing) {
        await launch(['disable',target]);
        if(before.loaded){await launch(['bootout',target]);await waitForUnload();}
        // Revalidate immediately before removing the definition.
        await readAgent();await fs.unlink(plist);
      }
    }
    for(let attempt=0;attempt<pollAttempts;attempt++) {
      const service=await status();
      if(action==='enable'?service.running&&service.enabled&&service.definitionCurrent:!service.loaded&&!service.installed)return {ok:true,action,label:identity.label,service};
      if(attempt+1<pollAttempts)await pause(pollMs);
    }
    return {ok:false,action,errorCategory:'notify-guard-action-incomplete'};
  } catch(error) {
    const safeCategories=new Set(['powershell-not-found','invalid-powershell-path','untrusted-notify-guard','untrusted-loaded-notify-guard','untrusted-notify-watcher','untrusted-launch-agent-directory','notify-guard-stop-incomplete']);
    return {ok:false,action,errorCategory:safeCategories.has(error.message)?error.message:'notify-guard-action-failed'};
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2),action=args.length===2&&args[0]==='--action'?args[1]:'invalid';
  const result=await invokeMacNotifyGuard(action);
  process.stdout.write(`${JSON.stringify(result)}\n`);process.exitCode=result.ok?0:1;
}
