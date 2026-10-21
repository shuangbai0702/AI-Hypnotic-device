import fs from 'node:fs';
import { join, resolve, dirname, basename, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { planAdapter, resolveHostFile } from '../host-adapter.mjs';

export const hostFiles = ['dsh-agent/lib/index.js', 'dsh-agent-loop/lib/index.js', 'dsh-api-session-controller/lib/client.js']
  .map(name => 'node_modules/@deepseek-ai/' + name);
const exists = path => typeof path === 'string' && fs.existsSync(path);
const read = path => fs.readFileSync(path, 'utf8');
const copy = (from, to) => { fs.mkdirSync(dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true }); };
function durableJson(path, value) {
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.new';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  const fd = fs.openSync(tmp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path);
}
function fingerprint(path) {
  if (!exists(path)) return null;
  const hash = createHash('sha256');
  const walk = (file, relative) => {
    const stat = fs.lstatSync(file);
    hash.update(relative + '\0');
    if (stat.isSymbolicLink()) hash.update('link:' + fs.readlinkSync(file));
    else if (stat.isDirectory()) { hash.update('dir'); for (const name of fs.readdirSync(file).sort()) walk(join(file, name), relative + '/' + name); }
    else { hash.update('file'); hash.update(fs.readFileSync(file)); }
  };
  walk(path, ''); return hash.digest('hex');
}
export function installPaths(app, home) {
  app = resolve(app); home = resolve(home);
  const state = join(home, '.session-editor-install');
  return { app, home, state, config: join(home, 'profiles/web/cordis.patch.yml'),
    target: join(home, 'profiles/web/node_modules/@shuangbai/dsh-session-editor'),
    manifest: join(state, 'install.json'), root: join(home, '.session-editor-transactions') };
}
export function prepareConfig(app, before) {
  // Use the selected DSH's exact YAML parser, including fresh stock `[]`.
  const yaml = createRequire(join(resolve(app), 'package.json'))('js-yaml');
  const patches = yaml.load(before) ?? [];
  if (!Array.isArray(patches)) throw new Error('DSH profile patch 必须是 YAML 数组；未修改配置');
  const registrations = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.name === '@shuangbai/dsh-session-editor') registrations.push(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  visit(patches);
  if (registrations.length > 1) throw new Error('存在重复插件注册；未修改配置');
  if (registrations.length) return before;
  const after = yaml.dump([...patches, { insert: [{ id: 'session-editor', name: '@shuangbai/dsh-session-editor', config: {} }] }], { noRefs: true, lineWidth: 120 });
  if (!Array.isArray(yaml.load(after))) throw new Error('生成的 YAML 未通过校验');
  return after;
}
export function preflight(app, home, uninstall = false) {
  const paths = installPaths(app, home);
  const ownerPath = join(paths.app, '.session-editor-adapter/owner.json');
  if (exists(ownerPath)) {
    const owner = JSON.parse(read(ownerPath));
    if (owner.active && resolve(owner.home) !== paths.home) throw new Error('该 DSH 已绑定其他数据目录；请先从原数据目录卸载，避免影响其他服务');
  }
  if (exists(join(paths.root, 'pending.json'))) throw new Error('存在未完成安装事务；停止目标 DSH 后先运行 --recover');
  planAdapter(paths.app, uninstall);
  const before = exists(paths.config) ? read(paths.config) : '';
  if (uninstall) {
    const manifest = JSON.parse(read(paths.manifest));
    if (resolve(manifest.app) !== paths.app) throw new Error('安装记录属于其他 DSH');
    if (manifest.hadPlugin && !exists(join(paths.state, 'previous-plugin'))) throw new Error('安装前插件备份缺失；拒绝卸载');
    if (before !== manifest.configAfter) throw new Error('安装后配置有其他修改；未执行卸载');
  } else {
    prepareConfig(paths.app, before);
    if (exists(paths.manifest) && resolve(JSON.parse(read(paths.manifest)).app) !== paths.app) throw new Error('此数据目录已绑定其他 DSH');
  }
  return paths;
}

