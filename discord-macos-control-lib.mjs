import { spawn, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {setNotificationsEnabled,restoreNotificationsEnabled} from './discord-notification-control.mjs';

const exec = promisify(execFile);
export const MAC_APP_NAME = 'Codex Discord 控制台.app';
export const MAC_CONTROL_ACTIONS = new Set(['status','stop-codex','start-temporary','stop-temporary','enable-long-term','disable-long-term']);
const DEFAULT_DIR = path.dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const failed = (action,errorCategory) => ({ok:false,action,errorCategory});
const xmlEscape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export const macNativePath = toolDir => path.join(toolDir,MAC_APP_NAME,'Contents','MacOS','CodexDiscordControl');
export const macAgentLabel = (toolDir, uid = process.getuid()) => `com.openai.codex-discord.${uid}.${createHash('sha256').update(path.resolve(toolDir)).digest('hex').slice(0,16)}`;

export function makeLaunchAgent({toolDir,nodePath=process.execPath,uid=process.getuid(),environment={}}) {
  toolDir = path.resolve(toolDir);
  const label = macAgentLabel(toolDir,uid);
  const env = { PATH: environment.PATH || process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const key of ['CODEX_HOME','CODEX_DISCORD_PWSH_PATH','CODEX_DISCORD_CODEX_PATH','CODEX_DISCORD_KEYCHAIN']) if(environment[key]) env[key]=environment[key];
  const value = { Label:label,ProgramArguments:[nodePath,path.join(toolDir,'discord-macos-control.mjs'),'--supervisor','scheduled'],WorkingDirectory:toolDir,RunAtLoad:true,KeepAlive:true,ThrottleInterval:5,ProcessType:'Background',EnvironmentVariables:env,StandardOutPath:path.join(toolDir,'discord-bridge-guard.log'),StandardErrorPath:path.join(toolDir,'discord-bridge-guard.log') };
  const encode = item => typeof item === 'boolean' ? `<${item}/>` : typeof item === 'number' ? `<integer>${item}</integer>` : Array.isArray(item) ? `<array>${item.map(encode).join('')}</array>` : item && typeof item === 'object' ? `<dict>${Object.entries(item).map(([k,v])=>`<key>${xmlEscape(k)}</key>${encode(v)}`).join('')}</dict>` : `<string>${xmlEscape(item)}</string>`;
  return {label,value,xml:`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${encode(value)}</plist>\n`};
}
export function validateLaunchAgent(value,spec) {
  return value?.Label === spec.label && value.WorkingDirectory === spec.value.WorkingDirectory &&
    JSON.stringify(value.ProgramArguments) === JSON.stringify(spec.value.ProgramArguments) && value.RunAtLoad === true && value.KeepAlive === true &&
    value.StandardOutPath === spec.value.StandardOutPath && value.StandardErrorPath === spec.value.StandardErrorPath &&
    !Object.keys(value).some(k => !Object.hasOwn(spec.value,k));
}
export function validateOwnedLaunchAgent(value,spec) {
  if(!Array.isArray(value?.ProgramArguments)||!path.isAbsolute(value.ProgramArguments[0]||''))return false;
  const adjusted={...value,ProgramArguments:[spec.value.ProgramArguments[0],...value.ProgramArguments.slice(1)]};
  return validateLaunchAgent(adjusted,spec) && value.EnvironmentVariables &&
    Object.keys(value.EnvironmentVariables).every(k=>['PATH','CODEX_HOME','CODEX_DISCORD_PWSH_PATH','CODEX_DISCORD_CODEX_PATH','CODEX_DISCORD_KEYCHAIN'].includes(k)&&typeof value.EnvironmentVariables[k]==='string');
}
export function validateLoadedLaunchAgent(text,{agent,plist,uid}) {
  if(!agent||!text.startsWith(`gui/${uid}/${agent.Label} = {\n`))return false;
  const lines=text.split('\n');
  const field=name=>{const matches=lines.filter(line=>line.startsWith(`\t${name} = `));return matches.length===1?matches[0].slice(name.length+4):null;};
  const block=text.match(/\n\targuments = \{\n([\s\S]*?)\n\t\}/);
  const args=block?block[1].split('\n').map(line=>line.startsWith('\t\t')?line.slice(2):null):null;
  return field('path')===plist && field('program')===agent.ProgramArguments[0] && field('working directory')===agent.WorkingDirectory && JSON.stringify(args)===JSON.stringify(agent.ProgramArguments);
}
export function validateRuntimeIdentity(runtime,info,{toolDir,uid=process.getuid()}) {
  return runtime?.version===1 && ['scheduled','temporary'].includes(runtime.mode) && runtime.toolDir===path.resolve(toolDir) &&
    Number.isSafeInteger(runtime.processId) && runtime.processId>1 && info?.pid===runtime.processId && info.uid===uid && info.pgid===info.pid &&
    typeof runtime.startToken==='string' && info.startToken===runtime.startToken && runtime.nodePath===info.executable &&
    JSON.stringify(info.argv?.slice(1))===JSON.stringify([path.join(runtime.toolDir,'discord-macos-control.mjs'),'--supervisor',runtime.mode]);
}
export async function terminateVerifiedMacProcessGroup(processGroupId,{signal=(pid,value)=>process.kill(pid,value),pollAttempts=20,pollMs=100,wait=delay}={}) {
  if(!Number.isSafeInteger(processGroupId)||processGroupId<=1)throw Error('invalid-process-group');
  try{signal(-processGroupId,'SIGTERM');}
  catch(error){
    if(error.code==='ESRCH')return;
    if(error.code!=='EPERM')throw error;
    // Darwin can return EPERM for a group containing only unreaped exits.
    // Only an explicit ESRCH proves the group disappeared after bootout;
    // native identity lookup failures are not evidence of process exit.
    for(let attempt=0;attempt<pollAttempts;attempt++) {
      try{signal(-processGroupId,0);}
      catch(probeError){
        if(probeError.code==='ESRCH')return;
        if(probeError.code!=='EPERM')throw error;
      }
      if(attempt+1<pollAttempts)await wait(pollMs);
    }
    throw error;
  }
}
async function readJsonBounded(file,max=65536) {
  const stat=await fs.lstat(file); if(!stat.isFile() || stat.isSymbolicLink() || stat.size>max) throw Error('invalid-state');
  return JSON.parse(await fs.readFile(file,'utf8'));
}
export async function writeMacJsonAtomic(file,value) {
  const temp=`${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp,`${JSON.stringify(value)}\n`,{mode:0o600,flag:'wx'}); await fs.rename(temp,file); }
  finally {await fs.rm(temp,{force:true});}
}
export async function readMacHealth(toolDir,running,now=Date.now()) {
  const discord={state:'unknown',restState:'unknown',lastActivityAt:null,healthState:'unknown',queueState:'unknown'};
  let queueCount=0;
  const states=new Set(['idle','connecting','ready','reconnecting','stopped','ok','offline','failed','unknown']);
  try {
    const h=await readJsonBounded(path.join(toolDir,'discord-bridge-health.json'));
    const age=now-Date.parse(h.observedAt);
    if(running && h.version===1 && age>=-5000 && age<=30000 && states.has(h.gateway?.state) && states.has(h.discordRest?.state) && Number.isSafeInteger(h.queueCount) && h.queueCount>=0 && h.queueCount<=1e6) {
      Object.assign(discord,{state:h.gateway.state,restState:h.discordRest.state,lastActivityAt:Number.isFinite(Date.parse(h.lastActivityAt))?h.lastActivityAt:null,healthState:'ready'});queueCount=h.queueCount;
    }
  } catch {}
  try {
    const s=await readJsonBounded(path.join(toolDir,'discord-inbox-state.json'),1024*1024);
    if(s.version===2 && s.pendingContinuations && typeof s.pendingContinuations==='object' && !Array.isArray(s.pendingContinuations)) {
      const entries=Object.values(s.pendingContinuations);if(entries.some(x=>!x||typeof x.status!=='string'))throw Error('invalid-queue');
      queueCount=entries.filter(x=>x.status==='queued').length;discord.queueState='ready';
    }
  } catch {}
  return {discord,queueCount};
}

export async function invokeMacControlAction(action,{toolDir=DEFAULT_DIR,operations,pollAttempts=20,pollMs=100}={}) {
  if(!MAC_CONTROL_ACTIONS.has(action))return failed('invalid','invalid-action');
  const starting=['start-temporary','enable-long-term'].includes(action);
  const stopping=['stop-temporary','disable-long-term'].includes(action);
  let ops,notificationSnapshot,notificationChange=false;
  const settleNotificationsAfterFailure=async result=>{
    if(starting&&notificationChange) {
      try{await ops.restoreNotificationsEnabled(notificationSnapshot);}
      catch{return failed(action,'notification-restore-failed');}
    }
    if(stopping&&ops) {
      try{await ops.setNotificationsEnabled(false);}
      catch{return failed(action,'notification-disable-failed');}
    }
    return result;
  };
  try {
    ops=operations || await createMacControlOperations({toolDir});
    if(action==='stop-codex') return await ops.stopDesktop();
    const before=await ops.serviceStatus();
    if(action==='status') {
      let desktop;try{desktop=await ops.desktopStatus();}catch{desktop={running:false,processCount:0,state:'unknown'};}
      const health=await readMacHealth(toolDir,before.running);
      return {ok:true,service:{...before,mode:before.runtime?.mode||'unknown'},desktop,codexDesktop:desktop,...health};
    }
    if(starting) {
      notificationSnapshot=await ops.setNotificationsEnabled(true);
      notificationChange=true;
    }
    // A damaged or unwritable config must not prevent stopping the owned
    // service. The final mute below still has to succeed for full success.
    if(stopping)try{await ops.setNotificationsEnabled(false);}catch{}
    if(action==='start-temporary' && !before.running) await ops.start(before.autoStartEnabled?'scheduled':'temporary');
    if(action==='stop-temporary') await ops.stop(before);
    if(action==='enable-long-term') {
      if(!before.taskDefinitionCurrent && (before.running || before.taskRunning))await ops.stop(before);
      if(!before.taskInstalled || !before.taskDefinitionCurrent) await ops.install();
      await ops.setEnabled(true);
      if(before.running && before.runtime?.mode!=='scheduled') await ops.stop(before);
      if(!before.running || before.runtime?.mode!=='scheduled' || !before.taskDefinitionCurrent)await ops.start('scheduled');
    }
    if(action==='disable-long-term') {if(before.taskInstalled)await ops.setEnabled(false);await ops.stop(before);}
    for(let n=0;n<pollAttempts;n++) {
      const s=await ops.serviceStatus();
      const complete = action==='start-temporary' ? s.running&&s.autoStartEnabled===before.autoStartEnabled : action==='stop-temporary' ? !s.running&&!s.taskRunning&&s.autoStartEnabled===before.autoStartEnabled : action==='enable-long-term' ? s.running&&s.autoStartEnabled&&s.runtime?.mode==='scheduled'&&s.taskDefinitionCurrent : !s.running&&!s.taskRunning&&!s.autoStartEnabled;
      if(complete){
        // A supervisor already starting when stop began may have enabled the
        // gate after our first write. Close it again only once stopped.
        if(stopping) {
          try{await ops.setNotificationsEnabled(false);}
          catch{return failed(action,'notification-disable-failed');}
        }
        return {ok:true,action,service:{...s,mode:s.runtime?.mode||'unknown'}};
      }
      if(n+1<pollAttempts)await delay(pollMs);
    }
    return await settleNotificationsAfterFailure(failed(action,'service-action-incomplete'));
  } catch {return await settleNotificationsAfterFailure(failed(action,action==='stop-codex'?'process-control-failed':'control-action-failed'));}
}

export async function createMacControlOperations({toolDir=DEFAULT_DIR,nodePath=process.execPath,home=os.homedir(),uid=process.getuid(),environment=process.env}={}) {
  if(process.platform!=='darwin')throw Error('macos-required');
  toolDir=await fs.realpath(toolDir);nodePath=await fs.realpath(nodePath);
  const spec=makeLaunchAgent({toolDir,nodePath,uid,environment});
  const domain=`gui/${uid}`, target=`${domain}/${spec.label}`;
  const agentsDir=path.join(home,'Library','LaunchAgents'),plist=path.join(agentsDir,`${spec.label}.plist`),runtimePath=path.join(toolDir,'discord-bridge-runtime.json');
  const launch=async args => (await exec('/bin/launchctl',args,{timeout:8000,maxBuffer:65536})).stdout;
  const native=async args => JSON.parse((await exec(macNativePath(toolDir),args,{timeout:12000,maxBuffer:65536})).stdout);
  const getInfo=async pid => {try{return await native(['--process-info',String(pid)]);}catch{return null;}};
  const readRuntime=async () => {
    try {const s=await fs.lstat(runtimePath);if(s.uid!==uid || (s.mode&0o022)!==0)return null;const r=await readJsonBounded(runtimePath);return validateRuntimeIdentity(r,await getInfo(r.processId),{toolDir,uid})?r:null;}catch{return null;}
  };
  const readAgent=async () => {
    try {
      const stat=await fs.lstat(plist);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o022)!==0)throw Error('untrusted-launch-agent');
      const value=JSON.parse((await exec('/usr/bin/plutil',['-convert','json','-o','-',plist],{timeout:5000,maxBuffer:65536})).stdout);
      if(!validateOwnedLaunchAgent(value,spec))throw Error('untrusted-launch-agent');return value;
    } catch(error){if(error.code==='ENOENT')return null;throw error;}
  };
  const readLoaded=async agent=>{
    let output;try{output=await launch(['print',target]);}catch{return false;}
    if(!validateLoadedLaunchAgent(output,{agent,plist,uid}))throw Error('untrusted-loaded-launch-agent');return true;
  };
  const serviceStatus=async () => {
    const agent=await readAgent();let disabled=false,loaded=false;
    if(agent) {const list=await launch(['print-disabled',domain]);const match=list.match(new RegExp(`"${spec.label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"\\s*=>\\s*(true|false|enabled|disabled)`));disabled=['true','disabled'].includes(match?.[1]);}
    loaded=await readLoaded(agent);
    const runtime=await readRuntime();
    return {taskInstalled:!!agent,taskDefinitionCurrent:!!agent&&validateLaunchAgent(agent,spec),autoStartEnabled:!!agent&&!disabled,taskRunning:loaded,running:!!runtime,runtime};
  };
  const stop=async () => {
    const runtime=await readRuntime();
    let members=[];
    if(runtime)members=await native(['--process-group',String(runtime.processId)]);
    const agent=await readAgent();
    if(await readLoaded(agent)){await launch(['bootout',target]);}
    const same=(a,b)=>a&&b&&a.pid===b.pid&&a.uid===b.uid&&a.startToken===b.startToken&&a.executable===b.executable;
    if(runtime && validateRuntimeIdentity(runtime,await getInfo(runtime.processId),{toolDir,uid})) {
      await terminateVerifiedMacProcessGroup(runtime.processId);
    }
    // Retain identities after the group leader exits, so TERM-resistant descendants cannot escape cleanup.
    for(let n=0;n<20;n++){
      const alive=[];for(const member of members)if(same(member,await getInfo(member.pid)))alive.push(member);
      if(alive.length===0)return;members=alive;await delay(100);
    }
    for(const member of members)if(same(member,await getInfo(member.pid))) {try{process.kill(member.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
    for(let n=0;n<20;n++){
      const alive=[];for(const member of members)if(same(member,await getInfo(member.pid)))alive.push(member);
      if(alive.length===0)return;members=alive;await delay(100);
    }
    if(members.length)throw Error('service-descendants-remain');
  };
  return {
    serviceStatus,readRuntime,getInfo,
    setNotificationsEnabled:enabled=>setNotificationsEnabled(toolDir,enabled),
    restoreNotificationsEnabled:snapshot=>restoreNotificationsEnabled(toolDir,snapshot),
    install:async () => {
      const previous=await readAgent();const updated=makeLaunchAgent({toolDir,nodePath,uid,environment:{...environment,...previous?.EnvironmentVariables}});await fs.mkdir(agentsDir,{recursive:true,mode:0o700});
      const stat=await fs.lstat(agentsDir);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid)throw Error('untrusted-launch-agent-directory');
      const temp=`${plist}.${randomUUID()}.tmp`;try{await fs.writeFile(temp,updated.xml,{mode:0o600,flag:'wx'});await fs.rename(temp,plist);}finally{await fs.rm(temp,{force:true});}
    },
    setEnabled:async value => {if(!await readAgent())throw Error('launch-agent-missing');await launch([value?'enable':'disable',target]);},
    stop,
    start:async mode => {
      if(mode==='scheduled') {
        const agent=await readAgent();if(!agent)throw Error('launch-agent-missing');if(!validateLaunchAgent(agent,spec))throw Error('launch-agent-update-required');
        if(await readLoaded(agent))await launch(['kickstart',target]);else await launch(['bootstrap',domain,plist]);
      } else {
        const previous=await readAgent();const effectiveEnvironment={...environment,...previous?.EnvironmentVariables};
        const log=await fs.open(path.join(toolDir,'discord-bridge-guard.log'),'a',0o600);
        try{const child=spawn(nodePath,[path.join(toolDir,'discord-macos-control.mjs'),'--supervisor','temporary'],{cwd:toolDir,env:effectiveEnvironment,detached:true,stdio:['ignore',log.fd,log.fd]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();}finally{await log.close();}
      }
    },
    desktopStatus:async () => {const v=await native(['--desktop-status']);if(v.ok!==true)throw Error('desktop-unverifiable');return v.desktop;},
    stopDesktop:async () => {const v=await native(['--stop-desktop']);return v;},
  };
}

export async function runMacSupervisor(mode,{toolDir=DEFAULT_DIR,bridgePath,nodePath=process.execPath,environment=process.env}={}) {
  if(!['scheduled','temporary'].includes(mode))throw Error('invalid-supervisor-mode');
  toolDir=await fs.realpath(toolDir);nodePath=await fs.realpath(nodePath);bridgePath ||= path.join(toolDir,'discord-bridge.mjs');
  const ops=await createMacControlOperations({toolDir,nodePath,environment});
  const runtimePath=path.join(toolDir,'discord-bridge-runtime.json');
  const lockHolder=spawn(macNativePath(toolDir),['--hold-lock'],{cwd:toolDir,stdio:['pipe','pipe','ignore']});
  const locked=await new Promise(resolve=>{
    let settled=false;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>finish(false),5000);
    lockHolder.stdout.once('data',chunk=>finish(chunk.toString()==='locked\n'));
    lockHolder.once('error',()=>finish(false));lockHolder.once('exit',()=>finish(false));
  });
  if(!locked){lockHolder.stdin.destroy();return;}
  let child=null,stopping=false,wake=null,ownsGroup=false,forceTimer=null;
  let notificationSnapshot,notificationChange=false,launched=false;
  const shutdown=()=>{
    stopping=true;wake?.();try{child?.kill('SIGTERM');}catch{}
    if(ownsGroup && !forceTimer)forceTimer=setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL');}catch{}},2500).unref();
  };
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);lockHolder.once('exit',shutdown);
  try {
    const identity=await ops.getInfo(process.pid);
    if(!identity||identity.pgid!==process.pid)throw Error('supervisor-process-group-unavailable');
    ownsGroup=true;
    // A new login or supervisor launch resumes notifications once. Child
    // retries inside this supervisor must preserve a later console stop.
    notificationSnapshot=await ops.setNotificationsEnabled(true);notificationChange=true;
    const runtime={version:1,processId:process.pid,startToken:identity.startToken,nodePath,toolDir,mode};
    await writeMacJsonAtomic(runtimePath,runtime);
    while(!stopping) {
      const exitCode=await new Promise(resolve=>{
        child=spawn(nodePath,[bridgePath],{cwd:toolDir,env:environment,stdio:'ignore'});
        child.once('spawn',()=>{launched=true;});
        child.once('error',()=>resolve(-1));child.once('close',code=>resolve(code));
      });
      child=null;
      await fs.appendFile(path.join(toolDir,'discord-bridge-guard.log'),`${new Date().toISOString()} event=bridge-exited exitCode=${Number.isInteger(exitCode)?exitCode:-1}\n`,{mode:0o600});
      if(!stopping)await new Promise(resolve=>{const timer=setTimeout(resolve,5000);wake=()=>{clearTimeout(timer);resolve();};});
    }
  } finally {
    if(forceTimer)clearTimeout(forceTimer);
    process.off('SIGTERM',shutdown);process.off('SIGINT',shutdown);
    try {
      try{const r=await readJsonBounded(runtimePath);if(r.processId===process.pid)await fs.unlink(runtimePath);}catch{}
      if(notificationChange&&!launched)await ops.restoreNotificationsEnabled(notificationSnapshot);
    }finally{lockHolder.off('exit',shutdown);lockHolder.stdin.end();}
  }
}
