import os from 'node:os';
import path from 'node:path';

// Persisted Windows paths must retain their meaning when inspected on macOS.
// POSIX paths are case sensitive, and a backslash can be part of a filename.
export function pathApi(value) {
  const text = String(value ?? '');
  return /^[A-Za-z]:/u.test(text) || text.startsWith('\\') || /^\/\/[^/]+\/[^/]+/u.test(text)
    ? path.win32
    : text.startsWith('/') ? path.posix : path;
}

export function isAbsolutePath(value) {
  const text = String(value ?? '');
  if (!text || text.includes('\0')) return false;
  const api = pathApi(text);
  // Windows rooted paths such as \tasks and C:tasks still depend on a drive/cwd.
  if (api === path.win32) return /^[A-Za-z]:[\\/]/u.test(text) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/u.test(text);
  return api.isAbsolute(text);
}

export function normalizePath(value) {
  const text = String(value ?? '');
  return pathApi(text).normalize(text);
}

export function pathKey(value) {
  if (!isAbsolutePath(value)) return null;
  const api = pathApi(value);
  const normalized = api.resolve(String(value));
  return api === path.win32 ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function pathsEqual(left, right) {
  const key = pathKey(left);
  return key !== null && pathApi(left) === pathApi(right) && key === pathKey(right);
}

export function isPathDescendant(root, candidate) {
  if (!isAbsolutePath(root) || !isAbsolutePath(candidate) || pathApi(root) !== pathApi(candidate)) return false;
  const api = pathApi(root);
  const relative = api.relative(pathKey(root), pathKey(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

export function expandPathVariables(value, { environment = process.env, homeDirectory } = {}) {
  let text = String(value ?? '').trim();
  const variable = (name, caseInsensitive = false) => {
    const key = caseInsensitive
      ? Object.keys(environment).find((entry) => entry.toUpperCase() === name.toUpperCase())
      : name;
    const expanded = String(environment[key] ?? '').trim();
    if (!expanded) throw new Error('Path could not be expanded');
    return expanded;
  };
  // Older Windows configuration templates remain usable with a native POSIX home.
  const legacyRoot = text.match(/^%([A-Za-z_][A-Za-z0-9_]*)%([\\/].*)?$/u);
  if (legacyRoot && variable(legacyRoot[1], true).startsWith('/')) {
    text = `%${legacyRoot[1]}%` + (legacyRoot[2] ?? '').replaceAll('\\', '/');
  }
  text = text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
    (_match, percent, braced, bare) => variable(percent ?? braced ?? bare, percent !== undefined));
  if (/^~(?:[\\/]|$)/u.test(text)) {
    const home = homeDirectory ?? (process.platform === 'win32'
      ? environment.USERPROFILE ?? environment.HOME
      : environment.HOME ?? environment.USERPROFILE) ?? os.homedir();
    if (!isAbsolutePath(home)) throw new Error('Path could not be expanded');
    text = pathApi(home).join(home, text.slice(2));
  }
  if (/%[^%]+%|\$\{/u.test(text)) throw new Error('Path could not be expanded');
  return text;
}
