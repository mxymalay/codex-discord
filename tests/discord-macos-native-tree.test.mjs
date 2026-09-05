import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const nativeSource = fileURLToPath(new URL('../control-app/CodexDiscordControl.m', import.meta.url));

test('native cleanup retains verified orphaned descendants and waits for asynchronous process exit', { skip: process.platform !== 'darwin', timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-tree-'));
  const harness = path.join(root, 'tree.m');
  const executable = path.join(root, 'tree');
  try {
    await fs.writeFile(harness, `#define main CodexControlAppMain
#include ${JSON.stringify(nativeSource)}
#undef main
static NSDictionary *Fixture(int pid,int ppid,NSString *token) {
  return @{ @"pid":@(pid),@"uid":@501,@"ppid":@(ppid),@"startToken":token,@"executable":@"/fixture/program" };
}
int main(int argc,const char *argv[]) {
  @autoreleasepool {
    if(argc==2) {
      NSDictionary *root=Fixture(100,1,@"root"),*child=Fixture(200,100,@"child");
      NSArray *orphan=VerifiedCleanupTree(@[root,child],@[],@[Fixture(200,1,@"child"),Fixture(400,200,@"grandchild")]);
      NSArray *fresh=VerifiedCleanupTree(@[root,child],@[root],@[root,Fixture(200,1,@"child"),Fixture(300,100,@"new")]);
      NSArray *reused=VerifiedCleanupTree(@[root,child],@[],@[Fixture(200,1,@"reused")]);
      PrintJSON(@{ @"orphanPids":[orphan valueForKey:@"pid"]?:@[], @"freshPids":[fresh valueForKey:@"pid"]?:@[], @"reusedRejected":reused==nil?@YES:@NO });
      return 0;
    }
    if(argc==3) {
      NSDictionary *child=ProcessInfo((pid_t)atoi(argv[2]));if(!child)return 2;
      PrintJSON(@{ @"remaining":@(WaitForProcessTreeExit(@[child],1.0)) });return 0;
    }
    return 2;
  }
}
`);
    await exec('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Werror', '-Wno-incompatible-pointer-types', '-framework', 'Cocoa', '-framework', 'Security', harness, '-o', executable]);
    const fixture = JSON.parse((await exec(executable, ['--fixture'])).stdout);
    assert.deepEqual(fixture.orphanPids, [200, 400]);
    assert.deepEqual(fixture.freshPids, [100, 200, 300]);
    assert.equal(fixture.reusedRejected, true);

    // This owned fixture exits naturally; the harness never signals an application.
    const child = spawn('/bin/sleep', ['0.25'], { stdio: 'ignore' });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    try {
      const outcome = JSON.parse((await exec(executable, ['--wait-child', String(child.pid)])).stdout);
      assert.equal(outcome.remaining, 0);
    } finally { await exited; }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
