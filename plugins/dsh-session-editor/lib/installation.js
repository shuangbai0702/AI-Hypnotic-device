import fs from 'node:fs';
import { join, resolve, dirname, basename, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { planAdapter, resolveHostFile } from '../host-adapter.mjs';
import { desktopArchive, desktopYaml } from './desktop-archive.js';

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
  // Recovery must still find its journal when replacement was interrupted
  // between renaming the old archive and committing the new one.
  const archive = join(app, 'resources/app.asar');
  const desktop = exists(archive) || exists(join(home, '.session-editor-transactions-desktop/pending.json'))
    ? { path: archive, cli: join(archive, 'dsh/node_modules/@deepseek-ai/dsh') } : null;
  const profile = desktop ? 'desktop' : 'web', suffix = desktop ? '-desktop' : '';
  const state = join(home, '.session-editor-install' + suffix);
  return { app, home, state, desktop, profile, config: join(home, 'profiles', profile, 'cordis.patch.yml'),
    target: join(home, 'profiles', profile, 'node_modules/@shuangbai/dsh-session-editor'),
    manifest: join(state, 'install.json'), root: join(home, '.session-editor-transactions' + suffix) };
}
function checkAdapter(paths, uninstall) {
  if (!paths.desktop) return planAdapter(paths.app, uninstall);
  const archiveState = join(paths.app, '.session-editor-adapter/archive.json');
  if (exists(archiveState)) {
    const state = JSON.parse(read(archiveState)), current = createHash('sha256').update(fs.readFileSync(paths.desktop.path)).digest('hex');
    if (![state.original, state.patched].includes(current)) throw new Error('桌面归档已被更新或修改；拒绝覆盖，请先恢复匹配版本');
    if (createHash('sha256').update(fs.readFileSync(join(paths.app, '.session-editor-adapter/original.asar'))).digest('hex') !== state.original) throw new Error('桌面原始归档备份损坏');
  }
  return planAdapter(paths.app, uninstall, {
    resolveFile: (app, file) => join(app, file),
    readFile: (file, encoding) => {
      const name = relative(paths.app, file).replaceAll('\\', '/');
      return hostFiles.includes(name) ? paths.desktop.archive.read('dsh/' + name).toString(encoding) : fs.readFileSync(file, encoding);
    },
  });
}
function configYaml(app) {
  // Use the selected DSH's exact YAML parser, including fresh stock `[]`.
  const desktop = desktopArchive(resolve(app));
  return desktop ? desktopYaml(desktop.archive) : createRequire(join(resolve(app), 'package.json'))('js-yaml');
}
export function prepareConfig(app, before) {
  const yaml = configYaml(app);
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
function uninstallConfig(paths, current, manifest) {
  const existed = manifest.configExisted !== false && !(paths.desktop && manifest.configExisted === undefined && manifest.configBefore === '');
  if (current === manifest.configAfter) return { text: manifest.configBefore, existed };
  const yaml = configYaml(paths.app);
  const before = yaml.load(manifest.configBefore) ?? yaml.load('[]'), installed = yaml.load(manifest.configAfter), now = yaml.load(current);
  // Only remove the whole registration inserted by this installer. An edited,
  // duplicate or pre-existing registration requires explicit manual resolution.
  const inserted = installed?.at?.(-1), registration = inserted?.insert?.[0];
  if (!Array.isArray(before) || !Array.isArray(installed) || !Array.isArray(now) ||
      installed.length !== before.length + 1 || !isDeepStrictEqual(installed.slice(0, -1), before) ||
      !inserted || Object.keys(inserted).length !== 1 || !Array.isArray(inserted.insert) || inserted.insert.length !== 1 ||
      registration?.name !== '@shuangbai/dsh-session-editor' || registration.id !== 'session-editor' ||
      Object.keys(registration).length !== 3 || !registration.config || Object.keys(registration.config).length !== 0) {
    throw new Error('安装记录无法安全确定新增注册；未执行卸载');
  }
  let registrations = 0;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.name === '@shuangbai/dsh-session-editor') registrations++;
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  visit(now);
  const matches = now.map((value, index) => isDeepStrictEqual(value, inserted) ? index : -1).filter(index => index >= 0);
  if (registrations !== 1 || matches.length !== 1) throw new Error('插件注册已修改或重复；未执行卸载，请先核对配置');
  const remaining = now.filter((_value, index) => index !== matches[0]);
  return { text: yaml.dump(remaining, { noRefs: true, lineWidth: 120 }), existed: existed || remaining.length > 0 };
}
export function preflight(app, home, uninstall = false) {
  const paths = installPaths(app, home);
  if (paths.desktop) paths.desktop = desktopArchive(paths.app);
  const ownerPath = join(paths.app, '.session-editor-adapter/owner.json');
  if (exists(ownerPath)) {
    const owner = JSON.parse(read(ownerPath));
    if (owner.active && resolve(owner.home) !== paths.home) throw new Error('该 DSH 已绑定其他数据目录；请先从原数据目录卸载，避免影响其他服务');
  }
  if (exists(join(paths.root, 'pending.json'))) throw new Error('存在未完成安装事务；停止目标 DSH 后先运行 --recover');
  checkAdapter(paths, uninstall);
  const before = exists(paths.config) ? read(paths.config) : '';
  if (uninstall) {
    const manifest = JSON.parse(read(paths.manifest));
    if (resolve(manifest.app) !== paths.app) throw new Error('安装记录属于其他 DSH');
    if (manifest.hadPlugin && !exists(join(paths.state, 'previous-plugin'))) throw new Error('安装前插件备份缺失；拒绝卸载');
    uninstallConfig(paths, before, manifest);
  } else {
    prepareConfig(paths.app, before);
    if (exists(paths.manifest) && resolve(JSON.parse(read(paths.manifest)).app) !== paths.app) throw new Error('此数据目录已绑定其他 DSH');
  }
  return paths;
}

