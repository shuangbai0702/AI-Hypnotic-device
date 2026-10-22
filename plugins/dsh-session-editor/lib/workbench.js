import { randomUUID, createHash } from "node:crypto";
import { importHost } from "./host-import.js";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { contentRevision, physicalEdit, summaryBody } from "./physical-edit.js";
import { acquireLiveSession, detachSession, json, err, withSessionWrite } from "./edit.js";
import { isCompactionCheckpoint, memoryAccess, contextCoverage } from "./coverage.js";
import { runtimePaths } from './runtime-paths.js';
import { getDiagnostics } from './diagnostics.js';

const fail = (text, status = 400) => Object.assign(new Error(text), { status });
const check = signal => signal?.throwIfAborted();
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const messageOf = e => e?.type === "user/message" ? e.data : e?.data?.message;
const bodyOf = m => (m?.content ?? []).filter(b => b.type === "text").map(b => b.text).join("\n");
const memoryEvent = e => ["user/message", "assistant/message"].includes(e?.type) &&
  [undefined, "user", "model", "session-editor", "compact-checkpoint"].includes(messageOf(e)?.source?.kind);
const tokens = text => Math.ceil(Array.from(text).reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 1 : 0.25), 0));
const textOf = m => (m?.content ?? []).map(b => b.text ?? b.thinking ?? "").join("\n");
const fingerprint = e => digest({ type: e.type, message: messageOf(e) });
const framed = text => `<compacted-summary>\n${text.trim()}\n</compacted-summary>`;
const safeId = id => { if (typeof id !== "string" || !id || id.length > 300) throw fail("需要有效目标会话 id"); return id; };
const sequence = n => { if (!Number.isSafeInteger(n) || n < 0) throw fail("消息编号无效"); return n; };

export function changeMemoryBlocks(blocks, change) {
  if (change.clearThinking && change.thinking?.length) throw fail("不能同时修改和清除思考");
  const edits = new Map();
  if (change.thinking !== undefined && !Array.isArray(change.thinking)) throw fail("thinking 必须为数组");
  for (const edit of change.thinking ?? []) {
    if (!Number.isInteger(edit.index) || !["reasoning", "thinking"].includes(blocks[edit.index]?.type) || typeof edit.text !== "string" || edits.has(edit.index)) throw fail("思考块编号无效或重复");
    edits.set(edit.index, edit.text);
  }
  if (change.text !== undefined && typeof change.text !== "string") throw fail("正文必须为字符串");
  let placed = false;
  const result = blocks.flatMap((b, index) => {
    if (["reasoning", "thinking"].includes(b.type)) return change.clearThinking ? [] : [edits.has(index) ? { ...b, [b.type === "thinking" ? "thinking" : "text"]: edits.get(index) } : b];
    if (b.type !== "text" || change.text === undefined) return [b];
    if (placed) return [];
    placed = true; return [{ ...b, text: change.text }];
  });
  if (change.text !== undefined && !placed) result.push({ type: "text", text: change.text });
  return result;
}

// Deterministic pruning leaves every rich block and all tool-call identities intact.
export function trimToolBlocks(blocks, head = 1200, tail = 400, sourceSeq = 0) {
  if (![head, tail].every(n => Number.isInteger(n) && n >= 0 && n <= 50000)) throw fail("头尾长度需为 0–50000 整数");
  const total = blocks.filter(b => b.type === "text").reduce((n, b) => n + Array.from(b.text).length, 0);
  const marker = `\n[工具输出中段已裁剪；原件 #${sourceSeq} 可在记忆工作台找回]\n`;
  if (head + tail + Array.from(marker).length >= total) throw fail("输出不够长，裁剪后没有节省");
  let consumed = 0, inserted = false;
  return blocks.flatMap(b => {
    if (b.type !== "text") return [b];
    const points = Array.from(b.text), start = consumed, end = start + points.length;
    consumed = end;
    const left = points.slice(0, Math.min(points.length, Math.max(0, head - start))).join("");
    const right = points.slice(Math.min(points.length, Math.max(0, total - tail - start))).join("");
    const mid = !inserted && start < total - tail && end > head ? (inserted = true, marker) : "";
    const text = left + mid + right;
    return text ? [{ ...b, text }] : [];
  });
}

