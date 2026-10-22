import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { installTransaction, recoverInstallation, preflight, installPaths, hostFiles, prepareConfig } from '../plugins/dsh-session-editor/lib/installation.js';
const source = resolve('plugins/dsh-session-editor');
const yaml = createRequire(resolve('app/package.json'))('js-yaml');
function fixture(config = '[]\n') {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-install-txn-')), app = join(root, 'app'), home = join(root, 'home');
  for (const file of hostFiles) { fs.mkdirSync(join(app, file, '..'), { recursive: true }); fs.copyFileSync(resolve('app', file), join(app, file)); }
  const originalManifest = resolve('app/.session-editor-adapter/manifest.json');
  if (fs.existsSync(originalManifest)) for (const entry of JSON.parse(fs.readFileSync(originalManifest))) fs.copyFileSync(resolve('app/.session-editor-adapter', entry.original), join(app, entry.path));
  fs.cpSync(resolve('app/node_modules/js-yaml'), join(app, 'node_modules/js-yaml'), { recursive: true });
  const paths = installPaths(app, home); fs.mkdirSync(join(home, 'profiles/web'), { recursive: true }); fs.writeFileSync(paths.config, config);
  fs.writeFileSync(join(home, 'credentials.yaml'), 'synthetic-credential: must-stay-identical\n');
  fs.writeFileSync(join(home, '.credentials.yaml'), 'synthetic-native-credential: must-stay-identical\n');
  const original = hostFiles.map(file => fs.readFileSync(join(app, file)));
  return { app, home, paths, root, original, assertRestored() {
    hostFiles.forEach((file, i) => assert.deepEqual(fs.readFileSync(join(app, file)), original[i]));
    assert.equal(fs.readFileSync(paths.config, 'utf8'), config);
    assert.equal(fs.readFileSync(join(home, 'credentials.yaml'), 'utf8'), 'synthetic-credential: must-stay-identical\n');
    assert.equal(fs.readFileSync(join(home, '.credentials.yaml'), 'utf8'), 'synthetic-native-credential: must-stay-identical\n');
  }, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
test('stock [] and existing YAML round-trip, idempotent registration, invalid YAML refuses preflight', () => {
  const f = fixture(); try {
    for (const config of ['', '[]\n', '# stock configuration\n[]\n', '- id: existing\n  config: {}\n']) {
      const after = prepareConfig(f.app, config), parsed = yaml.load(after);
      assert.ok(Array.isArray(parsed)); assert.equal(parsed.at(-1).insert[0].name, '@shuangbai/dsh-session-editor');
      assert.equal(prepareConfig(f.app, after), after);
    }
    for (const config of ['{invalid: root}', '[broken']) {
      fs.writeFileSync(f.paths.config, config);
      assert.throws(() => preflight(f.app, f.home));
      assert.equal(fs.existsSync(f.paths.root), false);
    }
  } finally { f.close(); }
});

test('install, reinstall and uninstall preserve account, provider, endpoint and default model settings',()=>{
  const entries=[{id:'llm-deepseek',config:{apiKeyEnv:'EXISTING_OFFICIAL_KEY',baseURL:'https://api.example.invalid/v1'}},
    {id:'llm-pi-ai',config:{providers:{existing:{apiKeyEnv:'EXISTING_CUSTOM_KEY',baseURL:'https://proxy.example.invalid/v1',models:[{id:'keep-model'}]}}}},
    {id:'agent-default-model',config:{provider:'existing',model:'keep-model'}}];
  const f=fixture(yaml.dump(entries));try {
    for(let n=0;n<2;n++) {
      installTransaction(f.app,f.home,source);
      const installed=yaml.load(fs.readFileSync(f.paths.config,'utf8'));
      assert.deepEqual(installed.slice(0,-1),entries);assert.equal(installed.length,entries.length+1);
      assert.equal(fs.readFileSync(join(f.home,'.credentials.yaml'),'utf8'),'synthetic-native-credential: must-stay-identical\n');
    }
    installTransaction(f.app,f.home,source,{uninstall:true});f.assertRestored();
  }finally{f.close();}
});
test('uninstall preserves settings added after install and retires the active install record', () => {
  const f = fixture(); try {
    installTransaction(f.app, f.home, source);
    const changed = yaml.load(fs.readFileSync(f.paths.config, 'utf8'));
    changed.push({ id: 'user-model', config: { model: 'new-model', endpoint: 'https://example.invalid/v1' } });
    fs.writeFileSync(f.paths.config, yaml.dump(changed));
    installTransaction(f.app, f.home, source, { uninstall: true });
    assert.deepEqual(yaml.load(fs.readFileSync(f.paths.config, 'utf8')), changed.slice(1));
    assert.equal(fs.existsSync(f.paths.manifest), false);
    assert.equal(fs.readFileSync(join(f.home, '.credentials.yaml'), 'utf8'), 'synthetic-native-credential: must-stay-identical\n');
    installTransaction(f.app, f.home, source);
    installTransaction(f.app, f.home, source, { uninstall: true });
    assert.deepEqual(yaml.load(fs.readFileSync(f.paths.config, 'utf8')), changed.slice(1));
  } finally { f.close(); }
});
test('uninstall rejects edited plugin registrations without changing host or configuration', () => {
  const f = fixture(); try {
    installTransaction(f.app, f.home, source);
    const changed = yaml.load(fs.readFileSync(f.paths.config, 'utf8'));
    changed.at(-1).insert[0].config = { userChange: true };
    const text = yaml.dump(changed); fs.writeFileSync(f.paths.config, text);
    const host = hostFiles.map(file => fs.readFileSync(join(f.app, file)));
    assert.throws(() => installTransaction(f.app, f.home, source, { uninstall: true }), /配置|注册/);
    assert.equal(fs.readFileSync(f.paths.config, 'utf8'), text);
    hostFiles.forEach((file, i) => assert.deepEqual(fs.readFileSync(join(f.app, file)), host[i]));
  } finally { f.close(); }
});
test('reinstall after uninstall records the new configuration baseline', () => {
  const f = fixture(); try {
    installTransaction(f.app, f.home, source);
    installTransaction(f.app, f.home, source, { uninstall: true });
    const text = '- id: configured-after-uninstall\n  config: { keep: true }\n';
    fs.writeFileSync(f.paths.config, text);
    installTransaction(f.app, f.home, source);
    installTransaction(f.app, f.home, source, { uninstall: true });
    assert.equal(fs.readFileSync(f.paths.config, 'utf8'), text);
  } finally { f.close(); }
});
test('uninstall restores a pre-existing plugin and rollback preserves its backup', () => {
  const f = fixture(); try {
    fs.mkdirSync(f.paths.target, { recursive: true });
    fs.writeFileSync(join(f.paths.target, 'AGENT.md'), 'synthetic user prompt');
    fs.writeFileSync(join(f.paths.target, 'prior.txt'), 'pre-existing plugin');
    installTransaction(f.app, f.home, source);
    installTransaction(f.app, f.home, source, { uninstall: true, deferHealth: true });
    assert.equal(fs.readFileSync(join(f.paths.target, 'prior.txt'), 'utf8'), 'pre-existing plugin');
    assert.equal(fs.existsSync(join(f.paths.state, 'previous-plugin')), false);
    recoverInstallation(f.app, f.home);
    assert.equal(fs.existsSync(join(f.paths.state, 'previous-plugin/prior.txt')), true);
    assert.equal(fs.existsSync(f.paths.manifest), true);
    installTransaction(f.app, f.home, source, { uninstall: true });
    assert.equal(fs.readFileSync(join(f.paths.target, 'AGENT.md'), 'utf8'), 'synthetic user prompt');
    assert.equal(fs.readFileSync(join(f.paths.target, 'prior.txt'), 'utf8'), 'pre-existing plugin');
    assert.equal(fs.existsSync(f.paths.manifest), false);
  } finally { f.close(); }
});
for (const phase of ['prepared', ...Array.from({length: 7}, (_, index) => 'committed-' + index)]) test(`fault at ${phase} restores all host, plugin, config and credentials`, () => {
  const f = fixture(); try {
    assert.throws(() => installTransaction(f.app, f.home, source, { checkpoint: name => { if (name === phase) throw Error('injected failure'); } }), /injected failure/);
    f.assertRestored();
    assert.equal(fs.existsSync(f.paths.target), false);
    assert.equal(fs.existsSync(f.paths.manifest), false);
    assert.equal(fs.existsSync(join(f.paths.root, 'pending.json')), false);
  } finally { f.close(); }
});
test('abrupt process exit retains durable transaction; next process recovers then retries', () => {
  const f = fixture(); try {
    const code = `import {installTransaction} from ${JSON.stringify(new URL('../plugins/dsh-session-editor/lib/installation.js', import.meta.url).href)}; installTransaction(process.argv[1],process.argv[2],process.argv[3],{checkpoint:stage=>{if(stage==='committed-4')process.exit(73)}});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.app, f.home, source], { encoding: 'utf8' });
    assert.equal(child.status, 73, child.stderr);
    assert.throws(() => preflight(f.app, f.home), /未完成/);
    assert.equal(recoverInstallation(f.app, f.home).recovered, true); f.assertRestored();
    installTransaction(f.app, f.home, source); installTransaction(f.app, f.home, source, { uninstall: true });
    f.assertRestored();
  } finally { f.close(); }
});
test('health failure rolls back; completion verifies bytes and preserves custom prompt on reinstall', () => {
  const f = fixture(); try {
    installTransaction(f.app, f.home, source, { deferHealth: true });
    assert.throws(() => preflight(f.app, f.home), /未完成/);
    recoverInstallation(f.app, f.home); f.assertRestored();
    installTransaction(f.app, f.home, source);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(f.paths.target,'host.json'),'utf8')), {app:f.app,home:f.home});
    const prompt = join(f.paths.target, 'AGENT.md'); fs.writeFileSync(prompt, 'synthetic custom prompt');
    installTransaction(f.app, f.home, source); assert.equal(fs.readFileSync(prompt, 'utf8'), 'synthetic custom prompt');
    installTransaction(f.app, f.home, source, { uninstall: true }); f.assertRestored();
    assert.equal(fs.existsSync(f.paths.target), false);
  } finally { f.close(); }
});
test('rollback refuses third-party changes and retains the recovery journal', () => {
  const f = fixture(); try {
    installTransaction(f.app, f.home, source, { deferHealth: true });
    const file = join(f.app, hostFiles[0]); fs.appendFileSync(file, '\n// third-party change\n');
    const changed = fs.readFileSync(file);
    assert.throws(() => recoverInstallation(f.app, f.home), /其他修改/);
    assert.deepEqual(fs.readFileSync(file), changed);
    assert.ok(fs.existsSync(join(f.paths.root, 'pending.json')));
  } finally { f.close(); }
});

test('one shared host cannot be rebound to another home while installed', () => {
  const f = fixture(); try {
    installTransaction(f.app, f.home, source);
    const otherHome = join(f.root, 'other-home');
    assert.throws(() => preflight(f.app, otherHome), /其他数据目录/);
    assert.throws(() => installTransaction(f.app, f.home, f.paths.target), /覆盖自身/);
    assert.equal(fs.existsSync(otherHome), false);
    installTransaction(f.app, f.home, source, { uninstall: true });
    f.assertRestored();
    preflight(f.app, otherHome);
  } finally { f.close(); }
});

test('a second process cannot modify a shared host during preparation', () => {
  const f = fixture(); try {
    let checked = false;
    installTransaction(f.app, f.home, source, { checkpoint: phase => {
      if (phase !== 'prepared') return;
      const code = `import {installTransaction} from ${JSON.stringify(new URL('../plugins/dsh-session-editor/lib/installation.js', import.meta.url).href)}; installTransaction(process.argv[1],process.argv[2],process.argv[3]);`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.app, join(f.root, 'other-home'), source], { encoding: 'utf8' });
      assert.equal(child.status, 1); assert.match(child.stderr, /事务锁/); checked = true;
    } });
    assert.equal(checked, true);
    installTransaction(f.app, f.home, source, { uninstall: true }); f.assertRestored();
  } finally { f.close(); }
});

test('corrupt host backup refuses uninstall before changing current files', () => {
  const f = fixture(); try {
    installTransaction(f.app, f.home, source);
    const adapter = join(f.app, '.session-editor-adapter');
    const manifest = JSON.parse(fs.readFileSync(join(adapter, 'manifest.json')));
    const current = fs.readFileSync(join(f.app, hostFiles[0]));
    fs.appendFileSync(join(adapter, manifest[0].original), 'corrupt backup');
    assert.throws(() => preflight(f.app, f.home, true), /备份校验失败/);
    assert.deepEqual(fs.readFileSync(join(f.app, hostFiles[0])), current);
    assert.equal(fs.existsSync(join(f.paths.root, 'pending.json')), false);
  } finally { f.close(); }
});
