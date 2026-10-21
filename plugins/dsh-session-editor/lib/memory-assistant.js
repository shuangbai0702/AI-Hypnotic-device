import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { contentRevision } from "./physical-edit.js";
import { isCompactionCheckpoint, memoryAccess } from "./coverage.js";

// Durable identity + lineage, without a backend-specific filesystem side channel.
const PREFIX = "session-editor-memory-";
const ISOLATED_PREFIX = PREFIX + "v1-";
const owned = (h, target) => h?.id?.startsWith(ISOLATED_PREFIX) && h.origin === undefined && h.parentSession === target && typeof h.cwd === "string" && h.cwd.length > 0;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const check = (signal) => { if (signal?.aborted) throw fail("操作已取消", 409); };
const int = (n, fallback, max) => n === undefined ? fallback : Number.isInteger(n) && n >= 0 && n <= max ? n : (() => { throw fail("分页参数超出范围"); })();
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const num = { type: "integer", description: "非负整数" };
const str = { type: "string" };
const pageSchema = { offset: num, limit: { type: "integer", description: "每页 1–50 条，默认 10" } };
const chunkSchema = { charOffset: num, charLimit: { type: "integer", description: "每页 1–12000 字符，默认 6000" } };
// ToolDefinition.execute owns input validation; the runtime validates outputs only.
function validate(schema, value) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("工具参数必须为对象");
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw fail(`缺少参数 ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (!schema.properties[key]) throw fail(`未知参数 ${key}`);
      validate(schema.properties[key], item);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw fail("参数必须为数组");
    for (const item of value) validate(schema.items, item);
  } else if (schema.type === "integer" ? !Number.isSafeInteger(value) || value < 0 : typeof value !== schema.type) throw fail("工具参数类型或范围无效");
  if (schema.enum && !schema.enum.includes(value)) throw fail("工具参数枚举无效");
}
function chunk(value, args) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const offset = int(args.charOffset, 0, Number.MAX_SAFE_INTEGER);
  const limit = int(args.charLimit, 6000, 12000);
  if (!limit) throw fail("charLimit 必须大于 0");
  return { text: raw.slice(offset, offset + limit), encoding: typeof value === "string" ? "text" : "json", charOffset: offset, totalChars: raw.length,
    truncated: offset + limit < raw.length, nextCharOffset: offset + limit < raw.length ? offset + limit : null };
}

// Same durable pending/last-used semantics as DSH's modelSelection projection.
export function selectedModel(events) {
  let pending, lastUsed;
  for (const event of events) {
    if (event.type === 'model/selection') pending = event.data;
    if (event.type !== 'request/header') continue;
    const config = event.data?.header?.config;
    if (!config?.provider || !config.model) continue;
    lastUsed = { provider: config.provider, model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: String(config.reasoningEffort) }) };
    if (pending && pending.provider === lastUsed.provider && pending.model === lastUsed.model && pending.reasoningEffort === lastUsed.reasoningEffort) pending = undefined;
  }
  return pending ?? lastUsed;
}
export const memoryAssistantPrompt = (id) => readFileSync(new URL("../AGENT.md", import.meta.url), "utf8")
  .replaceAll("{{TARGET_SESSION_ID}}", () => id).trimEnd();
const prompt = memoryAssistantPrompt;
const MEMORY_EVENT_TYPES = new Set(["user/message", "assistant/message"]);
const MEMORY_SOURCES = new Set(["user", "model", "session-editor", "compact-checkpoint"]);
const sourceKind = (source) => typeof source === "string" ? source : source?.kind;
const memorySource = (source) => source === undefined || MEMORY_SOURCES.has(sourceKind(source));
const eventMessage = (event) => event?.type === "user/message" ? event.data : event?.data?.message;
const isMemoryEvent = (event) => MEMORY_EVENT_TYPES.has(event?.type) &&
  [undefined, "user", "assistant"].includes(eventMessage(event)?.role) && memorySource(eventMessage(event)?.source);
const memoryMessages = (messages) => (Array.isArray(messages) ? messages : []).filter((message) =>
  MEMORY_EVENT_TYPES.has(message?.type) && ["user", "assistant"].includes(message.role) && memorySource(message.source));
const visibleBlocks = (blocks) => (Array.isArray(blocks) ? blocks : []).map((block, index) => {
  if (["text", "reasoning"].includes(block?.type)) return { index, type: block.type, text: block.text ?? "" };
  if (block?.type === "thinking") return { index, type: "thinking", thinking: block.thinking ?? "" };
  return { index, type: "protected", editable: false };
});
const descriptor = (m) => ({ seq: m.seq, role: m.role, type: m.type, checkpoint: m.checkpoint,
  chars: visibleBlocks(m.blocks).reduce((sum, b) => sum + (b.text ?? b.thinking ?? "").length, 0),
  editable: m.editable, readOnly: m.readOnly, editKind: m.editKind, summarySeq: m.summarySeq, accessLabel: m.accessLabel,
  coverageState: m.coverageState, thoughtState: m.thoughtState, thoughtCount: m.thoughtCount });
const visibleMessage = (m) => ({ ...descriptor(m), blocks: visibleBlocks(m.blocks) });
const historyMessage = (event) => ({ seq: event.seq, type: event.type,
  role: eventMessage(event)?.role ?? (event.type === "user/message" ? "user" : "assistant"),
  checkpoint: isCompactionCheckpoint(event), blocks: eventMessage(event)?.content ?? [] });
const writeResult = (value) => ({ contentRevision: value.contentRevision,
  ...(value.edit ? { seq: value.edit.targetSeq, newSeq: value.edit.newSeq } : {}),
  ...(value.note ? { note: value.note } : {}) });

/** Dependencies are native services; dispatch invokes registered business handlers in-process. */
export function createMemoryAssistant(ctx, dispatch) {
  const states = new Map();
  const configured = new WeakSet();
  let disposed = false;
  const stateFor = (id) => {
    if (typeof id !== "string" || !id || id.length > 300) throw fail("需要目标会话 id");
    if (id.startsWith(PREFIX)) throw fail("助手会话不能作为目标");
    let s = states.get(id);
    if (!s) states.set(id, s = { targetId: id, changeCount: 0, results: [], handle: null, pending: null, closing: null });
    return s;
  };
  async function call(path, id, body, signal) {
    check(signal);
    const url = new URL(`http://session-editor.local/api/session-editor/${path}`);
    if (!body) url.searchParams.set("id", id);
    const response = await dispatch(new Request(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, id }), signal } : { signal }));
    const value = await response.json();
    if (!response.ok || value.error || value.ok === false) throw fail(value.error ?? "业务操作失败", response.status >= 400 ? response.status : 409);
    return value;
  }
  async function rawEvents(id, signal) {
    const handle = await ctx.sessionPersistence.open(id, "read", { signal });
    try {
      const events = [];
      for (;;) {
        check(signal);
        const page = await handle.read(events.length, 500, { signal });
        events.push(...page.events);
        if (page.events.length < 500) return events;
      }
    } finally { await handle.close(); }
  }
  async function snapshot(s, signal) {
    const value = await call("context", s.targetId, null, signal);
    const events = await rawEvents(s.targetId, signal);
    if (value.contentRevision !== contentRevision(events)) throw fail("上下文快照不完整或读取期间已变化；请重读后再操作", 409);
    const bySeq = new Map(events.map(e => [e.seq, e]));
    const messages = memoryMessages(value.messages).map(m => ({ ...m, ...memoryAccess(bySeq.get(m.seq), true) }));
    const accessBySeq = new Map(messages.map(m => [m.seq, memoryAccess(bySeq.get(m.seq), true)]));
    for (const summary of messages.filter(m => m.checkpoint)) {
      for (const seq of summary.coverage?.coveredSeqs ?? []) {
        if (!accessBySeq.has(seq)) accessBySeq.set(seq, memoryAccess(bySeq.get(seq), false, summary.seq));
      }
    }
    return { ...value, events, messages, accessBySeq };
  }
  function historyWithAccess(event, v) {
    return { ...historyMessage(event), ...(v.accessBySeq.get(event.seq) ?? memoryAccess(event, false)) };
  }
  function definitions(s, lifetimeSignal) {
    const defs = [];
    function tool(name, description, parameters, run, writes = false) {
      defs.push({ name, description, parameters,
        output: { schema: { type: "object", additionalProperties: true }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
        async execute(args, exec) {
          let result;
          try {
            check(exec?.signal);
            validate(parameters, args);
            if (disposed || s.closing || lifetimeSignal.aborted) throw fail("助手已关闭", 409);
            const signal = exec?.signal ? AbortSignal.any([exec.signal, lifetimeSignal]) : lifetimeSignal;
            result = await run(args, signal);
            if (writes) s.changeCount++;
            result = { ok: true, ...result, changeCount: s.changeCount };
          } catch (e) { result = { ok: false, error: String(e?.message ?? e), status: e.status ?? 500, changeCount: s.changeCount }; }
          result = JSON.parse(JSON.stringify(result));
          s.results.push({ name, time: Date.now(), ...result });
          if (s.results.length > 20) s.results.shift();
          return result;
        },
      });
    }
    function page(items, args, revision) {
      const offset = int(args.offset, 0, Number.MAX_SAFE_INTEGER), limit = int(args.limit, 10, 50);
      if (!limit) throw fail("limit 必须大于 0");
      return { contentRevision: revision, total: items.length, offset, nextOffset: offset + limit < items.length ? offset + limit : null,
        items: items.slice(offset, offset + limit) };
    }
    // Project every tool response through the same memory-only boundary.
    tool("read_context", "分页列出当前模型上下文。正文用 read_message 分页读取。", object(pageSchema), async (a, signal) => {
      const v = await snapshot(s, signal);
      return { ...page(v.messages.map(descriptor), a, v.contentRevision), compressionRanges: v.compressionRanges ?? [] };
    });
    tool("read_history", "分页列出用户/助手历史记忆，包含已覆盖的只读原文；不含系统、工具或运行日志。", object(pageSchema), async (a, signal) => {
      const v = await snapshot(s, signal);
      return page(v.events.filter(isMemoryEvent).map(event => historyWithAccess(event, v)).map(descriptor), a, v.contentRevision);
    });
    tool("read_message", "按 seq 读取正文/思考及受保护占位，JSON 字符分页。跟随 nextCharOffset 读完；editable/readOnly 由当前上下文决定，history 中的生效摘要仍可编辑。", object({ seq: num, source: { type: "string", enum: ["context", "history"] }, ...chunkSchema }, ["seq"]), async (a, signal) => {
      if (a.source === "history") {
        const v = await snapshot(s, signal), event = v.events.find(e => e.seq === a.seq && isMemoryEvent(e));
        if (!event) throw fail("seq 不在可读记忆范围", 404);
        const m = historyWithAccess(event, v);
        return { seq: a.seq, sourceView: "history", ...memoryAccess(event, m.surfaceActive, m.summarySeq), contentRevision: v.contentRevision, ...chunk(visibleMessage(m), a) };
      }
      const v = await snapshot(s, signal), m = v.messages.find(m => m.seq === a.seq);
      if (!m) throw fail("目标不在当前可读记忆；历史原文请用 source=history", 404);
      return { seq: a.seq, ...memoryAccess(v.events.find(e => e.seq === a.seq), true), contentRevision: v.contentRevision, ...chunk(visibleMessage(m), a) };
    });
    tool("read_summaries", "分页列出摘要索引；text/charOffset 可分页读取某条摘要完整 editText。", object({ ...pageSchema, seq: num, ...chunkSchema }), async (a, signal) => {
      const v = await call("summary", s.targetId, null, signal);
      const events = await rawEvents(s.targetId, signal);
      if (v.contentRevision !== contentRevision(events)) throw fail("摘要读取期间已变化，请重读", 409);
      const allowed = new Set(events.filter(e => isMemoryEvent(e) && isCompactionCheckpoint(e)).map(e => e.seq));
      v.summaries = v.summaries.filter(m => allowed.has(m.seq));
      if (a.seq !== undefined) {
        const m = v.summaries.find(m => m.seq === a.seq);
        if (!m) throw fail("摘要不存在", 404);
        return { seq: m.seq, editable: true, readOnly: false, editKind: "summary", accessLabel: "生效摘要 · 可编辑", contentRevision: v.contentRevision, ...chunk(m.editText, a) };
      }
      return page(v.summaries.map(m => ({ seq: m.seq, chars: m.chars, coverage: m.coverage, editable: true, readOnly: false, editKind: "summary" })), a, v.contentRevision);
    });
    tool("search_memory", "对当前上下文或全部历史做字面搜索，结果为带 seq 的片段，非全文；按 offset 分页。", object({ query: str, source: { type: "string", enum: ["context", "history"] }, ...pageSchema }, ["query"]), async (a, signal) => {
      if (typeof a.query !== "string" || !a.query.trim()) throw fail("搜索词不能为空");
      const v = await snapshot(s, signal);
      const rows = a.source === "history" ? v.events.filter(isMemoryEvent).map(event => historyWithAccess(event, v)) : v.messages;
      const hits = rows.flatMap(m => { const text = JSON.stringify(visibleMessage(m)), i = text.toLowerCase().indexOf(a.query.toLowerCase());
        return i < 0 ? [] : [{ seq: m.seq, editable: m.editable, readOnly: m.readOnly, editKind: m.editKind, summarySeq: m.summarySeq, accessLabel: m.accessLabel,
          matchOffset: i, excerpt: text.slice(Math.max(0, i - 120), i + 360), excerptOnly: true }]; });
      return page(hits, a, v.contentRevision);
    });
    tool("propose_memory", "仅起草待人工审核的正文/思考/摘要修改或局部压缩候选，不改变目标上下文。局部压缩需连续的纯记忆范围，原文保留。", object({ kind: { type: "string", enum: ["message", "summary", "compress"] }, seq: num, startSeq: num, endSeq: num, text: str, reason: str, expectRevision: str,
      thinking: { type: "array", items: object({ index: num, text: str }, ["index", "text"]) }, clearThinking: { type: "boolean" } }, ["kind", "expectRevision", "reason"]), async (a, signal) => {
      const v = await snapshot(s, signal);
      if (v.contentRevision !== a.expectRevision) throw fail("版本冲突，请重新读取", 409);
      const members = a.kind === "compress" ? [a.startSeq, a.endSeq] : [a.seq];
      if (members.some(seq => !v.messages.some(m => m.seq === seq))) throw fail("候选目标不在允许记忆范围", 409);
      const value = await call("workbench/propose", s.targetId, a, signal);
      return { candidateId: value.candidate.candidateId, kind: a.kind, members: value.candidate.members, status: "pending", applied: false, contentRevision: v.contentRevision, note: "候选已保存，请到记忆工作台逐条预览和应用" };
    });
    async function write(a, signal, operation) {
      if (typeof a.expectRevision !== "string" || !a.expectRevision) throw fail("写入必须提供 expectRevision");
      const run = async () => {
        check(signal);
        if (ctx.agents.get(s.targetId)?.status === "running") throw fail("目标会话正在生成，拒绝写入", 409);
        const v = await snapshot(s, signal);
        if (v.contentRevision !== a.expectRevision) throw fail("版本冲突：重新读取后再编辑", 409);
        const m = v.messages.find(m => m.seq === a.seq);
        if (!m) throw fail("只允许修改当前上下文节点；被覆盖原文只读", 409);
        return operation(m, v);
      };
      return run();
    }
    tool("edit_message", "修改当前普通消息正文/逐块思考，保留所有附件工具块；不传字段即保留，clearThinking=true 明确清除思考。", object({ seq: num, expectRevision: str, text: str,
      thinking: { type: "array", items: object({ index: num, text: str }, ["index", "text"]) }, clearThinking: { type: "boolean" } }, ["seq", "expectRevision"]), async (a, signal) => write(a, signal, async (m) => {
      if (m.checkpoint || !["user/message", "assistant/message"].includes(m.type)) throw fail("消息类型受保护，请使用摘要工具");
      if (a.text === undefined && a.thinking === undefined && a.clearThinking !== true) throw fail("没有指定修改内容");
      if (a.clearThinking && a.thinking?.length) throw fail("不能同时修改和清除思考");
      let blocks = structuredClone(m.blocks);
      if (a.text !== undefined) {
        if (typeof a.text !== "string") throw fail("text 必须为字符串");
        let placed = false;
        blocks = blocks.flatMap(b => b.type !== "text" ? [b] : placed ? [] : (placed = true, [{ ...b, text: a.text }]));
        if (!placed) blocks.push({ type: "text", text: a.text });
      }
      // Indices always refer to original blocks, even when the body has multiple text blocks.
      const replacements = new Map();
      for (const edit of a.thinking ?? []) {
        const b = m.blocks[edit.index];
        if (!Number.isInteger(edit.index) || !["reasoning", "thinking"].includes(b?.type) || typeof edit.text !== "string" || replacements.has(edit.index)) throw fail("思考块 index 无效或重复");
        replacements.set(edit.index, edit.text);
      }
      let thoughtIndex = 0;
      const originalThoughts = m.blocks.map((b, i) => ({ b, i })).filter(({ b }) => ["reasoning", "thinking"].includes(b.type));
      blocks = blocks.flatMap(b => {
        if (!["reasoning", "thinking"].includes(b.type)) return [b];
        const index = originalThoughts[thoughtIndex++].i;
        if (a.clearThinking) return [];
        return replacements.has(index) ? [{ ...b, [b.type === "thinking" ? "thinking" : "text"]: replacements.get(index) }] : [b];
      });
      // Existing physical API owns the exclusive writer lease and checks revision again inside it.
      return writeResult(await call("edit", s.targetId, { seq: a.seq, blocks, physical: true, expectRevision: a.expectRevision }, signal));
    }), true);
    tool("edit_summary", "编辑当前摘要正文（保留压缩事务和原 rawOutput），必须提供当前 revision。", object({ seq: num, text: str, expectRevision: str }, ["seq", "text", "expectRevision"]), async (a, signal) => write(a, signal, async (m) => {
      if (!m.checkpoint) throw fail("目标不是摘要");
      return writeResult(await call("summary/edit", s.targetId, { seq: a.seq, text: a.text, expectRevision: a.expectRevision }, signal));
    }), true);
    tool("remove_from_context", "仅将当前节点移出上下文，保留原始历史。必须提供 revision；目标正在生成则拒绝。", object({ seq: num, expectRevision: str }, ["seq", "expectRevision"]), async (a, signal) => {
      // Attach through the same business gate first, then maintenance prevents a turn starting
      // between the live revision comparison and the synchronous surface append.
      if (ctx.agents.get(s.targetId)?.status === "running") throw fail("目标会话正在生成", 409);
      const attached = await call("attach", s.targetId, {}, signal);
      try {
        const agent = ctx.agents.get(s.targetId);
        if (!agent?.runMaintenance) throw fail("宿主缺少安全维护接口，未修改", 409);
        return await agent.runMaintenance(maintenanceSignal => {
          const activeSignal = maintenanceSignal && signal ? AbortSignal.any([maintenanceSignal, signal]) : signal ?? maintenanceSignal;
          return write(a, activeSignal, async () => {
            if (contentRevision(agent.session.snapshotEvents()) !== a.expectRevision) throw fail("版本冲突", 409);
            const nodes = await call("nodes", s.targetId, null, activeSignal);
            if (contentRevision(agent.session.snapshotEvents()) !== a.expectRevision) throw fail("版本冲突", 409);
            return writeResult(await call("delete-node", s.targetId, { seq: a.seq, expectRevision: a.expectRevision, expectGeneration: nodes.contentGeneration }, activeSignal));
          });
        });
      } finally {
        if (attached.attached) await call("detach", s.targetId, {});
      }
    }, true);
    return defs;
  }
  function configure(s, agentCtx, agent, openingSignal) {
    if (configured.has(agent)) return;
    if (disposed || s.closing) throw fail("助手正在关闭", 409);
    check(openingSignal);
    const lifetime = new AbortController();
    const signal = openingSignal ? AbortSignal.any([lifetime.signal, openingSignal]) : lifetime.signal;
    agentCtx.on("dispose", () => lifetime.abort());
    agentCtx.tools.restrict({ allow: [] });
    agentCtx.tools.presentAs("native");
    const allowed = definitions(s, signal);
    agentCtx.tools.guard(exec => allowed.some(t => t.name === exec.name) ? undefined : "只允许记忆助手专用工具");
    for (const def of allowed) agentCtx.tools.register(def);
    agentCtx.systemPrompt.section({ name: "session-editor-memory", order: 0, complete: true, interpolate: false, text: prompt(s.targetId) });
    agentCtx.systemPrompt.suppressRuntimeContext();
    agentCtx.on("agent/pre-step", async (_payload, next) => {
      const decision = await next();
      return decision.kind === "enter" ? { ...decision, messages: decision.messages.filter(m => memorySource(m.source)) } : decision;
    }, { prepend: true });
    agentCtx.on("system-prompt/assemble", async (_assembly, _context, next) => {
      const assembly = await next();
      return { ...assembly, tools: assembly.tools.filter(tool => allowed.some(def => def.name === tool.name)) };
    }, { prepend: true });
    configured.add(agent);
  }
  function setup(s) {
    return (agentCtx, agent) => {
      configure(s, agentCtx, agent, s.abort.signal);
      return { commit() { check(s.abort.signal); if (disposed || s.closing) throw fail("助手正在关闭", 409); } };
    };
  }
  // Serial publication runs before queued work, including ordinary web resumes.
  ctx.on("agent/created", ({ agent }) => {
    if (!agent.id.startsWith(PREFIX)) return;
    const header = agent.session.header;
    if (!agent.id.startsWith(ISOLATED_PREFIX) || !owned(header, header?.parentSession)) {
      throw fail("旧版记忆助手仅保留历史，请从目标会话编辑器打开新的隔离助手", 409);
    }
    configure(stateFor(header.parentSession), agent.ctx, agent);
  });
  async function open(id, reset = false) {
    if (disposed) throw fail("插件已卸载", 409);
    const s = stateFor(id);
    if (reset && s.resetting) return s.resetting;
    if (s.closing) await s.closing;
    if (disposed) throw fail("插件已卸载", 409);
    if (reset) {
      if (s.resetting) return s.resetting;
      const closing = close(id), epoch = s.epoch;
      const resetting = (async () => {
        await closing;
        if (disposed || s.epoch !== epoch) throw fail("重置已取消", 409);
        s.resetNext = true;
        return open(id);
      })();
      s.resetting = resetting;
      try { return await resetting; } finally { if (s.resetting === resetting) s.resetting = null; }
    }
    if (s.handle) return status(id);
    if (s.pending) return s.pending;
    s.abort = new AbortController();
    const task = (async () => {
      let handle;
      try {
        const target = await ctx.sessionPersistence.stat(id, { signal: s.abort.signal });
        if (!target) throw fail("目标会话不存在", 404);
        if (!target.header?.cwd) throw fail("目标会话缺少 DSH 原生聊天所需的工作目录元数据", 409);
        const all = (await ctx.sessionPersistence.list({ signal: s.abort.signal })).filter(x =>
          x.header.id.startsWith(PREFIX) && x.header.parentSession === id && x.header.origin === undefined);
        const candidates = all.filter(x => owned(x.header, id)).sort((a, b) => b.header.createdAt - a.header.createdAt);
        s.legacyArchived = all.some(x => !owned(x.header, id));
        check(s.abort.signal);
        const existing = !s.resetNext && candidates[0];
        const selection = ctx.agents.get(id)?.options;
        const savedSelection = existing ? selectedModel(await rawEvents(existing.header.id, s.abort.signal)) : undefined;
        const targetSelection = selectedModel(await rawEvents(id, s.abort.signal));
        const agentOptions = savedSelection ?? targetSelection ?? (selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) } : ctx.agentDefaultModel.currentSelection());
        s.resetNext = false;
        const live = existing && ctx.agents.get(existing.header.id);
        if (live) {
          if (!configured.has(live)) throw fail("已有助手缺少隔离配置，请关闭后重试", 409);
          handle = { agent: live, dispose: async () => {
            if (ctx.agents.get(live.id) !== live) return;
            live.cancel({ kind: "disposed" });
            await live.whenIdle();
            await ctx.agents.releaseIdle(live.id);
          } };
        } else handle = existing ? await ctx.agents.resume({ resumeSessionId: existing.header.id, agentOptions, setup: setup(s), signal: s.abort.signal })
          : await ctx.agents.create({ sessionId: ISOLATED_PREFIX + randomUUID(), meta: { cwd: target.header.cwd, parentSession: id }, agentOptions, setup: setup(s), signal: s.abort.signal });
        check(s.abort.signal);
        if (disposed || s.closing) throw fail("助手已关闭", 409);
        if (!savedSelection) handle.agent.session.append('model/selection', agentOptions);
        await ctx.sessions.flush(handle.agent.session);
        check(s.abort.signal);
        s.handle = handle;
        return status(id);
      } catch (e) { if (handle) { handle.agent.cancel({ kind: "disposed" }); await handle.dispose(); } throw e; }
    })();
    s.pending = task;
    try { return await task; } finally { if (s.pending === task) s.pending = null; }
  }
  async function close(id) {
    const s = stateFor(id);
    s.epoch = (s.epoch ?? 0) + 1;
    if (s.closing) return s.closing;
    s.abort?.abort();
    s.handle?.agent.cancel({ kind: "disposed" });
    const task = (async () => {
      if (s.pending) await s.pending.catch(() => {});
      if (s.handle) { const handle = s.handle; s.handle = null; await handle.dispose(); }
      return { ok: true, targetId: id, closed: true, changeCount: s.changeCount };
    })();
    s.closing = task;
    try { return await task; } finally { s.closing = null; }
  }
  function status(id) {
    const s = stateFor(id);
    return { ok: true, targetId: id, sessionId: s.handle?.agent.id ?? null, status: s.closing ? "closing" : s.handle?.agent.status ?? (s.pending ? "opening" : "closed"),
      changeCount: s.changeCount, results: s.results, model: s.handle?.agent.options ?? null,
      isolation: "memory-only-v1", legacyArchived: s.legacyArchived === true };
  }
  async function dispose() {
    disposed = true;
    await Promise.all([...states.keys()].map(close));
  }
  return { open, close, status, dispose,
    async handle(request) {
      try {
        const url = new URL(request.url), action = url.pathname.split("/").pop();
        const body = request.method === "POST" ? await request.json() : null;
        const id = body?.id ?? url.searchParams.get("id");
        if (action === "open") {
          return json(await open(id, body.reset === true));
        }
        if (action === "close") return json(await close(id));
        if (action === "status") return json(status(id));
        const s = stateFor(id);
        if (!s.handle || s.closing) throw fail("请先打开助手", 409);
        if (action === "cancel") s.handle.agent.cancel({ kind: "user" });
        else if (action === "prompt") {
          if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 50000) throw fail("text 需为 1–50000 字符");
          s.handle.agent.followup({ id: randomUUID(), role: "user", content: [{ type: "text", text: body.text }], source: { kind: "user" } });
        } else throw fail("未知助手接口", 404);
        return json(status(id));
      } catch (e) { return json({ ok: false, error: String(e?.message ?? e) }, e.status ?? 500); }
    },
  };
}

export function registerMemoryAssistant(ctx, route, dispatch) {
  const assistant = createMemoryAssistant(ctx, dispatch);
  for (const action of ["open", "close", "prompt", "cancel"]) route(`/api/session-editor/assistant/${action}`, ["POST"], assistant.handle);
  route("/api/session-editor/assistant/status", ["GET"], assistant.handle);
  ctx.on("dispose", () => assistant.dispose());
  return assistant;
}