export function selectedRegion(snapshot, startSeq, endSeq) {
  sequence(startSeq); sequence(endSeq);
  const nodes = snapshot.fold.nodes, from = nodes.indexOf(startSeq), to = nodes.indexOf(endSeq);
  if (from < 0 || to < from) throw fail("选区必须是当前上下文中顺序正确的连续区间", 409);
  const bySeq = snapshot.bySeq ?? new Map(snapshot.events.map(e => [e.seq, e]));
  const selected = nodes.slice(from, to + 1).map(seq => bySeq.get(seq));
  if (selected.some(e => !memoryEvent(e))) throw fail("选区包含系统、运行环境或工具结果；请选择连续的用户/助手记忆，工具结果使用单独裁剪");
  if (selected.some(e => messageOf(e)?.content?.some(b => !["text", "reasoning", "thinking"].includes(b.type)))) throw fail("选区包含附件或工具调用，需保留原始结构；请选择其他完整记忆区间");
  return selected;
}

// Preserve real surface order, including protected gaps. Neither UI nor AI
// should infer a continuous selection from filtered message numbers.
export function compressionRanges(snapshot) {
  const bySeq = snapshot.bySeq ?? new Map(snapshot.events.map(e => [e.seq, e]));
  const ranges = []; let current;
  for (const seq of snapshot.fold.nodes) {
    const event = bySeq.get(seq), message = messageOf(event);
    const allowed = memoryEvent(event) && (message.content ?? []).every(b => ["text", "reasoning", "thinking"].includes(b.type));
    if (!allowed) { current = undefined; continue; }
    if (!current) { current = { startSeq: seq, endSeq: seq, members: [], tokens: 0 }; ranges.push(current); }
    current.endSeq = seq; current.members.push(seq); current.tokens += tokens(textOf(message));
  }
  return ranges;
}

