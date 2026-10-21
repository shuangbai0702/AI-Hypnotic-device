// lib/index.js — shuangbai session-editor: host half
// cordis 插件：通过 connection.fetch 暴露只读观测 API（M2），编辑 API（M3+）。
//
// 依赖服务（inject）：
//   connection         — HTTP 路由注册（dsh-client-connection）
//   sessions           — 活动会话存储（可选）
//   sessionPersistence — 冷会话读取（append-only 日志句柄）
//   sessionQuery       — 检索（M2 暂不强制）

import { registerEditRoutes } from "./edit.js";
import { importHost } from "./host-import.js";
import { contentRevision, summaryBody } from "./physical-edit.js";
import { contextCoverage, isCompactionCheckpoint } from "./coverage.js";
import { registerMemoryAssistant } from "./memory-assistant.js";
import { registerWorkbench, compressionRanges } from "./workbench.js";

export const name = "session-editor";

export const inject = ["connection", "sessions", "sessionPersistence", "agents", "tools", "systemPrompt", "agentDefaultModel", "tokenMeter"];

const PKG = { name: "@shuangbai/dsh-session-editor", version: "0.3.0" };

/** JSON 响应 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function err(message, status = 400, extra = {}) {
  return json({ error: message, ...extra }, status);
}

/** 文本长度 → 粗略 token 估算（中文≈1/字，英文≈1/4 词符） */
function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.0 + rest * 0.3);
}

/** 把 Message 的 content blocks 压成展示文本 */
function textOfMessage(message) {
  if (!message) return "";
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .map((b) => {
      if (!b) return "";
      if (b.type === "text") return b.text ?? "";
      if (b.type === "reasoning") return `[reasoning] ${b.text ?? ""}`;
      if (b.type === "thinking") return `[thinking] ${b.thinking ?? ""}`;
      if (b.type === "tool-call") return `[tool-call] ${b.name}(${typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {})})`;
      if (b.type === "image") return "[image]";
      if (b.type === "file") return "[file]";
      return `[${b.type ?? "block"}]`;
    })
    .join("\n");
}


async function readAllEvents(sessionPersistence, sessionId) {
  const handle = await sessionPersistence.open(sessionId, "read");
  try {
    const out = [];
    const CHUNK = 500;
    for (;;) {
      const slice = await handle.read(out.length, CHUNK);
      out.push(...slice.events);
      if (slice.events.length < CHUNK) break;
      if (out.length > 200000) break; // 防御性上限
    }
    return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: out };
  } finally {
    await handle.close();
  }
}

