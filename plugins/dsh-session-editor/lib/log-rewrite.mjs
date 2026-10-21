#!/usr/bin/env node
// Offline diagnostics only. Mutations belong to the Web editor, which releases
// the live session and holds the native persistence write lease. The former
// greedy repair could drop events and bypass native validation.
import { statSync } from 'node:fs';
import { loadSession } from './shadowing.js';

const [, , command, directory] = process.argv;
try {
  if (command !== 'inspect' || !directory) {
    throw new Error('此工具仅支持 inspect <sessionDir>；编辑、恢复和修复请使用 DSH 网页编辑器，避免绕过会话写锁。');
  }
  const { events, trace, file } = loadSession(directory);
  console.log(`事件总数: ${events.length}；有效消息: ${trace.nodes.length}；文件大小: ${statSync(file).size} bytes`);
  for (const event of events) {
    const operation = event.surfaceOp ? ` op=${JSON.stringify(event.surfaceOp)}` : '';
    console.log(`${event.seq ?? 'header'} ${event.type}${operation}`);
  }
} catch (error) {
  console.error(`[log-rewrite] ${error.message}`);
  process.exitCode = 1;
}
