import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readArchive } from '../plugins/dsh-session-editor/lib/desktop-archive.js';
import { installTransaction, installPaths, recoverInstallation, hostFiles, preflight } from '../plugins/dsh-session-editor/lib/installation.js';
const source = resolve('plugins/dsh-session-editor');
const hash = data => createHash('sha256').update(data).digest('hex');
function archive(files) {
  const header = { files: {} }, parts = []; let offset = 0;
  for (const [path, content] of files) {
    const names = path.split('/'); let node = header;
    for (const name of names.slice(0, -1)) node = node.files[name] ??= { files: {} };
    node.files[names.at(-1)] = { offset: String(offset), size: content.length,
      integrity: { algorithm: 'SHA256', hash: hash(content), blockSize: 4194304, blocks: [hash(content)] } };
    parts.push(content); offset += content.length;
  }
  const json = Buffer.from(JSON.stringify(header)), pad = (4 - json.length % 4) % 4, prefix = Buffer.alloc(16 + json.length + pad);
  prefix.writeUInt32LE(4); prefix.writeUInt32LE(json.length + pad + 8, 4); prefix.writeUInt32LE(json.length + pad + 4, 8); prefix.writeUInt32LE(json.length, 12); json.copy(prefix, 16);
  return Buffer.concat([prefix, ...parts]);
}
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-desktop-install-')), app = join(root, 'desktop'), home = join(root, 'home');
  const files = new Map([['package.json', Buffer.from(JSON.stringify({name:'@deepseek-ai/dsh-desktop',version:'0.2.1-rc.2',dshBuildCommit:'332895e0f7c9d4dbfb29729f5eb367fa263ff986',dshBuildDirty:false}))], ['unrelated.txt', Buffer.from('do not change')],
    ['dsh/node_modules/js-yaml/dist/js-yaml.js', fs.readFileSync(resolve('app/node_modules/js-yaml/dist/js-yaml.js'))]]);
  const originals = JSON.parse(fs.readFileSync(resolve('app/.session-editor-adapter/manifest.json')));
  for (const file of hostFiles) {
    const original = originals.find(entry => entry.path === file);
    files.set('dsh/' + file, fs.readFileSync(resolve('app/.session-editor-adapter', original.original)));
  }
  const bytes = archive(files), path = join(app, 'resources/app.asar'); fs.mkdirSync(join(app, 'resources'), { recursive: true }); fs.writeFileSync(path, bytes);
  fs.mkdirSync(join(home, 'profiles/desktop'), { recursive: true }); fs.writeFileSync(join(home, 'profiles/desktop/cordis.patch.yml'), '[]\n');
  const paths = installPaths(app, home);
  return { app, home, path, bytes, paths, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
test('ASAR bounds reject corrupt input, rewrite changes only selected file and integrity', () => {
  const input = archive(new Map([['first', Buffer.from('123')], ['second', Buffer.from('keep')]]));
  const changed = readArchive(input).rewrite(new Map([['first', Buffer.from('longer')]])), parsed = readArchive(changed);
  assert.equal(parsed.read('first').toString(), 'longer'); assert.equal(parsed.read('second').toString(), 'keep');
  const header = JSON.parse(changed.subarray(16, 16 + changed.readUInt32LE(12)));
  assert.equal(header.files.first.integrity.hash, hash(Buffer.from('longer')));
  assert.throws(() => readArchive(input.subarray(0, input.length - 1)), /越界/);
  assert.throws(() => readArchive(Buffer.alloc(16)), /损坏/);
  assert.throws(() => parsed.rewrite(new Map([['../outside', Buffer.from('bad')]])), /缺少/);
  const reusable = readArchive(input); reusable.rewrite(new Map([['first', Buffer.from('length changes')]]));
  assert.equal(reusable.read('second').toString(), 'keep');
  const again = readArchive(reusable.rewrite(new Map([['first', Buffer.from('x')]])));
  assert.equal(again.read('second').toString(), 'keep');
});
test('desktop install and reinstall preserve archive files, target desktop profile; uninstall restores exact archive', () => {
  const f = fixture(); try {
    for (let n = 0; n < 2; n++) {
      installTransaction(f.app, f.home, source);
      assert.equal(readArchive(fs.readFileSync(f.path)).read('unrelated.txt').toString(), 'do not change');
      assert.equal(fs.existsSync(join(f.home, 'profiles/web')), false);
      assert.ok(fs.readFileSync(f.paths.config, 'utf8').includes('@shuangbai/dsh-session-editor'));
      const host = JSON.parse(fs.readFileSync(join(f.paths.target, 'host.json')));
      assert.equal(host.app, join(f.path, 'dsh/node_modules/@deepseek-ai/dsh'));
    }
    installTransaction(f.app, f.home, source, { uninstall: true });
    assert.deepEqual(fs.readFileSync(f.path), f.bytes); assert.equal(fs.readFileSync(f.paths.config, 'utf8'), '[]\n');
    assert.equal(fs.existsSync(f.paths.target), false);
  } finally { f.close(); }
});
test('fresh desktop uninstall restores absent patch instead of an invalid empty YAML document', () => {
  const f = fixture(); try {
    fs.unlinkSync(f.paths.config);
    installTransaction(f.app, f.home, source);
    assert.equal(JSON.parse(fs.readFileSync(f.paths.manifest)).configExisted, false);
    installTransaction(f.app, f.home, source, { uninstall: true });
    assert.equal(fs.existsSync(f.paths.config), false); assert.deepEqual(fs.readFileSync(f.path), f.bytes);
  } finally { f.close(); }
});
test('desktop uninstall retains later model settings and can roll back before health confirmation', () => {
  const f = fixture(); try {
    fs.unlinkSync(f.paths.config);
    installTransaction(f.app, f.home, source);
    const installed = fs.readFileSync(f.path), manifest = fs.readFileSync(f.paths.manifest);
    const config = fs.readFileSync(f.paths.config, 'utf8') + '- id: user-model\n  config: { model: selected-later }\n';
    fs.writeFileSync(f.paths.config, config);
    installTransaction(f.app, f.home, source, { uninstall: true, deferHealth: true });
    assert.deepEqual(fs.readFileSync(f.path), f.bytes);
    assert.equal(fs.existsSync(f.paths.manifest), false);
    assert.match(fs.readFileSync(f.paths.config, 'utf8'), /selected-later/);
    assert.doesNotMatch(fs.readFileSync(f.paths.config, 'utf8'), /@shuangbai/);
    recoverInstallation(f.app, f.home);
    assert.deepEqual(fs.readFileSync(f.path), installed);
    assert.deepEqual(fs.readFileSync(f.paths.manifest), manifest);
    assert.equal(fs.readFileSync(f.paths.config, 'utf8'), config);
    installTransaction(f.app, f.home, source, { uninstall: true });
    assert.match(fs.readFileSync(f.paths.config, 'utf8'), /selected-later/);
  } finally { f.close(); }
});
test('unknown desktop shell build refuses preflight before any target mutation', () => {
  const f = fixture(); try {
    fs.writeFileSync(f.path, readArchive(f.bytes).rewrite(new Map([['package.json', Buffer.from('{"name":"@deepseek-ai/dsh-desktop","version":"9.0.0"}')]])));
    const before = fs.readFileSync(f.path);
    assert.throws(() => preflight(f.app, f.home), /尚未适配/);
    assert.deepEqual(fs.readFileSync(f.path), before); assert.equal(fs.existsSync(f.paths.target), false);
  } finally { f.close(); }
});
for (const phase of ['prepared', 'committed-0', 'committed-1', 'committed-2', 'committed-3', 'committed-4', 'committed-5', 'committed-6']) test('desktop rollback at ' + phase, () => {
  const f = fixture(); try {
    assert.throws(() => installTransaction(f.app, f.home, source, { checkpoint(name) { if (name === phase) throw Error('injected desktop failure'); } }), /injected desktop failure/);
    assert.deepEqual(fs.readFileSync(f.path), f.bytes); assert.equal(fs.readFileSync(f.paths.config, 'utf8'), '[]\n');
    assert.equal(fs.existsSync(f.paths.target), false); assert.equal(fs.existsSync(join(f.paths.root, 'pending.json')), false);
    assert.equal(fs.existsSync(join(f.home, 'profiles/desktop/package.json')), false);
  } finally { f.close(); }
});
test('desktop pending health can roll back when archive is missing; updates refuse overwrite', () => {
  const f = fixture(); try {
    installTransaction(f.app, f.home, source, { deferHealth: true }); fs.unlinkSync(f.path);
    recoverInstallation(f.app, f.home); assert.deepEqual(fs.readFileSync(f.path), f.bytes);
    installTransaction(f.app, f.home, source);
    fs.writeFileSync(f.path, readArchive(fs.readFileSync(f.path)).rewrite(new Map([['unrelated.txt', Buffer.from('new host build')]])));
    assert.throws(() => preflight(f.app, f.home, true), /归档已被更新/);
  } finally { f.close(); }
});
