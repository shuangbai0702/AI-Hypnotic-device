import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const installed = new URL('../host.json', import.meta.url);
function installation() {
  return existsSync(installed) ? JSON.parse(readFileSync(installed, 'utf8')) : {};
}

// Match native DSH's blank-env and tilde semantics. The persistence backend's
// actual root wins over launch-time guesses; never search other user homes.
export function runtimePaths(ctx, { env = process.env, userHome = homedir(), host = installation() } = {}) {
  const expand = value => resolve(value === '~' ? userHome : /^~[\\/]/.test(value) ? join(userHome, value.slice(2)) : value);
  const nativeRoot = ctx?.sessionPersistence?.root;
  const hasNativeRoot = typeof nativeRoot === 'string' && nativeRoot.trim().length > 0;
  const sessions = hasNativeRoot ? expand(nativeRoot) : undefined;
  let home, source;
  if (sessions && basename(sessions) === 'sessions') { home = dirname(sessions); source = 'persistence'; }
  else if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim()) { home = expand(env.DSH_HOME); source = 'environment'; }
  else if (typeof host.home === 'string' && host.home.trim()) { home = expand(host.home); source = 'installation'; }
  else { home = join(userHome, '.dsh'); source = 'default'; }
  return { home, sessions: sessions ?? join(home, 'sessions'), source };
}
