// Start only the selected Desktop Host, on its native loopback port 0. It is
// always stopped before returning; no desktop protocol registration occurs.
import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import fs from 'node:fs';
import { once } from 'node:events';
const [appArg, homeArg, mode] = process.argv.slice(2);
let child, exited, closed, failed = false, output = '';
try {
  if (!appArg || !homeArg || !['installed', 'uninstalled'].includes(mode)) throw Error('桌面健康检查参数无效');
  const app = resolve(appArg), home = resolve(homeArg), runtime = join(app, 'resources/app.asar/dsh'), profile = join(home, 'profiles/desktop');
  child = fork(join(runtime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'), [runtime, profile, join(app, 'resources/runtime/primary-runtime')], {
    execPath: join(app, 'DeepSeek Harness.exe'), execArgv: ['--expose-internals'], cwd: profile,
    env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  exited = once(child, 'exit');
  closed = once(child, 'close').catch(() => {});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes.toString()).slice(-65536); });
  const ready = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(Error('桌面 Host 启动超时')), 45000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(Error('桌面 Host 提前退出')); });
    child.on('message', message => {
      if (message?.type === 'ready') { clearTimeout(timer); done(message); }
      if (message?.type === 'fatal') { output = (output + '\n' + String(message.diagnostic ?? message.message)).slice(-65536); clearTimeout(timer); reject(Error('桌面 Host 报告启动失败')); }
    });
  });
  const url = new URL(ready.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw Error('桌面 Host 返回非本地地址');
  const auth = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const cookie = auth.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw Error('桌面 Host 登录验证失败');
  const page = await fetch(url.origin, { headers: { cookie }, signal: AbortSignal.timeout(10000) });
  if (!page.ok) throw Error('桌面网页未就绪');
  const response = await fetch(url.origin + '/api/session-editor/status', { headers: { cookie }, signal: AbortSignal.timeout(10000) });
  if (mode === 'installed') {
    const status = await response.json();
    if (!response.ok || !status.ok || ['connection', 'sessions', 'sessionPersistence', 'sessionQuery'].some(key => status.services?.[key] !== 'ok')) throw Error('桌面插件依赖未就绪');
  } else if (response.status !== 404) throw Error('桌面卸载后插件接口仍存在');
  console.log(JSON.stringify({ ok: true, healthScope: 'desktop-host', windowVerified: false, port: Number(url.port) }));
} catch (error) {
  failed = true;
  console.error(error.message); process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    if (child.connected) child.send({ type: 'shutdown' }, () => {});
    let timer;
    await Promise.race([exited.catch(() => {}), new Promise(done => { timer = setTimeout(done, 10000); })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited.catch(() => {}); }
  }
  if (closed) await closed;
  // Flush after child exit/pipe close, including diagnostics delivered over IPC.
  if (failed && homeArg) {
    const logs = join(resolve(homeArg), 'logs/session-editor-installer'); fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(join(logs, 'desktop-host-health.log'), output || 'Desktop Host failed before emitting diagnostics.');
  }
}
