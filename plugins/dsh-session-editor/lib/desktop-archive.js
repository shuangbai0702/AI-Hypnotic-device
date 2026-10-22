import fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Electron ASAR uses two Chromium Pickles followed by packed file bytes.
// No extraction or archive-controlled filesystem paths are used here.
export function readArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > 512 * 1024 * 1024) throw new Error('无效或过大的桌面 ASAR');
  const headerSize = bytes.readUInt32LE(4), jsonSize = bytes.readUInt32LE(12), start = 8 + headerSize;
  if (bytes.readUInt32LE(0) !== 4 || headerSize > 32 * 1024 * 1024 || headerSize < 8 ||
      bytes.readUInt32LE(8) !== headerSize - 4 || jsonSize > headerSize - 8 || start > bytes.length) throw new Error('桌面 ASAR 头损坏');
  const header = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString('utf8'));
  const packed = [], entries = new Map(), contents = new Map();
  const visit = (files, prefix = '') => {
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('桌面 ASAR 目录损坏');
    for (const [name, entry] of Object.entries(files)) {
      if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name) || !entry || typeof entry !== 'object') throw new Error('桌面 ASAR 路径损坏');
      const path = prefix + name;
      if (entry.files) visit(entry.files, path + '/');
      else {
        entries.set(path, entry);
        if (entry.link || entry.unpacked) continue;
        const offset = Number(entry.offset);
        if (!/^\d+$/.test(String(entry.offset)) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(entry.size) ||
            entry.size < 0 || offset < 0 || start + offset + entry.size > bytes.length) throw new Error('桌面 ASAR 文件越界');
        packed.push({ path, entry, offset });
        contents.set(path, { offset, size: entry.size });
      }
    }
  };
  visit(header.files);
  packed.sort((a, b) => a.offset - b.offset);
  let end = 0;
  for (const file of packed) { if (file.offset < end) throw new Error('桌面 ASAR 文件重叠'); end = file.offset + file.entry.size; }
  const read = path => {
    const entry = entries.get(path);
    if (!entry || entry.link || entry.unpacked || entry.files) throw new Error('缺少受支持的桌面归档文件：' + path);
    const original = contents.get(path);
    return bytes.subarray(start + original.offset, start + original.offset + original.size);
  };
  return { read, rewrite(replacements) {
    for (const path of replacements.keys()) read(path);
    const parts = []; let offset = 0;
    for (const file of packed) {
      const content = replacements.get(file.path) ?? read(file.path);
      const entry = file.entry;
      entry.offset = String(offset); entry.size = content.length;
      if (replacements.has(file.path) && entry.integrity) {
        const blockSize = entry.integrity.blockSize;
        if (entry.integrity.algorithm !== 'SHA256' || !Number.isSafeInteger(blockSize) || blockSize <= 0) throw new Error('不支持的 ASAR 完整性格式');
        const blocks = [];
        for (let n = 0; n < content.length; n += blockSize) blocks.push(digest(content.subarray(n, n + blockSize)));
        entry.integrity = { ...entry.integrity, hash: digest(content), blocks };
      }
      parts.push(content); offset += content.length;
    }
    const json = Buffer.from(JSON.stringify(header)), padding = (4 - json.length % 4) % 4;
    const prefix = Buffer.alloc(16 + json.length + padding);
    prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(json.length + padding + 8, 4);
    prefix.writeUInt32LE(json.length + padding + 4, 8); prefix.writeUInt32LE(json.length, 12); json.copy(prefix, 16);
    return Buffer.concat([prefix, ...parts]);
  } };
}

export function desktopArchive(app) {
  const path = join(app, 'resources/app.asar');
  if (!fs.existsSync(path)) return null;
  const archive = readArchive(fs.readFileSync(path));
  const manifest = JSON.parse(archive.read('package.json').toString('utf8'));
  if (manifest.name !== '@deepseek-ai/dsh-desktop') throw new Error('不是受支持的 DSH 桌面程序');
  if (manifest.version !== '0.2.1-rc.2' || manifest.dshBuildCommit !== '332895e0f7c9d4dbfb29729f5eb367fa263ff986' || manifest.dshBuildDirty !== false) throw new Error('尚未适配此桌面构建；未修改归档');
  return { path, archive, cli: join(path, 'dsh/node_modules/@deepseek-ai/dsh') };
}

export function desktopYaml(archive) {
  // Evaluate the selected host's self-contained UMD parser, just as requiring
  // its js-yaml package would. No dependency is downloaded or written globally.
  const exports = {};
  runInNewContext(archive.read('dsh/node_modules/js-yaml/dist/js-yaml.js').toString('utf8'), { exports, module: { exports } }, { timeout: 5000 });
  if (typeof exports.load !== 'function' || typeof exports.dump !== 'function') throw new Error('桌面 YAML 解析器不兼容');
  return exports;
}
