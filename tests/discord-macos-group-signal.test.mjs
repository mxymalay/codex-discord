import assert from 'node:assert/strict';
import test from 'node:test';
import * as control from '../discord-macos-control-lib.mjs';

const failure = code => Object.assign(new Error(`fixture ${code}`), { code });
function fixture(outcomes) {
  const calls = [], waits = [];
  return {
    calls, waits,
    options: {
      pollAttempts: 3, pollMs: 7,
      signal(pid, signal) {
        calls.push([pid, signal]);
        assert.ok(outcomes.length, 'unexpected signal beyond the bounded plan');
        const result = outcomes.shift();
        if (result instanceof Error) throw result;
        return result;
      },
      wait: async milliseconds => { waits.push(milliseconds); },
    },
  };
}

test('successful verified group TERM needs no existence probes', async () => {
  const f = fixture([true]);
  await control.terminateVerifiedMacProcessGroup(73, f.options);
  assert.deepEqual(f.calls, [[-73, 'SIGTERM']]);
  assert.deepEqual(f.waits, []);
});

test('an already absent group retains the original TERM ESRCH success', async () => {
  const f = fixture([failure('ESRCH')]);
  await control.terminateVerifiedMacProcessGroup(73, f.options);
  assert.deepEqual(f.calls, [[-73, 'SIGTERM']]);
});

test('TERM EPERM is accepted only after a group probe explicitly reports ESRCH', async () => {
  const f = fixture([failure('EPERM'), failure('ESRCH')]);
  await control.terminateVerifiedMacProcessGroup(73, f.options);
  assert.deepEqual(f.calls, [[-73, 'SIGTERM'], [-73, 0]]);
  assert.deepEqual(f.waits, []);
});

test('a zombie group may return EPERM until reaped without another terminating signal', async () => {
  const f = fixture([failure('EPERM'), failure('EPERM'), failure('EPERM'), failure('ESRCH')]);
  await control.terminateVerifiedMacProcessGroup(73, f.options);
  assert.deepEqual(f.calls, [[-73, 'SIGTERM'], [-73, 0], [-73, 0], [-73, 0]]);
  assert.deepEqual(f.waits, [7, 7]);
});

for (const probe of ['EPERM', 'alive']) {
  test(`a group that remains ${probe} preserves the original TERM failure within a finite budget`, async () => {
    const original = failure('EPERM');
    const f = fixture([original, ...Array.from({ length: 3 }, () => probe === 'EPERM' ? failure('EPERM') : true)]);
    await assert.rejects(control.terminateVerifiedMacProcessGroup(73, f.options), error => error === original);
    assert.deepEqual(f.calls, [[-73, 'SIGTERM'], [-73, 0], [-73, 0], [-73, 0]]);
    assert.deepEqual(f.waits, [7, 7]);
  });
}

test('unexpected existence-probe errors preserve the original TERM error', async () => {
  const original = failure('EPERM');
  const f = fixture([original, failure('EIO')]);
  await assert.rejects(control.terminateVerifiedMacProcessGroup(73, f.options), error => error === original);
  assert.deepEqual(f.calls, [[-73, 'SIGTERM'], [-73, 0]]);
  assert.deepEqual(f.waits, []);
});

test('unexpected TERM errors never enter the exit-race probe path', async () => {
  const original = failure('EACCES');
  const f = fixture([original]);
  await assert.rejects(control.terminateVerifiedMacProcessGroup(73, f.options), error => error === original);
  assert.deepEqual(f.calls, [[-73, 'SIGTERM']]);
  assert.deepEqual(f.waits, []);
});

test('invalid group IDs cannot turn into broad or current-group signals', async () => {
  for (const id of [-73, 0, 1, 1.5, NaN]) {
    const f = fixture([]);
    await assert.rejects(control.terminateVerifiedMacProcessGroup(id, f.options), /invalid-process-group/);
    assert.deepEqual(f.calls, []);
  }
});
