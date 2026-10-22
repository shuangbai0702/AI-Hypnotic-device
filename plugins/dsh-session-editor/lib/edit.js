// lib/edit.js — shuangbai session-editor: 编辑能力（M3+）
// 通过 surface 替换和独占持久化写租约编辑；驻留 agent 由原生命周期所有者释放。
import { createHash } from 'node:crypto';
import { physicalEdit, setMessageBlocks, contentRevision } from './physical-edit.js';
import { isCompactionCheckpoint } from './coverage.js';
import { importHost } from './host-import.js';
import { captureError } from './diagnostics.js';

/** JSON 响应工具（与 index.js 相同约定） */
export function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function err(message, status = 400, extra = {}, cause) {
  captureError(cause ?? new Error(message));
  return json({ error: message, ...extra }, status);
}

async function readEventsViaPersistence(ctx, sessionId) {
  const handle = await ctx.sessionPersistence.open(sessionId, "read");
  try {
    const out = [];
    for (;;) {
      const slice = await handle.read(out.length, 500);
      out.push(...slice.events);
      if (slice.events.length < 500) break;
      if (out.length > 200000) break;
    }
    return out;
  } finally { await handle.close(); }
}

/** 从 store 取 live agent/session；没有则通过 agents.resume 从持久化装载（官方路径，绑定写） */
const attachedHandles = new Map();

export async function acquireLiveSession(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId);
  if (live) return { session: live, attached: false };
  if (ctx.get("agents") === void 0) throw new Error("agents 服务不可用，无法从磁盘装载会话");
  const handle = await ctx.agents.resume({ resumeSessionId: sessionId });
  attachedHandles.set(sessionId, handle);
  return { session: handle.agent.session, attached: true };
}

/** 释放本插件接管的会话（dispose agent：停止/排空/注销/移除，关闭写句柄） */
export async function detachSession(ctx, sessionId) {
  const handle = attachedHandles.get(sessionId);
  if (handle === void 0) return { detached: false, note: "本插件未接管该会话" };
  attachedHandles.delete(sessionId);
  try {
    await handle.dispose();
    return { detached: true, note: "已 dispose agent 并释放写句柄" };
  } catch (e) {
    return { detached: true, degraded: true, cause: String(e?.message ?? e), causeStack: String(e?.stack ?? "").slice(0, 600), note: "dispose 抛错（可能部分成功）；写句柄状态未知" };
  }
}

/** surface 节点详情：seq → {type, role, checkpoint, time} */
export function surfaceNodes(events, fold, deriveEventMessage) {
  const out = [];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  for (const seq of fold.nodes) {
    const event = bySeq.get(seq);
    const message = fold.projectedMessages?.get(seq) ?? deriveEventMessage(event);
    out.push({
      seq,
      type: event?.type,
      role: message?.role ?? null,
      time: event?.time,
      checkpoint: isCompactionCheckpoint(event),
      chars: message ? (Array.isArray(message.content) ? message.content.map((b) => (b?.text ?? b?.thinking ?? "")).join("").length : 0) : 0,
      surfaceOp: event?.surfaceOp ?? "append",
    });
  }
  return out;
}

/** 构造一条替换事件（data 即消息对象，对齐各类型事件契约） */
export function buildReplacementEvent(templateEvent, newBlocks) {
  const type = templateEvent.type;
  if (!["user/message", "assistant/message", "system/message", "developer/message"].includes(type)) {
    throw new Error(`类型 ${type} 不支持替换（tool/result 请用专用接口）`);
  }
  const payload = JSON.parse(JSON.stringify(templateEvent.data));
  setMessageBlocks({ type, data: payload }, newBlocks);
  return { type, data: payload };
}

/** 消息事件 data 的正确包装 */
/** 克隆同会话最近一条合法同角色事件作为契约模板（v4 assistant 契约复杂：id+replayState+usage+stream） */
function cloneContractTemplate(events, type) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === type) return events[i];
  }
  return undefined;
}

function messageData(type, role, blocks, template) {
  if (type === "user/message") {
    return { content: blocks, source: { kind: "session-editor" }, role: "user", id: cryptoId() };
  }
  // system/developer/assistant 需要 {turn, step, message}
  const turn = template?.data?.turn ?? 1;
  const step = template?.data?.step ?? 1;
  return { turn, step, message: { id: cryptoId(), role, content: blocks,
    source: { kind: role === 'system' ? 'system-prompt' : 'session-editor' } } };
}

