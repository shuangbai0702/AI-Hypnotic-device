// lib/shadowing.js — Surface 遮蔽关系追踪（审计 B 项核心）
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isCompactionCheckpoint } from './coverage.js';
//
// 能力：
//   1. 从日志重建完整替换链：每个 replace 事件记录 {startSeq,endSeq → newSeq}
//   2. 对任意历史 seq：判定 当前可见 / 遮蔽 / 投影改写可见
//   3. 对遮蔽 seq：沿替换链迭代定位"最终有效节点"，多候选时如实列出
//   4. 重建"原始历史 → 第N次摘要 → 当前" 的层叠路径
//
// 关键认知（与用户对齐的语义）：
//   replace 事件 A（startSeq..endSeq → newSeq）表示：surface 上那一段被 newSeq 的消息替代。
//   语义归属：被遮蔽区间里**语义等价**的接续者是 newSeq 这条消息（例如压缩摘要接续被压缩的旧历史）。
//   但若区间含多条消息（如 8..36 含 8 条），则"哪一句对应摘要哪一句"无法精确证明——
//   此时必须如实返回整个区间 + 单一接续者，并标注不确定性。

import { zstdCompressSync } from 'node:zlib';
import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, openSync, fsyncSync, closeSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeLogBuf, parseRows, assertSequence } from './log-codec.js';
export { decodeLogBuf, parseRows } from './log-codec.js';

const SURFACE_TYPES = new Set(["system/message", "developer/message", "user/message", "assistant/message", "tool/result"]);

/** 重建 surface（与 dsh-session fold 一致的精简版）+ 替换链 */
export function buildTrace(events) {
  const hasHeader = events[0]?.type === 'session';
  const nodes = [];                       // 当前可见 seq（模型可见顺序）
  const replacements = [];                // [{replaceSeq, startSeq, endSeq, shadowed:[...], newSeq}]
  const projected = new Map();            // seq → 改写说明（本会话未用投影事件，但结构保留）
  let replaceGeneration = 0;

  for (const e of events) {
    const op = e.surfaceOp;
    if (!SURFACE_TYPES.has(e.type)) continue;
    if (op === undefined || op === 'append') {
      nodes.push(e.seq);
    } else if (op && op.op === 'replace') {
      const sIdx = nodes.indexOf(op.startSeq);
      const eIdx = nodes.indexOf(op.endSeq);
      if (sIdx < 0 || eIdx < 0 || sIdx > eIdx) continue; // 非法 replace 跳过（v4 已挡）
      const shadowed = nodes.slice(sIdx, eIdx + 1);
      nodes.splice(sIdx, eIdx - sIdx + 1, e.seq);
      replacements.push({
        replaceSeq: e.seq,
        startSeq: op.startSeq,
        endSeq: op.endSeq,
        shadowed,
        newSeq: e.seq,
        isCheckpoint: isCompactionCheckpoint(e),
      });
      replaceGeneration += 1;
    }
  }
  return { hasHeader, nodes, replacements, projected, replaceGeneration, events };
}

/**
 * 查询一条历史 seq 的当前状态与最终有效节点。
 * @returns {{
 *   seq, visible: boolean, projected: boolean,
 *   finalNodes: number[],            // 最终有效节点（沿替换链迭代收敛；多候选如实列出）
 *   chain: [{replaceSeq, startSeq, endSeq, newSeq, isCheckpoint, note}],
 *   ambiguous: boolean,              // 区间含多条消息时语义对应不确定
 * }}
 */
export function locate(trace, seq) {
  const visible = trace.nodes.includes(seq);
  const projected = trace.projected.has(seq);
  const chain = [];
  let current = [seq];
  let ambiguous = false;
  const visited = new Set();

  for (;;) {
    // 找作用于 current 中任一节点的最早 replace
    let hit = null;
    for (const r of trace.replacements) {
      if (visited.has(r.replaceSeq)) continue;
      const overlap = current.filter((s) => r.shadowed.includes(s));
      if (overlap.length > 0) { hit = { r, overlap }; break; }
    }
    if (!hit) break;
    const { r, overlap } = hit;
    visited.add(r.replaceSeq);
    const note = r.shadowed.length > 1
      ? `该 replace 遮蔽了 ${r.shadowed.length} 条消息（${r.startSeq}..${r.endSeq}），${overlap.length} 条在查询链上；摘要与原句非一一对应`
      : '';
    if (r.shadowed.length > 1) ambiguous = true;
    chain.push({
      replaceSeq: r.replaceSeq,
      startSeq: r.startSeq,
      endSeq: r.endSeq,
      newSeq: r.newSeq,
      isCheckpoint: r.isCheckpoint,
      shadowedCount: r.shadowed.length,
      note,
    });
    current = [r.newSeq];
    if (current[0] === seq) break; // 防自环
  }

  // 收敛后：current 若仍可见即为最终节点；若它又被后续 replace 替换则继续（循环已处理）
  const finalNodes = chain.length ? current : (visible ? [seq] : []);
  return { seq, visible, projected, finalNodes, chain, ambiguous };
}

/** 会话级统计：可见/遮蔽分类，供 UI 分组 */
export function classifyAll(trace) {
  const visibleSet = new Set(trace.nodes);
  const shadowed = [];
  for (const e of trace.events) {
    if (!SURFACE_TYPES.has(e.type)) continue;
    const s = e.seq;
    if (visibleSet.has(s)) continue;
    const loc = locate(trace, s);
    shadowed.push({ seq: s, type: e.type, ...loc });
  }
  return { visible: [...visibleSet], shadowed };
}

/** 从会话目录读日志并解析（绕开 persistence，纯文件） */
export function loadSession(dir) {
  const file = join(dir, 'session.v4.jsonl.zstd');
  const events = parseRows(decodeLogBuf(readFileSync(file)));
  assertSequence(events);
  const trace = buildTrace(events);
  return { events, trace, file };
}

// 适配别名（edit.js 使用）
export { buildTrace as sessionShadowing, locate as locateSeq };

// ---------- 校验 + 原子写回 ----------
const HERE2 = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR2 = join(HERE2, "..", "..", "..", "backups", "physical-sync");

export function writeValidatedEvents(sessionDir, events) {
  assertSequence(events);
  const out = Buffer.concat(events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8'))));
  const file = join(sessionDir, 'session.v4.jsonl.zstd');
  // Never replace a source that could only be partially read. Caller holds the
  // native write lease; check the complete source again before taking a backup.
  loadSession(sessionDir);
  const backupDir = process.env.DSH_HOME ? join(process.env.DSH_HOME, "backups", "physical-sync") : BACKUP_DIR2;
  mkdirSync(backupDir, { recursive: true });
  const nonce = randomUUID();
  copyFileSync(file, join(backupDir, `${basename(sessionDir)}-${Date.now()}-${nonce}.zstd`));
  const tmp = file + '.' + nonce + '.psync-tmp';
  try {
    writeFileSync(tmp, out, { flag: 'wx' });
    const fd = openSync(tmp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const round = parseRows(decodeLogBuf(readFileSync(tmp)));
    assertSequence(round);
    if (JSON.stringify(round) !== JSON.stringify(events)) throw new Error('完整读回不一致，拒绝替换');
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
