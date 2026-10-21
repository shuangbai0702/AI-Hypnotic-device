#!/usr/bin/env node
// log-rewrite.mjs — shuangbai 物理日志重写器（M4 核心）
// 用法:
//   node log-rewrite.mjs inspect <sessionDir>              检查日志（seq/类型/surfaceOp/配对/turn）
//   node log-rewrite.mjs delete <sessionDir> <seq...>      物理删除事件并重编号（校验不过则拒绝）
//   node log-rewrite.mjs edit <sessionDir> <seq> <jsonFile> 物理改写事件 data（保留 type/time/surfaceOp）
//   node log-rewrite.mjs repair <sessionDir>               自动修复常见损坏（删除无法通过准入的事件）
//   node log-rewrite.mjs restore <sessionDir>              从最近备份还原
//
// 安全机制：改写前自动备份到 backups/logrewrite/<sessionId>-<ts>.jsonl.zstd；
// 临时文件写入 → 全量校验（v4 准入规则）→ 原子替换；任何一步失败保留原文件。
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as nodeCrypto from 'node:crypto';
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = resolve(HERE, '../backups/logrewrite');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 多帧 zstd 解码 */
function decode(buf) {
  if (!buf.subarray(0, 4).equals(MAGIC)) return buf.toString('utf8');
  let off = 0, text = '';
  for (;;) {
    const i = buf.indexOf(MAGIC, off);
    if (i < 0) break;
    try { text += zstdDecompressSync(buf.subarray(i)).toString('utf8'); } catch { /* torn tail */ }
    off = i + 4;
  }
  return text;
}
function parse(text) {
  return text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
/** 一行一帧重编码 */
function encode(events) {
  return Buffer.concat(events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8'))));
}

const surfaceTypes = new Set(["system/message", "developer/message", "user/message", "assistant/message", "tool/result"]);

/** 结构校验：seq 连续 + tool 配对 + turn/step 开合 + v4 正整数约束 */
function validate(events) {
  const problems = [];
  let openTool = null;               // 待配对的 tool/call id
  let turn = 0, step = 0, turnOpen = false;
  const hasHeader = events[0] && events[0].type === 'session';
  for (const [i0, e] of events.entries()) {
    const i = hasHeader ? i0 - 1 : i0;
    if (e.type === 'session') continue;
    if (e.seq !== i) problems.push(`seq 断裂: 位置 ${i} 的 seq=${e.seq}`);
    if (e.type === 'tool/call') { if (openTool) problems.push(`seq ${e.seq}: 上一个 tool/call(${openTool}) 未配对`); openTool = e.data?.id ?? e.data?.call?.id ?? '?'; }
    if (e.type === 'tool/result') { if (!openTool) problems.push(`seq ${e.seq}: tool/result 无配对 call`); openTool = null; }
    if (e.type === 'turn/start') { if (turnOpen) problems.push(`seq ${e.seq}: turn 未闭合又开启`); turn = e.data?.turn ?? turn + 1; step = 0; turnOpen = true; }
    if (e.type === 'step/start') { if (!turnOpen) problems.push(`seq ${e.seq}: step/start 无打开 turn`); step = e.data?.step ?? step + 1; }
    if (e.type === 'turn/end') turnOpen = false;
    for (const t of ['system/message', 'developer/message', 'assistant/message']) {
      if (e.type === t) {
        const d = e.data ?? {};
        if (!Number.isInteger(d.turn) || d.turn < 1) problems.push(`seq ${e.seq}: ${t} turn 非法(${d.turn})`);
        if (!Number.isInteger(d.step) || d.step < 1) problems.push(`seq ${e.seq}: ${t} step 非法(${d.step})`);
      }
    }
  }
  if (openTool) problems.push(`结尾存在未配对 tool/call(${openTool})`);
  return problems;
}

function sessionDirFiles(dir) {
  const f = join(dir, 'session.v4.jsonl.zstd');
  if (!existsSync(f)) throw new Error(`日志不存在: ${f}`);
  return f;
}

function backup(file, dir) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = join(BACKUP_DIR, `${basename(dir)}-${ts}.zstd`);
  copyFileSync(file, dst);
  return dst;
}

function writeValidated(file, events) {
  const problems = validate(events);
  if (problems.length) throw new Error(`校验未通过，拒绝写入:\n  ${problems.slice(0, 10).join('\n  ')}`);
  const tmp = `${file}.rewrite-tmp`;
  writeFileSync(tmp, encode(events));
  // 读回验证
  const round = parse(decode(readFileSync(tmp)));
  if (round.length !== events.length) throw new Error('读回验证失败：行数不一致');
  const st = statSync(tmp);
  if (st.size === 0) throw new Error('空文件拒绝替换');
  renameSync(tmp, file);
  return { sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
}

function cmdInspect(dir) {
  const file = sessionDirFiles(dir);
  const events = parse(decode(readFileSync(file)));
  console.log(`事件总数: ${events.length}  文件: ${(statSync(file).size / 1024).toFixed(0)}KB`);
  const problems = validate(events);
  console.log(problems.length ? `校验问题 ${problems.length}:\n  ${problems.slice(0, 15).join('\n  ')}` : '结构校验: 通过');
  for (const e of events) {
    const mark = surfaceTypes.has(e.type) ? '*' : ' ';
    const op = e.surfaceOp ? ` op=${JSON.stringify(e.surfaceOp)}` : '';
    const d = JSON.stringify(e.data ?? {}).slice(0, 60);
    console.log(`${mark} ${String(e.seq).padStart(4)} ${e.type.padEnd(26)}${op} ${d}`);
  }
}

function renumber(events) {
  const hasHeader = events[0] && events[0].type === 'session';
  return events.map((e, i) => {
    if (hasHeader && i === 0) return e;           // 头事件无 seq
    const seq = hasHeader ? i - 1 : i;
    return e.seq === seq ? e : { ...e, seq };
  });
}

function cmdDelete(dir, seqs) {
  const file = sessionDirFiles(dir);
  const events = parse(decode(readFileSync(file)));
  const drop = new Set(seqs.map(Number));
  // 拒绝删除高危事件：tool/call、tool/result、compaction/*
  for (const s of drop) {
    const e = events[s];
    if (!e) throw new Error(`seq ${s} 不存在`);
    if (['tool/call', 'tool/result', 'compaction/start', 'compaction/end', 'compaction/summary', 'compaction/prune', 'session'].includes(e.type)) {
      throw new Error(`拒绝删除 seq ${s}（${e.type}）：引用关系敏感，请手工评估`);
    }
  }
  const kept = renumber(events.filter((e) => !drop.has(e.seq)));
  const bak = backup(file, dir);
  const { sha256 } = writeValidated(file, kept);
  console.log(`已物理删除 ${drop.size} 条事件；备份: ${bak}\n新文件 sha256=${sha256.slice(0, 16)}… 事件数 ${kept.length}`);
}

function cmdEdit(dir, seq, jsonFile) {
  const file = sessionDirFiles(dir);
  const events = parse(decode(readFileSync(file)));
  const idx = events.findIndex((e) => e.seq === Number(seq));
  if (idx === -1) throw new Error(`seq ${seq} 不存在`);
  const e = events[idx];
  const patch = JSON.parse(readFileSync(resolve(process.cwd(), jsonFile), 'utf8'));
  events[idx] = { ...e, data: { ...e.data, ...patch } };
  const bak = backup(file, dir);
  const { sha256 } = writeValidated(file, events);
  console.log(`已物理改写 seq ${idx}；备份: ${bak}\nsha256=${sha256.slice(0, 16)}…`);
}

function cmdRepair(dir) {
  const file = sessionDirFiles(dir);
  const events = parse(decode(readFileSync(file)));
  // 策略：逐个剔除导致校验失败的事件（简单贪婪法），优先保留前面的事件
  let working = [...events];
  let removed = [];
  for (let guard = 0; guard < 50; guard++) {
    const problems = validate(working);
    if (!problems.length) break;
    if (problems[0].startsWith('seq 断裂')) { working = renumber(working); continue; }
    const m = problems[0].match(/seq (\d+)/);
    if (!m) throw new Error(`无法定位问题事件: ${problems[0]}`);
    const bad = Number(m[1]);
    const idx = working.findIndex((e) => e.seq === bad);
    if (idx === -1) throw new Error(`定位失败: ${problems[0]}`);
    // assistant/message turn/step 非法 → 就近补齐（取最近一次 turn/start 的 turn，step 取其后最大 step+1）
    if (/turn 非法|step 非法/.test(problems[0])) {
      let t = 1, s = 1;
      for (let k = idx; k >= 0; k--) {
        if (working[k].type === 'turn/start') { t = working[k].data?.turn ?? 1; break; }
      }
      for (let k = 0; k < idx; k++) if (working[k].type === 'step/start' && (working[k].data?.turn ?? t) === t) s = Math.max(s, (working[k].data?.step ?? 1) + 1);
      working[idx] = { ...working[idx], data: { ...working[idx].data, turn: t, step: s } };
      continue;
    }
    removed.push(working[idx].seq + ':' + working[idx].type);
    working.splice(idx, 1);
    working = renumber(working);
  }
  if (!removed.length) { console.log('无需修复'); return; }
  const bak = backup(file, dir);
  writeValidated(file, working);
  console.log(`已移除 ${removed.length} 条事件: ${removed.join(', ')}\n备份: ${bak}`);
}

function cmdInsert(dir, jsonFile) {
  // 物理插入一条合法 user 消息到日志末尾（turn 边界安全：纯 append，不动既有结构）
  const file = sessionDirFiles(dir);
  const events = parse(decode(readFileSync(file)));
  const payload = JSON.parse(readFileSync(resolve(process.cwd(), jsonFile), 'utf8'));
  const text = typeof payload === "string" ? payload : payload.text;
  if (typeof text !== "string" || !text) throw new Error("需要 {text}");

  const lastTurn = [...events].reverse().find((e) => e.type === "turn/start");
  const closed = [...events].reverse().find((e) => e.type === "turn/end" || e.type === "session/end-seed");
  const turnOpen = lastTurn !== undefined && (closed === undefined || closed.seq < lastTurn.seq);
  const stamp = Date.now();
  const add = [];
  if (turnOpen) {
    add.push({ type: "user/message", time: stamp, data: { content: [{ type: "text", text }], source: { kind: "session-editor" }, role: "user", id: nodeCrypto.randomBytes(16).toString("hex") }, surfaceOp: "append" });
  } else {
    const nextTurn = (lastTurn?.data?.turn ?? 0) + 1;
    add.push({ type: "turn/start", time: stamp, data: { turn: nextTurn } });
    add.push({ type: "step/start", time: stamp, data: { turn: nextTurn, step: 1 } });
    add.push({ type: "user/message", time: stamp, data: { content: [{ type: "text", text }], source: { kind: "session-editor" }, role: "user", id: nodeCrypto.randomBytes(16).toString("hex") }, surfaceOp: "append" });
    add.push({ type: "step/end", time: stamp, data: { turn: nextTurn, step: 1 } });
    add.push({ type: "turn/end", time: stamp, data: { turn: nextTurn } });
  }
  const bak = backup(file, dir);
  const built = renumber([...events, ...add]);
  const { sha256 } = writeValidated(file, built);
  console.log(`已物理插入 ${add.length} 条事件（text: ${text.slice(0, 40)}）；备份: ${bak}\nsha256=${sha256.slice(0, 16)}…`);
}

function cmdRestore(dir) {
  const file = sessionDirFiles(dir);
  const candidates = existsSync(BACKUP_DIR)
    ? readdirSync(BACKUP_DIR).filter((f) => f.startsWith(basename(dir)) && f.endsWith('.zstd')).sort()
    : [];
  if (!candidates.length) throw new Error('没有备份');
  const latest = join(BACKUP_DIR, candidates.at(-1));
  const events = parse(decode(readFileSync(latest)));
  const problems = validate(events);
  if (problems.length) throw new Error(`备份自身校验失败，拒绝还原:\n  ${problems.slice(0, 5).join('\n  ')}`);
  writeValidated(file, events);
  console.log(`已从 ${candidates.at(-1)} 还原（${events.length} 事件）`);
}

const [, , cmd, dir, ...rest] = process.argv;
try {
  if (cmd === 'inspect') cmdInspect(dir);
  else if (cmd === 'delete') cmdDelete(dir, rest);
  else if (cmd === 'edit') cmdEdit(dir, rest[0], rest[1]);
  else if (cmd === 'repair') cmdRepair(dir);
  else if (cmd === 'insert') cmdInsert(dir, rest[0]);
  else if (cmd === 'restore') cmdRestore(dir);
  else console.log('用法: node log-rewrite.mjs inspect|delete|edit|insert|repair|restore <sessionDir> …');
} catch (e) {
  console.error(`[log-rewrite] ${e.message}`);
  process.exit(1);
}
