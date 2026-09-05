import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { expandPathVariables, isAbsolutePath, isPathDescendant, normalizePath, pathApi, pathKey, pathsEqual } from '../discord-paths-lib.mjs';

test('path identity preserves POSIX case and backslashes while normalizing Windows drive and UNC paths', () => {
  assert.equal(pathApi('/Users/operator/repo\\archive'), path.posix);
  assert.equal(pathKey('/Users/operator/Repo/../repo'), '/Users/operator/repo');
  assert.equal(pathsEqual('/Users/operator/Repo', '/Users/operator/repo'), false);
  assert.equal(pathsEqual('/Users/operator/repo\\archive', '/Users/operator/repo/archive'), false);
  assert.equal(pathsEqual('C:\\Repo\\', 'c:/repo'), true);
  assert.equal(pathsEqual('\\\\Server\\Share\\Repo', '//server/share/repo/'), true);
  assert.equal(normalizePath('C:/Repo/../Tasks'), 'C:\\Tasks');
  assert.equal(normalizePath('/Users/operator/Repo/../Tasks'), '/Users/operator/Tasks');
});

test('path boundaries reject drive-relative paths, siblings, case changes, and traversal', () => {
  for (const candidate of ['', null, 'relative/tasks', 'C:tasks', '\\tasks', '/tmp/\0unsafe']) {
    assert.equal(isAbsolutePath(candidate), false, String(candidate));
    assert.equal(pathsEqual(candidate, candidate), false, String(candidate));
  }
  assert.equal(isPathDescendant('/', '/Users/operator'), true);
  assert.equal(isPathDescendant('/Tasks', '/Tasks/..cache'), true);
  for (const candidate of ['/Tasks', '/Tasks-other/task', '/Tasks/../outside', '/tasks/child', 'C:\\Tasks\\child']) {
    assert.equal(isPathDescendant('/Tasks', candidate), false, candidate);
  }
  assert.equal(isPathDescendant('C:\\Tasks', 'c:/tasks/child'), true);
  assert.equal(isPathDescendant('C:\\Tasks', 'D:\\Tasks\\child'), false);
  assert.equal(isPathDescendant('\\\\Server\\Share\\Tasks', '//server/share/tasks/child'), true);
  assert.equal(isPathDescendant('\\\\Server\\Share\\Tasks', '//server/other/tasks/child'), false);
});

test('path expansion keeps percent variables case insensitive and POSIX dollar variables exact', () => {
  const environment = { USERPROFILE: 'C:\\Users\\Operator', CODEX_HOME: '/Users/operator/.codex', HOME: '/Users/operator' };
  assert.equal(expandPathVariables('%userprofile%\\Tasks', { environment }), 'C:\\Users\\Operator\\Tasks');
  assert.equal(expandPathVariables('%codex_home%\\worktrees\\discord', { environment }), '/Users/operator/.codex/worktrees/discord');
  assert.equal(expandPathVariables('${CODEX_HOME}/worktrees/discord', { environment }), '/Users/operator/.codex/worktrees/discord');
  assert.equal(expandPathVariables('$HOME/Tasks', { environment }), '/Users/operator/Tasks');
  assert.equal(expandPathVariables('~/Tasks', { environment, homeDirectory: '/Users/operator' }), '/Users/operator/Tasks');
  assert.equal(expandPathVariables('$CODEX_HOME/Tasks', { environment: { CODEX_HOME: '/Users/operator/$literal' } }), '/Users/operator/$literal/Tasks');
  for (const configured of ['$home/Tasks', '${MISSING}/Tasks', '%MISSING%\\Tasks']) {
    assert.throws(() => expandPathVariables(configured, { environment }), /could not be expanded/);
  }
});
