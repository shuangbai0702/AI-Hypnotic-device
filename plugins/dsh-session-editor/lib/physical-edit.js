import { createHash } from "node:crypto";
import { importHost } from "./host-import.js";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadSession, writeValidatedEvents } from "./shadowing.js";
import { runtimePaths } from './runtime-paths.js';
import { isCompactionCheckpoint as checkpoint } from "./coverage.js";

export const contentRevision = (events) => createHash("sha256").update(JSON.stringify(events)).digest("hex");


export function summaryBody(text) {
  const open = text.indexOf("<compacted-summary>");
  const close = text.lastIndexOf("</compacted-summary>");
  return open >= 0 && close > open ? text.slice(open + 19, close).trim() : text;
}

// Keep the existing transaction identity and its command provenance intact.
// Editing a checkpoint is not a newly generated compaction.
export function rewriteSummary(events, seq, text) {
  const current = events.find((e) => e.seq === seq);
  if (current?.type !== "user/message" || !checkpoint(current)) throw new Error("目标不是压缩摘要");
  const id = current.data.source?.compactionId;
  const summary = events.find((e) => e.type === "compaction/summary" && e.data.compactionId === id);
  if (!summary) throw new Error("摘要缺少对应压缩记录，未修改日志");
  const body = summaryBody(text);
  const joined = current.data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const open = joined.indexOf("<compacted-summary>") + 19;
  const close = joined.lastIndexOf("</compacted-summary>");
  if (close < open) throw new Error("摘要标签不完整，未修改日志");
  current.data.content = [{ type: "text", text: joined.slice(0, open) },
    { type: "text", text: body }, { type: "text", text: joined.slice(close) }];
  summary.data.summary = [{ type: "text", text: body }];
  // rawOutput remains the original provider response for audit purposes.
  return { originSeq: seq, type: current.type };
}

// Keep native replay metadata only for unchanged blocks. The editor must not
// reuse a text signature for edited text or shift tool signatures by index.
export function setMessageBlocks(event, blocks) {
  if (event.type === "user/message") { event.data.content = blocks; return; }
  const message = event.data.message;
  const previous = message.content;
  const state = message.source?.replayState;
  if (state && JSON.stringify(previous) !== JSON.stringify(blocks)) {
    if (state.response?.kind === "pi-ai" && state.response.version === 2 &&
        Array.isArray(state.blocks) && state.blocks.length === previous.length &&
        state.blocks.every((b, i) => b.type === previous[i].type)) {
      const used = new Set();
      const metadata = blocks.map((b) => {
        const index = previous.findIndex((old, i) => !used.has(i) && JSON.stringify(old) === JSON.stringify(b));
        if (index < 0) {
          // These are wire field names, not cryptographic thought signatures.
          const marker = state.blocks.find((old) => old.type === b.type &&
            ["reasoning_content", "reasoning", "reasoning_text"].includes(old.thinkingSignature));
          return marker && b.type === "reasoning"
            ? { type: b.type, thinkingSignature: marker.thinkingSignature } : { type: b.type };
        }
        used.add(index);
        return state.blocks[index];
      });
      const { responseId, ...response } = state.response;
      message.source = { ...message.source, replayState: { ...state, response, blocks: metadata } };
    } else {
      // Unknown replay formats are adapter-owned: use DSH's neutral fallback.
      const { replayState, ...source } = message.source;
      message.source = source;
    }
  }
  message.content = blocks;
}

// Only one-to-one message replacements have an unambiguous original bubble.
export function rewriteMessage(events, seq, blocks) {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const current = bySeq.get(seq);
  if (!current || !["user/message", "assistant/message", "developer/message"].includes(current.type) || checkpoint(current)) {
    throw new Error("只能同步普通消息；压缩摘要请使用摘要编辑");
  }
  let origin = current;
  const seen = new Set();
  while (origin.surfaceOp?.op === "replace") {
    const op = origin.surfaceOp;
    if (seen.has(origin.seq) || op.startSeq !== op.endSeq) throw new Error("替换链不是一对一消息，拒绝改写原始历史");
    seen.add(origin.seq);
    const previous = bySeq.get(op.startSeq);
    if (!previous || previous.type !== current.type || checkpoint(previous)) throw new Error("替换链跨越摘要或消息类型，拒绝改写");
    origin = previous;
  }
  for (const e of new Set([current, origin])) setMessageBlocks(e, blocks);
  return { originSeq: origin.seq, type: current.type };
}

// Release the actual lifecycle owner first, then hold the official write lease
// throughout validation + atomic replacement. Never retain a stale live Session.
export async function physicalEdit(ctx, body, detachOwned) {
  const { id, seq, blocks, expectRevision, signal } = body;
  signal?.throwIfAborted();
  const agent = ctx.agents.get(id);
  if (agent?.status === "running") throw new Error("会话正在生成，请停止生成后再编辑");
  await detachOwned(ctx, id);
  if (ctx.sessions.get(id)) {
    if (typeof ctx.agents.releaseIdle !== "function") throw new Error("此会话由网页持有，当前宿主缺少安全释放接口；未修改历史");
    await ctx.agents.releaseIdle(id);
  }
  if (ctx.sessions.get(id)) throw new Error("会话仍被占用，未修改历史");
  const writer = await ctx.sessionPersistence.open(id, "write");
  try {
    signal?.throwIfAborted();
    const paths = runtimePaths(ctx);
    const root = paths.sessions;
    const dir = readdirSync(root).map((d) => join(root, d, id))
      .find((d) => existsSync(join(d, "session.v4.jsonl.zstd")));
    if (!dir) throw new Error("未找到会话日志");
    const { events, trace } = loadSession(dir);
    const rows = events[0]?.type === "session" ? events.slice(1) : events;
    if (expectRevision && contentRevision(rows) !== expectRevision) throw new Error("版本冲突：请刷新编辑器后重试");
    if (!trace.nodes.includes(seq)) throw new Error(`seq ${seq} 已被替换，请刷新后编辑有效节点`);
    let toolEdit;
    if (Array.isArray(body.toolBlocks)) {
      const target = rows.find(e => e.seq === seq);
      if (target?.type !== "tool/result") throw new Error("目标不是工具结果");
      // Native tool replacements require an open turn. Under the write lease,
      // rewrite only content, keeping every lifecycle and call identity intact.
      target.data.message.content = body.toolBlocks;
      toolEdit = { originSeq: seq, type: target.type };
    }
    const edit = toolEdit ?? (typeof body.summaryText === "string"
      ? rewriteSummary(events, seq, body.summaryText) : rewriteMessage(events, seq, blocks));
    // The canonical Session constructor validates both v4 admission and surface.
    ctx.sessions.prepare(id, { seed: rows, meta: writer.header, inheritedEventCount: writer.inheritedEventCount });
    const { assertReleasedV4Relationships } = await importHost("@deepseek-ai/dsh-session-format-v3-to-v4");
    assertReleasedV4Relationships({ header: writer.header, events: rows, inheritedEventCount: writer.inheritedEventCount },
      new Set(rows.map((e) => e.type)));
    if (ctx.sessions.get(id)) throw new Error("会话被重新激活，未修改历史");
    signal?.throwIfAborted();
    const sha256 = writeValidatedEvents(dir, events, join(paths.home, 'backups', 'physical-sync'));
    return { ok: true, edit: { targetSeq: seq, newSeq: seq, type: edit.type },
      physicalSync: { ...edit, sha256 }, contentRevision: contentRevision(rows),
      note: "上下文与原始历史已同步，重新载入会话后显示" };
  } finally {
    await writer.close();
  }
}
