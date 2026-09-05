import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setNotificationsEnabled,restoreNotificationsEnabled} from '../discord-notification-control.mjs';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'discord-notification-control-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root,file:path.join(root,'config.json')};
}

test('notification gate changes only enabled and restores that property over newer unrelated settings',async t=>{
  const {root,file}=await fixture(t);
  const original={enabled:false,provider:'fixture',nested:{retained:42},array:['one','two']};
  await fs.writeFile(file,JSON.stringify(original),{mode:0o600});
  const snapshot=await setNotificationsEnabled(root,true);
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{...original,enabled:true});
  await fs.writeFile(file,JSON.stringify({...original,enabled:true,added:'new setting'}));
  await restoreNotificationsEnabled(root,snapshot);
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{...original,added:'new setting'});
  assert.deepEqual(await fs.readdir(root),['config.json']);
});

test('notification rollback preserves an absent enabled property or its original nonboolean value',async t=>{
  const {root,file}=await fixture(t);
  for(const original of [{other:7},{enabled:null,other:7},{enabled:'legacy',other:7}]) {
    await fs.writeFile(file,JSON.stringify(original));
    const snapshot=await setNotificationsEnabled(root,false);
    assert.equal(JSON.parse(await fs.readFile(file,'utf8')).enabled,false);
    await restoreNotificationsEnabled(root,snapshot);
    assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),original);
  }
});

test('notification updates preserve exact numeric tokens outside enabled, including values beyond Number range',async t=>{
  const {root,file}=await fixture(t);
  const original='{"enabled":false,"large":9007199254740993,"overflow":1e400,"negativeZero":-0,"nested":{"underflow":1e-400,"fraction":0.123456789012345678901234567890},"array":[123456789012345678901234567890,1E+003,1.00]}';
  const expected=['9007199254740993','1e400','-0','1e-400','0.123456789012345678901234567890','123456789012345678901234567890','1E+003','1.00'];
  const assertNumbers=async()=>{
    const text=await fs.readFile(file,'utf8');
    const tokens=[...text.matchAll(/[:\[,]\s*(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)].map(match=>match[1]);
    assert.deepEqual(tokens,expected,'unrelated numeric JSON tokens changed');
    return JSON.parse(text).enabled;
  };
  await fs.writeFile(file,original);
  const snapshot=await setNotificationsEnabled(root,true);
  assert.equal(await assertNumbers(),true);
  await restoreNotificationsEnabled(root,snapshot);
  assert.equal(await assertNumbers(),false);
});

test('notification rollback restores a numeric enabled token without precision loss',async t=>{
  const {root,file}=await fixture(t);
  for(const token of ['9007199254740993','1e400','-0']) {
    await fs.writeFile(file,`{"enabled":${token},"keep":7}`);
    const snapshot=await setNotificationsEnabled(root,false);
    assert.equal(JSON.parse(await fs.readFile(file,'utf8')).enabled,false);
    await restoreNotificationsEnabled(root,snapshot);
    assert.equal((await fs.readFile(file,'utf8')).match(/"enabled"\s*:\s*([^,\s}]+)/)[1],token);
  }
});

test('missing notification configuration is a no-op while malformed configuration is preserved and rejected',async t=>{
  const {root,file}=await fixture(t);
  const snapshot=await setNotificationsEnabled(root,false);
  await restoreNotificationsEnabled(root,snapshot);
  assert.deepEqual(await fs.readdir(root),[]);
  for(const text of ['null','[]','42','"text"','{invalid']) {
    await fs.writeFile(file,text);
    await assert.rejects(setNotificationsEnabled(root,true));
    assert.equal(await fs.readFile(file,'utf8'),text);
  }
});

test('notification changes reject symbolic links and never alter their target', {skip:process.platform==='win32'},async t=>{
  const {root,file}=await fixture(t);
  const target=path.join(root,'target.json'),original='{"enabled":true,"keep":7}';
  await fs.writeFile(target,original);
  await fs.symlink(target,file);
  await assert.rejects(setNotificationsEnabled(root,false));
  assert.equal(await fs.readFile(target,'utf8'),original);
  assert.equal((await fs.lstat(file)).isSymbolicLink(),true);
});
