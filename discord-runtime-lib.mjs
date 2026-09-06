import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveCodexHome({ environment = process.env, toolDir, homeDirectory = os.homedir() } = {}) {
  const configured = String(environment.CODEX_HOME ?? '').trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error('CODEX_HOME must be absolute');
    return path.normalize(configured);
  }
  // Preserve existing portable deployments and isolated notification fixtures.
  if (toolDir && path.basename(toolDir) === 'mobile-notify') return path.dirname(toolDir);
  return path.join(homeDirectory, '.codex');
}

export async function findExecutable(command, { environment = process.env, candidates = [], platform = process.platform } = {}) {
  const configured = String(command ?? '').trim();
  const names = platform === 'win32' && !path.extname(configured) ? [configured, `${configured}.exe`, `${configured}.com`] : [configured];
  const paths = path.isAbsolute(configured) ? [configured] : [
    ...String(environment.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter((item) => path.isAbsolute(item))
      .flatMap((directory) => names.map((name) => path.join(directory, name))),
    ...candidates,
  ];
  for (const candidate of paths) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* Ignore stale installs and nonexecutable files. */ }
  }
  return null;
}

export function desktopEndpoint(name) {
  return path.posix.isAbsolute(name) ? name : `\\\\.\\pipe\\${name}`;
}

export function codexRouterEndpoint({ platform = process.platform, ...options } = {}) {
  return platform === 'win32' ? '\\\\.\\pipe\\codex-ipc' : path.join(resolveCodexHome(options), 'ipc', 'ipc.sock');
}

export async function listDesktopEndpoints({ platform = process.platform, socketDirectory = '/tmp/codex-browser-use', userId = process.getuid?.() } = {}) {
  if (platform === 'win32') return (await fs.readdir('\\\\.\\pipe\\')).filter((name) => name.startsWith('codex-browser-use-'));
  const endpoints = [];
  for (const name of await fs.readdir(socketDirectory)) {
    if (!name.endsWith('.sock')) continue;
    const socket = path.join(socketDirectory, name);
    try {
      const info = await fs.lstat(socket);
      // The shared socket directory is sticky; never connect to another user's endpoint or a symlink.
      if (info.isSocket() && info.uid === userId) endpoints.push({ socket, modified: info.mtimeMs });
    } catch { /* Desktop restarts can remove an endpoint during discovery. */ }
  }
  return endpoints.sort((a, b) => b.modified - a.modified).map((entry) => entry.socket);
}