function cryptoId() {
  return createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 32);
}

// Shared by direct edits and workbench commits: one writer per target/context.
const sessionWrites = new WeakMap();
export async function withSessionWrite(ctx, id, run) {
  let pending = sessionWrites.get(ctx);
  if (!pending) sessionWrites.set(ctx, pending = new Set());
  if (pending.has(id)) throw Object.assign(new Error("此会话正在编辑，请稍后重试"), { status: 409 });
  pending.add(id);
  try { return await run(); } finally { pending.delete(id); }
}

// Synthetic turns must never be appended behind a resident loop's cached
// phase.lastTurn. Release its actual owner, then append under an exclusive
// persistence lease without creating another agent. The next prompt restores
// both the log and loop position together.
async function appendDetached(ctx, body, run) {
  const { id, expectRevision, signal } = body;
  signal?.throwIfAborted();
  if (ctx.agents.get(id)?.status === 'running') throw Object.assign(new Error('会话正在生成，请停止生成后再编辑'), { status: 409 });
  if (ctx.sessions.get(id)) {
    if (typeof ctx.agents.releaseIdle !== 'function') throw new Error('当前宿主缺少安全释放接口；未修改会话');
    await ctx.agents.releaseIdle(id);
    attachedHandles.delete(id);
  }
  if (ctx.sessions.get(id)) throw new Error('会话仍被占用，未修改会话');
  const writer = await ctx.sessionPersistence.open(id, 'write');
  try {
    const events = [];
    for (;;) {
      const part = await writer.read(events.length, 500);
      events.push(...part.events);
      if (part.events.length < 500) break;
    }
    signal?.throwIfAborted();
    if (expectRevision && contentRevision(events) !== expectRevision) throw Object.assign(new Error('版本冲突：请刷新后重试'), { status: 409 });
    const { assertReleasedV4Relationships } = await importHost('@deepseek-ai/dsh-session-format-v3-to-v4');
    const validate = rows => assertReleasedV4Relationships({ header: writer.header, events: rows, inheritedEventCount: writer.inheritedEventCount }, new Set(rows.map(e => e.type)));
    validate(events);
    const session = ctx.sessions.prepare(id, { seed: structuredClone(events), meta: writer.header,
      inheritedEventCount: writer.inheritedEventCount, eventState: 'detached' });
    if (Number.isInteger(body.seq) && !session.surface.nodes.includes(body.seq)) throw Object.assign(new Error('目标已不在有效上下文，请刷新'), { status: 409 });
    if (Number.isInteger(body.expectGeneration) && session.surface.contentGeneration !== body.expectGeneration) throw Object.assign(new Error('版本冲突：请刷新后重试'), { status: 409 });
    const result = run(session);
    const rows = session.snapshotEvents();
    validate(rows);
    signal?.throwIfAborted();
    await writer.append(rows.slice(events.length));
    await writer.flush();
    return result;
  } finally { await writer.close(); }
}