export function apply(ctx, config = {}) {
  const handlers = new Map();
  const route = (path, methods, handler) => {
    for (const method of methods) handlers.set(`${method} ${path}`, handler);
    return ctx.connection.fetch.register({ path, methods, requestBody: "buffered", fetch: handler });
  };
  const dispatch = (request) => {
    const handler = handlers.get(`${request.method} ${new URL(request.url).pathname}`);
    return handler ? handler(request) : err("route not found", 404);
  };

  // ---------- status ----------
  route("/api/session-editor/status", ["GET", "HEAD"], async () => {
    const services = {};
    for (const key of ["connection", "sessions", "sessionPersistence", "sessionQuery"]) {
      try { services[key] = ctx.get(key) !== undefined ? "ok" : "absent"; } catch { services[key] = "absent"; }
    }
    return json({
      ok: true,
      plugin: PKG,
      services,
      startedAt: new Date().toISOString(),
    });
  });

  // ---------- sessions 列表 ----------
  route("/api/session-editor/sessions", ["GET"], async () => {
    try {
      const snaps = await ctx.sessionPersistence.list();
      return json({
        ok: true,
        sessions: snaps.map((s) => ({
          id: s.header.id,
          cwd: s.header.cwd,
          createdAt: s.header.createdAt,
          isSeeded: s.header.isSeeded ?? false,
          eventCount: s.eventCount ?? undefined,
          sizeBytes: s.sizeBytes ?? undefined,
        })),
      });
    } catch (e) {
      return err(`list failed: ${e?.message ?? e}`, 500);
    }
  });

  // ---------- 原始事件 ----------
  route("/api/session-editor/events", ["GET"], async (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return err("missing id");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 5000), 50000);
    try {
      const { header, inheritedEventCount, events } = await readAllEvents(ctx.sessionPersistence, id);
      const slim = events.slice(0, limit).map((e) => ({
        seq: e.seq,
        type: e.type,
        time: e.time,
        surfaceOp: e.surfaceOp ?? undefined,
        summary:
          e.type === "user/message" || e.type === "assistant/message" || e.type === "system/message"
            ? textOfMessage(e.type === "user/message" ? e.data : e.data?.message).slice(0, 240)
            : undefined,
      }));
      return json({ ok: true, header: { id: header.id, cwd: header.cwd, createdAt: header.createdAt }, inheritedEventCount, total: events.length, events: slim });
    } catch (e) {
      return err(`read failed: ${e?.message ?? e}`, 500);
    }
  });

  // ---------- surface / context / summary：离线复算 ----------
  const computeSurface = async (sessionId) => {
    const { foldSurface, deriveEventMessage } = await importHost("@deepseek-ai/dsh-session");
    const { header, inheritedEventCount, events } = await readAllEvents(ctx.sessionPersistence, sessionId);
    const fold = foldSurface(events);
    // events[seq] 不能用数组下标（row0 是无 seq 的 session 头）→ 按 seq 建映射
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    return { fold, events, bySeq, header, inheritedEventCount, deriveEventMessage };
  };

  route("/api/session-editor/coverage", ["GET"], async (request) => {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return err("missing id");
    try {
      const { events, fold, deriveEventMessage } = await computeSurface(id);
      return json({ ok: true, ...contextCoverage(events, fold, deriveEventMessage) });
    } catch (e) { return err(`coverage failed: ${e?.message ?? e}`, 500); }
  });

  // surface：节点顺序 + 生成计数
  route("/api/session-editor/surface", ["GET"], async (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return err("missing id");
    try {
      const { fold, events } = await computeSurface(id);
      return json({
        ok: true,
        contentRevision: contentRevision(events),
        replaceGeneration: fold.replacements.length,
        nodeCount: fold.nodes.length,
        eventCount: events.length,
        nodes: fold.nodes.map((seq) => ({ seq, type: events[seq]?.type })),
      });
    } catch (e) {
      return err(`surface failed: ${e?.message ?? e}`, 500);
    }
  });

  // context：模型将看到的派生消息（即 deriveMessages 的离线等价）
  route("/api/session-editor/context", ["GET"], async (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return err("missing id");
    try {
      const { fold, events, bySeq, deriveEventMessage } = await computeSurface(id);
      const coverage = contextCoverage(events, fold, deriveEventMessage);
      const coverageBySeq = new Map(coverage.items.map(({ text, preview, ...item }) => [item.seq, item]));
      const summariesBySeq = new Map(coverage.summaries.map((summary) => [summary.seq, summary]));
      const messages = [];
      let systemPromptChars = 0;
      for (const seq of fold.nodes) {
        const event = bySeq.get(seq) ?? events[seq];
        const message = fold.projectedMessages.get(seq) ?? deriveEventMessage(event);
        if (!message) continue;
        const text = textOfMessage(message);
        const checkpoint = isCompactionCheckpoint(event);
        if (message.role === "system") systemPromptChars += text.length;
        messages.push({
          index: messages.length,
          seq,
          role: message.role,
          type: event.type,
          time: event.time,
          source: event.data?.source?.kind ?? event.data?.message?.source?.kind ?? undefined,
          model: event.data?.message?.source?.model ?? undefined,
          checkpoint,
          editable: coverageBySeq.get(seq)?.editable ?? false,
          readOnly: coverageBySeq.get(seq)?.readOnly ?? true,
          editKind: coverageBySeq.get(seq)?.editKind,
          accessLabel: coverageBySeq.get(seq)?.accessLabel,
          coverage: summariesBySeq.get(seq),
          contextCoverage: coverageBySeq.get(seq),
          coverageState: coverageBySeq.get(seq)?.coverageState,
          thoughtState: coverageBySeq.get(seq)?.thoughtState,
          thoughtCount: coverageBySeq.get(seq)?.thoughtCount ?? 0,
          fullySummaryCovered: coverageBySeq.get(seq)?.fullySummaryCovered ?? false,
          chars: text.length,
          tokens: estimateTokens(text),
          text: text.slice(0, config.maxTextChars ?? 4000),
          blocks: message.content,
          editText: checkpoint ? summaryBody(text) : message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
        });
      }
      return json({
        ok: true,
        contentRevision: contentRevision(events),
        replaceGeneration: fold.replacements.length,
        nodeCount: fold.nodes.length,
        messageCount: messages.length,
        systemPromptChars,
        totalTokens: messages.reduce((a, m) => a + m.tokens, 0),
        compressionRanges: compressionRanges({ events, fold, bySeq }),
        messages,
      });
    } catch (e) {
      return err(`context failed: ${e?.message ?? e}`, 500);
    }
  });

  // summary：压缩摘要节点与其遮蔽区间
  route("/api/session-editor/summary", ["GET"], async (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return err("missing id");
    try {
      const { fold, events, bySeq, deriveEventMessage } = await computeSurface(id);
      const coverage = contextCoverage(events, fold, deriveEventMessage);
      const summaries = [];
      for (const seq of fold.nodes) {
        const event = bySeq.get(seq) ?? events[seq];
        if (!isCompactionCheckpoint(event)) continue;
        const message = deriveEventMessage(event);
        const text = textOfMessage(message);
        const covered = coverage.summaries.find(s => s.seq === seq);
        summaries.push({
          seq,
          time: event.time,
          chars: text.length,
          tokens: estimateTokens(text),
          coverage: covered,
          text: text.slice(0, config.maxTextChars ?? 20000),
          editText: summaryBody(text),
        });
      }
      return json({ ok: true, contentRevision: contentRevision(events), count: summaries.length, summaries });
    } catch (e) {
      return err(`summary failed: ${e?.message ?? e}`, 500);
    }
  });

  // history：与 events 相同但语义命名（供 UI 完整历史页）
  route("/api/session-editor/history", ["GET"], async (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return err("missing id");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 2000), 50000);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
    try {
      const { header, events } = await readAllEvents(ctx.sessionPersistence, id);
      const window = events.slice(offset, offset + limit).map((e) => ({
        seq: e.seq,
        type: e.type,
        time: e.time,
        surfaceOp: e.surfaceOp ?? undefined,
        raw: JSON.stringify(e).slice(0, config.maxRawChars ?? 8000),
      }));
      return json({ ok: true, total: events.length, offset, limit, events: window, header: { id: header.id, cwd: header.cwd } });
    } catch (e) {
      return err(`history failed: ${e?.message ?? e}`, 500);
    }
  });

  // ---------- M3+：编辑能力 ----------
  registerEditRoutes(ctx, route, computeSurface);
  registerWorkbench(ctx, route, computeSurface);
  registerMemoryAssistant(ctx, route, dispatch);
}
