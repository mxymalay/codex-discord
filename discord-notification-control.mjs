import {promises as fs,constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

async function readConfig(file) {
  let before;
  try {before=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!before.isFile()||before.isSymbolicLink()||before.size>1024*1024)throw Error('invalid-notification-config');
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try {
    const stat=await handle.stat();
    if(!stat.isFile()||stat.dev!==before.dev||stat.ino!==before.ino||stat.size>1024*1024)throw Error('notification-config-changed');
    const bytes=await handle.readFile();
    // Keep the original numeric tokens: settings outside enabled may contain
    // integers or exponents that JavaScript Number cannot represent exactly.
    let value;try{value=JSON.parse(bytes.toString('utf8'),(_key,item,context)=>typeof item==='number'?JSON.rawJSON(context.source):item);}catch{throw Error('invalid-notification-config');}
    if(!value||typeof value!=='object'||Array.isArray(value)||JSON.isRawJSON(value))throw Error('invalid-notification-config');
    return {stat,bytes,value};
  }finally{await handle.close();}
}

async function updateConfig(toolDir,change,{allowMissing=true}={}) {
  const file=path.join(toolDir,'config.json');
  for(let attempt=0;attempt<5;attempt++) {
    const original=await readConfig(file);
    if(!original){if(allowMissing)return {configExists:false};throw Error('notification-config-missing');}
    const value={...original.value};change(value);
    const snapshot={configExists:true,hadEnabled:Object.hasOwn(original.value,'enabled'),enabled:original.value.enabled};
    if(Object.hasOwn(value,'enabled')===snapshot.hadEnabled&&Object.is(value.enabled,snapshot.enabled))return snapshot;
    const temporary=`${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary,`${JSON.stringify(value,null,2)}\n`,{flag:'wx',mode:original.stat.mode&0o777});
      const current=await readConfig(file);
      if(!current)throw Error('notification-config-missing');
      // Retry from the latest object if another settings writer changed the
      // file while this update was prepared, retaining its unrelated keys.
      if(current.stat.dev!==original.stat.dev||current.stat.ino!==original.stat.ino||!current.bytes.equals(original.bytes))continue;
      await fs.rename(temporary,file);
      return snapshot;
    }finally{await fs.rm(temporary,{force:true});}
  }
  throw Error('notification-config-changed');
}

export async function setNotificationsEnabled(toolDir,enabled) {
  if(typeof enabled!=='boolean')throw Error('invalid-notification-setting');
  return updateConfig(toolDir,value=>{value.enabled=enabled;});
}

export async function restoreNotificationsEnabled(toolDir,snapshot) {
  if(!snapshot?.configExists)return;
  await updateConfig(toolDir,value=>{
    if(snapshot.hadEnabled)value.enabled=snapshot.enabled;
    else delete value.enabled;
  },{allowMissing:false});
}