/** 编辑 API 路由注册 */
export function registerEditRoutes(ctx, route, computeOffline) {
  const register = route;
  route = (path, methods, handler) => register(path, methods, !methods.includes("POST") ? handler : async (request) => {
    let id;
    try { id = (await request.clone().json())?.id; } catch { return err("invalid json"); }
    try { return await withSessionWrite(ctx, id, () => handler(request)); }
    catch (e) { return err(e.message, e.status ?? 500, {}, e); }
  });
  // ---- 遮蔽关系：单条定位 + 全量分类 ----
  route("/api/session-editor/shadowing", ["GET"], async (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const seq = Number(url.searchParams.get("seq"));
    if (!id || !Number.isInteger(seq)) return err("需要 id / seq");
    try {
      const { sessionShadowing, locateSeq, classifyAll } = await import("./shadowing.js");
      const events = await readEventsViaPersistence(ctx, id);
      const trace = sessionShadowing(events);
      return json({ ok: true, ...locateSeq(trace, seq) });
    } catch (e) {
      return err(`shadowing failed: ${e?.message ?? e}`, 500, {}, e);
    }
  });
  route("/api/session-editor/shadowing/all", ["GET"], async (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return err("需要 id");
    try {
      const { sessionShadowing, classifyAll } = await import("./shadowing.js");
      const events = await readEventsViaPersistence(ctx, id);
      const trace = sessionShadowing(events);
      const cls = classifyAll(trace);
      return json({
        ok: true,
        nodeCount: trace.nodes.length,
        replaceGeneration: trace.replaceGeneration,
        visibleCount: cls.visible.length,
        shadowedCount: cls.shadowed.length,
        shadowed: cls.shadowed.map((s) => ({
          seq: s.seq, type: s.type, visible: s.visible,
          finalNodes: s.finalNodes, ambiguous: s.ambiguous,
          chain: s.chain,
        })),
      });
    } catch (e) {
      return err(`shadowing/all failed: ${e?.message ?? e}`, 500, {}, e);
    }
  });
  // ---- surface 明细（含 role/checkpoint）----
  route("/api/session-editor/nodes", ["GET"], async (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return err("missing id");
    try {
      const off = await computeOffline(id);
      return json({
        ok: true,
        contentGeneration: off.fold.contentGeneration,
        nodeCount: off.fold.nodes.length,
        nodes: surfaceNodes(off.events, off.fold, off.deriveEventMessage),
      });
    } catch (e) {
      return err(`nodes failed: ${e?.message ?? e}`, 500, {}, e);
    }
  });

  // ---- 会话接管（把磁盘会话装载进本进程并广播）----
  route("/api/session-editor/attach", ["POST"], async (request) => {
    try {
      const body = await request.json();
      const id = body?.id;
      if (!id) return err("missing id");
      const { session, attached } = await acquireLiveSession(ctx, id);
      return json({
        ok: true,
        attached,
        sessionId: session.id,
        eventCount: session.snapshotEvents().length,
        note: attached ? "已接管为 live 会话（本进程）" : "会话本就是 live",
      });
    } catch (e) {
      return err(`attach failed: ${e?.message ?? e}`, 500, {}, e);
    }
  });

  // ---- 释放接管的会话 ----
  route("/api/session-editor/detach", ["POST"], async (request) => {
    try {
      const body = await request.json();
      const id = body?.id;
      if (!id) return err("missing id");
      return json({ ok: true, ...(await detachSession(ctx, id)) });
    } catch (e) {
      return err(`detach failed: ${e?.message ?? e}`, 500, {}, e);
    }
  });

  // ---- 编辑单条 surface 节点（replace 语义）----
  // body: { id, seq, blocks: [ {type:"text", text:"…"}, … ], expectGeneration }
  route("/api/session-editor/edit", ["POST"], async (request) => {
    let body;
    try { body = await request.json(); } catch { return err("invalid json"); }
    const { id, seq, blocks, expectGeneration } = body ?? {};
    if (!id || !Number.isInteger(seq) || !Array.isArray(blocks)) return err("需要 id / seq / blocks");
    try {
      if (body.physical === true) return json(await physicalEdit(ctx, body, detachSession));
      return json(await appendDetached(ctx, body, (detached) => {
        const template = detached.eventAt(seq);
        if (!template) throw Object.assign(new Error(`seq ${seq} 不存在`), { status: 404 });
        if (isCompactionCheckpoint(template)) throw Object.assign(new Error("压缩摘要请使用摘要编辑接口"), { status: 422 });
        if (!["user/message", "assistant/message", "developer/message"].includes(template.type)) {
          throw Object.assign(new Error(`seq ${seq} 类型 ${template.type} 不支持该编辑方式（system 由 DSH 每轮重建；tool 结构受保护）`), { status: 422 });
        }
        const { type, data } = buildReplacementEvent(detached.eventAt(seq), blocks);
        const event = detached.append(type, data, {
          surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
          sourceEventSeqs: [seq],
        });
        return {
          ok: true,
          attached: false,
          edit: { targetSeq: seq, newSeq: event.seq, type },
          generationAfter: detached.surface.contentGeneration,
          note: "replace 事件已落盘并广播；下一次 deriveMessages 即为新内容",
        };
      }));
    } catch (e) {
      return err(`edit failed: ${e?.message ?? e}`, e.status ?? 500, {}, e);
    }
  });

  // ---- 删除 surface 节点（replace 为空 system 占位；模型仅见一条空系统消息）----
  route("/api/session-editor/delete-node", ["POST"], async (request) => {
    try {
      const body = await request.json();
      const { id, seq, expectGeneration, expectRevision } = body ?? {};
      if (!id || !Number.isInteger(seq)) return err("需要 id / seq");
      return json(await appendDetached(ctx, body, (session) => {
        // tombstone 也必须匹配 open turn/step：复用 insert 的补全序列
        const events = session.snapshotEvents();
        const openTurn = events.findLast((e) => e.type === "turn/start");
        // Loading a seed does not close its interrupted turn or step in v4.
        const closedAfter = events.findLast((e) => e.type === "turn/end");
        const turnOpen = openTurn !== undefined && (closedAfter === undefined || closedAfter.seq < openTurn.seq);
        let event;
        if (turnOpen) {
          const turnNo = openTurn.data?.turn ?? 1;
          const boundary = events.findLast(e => ["step/start", "step/end"].includes(e.type) && e.data?.turn === turnNo);
          const ownStep = boundary?.type !== "step/start";
          const stepNo = ownStep ? (boundary?.data.step ?? 0) + 1 : boundary.data.step;
          if (ownStep) session.append("step/start", { turn: turnNo, step: stepNo });
          const sysTpl2 = cloneContractTemplate(events, "system/message");
          const sysData2 = sysTpl2 ? JSON.parse(JSON.stringify(sysTpl2.data)) : { turn: turnNo, step: stepNo, message: { role: "system", id: cryptoId(), content: [], source: { kind: "session-editor" } } };
          sysData2.turn = turnNo; sysData2.step = stepNo;
          sysData2.message = { role: "system", id: cryptoId(), content: [], source: { kind: "system-prompt" } };
          event = session.append("system/message", sysData2, {
            surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
            sourceEventSeqs: [seq],
          });
          if (ownStep) session.append("step/end", { turn: turnNo, step: stepNo });
        } else {
          const nextTurn = (openTurn?.data?.turn ?? 0) + 1;
          session.append("turn/start", { turn: nextTurn });
          session.append("step/start", { turn: nextTurn, step: 1 });
          const sysTpl = cloneContractTemplate(events, "system/message");
          const sysData = sysTpl ? JSON.parse(JSON.stringify(sysTpl.data)) : { turn: nextTurn, step: 1, message: { role: "system", id: cryptoId(), content: [], source: { kind: "session-editor" } } };
          sysData.turn = nextTurn; sysData.step = 1;
          sysData.message = { role: "system", id: cryptoId(), content: [], source: { kind: "system-prompt" } };
          event = session.append("system/message", sysData, {
            surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
            sourceEventSeqs: [seq],
          });
          session.append("step/end", { turn: nextTurn, step: 1 });
          // Native chat projections read reason.kind for every completed turn.
          session.append("turn/end", { turn: nextTurn, reason: { kind: "completed" } });
        }
        return { ok: true, edit: { targetSeq: seq, newSeq: event.seq }, note: "节点已从模型可见序列移除（空占位）" };
      }));
    } catch (e) {
      return err(`delete failed: ${e?.message ?? e}`, e.status ?? 500, {}, e);
    }
  });

  // ---- 插入消息（append 到 surface 末尾）----
  // body: { id, role: 'user'|'assistant'|'system'|'developer', blocks }
  route("/api/session-editor/insert", ["POST"], async (request) => {
    try {
      const body = await request.json();
      const { id, role, blocks } = body ?? {};
      if (!id || !role || !Array.isArray(blocks)) return err("需要 id / role / blocks");
      const typeMap = { user: "user/message", assistant: "assistant/message", system: "system/message", developer: "developer/message" };
      const type = typeMap[role];
      if (!type) return err(`role 必须是 ${Object.keys(typeMap).join('/')}`);
      return json(await appendDetached(ctx, body, (session) => {
        // v4 状态机：user 可在任何时刻追加；system/developer/assistant 必须在 open turn+step 内。
        // 若当前无 open turn，则补全合法序列: turn/start → step/start → msg → step/end → turn/end
        const events = session.snapshotEvents();
        const openTurn = events.findLast((e) => e.type === "turn/start");
        const closedAfter = events.findLast((e) => e.type === "turn/end");
        const turnOpen = openTurn !== undefined && (closedAfter === undefined || closedAfter.seq < openTurn.seq);
        let event;
        // 契约模板：从日志最近一条同类型事件克隆（保证 v4 全字段合法）
        const template = cloneContractTemplate(events, type);
        if (role === 'assistant' && !template) throw Object.assign(new Error('需要已有助手回复作为原生消息模板；未插入内容'), { status: 422 });
        if (role === "user") {
          event = session.append("user/message", messageData("user/message", "user", blocks), { surfaceOp: "append" });
        } else if (turnOpen) {
          const turnNo = openTurn.data?.turn ?? 1;
          const boundary = events.findLast(e => ["step/start", "step/end"].includes(e.type) && e.data?.turn === turnNo);
          const ownStep = boundary?.type !== "step/start";
          const stepNo = ownStep ? (boundary?.data.step ?? 0) + 1 : boundary.data.step;
          if (ownStep) session.append("step/start", { turn: turnNo, step: stepNo });
          if (template) {
            const data = JSON.parse(JSON.stringify(template.data));
            data.turn = turnNo; data.step = stepNo;
            data.message.content = blocks;
            data.message.id = cryptoId();
            event = session.append(type, data, { surfaceOp: "append" });
          } else {
            event = session.append(type, messageData(type, role, blocks, { data: { turn: turnNo, step: stepNo } }), { surfaceOp: "append" });
          }
          if (ownStep) session.append("step/end", { turn: turnNo, step: stepNo });
        } else {
          // 无 open turn：完整 turn 序列；assistant 用克隆模板
          const nextTurn = (openTurn?.data?.turn ?? 0) + 1;
          session.append("turn/start", { turn: nextTurn });
          session.append("step/start", { turn: nextTurn, step: 1 });
          if (template) {
            const data = JSON.parse(JSON.stringify(template.data));
            data.turn = nextTurn; data.step = 1;
            data.message.content = blocks;
            data.message.id = cryptoId();
            event = session.append(type, data, { surfaceOp: "append" });
          } else {
            event = session.append(type, messageData(type, role, blocks, { data: { turn: nextTurn, step: 1 } }), { surfaceOp: "append" });
          }
          session.append("step/end", { turn: nextTurn, step: 1 });
          session.append("turn/end", { turn: nextTurn, reason: { kind: "completed" } });
        }
        return { ok: true, seq: event.seq, note: "已插入并进入模型上下文" };
      }));
    } catch (e) {
      return err(`insert failed: ${e?.message ?? e}`, e.status ?? 500, {}, e);
    }
  });

  // ---- 物理同步：把编辑同步写进原始历史（聊天区重载后显示新内容）----
  // 语义：用户在 UI 保存时，除 surface replace（模型上下文）外，可选择同时物理改写原始日志。
  route("/api/session-editor/physical-sync", ["POST"], async (request) => {
    try {
      const body = await request.json();
      const { id, seq, blocks } = body ?? {};
      if (!id || !Number.isInteger(seq) || !Array.isArray(blocks)) return err("需要 id / seq / blocks");
      return json(await physicalEdit(ctx, body, detachSession));
    } catch (e) {
      return err(`physical-sync failed: ${e?.message ?? e}`, 500, {}, e);
    }
  });
  // ---- 编辑压缩摘要（v4 正确序列）----
  // 规则（实测破译）：
  //   原生顺序: compaction/start → compaction/summary → checkpoint(replace) → compaction/end
  //   compaction.turn 必须等于 open turn；无 open turn 时用 null
  //   summary 需 shadowedRange/shadowedSeqs 精确匹配当时 surface span
  route("/api/session-editor/summary/edit", ["POST"], async (request) => {
    try {
      const body = await request.json();
      const { id, seq, text, expectGeneration } = body ?? {};
      if (!id || !Number.isInteger(seq) || typeof text !== "string") return err("需要 id / seq / text");
      return json(await physicalEdit(ctx, { ...body, summaryText: text }, detachSession));
    } catch (e) {
      return err(`summary edit failed: ${e?.message ?? e}`, 500, {}, e);
    }
  });
}