export function createWorkbench(ctx, computeSurface) {
  const pending = new Set();
  const root = () => join(runtimePaths(ctx).home, 'session-editor', 'candidates');
  const file = id => join(root(), digest(safeId(id)) + ".json");
  function load(id) {
    const path = file(id);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf8");
    if (raw.length > 12000000) throw fail("候选队列文件过大，请先处理现有候选", 409);
    const data = JSON.parse(raw);
    if (data.targetId !== id || !Array.isArray(data.items)) throw fail("候选文件身份或格式异常", 500);
    return data.items;
  }
  function save(id, items) {
    mkdirSync(root(), { recursive: true });
    const path = file(id), temp = path + ".tmp";
    const value = JSON.stringify({ targetId: id, items });
    if (value.length > 12000000) throw fail("候选和恢复快照已达容量上限，未写入新操作", 409);
    writeFileSync(temp, value, "utf8"); renameSync(temp, path);
  }
  async function exclusive(id, run) {
    safeId(id);
    if (pending.has(id)) throw fail("当前会话的记忆工作台正在处理操作", 409);
    pending.add(id); try { return await run(); } finally { pending.delete(id); }
  }
  async function snapshot(id, expectRevision) {
    safeId(id);
    const v = await computeSurface(id);
    v.revision = contentRevision(v.events);
    if (expectRevision !== undefined && (typeof expectRevision !== "string" || !expectRevision || expectRevision !== v.revision)) throw fail("版本冲突：请刷新后重新预览", 409);
    return v;
  }
  const active = (v, seq) => {
    sequence(seq);
    if (!v.fold.nodes.includes(seq)) throw fail("目标已不在有效上下文", 409);
    return v.events.find(e => e.seq === seq);
  };
  function describe(e) {
    const m = messageOf(e), text = textOf(m);
    return { seq: e.seq, type: e.type, role: m?.role, checkpoint: isCompactionCheckpoint(e),
      chars: text.length, tokens: tokens(text), preview: text.slice(0, 180),
      canCompact: memoryEvent(e) && m.content.every(b => ["text", "reasoning", "thinking"].includes(b.type)),
      tool: e.type === "tool/result", toolCallId: e.type === "tool/result" ? m.source.callId : undefined, thoughtCount: m?.content?.filter(b => ["reasoning", "thinking"].includes(b.type)).length ?? 0 };
  }
  async function list(id) {
    const v = await snapshot(id);
    const bySeq = new Map(v.events.map(e => [e.seq, e]));
    return { ok: true, contentRevision: v.revision, rows: v.fold.nodes.map(seq => describe(bySeq.get(seq))),
      compressionRanges: compressionRanges(v),
      candidates: load(id).filter((c, i, all) => c.status === "pending" || i >= all.length - 200).map(({ baseline, replacement, original, ...item }) => ({ ...item, canRestore: !!original })),
      estimate: true };
  }
  async function propose(id, input, signal) {
    return exclusive(id, async () => {
      check(signal);
      if (!input.expectRevision) throw fail("起草候选必须提供 expectRevision");
      const v = await snapshot(id, input.expectRevision);
      const kind = input.kind;
      if (!["message", "summary", "compress", "tool-trim", "tool-restore", "recall", "field-restore"].includes(kind)) throw fail("未知候选类型");
      let selected, replacement, before, after, target, original;
      if (kind === "field-restore") {
        target = active(v, input.seq); selected = [target];
        const source = load(id).find(c => c.candidateId === input.sourceCandidateId && c.status === "applied" && c.seq === input.seq);
        if (!source?.original || !memoryEvent(target)) throw fail("只能从此消息已应用的候选恢复字段");
        const fields = input.fields;
        if (!Array.isArray(fields) || !fields.length || fields.some(f => !["body", "thinking"].includes(f))) throw fail("请选择正文或思考字段");
        if (isCompactionCheckpoint(target)) {
          if (!fields.includes("body") || fields.includes("thinking") || source.original.text === undefined) throw fail("摘要只能恢复正文");
          replacement = { text: source.original.text }; before = summaryBody(bodyOf(messageOf(target))); after = replacement.text;
          original = { text: before };
        } else {
          if (!source.original.blocks) throw fail("原件字段类型不匹配");
          const current = messageOf(target).content;
          let blocks = fields.includes("body") ? changeMemoryBlocks(current, { text: bodyOf({ content: source.original.blocks }) }) : structuredClone(current);
          if (fields.includes("thinking")) {
            const thoughts = source.original.blocks.filter(b => ["reasoning", "thinking"].includes(b.type));
            const first = blocks.findIndex(b => ["reasoning", "thinking"].includes(b.type));
            blocks = blocks.filter(b => !["reasoning", "thinking"].includes(b.type));
            blocks.splice(first < 0 ? 0 : first, 0, ...structuredClone(thoughts));
          }
          replacement = { blocks }; original = { blocks: structuredClone(current) };
          before = textOf(messageOf(target)); after = textOf({ content: blocks });
        }
      } else if (kind === "compress") {
        selected = selectedRegion(v, input.startSeq, input.endSeq);
        if (typeof input.text !== "string" || !input.text.trim()) throw fail("摘要不能为空");
        replacement = { text: input.text.trim() }; before = selected.map(e => `#${e.seq} ${textOf(messageOf(e))}`).join("\n\n"); after = framed(replacement.text);
        if (tokens(after) >= selected.reduce((n, e) => n + tokens(textOf(messageOf(e))), 0)) throw fail("摘要连同标签必须比原选区更短");
      } else if (kind === "recall") {
        sequence(input.seq);
        target = v.events.find(e => e.seq === input.seq);
        if (!memoryEvent(target)) throw fail("只能补回用户/助手记忆正文");
        const text = bodyOf(messageOf(target));
        if (!text.trim()) throw fail("原文没有可补回的正文");
        selected = [target]; replacement = { text: `用户选择补回的历史记忆（原件 #${target.seq}，${messageOf(target).role}）：\n${isCompactionCheckpoint(target) ? summaryBody(text) : text}` };
        before = "不会改变现有摘要；作为补充记忆加入上下文"; after = replacement.text;
      } else {
        target = active(v, input.seq); selected = [target];
        if (kind.startsWith("tool-")) {
          if (target.type !== "tool/result") throw fail("目标不是工具结果");
          original = { blocks: structuredClone(messageOf(target).content), toolCallId: messageOf(target).source.callId };
          if (kind === "tool-trim") replacement = { blocks: trimToolBlocks(messageOf(target).content, input.head, input.tail, target.seq) };
          else {
            const archived = input.sourceCandidateId && load(id).find(c => c.candidateId === input.sourceCandidateId && c.status === "applied" && c.original?.toolCallId === messageOf(target).source.callId);
            if (input.sourceCandidateId && !archived) throw fail("原件必须属于同一次工具调用");
            if (archived) replacement = { blocks: structuredClone(archived.original.blocks) };
            else {
              sequence(input.sourceSeq);
              const event = v.events.find(e => e.seq === input.sourceSeq);
              if (event?.type !== "tool/result" || messageOf(event)?.source?.callId !== messageOf(target)?.source?.callId) throw fail("原件必须属于同一次工具调用");
              replacement = { blocks: structuredClone(messageOf(event).content) };
            }
          }
          before = textOf(messageOf(target)); after = textOf({ content: replacement.blocks });
        } else {
          if (!memoryEvent(target)) throw fail("只支持用户/助手记忆");
          if (kind === "summary") {
            if (!isCompactionCheckpoint(target) || typeof input.text !== "string") throw fail("目标或摘要格式无效");
            replacement = { text: input.text }; before = summaryBody(bodyOf(messageOf(target))); after = input.text; original = { text: before };
          } else {
            if (isCompactionCheckpoint(target)) throw fail("摘要请使用摘要候选");
            if (input.text === undefined && input.thinking === undefined && input.clearThinking !== true) throw fail("未指定修改字段");
            original = { blocks: structuredClone(messageOf(target).content) };
            replacement = { blocks: changeMemoryBlocks(messageOf(target).content, input) };
            before = textOf(messageOf(target)); after = textOf({ content: replacement.blocks });
          }
        }
      }
      if (before === after) throw fail("候选没有内容变化");
      if (before.length + after.length > 250000) throw fail("候选过大，请缩小选区");
      const items = load(id);
      if (items.filter(c => c.status === "pending").length >= 100) throw fail("最多保留 100 个待审候选，请先应用或拒绝", 409);
      const item = { candidateId: randomUUID(), kind, seq: input.seq, startSeq: input.startSeq, endSeq: input.endSeq,
        sourceSeq: input.sourceSeq, reason: String(input.reason ?? "用户手动起草").slice(0, 2000),
        createdAt: Date.now(), status: "pending", baseRevision: v.revision,
        members: selected.map(e => e.seq), baseline: selected.map(fingerprint), replacement, original, before, after,
        tokensBefore: tokens(before), tokensAfter: tokens(after), estimate: true };
      check(signal); items.push(item); save(id, items);
      const { baseline, replacement: hidden, original: saved, ...publicItem } = item;
      return { ok: true, candidate: publicItem, contentRevision: v.revision };
    });
  }
  function validateCandidate(v, c) {
    const current = c.kind === "compress" ? selectedRegion(v, c.startSeq, c.endSeq)
      : c.kind === "recall" ? c.members.map(seq => v.events.find(e => e.seq === seq)) : [active(v, c.seq)];
    if (current.length !== c.members.length || current.some((e, i) => !e || e.seq !== c.members[i] || fingerprint(e) !== c.baseline[i])) throw fail("候选目标内容已变化，请拒绝旧候选并重新起草", 409);
  }
  async function apply(id, candidateId, signal) {
    return exclusive(id, () => withSessionWrite(ctx, id, async () => {
      check(signal);
      const items = load(id), candidate = items.find(c => c.candidateId === candidateId);
      if (!candidate) throw fail("候选不存在", 404);
      if (candidate.status === "applied") return { ok: true, alreadyApplied: true, contentRevision: candidate.appliedRevision };
      if (candidate.status !== "pending") throw fail("此候选已经拒绝", 409);
      if (ctx.agents.get(id)?.status === "running") throw fail("目标会话正在生成，请停止后应用", 409);
      const v = await snapshot(id);
      const applied = (revision, result) => {
        candidate.status = "applied"; candidate.appliedAt ??= Date.now(); candidate.appliedRevision = revision;
        let warning, diagnosticId;
        try { save(id, items); } catch (error) {
          warning = "内容已写入；候选状态保存失败，重试将核对提交记录。";
          diagnosticId = getDiagnostics(ctx).warning('candidate-state-save', error, id);
        }
        return { ok: true, ...result, contentRevision: revision, candidateId, warning, diagnosticId };
      };
      // An append may have committed even if persisting the candidate status failed.
      const receipt = v.events.find(e => messageOf(e)?.id === candidateId || messageOf(e)?.source?.compactionId === candidateId ||
        (candidate.kind.startsWith("tool-") && e.type === "tool/result" && e.sourceEventSeqs?.includes(candidate.seq) && JSON.stringify(messageOf(e)?.content) === JSON.stringify(candidate.replacement.blocks)));
      if (receipt) {
        return applied(v.revision, { alreadyApplied: true });
      }
      if (["message", "summary", "field-restore", "tool-trim", "tool-restore"].includes(candidate.kind)) {
        const e = v.events.find(e => e.seq === candidate.seq);
        const same = candidate.replacement.blocks ? JSON.stringify(messageOf(e)?.content) === JSON.stringify(candidate.replacement.blocks)
          : isCompactionCheckpoint(e) && summaryBody(bodyOf(messageOf(e))) === summaryBody(candidate.replacement.text);
        if (same) return applied(v.revision, { alreadyApplied: true });
      }
      validateCandidate(v, candidate);
      let result;
      if (["message", "summary", "field-restore", "tool-trim", "tool-restore"].includes(candidate.kind)) {
        check(signal);
        result = await physicalEdit(ctx, { id, seq: candidate.seq, expectRevision: v.revision, signal,
          ...(candidate.kind.startsWith("tool-") ? { toolBlocks: candidate.replacement.blocks } : candidate.replacement.text !== undefined ? { summaryText: candidate.replacement.text } : { blocks: candidate.replacement.blocks }) }, detachSession);
      } else result = await commitAppend(id, candidate, signal);
      // A completed business write remains completed even if the viewer disconnects.
      return applied(result.contentRevision, result);
    }));
  }
  async function commitAppend(id, c, signal) {
    const acquired = await acquireLiveSession(ctx, id);
    const agent = ctx.agents.get(id);
    try {
      if (!agent?.runMaintenance) throw fail("宿主缺少安全维护接口", 409);
      return await agent.runMaintenance(async maintenanceSignal => {
        const operationSignal = maintenanceSignal && signal ? AbortSignal.any([signal, maintenanceSignal]) : signal ?? maintenanceSignal;
        check(operationSignal);
        const session = acquired.session, events = session.snapshotEvents();
        const v = { events, fold: session.surface, bySeq: new Map(events.map(e => [e.seq, e])) };
        validateCandidate(v, c);
        const lastBoundary = events.findLast(e => ["turn/start", "turn/end", "session/end-seed"].includes(e.type));
        if (lastBoundary?.type === "turn/start") throw fail("目标仍有未结束轮次，请先恢复或停止会话", 409);
        const lastCompaction = events.findLast(e => ["compaction/start", "compaction/end", "session/end-seed"].includes(e.type));
        if (lastCompaction?.type === "compaction/start") throw fail("目标压缩尚未结束", 409);
        const operations = [];
        const add = (type, data, options) => { const seq = events.length + operations.length; operations.push({ seq, type, data, ...options, time: Date.now() }); return seq; };
        const estimate = e => ctx.tokenMeter?.estimateMessage?.(messageOf(e)) ?? tokens(textOf(messageOf(e)));
        if (c.kind === "compress") {
          const selected = selectedRegion(v, c.startSeq, c.endSeq);
          const { toolPairingBalancedBefore, toolPairingBalancedAfter, compactCheckpointSource } = await importHost("@deepseek-ai/dsh-compaction");
          if (!toolPairingBalancedBefore(session, c.startSeq) || !toolPairingBalancedAfter(session, c.endSeq)) throw fail("选区切断了工具调用与结果", 409);
          check(operationSignal);
          const compactionId = c.candidateId, lifecycle = { compactionId, turn: null };
          const message = { id: randomUUID(), role: "user", content: [{ type: "text", text: framed(c.replacement.text) }], source: compactCheckpointSource(compactionId) };
          const before = selected.reduce((n, e) => n + estimate(e), 0);
          const after = ctx.tokenMeter?.estimateMessage?.(message) ?? tokens(framed(c.replacement.text));
          if (after >= before) throw fail("按当前 DSH 估算，摘要并未缩短", 409);
          const start = add("compaction/start", lifecycle);
          const summary = add("compaction/summary", { compactionId, summary: [{ type: "text", text: c.replacement.text }],
            shadowedRange: { start: c.startSeq, end: c.endSeq }, shadowedSeqs: c.members, shadowedTokenCount: before });
          add("user/message", message, { surfaceOp: { op: "replace", startSeq: c.startSeq, endSeq: c.endSeq }, sourceEventSeqs: [start, summary, ...c.members] });
          add("compaction/end", lifecycle);
        } else if (c.kind === "recall") {
          add("user/message", { id: c.candidateId, role: "user", source: { kind: "session-editor" }, content: [{ type: "text", text: c.replacement.text }] }, { surfaceOp: "append", sourceEventSeqs: c.members });
        } else throw fail("此操作不支持追加提交");
        // Preflight the whole prospective log before any append reaches the live owner.
        const rows = [...events, ...operations];
        const { Session } = await importHost("@deepseek-ai/dsh-session");
        Session.create(id, rows, session.header, session.inheritedEventCount ?? 0, ctx.sessions.messageProjections ?? []);
        const { assertReleasedV4Relationships } = await importHost("@deepseek-ai/dsh-session-format-v3-to-v4");
        assertReleasedV4Relationships({ header: session.header, events: rows, inheritedEventCount: session.inheritedEventCount ?? 0 }, new Set(rows.map(e => e.type)));
        check(operationSignal);
        if (contentRevision(session.snapshotEvents()) !== contentRevision(events)) throw fail("提交前会话已变化，请重试", 409);
        for (const { type, data, surfaceOp, sourceEventSeqs } of operations) session.append(type, data, { ...(surfaceOp ? { surfaceOp } : {}), ...(sourceEventSeqs ? { sourceEventSeqs } : {}) });
        await ctx.sessions.flush(session);
        return { contentRevision: contentRevision(session.snapshotEvents()), newSeq: operations.find(e => ["user/message", "tool/result"].includes(e.type))?.seq,
          note: "候选已应用，原件仍可在历史中检索" };
      });
    } finally { if (acquired.attached) await detachSession(ctx, id); }
  }
  async function reject(id, candidateId) {
    return exclusive(id, async () => {
      const items = load(id), item = items.find(c => c.candidateId === candidateId);
      if (!item) throw fail("候选不存在", 404);
      if (item.status === "applied") throw fail("候选已经应用，不能改为拒绝", 409);
      item.status = "rejected"; save(id, items); return { ok: true };
    });
  }
  async function originals(id, query = "", seq, offset = 0, archiveId) {
    const v = await snapshot(id);
    const access = new Map(contextCoverage(v.events, v.fold, messageOf).items.map(i => [i.seq, i]));
    const accessOf = event => memoryAccess(event, !event.archiveId && v.fold.nodes.includes(event.seq), access.get(event.seq)?.summarySeq);
    if (!Number.isSafeInteger(offset) || offset < 0) throw fail("分页位置无效");
    const archives = load(id).filter(c => c.status === "applied" && c.original?.toolCallId).map(c => {
      const event = v.events.find(e => e.seq === c.seq);
      return event?.type === "tool/result" ? { ...event, archiveId: c.candidateId, data: { ...event.data, message: { ...messageOf(event), content: c.original.blocks } } } : null;
    }).filter(Boolean);
    const rows = archiveId ? archives.filter(e => e.archiveId === archiveId) : [...v.events.filter(e => memoryEvent(e) || e.type === "tool/result"), ...archives];
    if (seq !== undefined) {
      sequence(seq); const event = rows.find(e => e.seq === seq);
      if (!event) throw fail("原文不存在", 404);
      const text = textOf(messageOf(event));
      return { ok: true, seq, archiveId: event.archiveId, ...accessOf(event), contentRevision: v.revision, ...describe(event), text: text.slice(offset, offset + 20000), totalChars: text.length,
        nextOffset: offset + 20000 < text.length ? offset + 20000 : null, active: !event.archiveId && v.fold.nodes.includes(seq) };
    }
    const hits = rows.filter(e => !query || textOf(messageOf(e)).toLowerCase().includes(query.toLowerCase()));
    return { ok: true, contentRevision: v.revision, total: hits.length, offset, nextOffset: offset + 40 < hits.length ? offset + 40 : null,
      items: hits.slice(offset, offset + 40).map(e => ({ ...describe(e), archiveId: e.archiveId, ...accessOf(e), active: !e.archiveId && v.fold.nodes.includes(e.seq) })) };
  }
  return { list, propose, apply, reject, originals };
}

export function registerWorkbench(ctx, route, computeSurface) {
  const service = createWorkbench(ctx, computeSurface);
  const wrap = run => async request => { try { return json(await run(request)); } catch (error) { return err(String(error?.message ?? error), error.status ?? 500, {}, error); } };
  route("/api/session-editor/workbench", ["GET"], wrap(r => service.list(new URL(r.url).searchParams.get("id"))));
  route("/api/session-editor/workbench/originals", ["GET"], wrap(r => { const p = new URL(r.url).searchParams; return service.originals(p.get("id"), p.get("query") ?? "", p.has("seq") ? Number(p.get("seq")) : undefined, Number(p.get("offset") ?? 0), p.get("archiveId") ?? undefined); }));
  for (const action of ["propose", "apply", "reject"]) route(`/api/session-editor/workbench/${action}`, ["POST"], wrap(async r => {
    const b = await r.json(); return action === "propose" ? service.propose(b.id, b, r.signal) : service[action](b.id, b.candidateId, r.signal);
  }));
  return service;
}
