#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflight, installTransaction, recoverInstallation } from './lib/installation.js';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
try {
  if (!option('--app') || !option('--home')) throw new Error('用法: install.mjs --app <DSH程序目录> --home <DSH_HOME> [--check|--uninstall|--recover|--complete]');
  const app = resolve(option('--app')), home = resolve(option('--home'));
  if (args.includes('--recover') || args.includes('--complete')) {
    console.log(JSON.stringify(recoverInstallation(app, home, args.includes('--complete'))));
  } else if (args.includes('--check')) {
    preflight(app, home, args.includes('--uninstall'));
    console.log('预检通过；未修改文件。');
  } else {
    const source = dirname(fileURLToPath(import.meta.url));
    const result = installTransaction(app, home, source, { uninstall: args.includes('--uninstall'), deferHealth: args.includes('--defer-health') });
    console.log(result.awaitingHealth ? '文件已提交，等待服务与插件健康确认；失败请停止目标服务后运行 --recover。' : '文件事务已完成；尚未验证服务启动。请启动原 DSH 并检查编辑器。');
  }
} catch (error) {
  console.error(error.message);
  if (error instanceof AggregateError) for (const cause of error.errors) console.error(cause.message);
  process.exitCode = 1;
}
