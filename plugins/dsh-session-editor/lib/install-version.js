import fs from 'node:fs';
import { join, resolve } from 'node:path';

export const pluginName = '@shuangbai/dsh-session-editor';
export function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 128) throw new Error('版本号无效');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
  if (!match || match[4]?.split('.').some(part => /^0\d+$/.test(part))) throw new Error('版本号无效：' + value);
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') ?? [] };
}
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === b.pre[i]) continue;
    if (a.pre[i] === undefined || b.pre[i] === undefined) return a.pre[i] === undefined ? -1 : 1;
    const an = /^\d+$/.test(a.pre[i]), bn = /^\d+$/.test(b.pre[i]);
    if (an !== bn) return an ? -1 : 1;
    return (an ? BigInt(a.pre[i]) > BigInt(b.pre[i]) : a.pre[i] > b.pre[i]) ? 1 : -1;
  }
  return 0;
}
export function packageVersion(directory) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(join(directory, 'package.json'), 'utf8')); }
  catch { throw new Error('无法读取插件版本；请保留现有文件，使用完整安装包重试'); }
  if (pkg.name !== pluginName) throw new Error('插件标识不匹配；拒绝覆盖');
  parseVersion(pkg.version);
  return pkg.version;
}
export function installationRecord(paths) {
  if (!fs.existsSync(paths.manifest)) return null;
  let record;
  try { record = JSON.parse(fs.readFileSync(paths.manifest, 'utf8')); }
  catch { throw new Error('安装记录损坏；未修改目标，请先恢复安装记录'); }
  const path = record?.schema === 2 ? record.app?.path : record?.schema === undefined ? record?.app : null;
  if (typeof path !== 'string' || !path || typeof record.configBefore !== 'string' ||
      typeof record.configAfter !== 'string' || typeof record.hadPlugin !== 'boolean') throw new Error('安装记录格式不受支持；请使用匹配或更新的安装器');
  if (resolve(path) !== paths.app) throw new Error('此数据目录已绑定其他 DSH');
  if (record.schema === 2) {
    if (record.plugin?.name !== pluginName) throw new Error('安装记录插件标识不匹配');
    parseVersion(record.plugin.version);
  }
  return record;
}
export function checkInstallVersion(paths, source) {
  const incoming = packageVersion(source), record = installationRecord(paths);
  const installed = fs.existsSync(paths.target) ? packageVersion(paths.target) : record?.plugin?.version;
  if (record?.plugin && installed !== record.plugin.version) throw new Error('插件版本与安装记录不一致；拒绝覆盖，请先恢复匹配备份');
  if (installed && compareVersions(incoming, installed) < 0) throw new Error(`禁止降级：已安装 ${installed}，当前安装包 ${incoming}；请使用相同或更新版本`);
  return { incoming, installed, record };
}