function allowedDestinations(paths) {
  return [...hostFiles.map(file => resolveHostFile(paths.app, file)), join(paths.app, '.session-editor-adapter'),
    paths.config, paths.target, paths.manifest, join(paths.state, 'previous-plugin')];
}
function validateJournal(paths, journal) {
  const allowed = allowedDestinations(paths);
  if (journal.app !== paths.app || journal.home !== paths.home || !/^[a-f0-9-]{36}$/.test(journal.id)) throw new Error('事务身份不匹配');
  const root = join(paths.root, journal.id);
  for (const [index, entry] of journal.entries.entries()) {
    if (!allowed.includes(entry.destination) || entry.backup !== join(root, 'before', String(index)) ||
      entry.staged !== join(root, 'after', String(index))) throw new Error('事务路径不匹配；拒绝恢复');
  }
}
function pending(paths) {
  const pointer = JSON.parse(read(join(paths.root, 'pending.json')));
  if (!/^[a-f0-9-]{36}$/.test(pointer.id)) throw new Error('事务指针无效');
  const file = join(paths.root, pointer.id, 'journal.json');
  const journal = JSON.parse(read(file)); validateJournal(paths, journal);
  return { file, journal };
}
function acquireFile(lock) {
  fs.mkdirSync(dirname(lock), { recursive: true });
  if (exists(lock)) {
    const owner = JSON.parse(read(lock));
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('另一个安装器仍持有事务锁');
    fs.unlinkSync(lock);
  }
  const token = randomUUID(), fd = fs.openSync(lock, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return () => { if (exists(lock) && JSON.parse(read(lock)).token === token) fs.unlinkSync(lock); };
}
function acquire(paths) {
  // A host can be discovered with more than one home. Serialize modifications
  // to the shared host as well as the per-home transaction journal.
  const releaseHost = acquireFile(join(paths.app, '.session-editor-install.lock.json'));
  try {
    const releaseHome = acquireFile(join(paths.root, 'lock.json'));
    return () => { try { releaseHome(); } finally { releaseHost(); } };
  } catch (error) { releaseHost(); throw error; }
}
function siblings(entry, id) {
  return { temp: join(dirname(entry.destination), '.' + basename(entry.destination) + '.editor-new-' + id),
    old: join(dirname(entry.destination), '.' + basename(entry.destination) + '.editor-old-' + id) };
}
function replace(entry, source, id) {
  // All recursive mutations are confined to validated managed paths or sibling
  // names derived from the transaction UUID, never arbitrary journal input.
  const { temp, old } = siblings(entry, id);
  if (exists(temp) || exists(old)) throw new Error('事务临时文件已存在，拒绝覆盖');
  fs.mkdirSync(dirname(entry.destination), { recursive: true });
  if (source) copy(source, temp);
  if (exists(entry.destination)) fs.renameSync(entry.destination, old);
  if (source) fs.renameSync(temp, entry.destination);
}
function rollback(paths, file, journal) {
  validateJournal(paths, journal);
  journal.phase = 'rolling-back'; durableJson(file, journal);
  for (const entry of [...journal.entries].reverse()) {
    if (!entry.attempted) continue;
    const current = fingerprint(entry.destination), { old, temp } = siblings(entry, journal.id);
    if (![entry.before, entry.after, null].includes(current)) throw new Error('回滚目标已有其他修改；保留备份，拒绝覆盖');
    if (entry.before !== null && fingerprint(entry.backup) !== entry.before) throw new Error('回滚备份校验失败');
    if (current !== entry.before) {
      // Keep the failed state in the transaction's own directory when possible.
      if (exists(entry.destination)) fs.rmSync(entry.destination, { recursive: true, force: true });
      if (entry.before !== null) copy(entry.backup, entry.destination);
    }
    if (exists(old)) fs.rmSync(old, { recursive: true, force: true });
    if (exists(temp)) fs.rmSync(temp, { recursive: true, force: true });
    if (fingerprint(entry.destination) !== entry.before) throw new Error('回滚读回校验失败');
  }
  journal.phase = 'rolled-back'; durableJson(file, journal);
  fs.unlinkSync(join(paths.root, 'pending.json'));
}
export function recoverInstallation(app, home, complete = false) {
  const paths = installPaths(app, home), release = acquire(paths);
  try {
    if (!exists(join(paths.root, 'pending.json'))) return { recovered: false };
    const { file, journal } = pending(paths);
    if (!complete) { rollback(paths, file, journal); return { recovered: true }; }
    if (journal.phase !== 'awaiting-health') throw new Error('事务未等待健康确认，不能标记完成');
    for (const entry of journal.entries) if (fingerprint(entry.destination) !== entry.after) throw new Error('健康确认前文件发生变化；保留待恢复事务');
    journal.phase = 'completed'; durableJson(file, journal);
    fs.unlinkSync(join(paths.root, 'pending.json'));
    for (const entry of journal.entries) {
      const { old, temp } = siblings(entry, journal.id);
      for (const path of [old, temp]) if (exists(path)) fs.rmSync(path, { recursive: true, force: true });
    }
    return { completed: true };
  } finally { release(); }
}

export function installTransaction(app, home, source, { uninstall = false, deferHealth = false, checkpoint = () => {} } = {}) {
  const targetRelative = relative(installPaths(app, home).target, resolve(source));
  if (!targetRelative || (!targetRelative.startsWith('..') && !isAbsolute(targetRelative))) throw new Error('不能从已安装的插件目录覆盖自身；请使用独立安装包');
  const paths = preflight(app, home, uninstall), release = acquire(paths);
  const id = randomUUID(), root = join(paths.root, id), file = join(root, 'journal.json');
  const journal = { id, app: paths.app, home: paths.home, operation: uninstall ? 'uninstall' : 'install', phase: 'preparing', entries: [] };
  try {
    if (exists(join(paths.root, 'pending.json'))) throw new Error('另一个安装器留下待确认事务；请先恢复');
    // Prepare a complete adapter in an isolated miniature host before touching
    // the real host. Only the three explicitly managed modules are copied.
    const hostStage = join(root, 'host');
    for (const relative of hostFiles) copy(resolveHostFile(paths.app, relative), join(hostStage, relative));
    if (exists(join(paths.app, 'package.json'))) copy(join(paths.app, 'package.json'), join(hostStage, 'package.json'));
    if (exists(join(paths.app, '.session-editor-adapter'))) copy(join(paths.app, '.session-editor-adapter'), join(hostStage, '.session-editor-adapter'));
    planAdapter(hostStage, uninstall)();
    fs.mkdirSync(join(hostStage, '.session-editor-adapter'), { recursive: true });
    fs.writeFileSync(join(hostStage, '.session-editor-adapter/owner.json'), JSON.stringify({ home: paths.home, active: !uninstall }));
    const operations = hostFiles.map(relative => ({ destination: resolveHostFile(paths.app, relative), source: join(hostStage, relative) }));
    operations.push({ destination: join(paths.app, '.session-editor-adapter'), source: join(hostStage, '.session-editor-adapter') });
    const before = exists(paths.config) ? read(paths.config) : '';
    const configStage = join(root, 'config.yml');
    if (uninstall) {
      const manifest = JSON.parse(read(paths.manifest));
      fs.writeFileSync(configStage, manifest.configBefore);
      // Uninstalled code is retained in the transaction snapshot, not deleted.
      operations.push({ destination: paths.target, source: manifest.hadPlugin ? join(paths.state, 'previous-plugin') : null });
    } else {
      fs.writeFileSync(configStage, prepareConfig(paths.app, before));
      const pluginStage = join(root, 'plugin'); fs.mkdirSync(join(pluginStage, 'lib'), { recursive: true });
      for (const name of ['package.json','README.md','AGENT.md','install.mjs','host-adapter.mjs']) {
        copy(name === 'AGENT.md' && exists(join(paths.target, name)) ? join(paths.target, name) : join(source, name), join(pluginStage, name));
      }
      for (const entry of fs.readdirSync(join(source, 'lib'), { withFileTypes: true })) {
        if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) copy(join(source, 'lib', entry.name), join(pluginStage, 'lib', entry.name));
      }
      fs.writeFileSync(join(pluginStage, 'host.json'), JSON.stringify({ app: paths.app }, null, 2));
      operations.push({ destination: paths.target, source: pluginStage });
      if (!exists(paths.manifest)) {
        const manifestStage = join(root, 'install.json');
        fs.writeFileSync(manifestStage, JSON.stringify({ app: paths.app, configBefore: before, configAfter: read(configStage), hadPlugin: exists(paths.target) }, null, 2));
        operations.push({ destination: paths.manifest, source: manifestStage });
        if (exists(paths.target)) operations.push({ destination: join(paths.state, 'previous-plugin'), source: paths.target });
      }
    }
    operations.push({ destination: paths.config, source: configStage });
    for (const [index, operation] of operations.entries()) {
      const entry = { destination: operation.destination, backup: join(root, 'before', String(index)), staged: join(root, 'after', String(index)), before: fingerprint(operation.destination), after: fingerprint(operation.source), attempted: false };
      if (entry.before !== null) copy(operation.destination, entry.backup);
      if (operation.source) copy(operation.source, entry.staged);
      journal.entries.push(entry);
    }
    validateJournal(paths, journal);
    journal.phase = 'prepared'; durableJson(file, journal);
    durableJson(join(paths.root, 'pending.json'), { id });
    checkpoint('prepared', journal);
    for (const [index, entry] of journal.entries.entries()) {
      if (fingerprint(entry.destination) !== entry.before) throw new Error('提交前目标发生变化；拒绝覆盖');
      entry.attempted = true; journal.phase = 'committing'; durableJson(file, journal);
      replace(entry, entry.after !== null ? entry.staged : null, id);
      if (fingerprint(entry.destination) !== entry.after) throw new Error('安装产物读回校验失败');
      checkpoint('committed-' + index, journal);
    }
    journal.phase = 'awaiting-health'; durableJson(file, journal);
  } catch (error) {
    if (exists(join(paths.root, 'pending.json')) && JSON.parse(read(join(paths.root, 'pending.json'))).id === id) {
      try { rollback(paths, file, journal); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], '安装失败且回滚未完成；保留事务和备份，请勿继续安装'); }
    }
    throw error;
  } finally { release(); }
  if (!deferHealth) recoverInstallation(app, home, true);
  return { ok: true, awaitingHealth: deferHealth, transactionId: id };
}