function allowedDestinations(paths) {
  return [...(paths.desktop ? [paths.desktop.path] : hostFiles.map(file => resolveHostFile(paths.app, file))), join(paths.app, '.session-editor-adapter'),
    paths.config, paths.target, paths.manifest, join(paths.state, 'previous-plugin'),
    ...(paths.desktop ? [join(dirname(paths.config), 'package.json'), join(dirname(paths.config), 'pnpm-workspace.yaml')] : [])];
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
  let paths = preflight(app, home, uninstall);
  const release = acquire(paths);
  const id = randomUUID(), root = join(paths.root, id), file = join(root, 'journal.json');
  const journal = { id, app: paths.app, home: paths.home, operation: uninstall ? 'uninstall' : 'install', phase: 'preparing', entries: [] };
  try {
    // Refresh the captured archive and owner/config checks after acquiring both
    // locks; another installer may have completed while this one was probing.
    paths = preflight(app, home, uninstall);
    if (exists(join(paths.root, 'pending.json'))) throw new Error('另一个安装器留下待确认事务；请先恢复');
    // Prepare a complete adapter in an isolated miniature host before touching
    // the real host. Only the three explicitly managed modules are copied.
    const hostStage = join(root, 'host');
    for (const relative of hostFiles) {
      if (paths.desktop) { fs.mkdirSync(dirname(join(hostStage, relative)), { recursive: true }); fs.writeFileSync(join(hostStage, relative), paths.desktop.archive.read('dsh/' + relative)); }
      else copy(resolveHostFile(paths.app, relative), join(hostStage, relative));
    }
    if (exists(join(paths.app, 'package.json'))) copy(join(paths.app, 'package.json'), join(hostStage, 'package.json'));
    if (exists(join(paths.app, '.session-editor-adapter'))) copy(join(paths.app, '.session-editor-adapter'), join(hostStage, '.session-editor-adapter'));
    planAdapter(hostStage, uninstall)();
    fs.mkdirSync(join(hostStage, '.session-editor-adapter'), { recursive: true });
    fs.writeFileSync(join(hostStage, '.session-editor-adapter/owner.json'), JSON.stringify({ home: paths.home, active: !uninstall }));
    const operations = [];
    if (paths.desktop) {
      const adapter = join(hostStage, '.session-editor-adapter'), original = join(adapter, 'original.asar');
      if (!exists(original)) copy(paths.desktop.path, original);
      const archiveStage = join(root, 'app.asar');
      if (uninstall) copy(original, archiveStage);
      else fs.writeFileSync(archiveStage, paths.desktop.archive.rewrite(new Map(hostFiles.map(file => ['dsh/' + file, fs.readFileSync(join(hostStage, file))]))));
      if (!uninstall) fs.writeFileSync(join(adapter, 'archive.json'), JSON.stringify({ original: createHash('sha256').update(fs.readFileSync(original)).digest('hex'), patched: createHash('sha256').update(fs.readFileSync(archiveStage)).digest('hex') }));
      operations.push({ destination: paths.desktop.path, source: archiveStage });
    } else operations.push(...hostFiles.map(relative => ({ destination: resolveHostFile(paths.app, relative), source: join(hostStage, relative) })));
    operations.push({ destination: join(paths.app, '.session-editor-adapter'), source: join(hostStage, '.session-editor-adapter') });
    if (paths.desktop && !uninstall) {
      const initial = {
        'package.json': JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2) + '\n',
        'pnpm-workspace.yaml': 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
      };
      for (const [name, content] of Object.entries(initial)) {
        const destination = join(dirname(paths.config), name);
        if (!exists(destination)) {
          const staged = join(root, 'profile-' + name); fs.writeFileSync(staged, content);
          operations.push({ destination, source: staged });
        }
      }
    }
    const before = exists(paths.config) ? read(paths.config) : '';
    const configStage = join(root, 'config.yml');
    let restoreConfig = true;
    if (uninstall) {
      const manifest = JSON.parse(read(paths.manifest));
      const restored = uninstallConfig(paths, before, manifest);
      restoreConfig = restored.existed;
      if (restoreConfig) fs.writeFileSync(configStage, restored.text);
      // Uninstalled code is retained in the transaction snapshot, not deleted.
      operations.push({ destination: paths.target, source: manifest.hadPlugin ? join(paths.state, 'previous-plugin') : null });
      operations.push({ destination: paths.manifest, source: null });
      if (exists(join(paths.state, 'previous-plugin'))) operations.push({ destination: join(paths.state, 'previous-plugin'), source: null });
    } else {
      fs.writeFileSync(configStage, prepareConfig(paths.app, before));
      const pluginStage = join(root, 'plugin'); fs.mkdirSync(join(pluginStage, 'lib'), { recursive: true });
      for (const name of ['package.json','README.md','AGENT.md','install.mjs','host-adapter.mjs']) {
        copy(name === 'AGENT.md' && exists(join(paths.target, name)) ? join(paths.target, name) : join(source, name), join(pluginStage, name));
      }
      for (const entry of fs.readdirSync(join(source, 'lib'), { withFileTypes: true })) {
        if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) copy(join(source, 'lib', entry.name), join(pluginStage, 'lib', entry.name));
      }
      fs.writeFileSync(join(pluginStage, 'host.json'), JSON.stringify({ app: paths.desktop?.cli ?? paths.app, home: paths.home }, null, 2));
      operations.push({ destination: paths.target, source: pluginStage });
      if (!exists(paths.manifest)) {
        const manifestStage = join(root, 'install.json');
        fs.writeFileSync(manifestStage, JSON.stringify({ app: paths.app, configBefore: before, configExisted: exists(paths.config), configAfter: read(configStage), hadPlugin: exists(paths.target) }, null, 2));
        operations.push({ destination: paths.manifest, source: manifestStage });
        if (exists(paths.target)) operations.push({ destination: join(paths.state, 'previous-plugin'), source: paths.target });
      }
    }
    operations.push({ destination: paths.config, source: restoreConfig ? configStage : null });
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
