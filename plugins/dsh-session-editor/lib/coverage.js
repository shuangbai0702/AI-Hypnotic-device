// Read-only presentation of the canonical DSH surface. Never infer coverage
// from timestamps or numeric ranges: shadowedSeqs are exact surface membership.
//
// Coverage is a message-level property. DSH replaces complete surface nodes,
// so a reasoning block cannot be covered independently from the text blocks
// in the same assistant message. `thoughtState` is returned separately to
// keep that fact visible without pretending the adapter will replay it.
export const isCompactionCheckpoint = (event) => event?.type === "user/message" &&
  event.data?.source?.kind === "compact-checkpoint";

// A history view is not an editing restriction: actual surface membership is.
export function memoryAccess(event, active, summarySeq = null) {
  const checkpoint = isCompactionCheckpoint(event);
  const message = event?.type === "user/message" ? event.data : event?.data?.message;
  const editable = active && ["user/message", "assistant/message"].includes(event?.type) &&
    [undefined, "user", "model", "session-editor", "compact-checkpoint"].includes(typeof message?.source === "string" ? message.source : message?.source?.kind);
  return { surfaceActive: !!active, editable: !!editable, readOnly: !editable,
    editKind: editable ? checkpoint ? "summary" : "message" : null,
    summarySeq: active && checkpoint ? event.seq : summarySeq,
    accessLabel: editable ? checkpoint ? "生效摘要 · 可编辑" : "当前消息 · 可编辑"
      : active ? "受保护内容" : checkpoint ? "旧摘要 · 已归档，只读" : "已归档原文 · 只读" };
}

const messageBlocks = (message) => Array.isArray(message?.content) ? message.content : [];
const thoughtCountOf = (message) => messageBlocks(message)
  .filter((b) => ["reasoning", "thinking"].includes(b?.type)).length;

function stateOf(status, checkpoint, thoughtCount) {
  if (status === "active" && checkpoint) return "summary-active";
  if (status === "covered") return "summary-covered";
  if (status === "active" && thoughtCount > 0) return "retained-with-thinking";
  if (status === "active") return "retained";
  return status;
}

function thoughtStateOf(status, thoughtCount) {
  if (thoughtCount === 0) return "none";
  if (status === "covered") return "summary-covered";
  if (status === "active") return "retained";
  return "not-active";
}

/**
 * Reconcile the messages that are still on DSH's surface with every exact
 * replacement range. The result is descriptive only; it never writes events.
 */
export function contextCoverage(events, fold, deriveEventMessage) {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const active = new Set(fold.nodes);
  const next = new Map();
  for (const replacement of fold.replacements) {
    for (const seq of replacement.shadowedSeqs ?? []) next.set(seq, replacement.seq);
  }

  const items = [];
  for (const event of events) {
    const message = fold.projectedMessages?.get(event.seq) ?? deriveEventMessage(event);
    if (!message) continue;
    const chain = [];
    const seen = new Set([event.seq]);
    let target = event.seq;
    while (next.has(target)) {
      target = next.get(target);
      if (seen.has(target)) throw new Error("上下文替换链存在循环");
      seen.add(target);
      chain.push(target);
    }
    const summarySeqs = chain.filter((seq) => isCompactionCheckpoint(bySeq.get(seq)));
    const finalEvent = bySeq.get(target);
    const removed = !active.has(event.seq) && active.has(target) &&
      finalEvent?.type === "system/message" && finalEvent.data?.message?.content?.length === 0;
    const status = active.has(event.seq)
      ? "active"
      : removed ? "removed" : summarySeqs.length ? "covered" : chain.length ? "replaced" : "unknown";
    const thoughtCount = thoughtCountOf(message);
    const checkpoint = isCompactionCheckpoint(event);
    const text = messageBlocks(message).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    items.push({
      seq: event.seq,
      role: message.role,
      type: event.type,
      checkpoint,
      status,
      coverageState: stateOf(status, checkpoint, thoughtCount),
      thoughtState: thoughtStateOf(status, thoughtCount),
      thoughtCount,
      fullySummaryCovered: status === "covered",
      ...memoryAccess(event, active.has(event.seq), active.has(target) && isCompactionCheckpoint(finalEvent) ? target : null),
      finalSeq: active.has(target) ? target : null,
      summarySeqs,
      chain,
      text,
      preview: text.slice(0, 240),
    });
  }

  const summaries = items.filter((i) => i.checkpoint && i.status === "active").map((summary) => {
    const covered = items.filter((i) => i.seq !== summary.seq && i.finalSeq === summary.seq);
    const direct = fold.replacements.find((r) => r.seq === summary.seq)?.shadowedSeqs ?? [];
    return {
      seq: summary.seq,
      directSeqs: direct,
      coveredSeqs: covered.map((i) => i.seq),
      userCount: covered.filter((i) => i.role === "user" && !i.checkpoint).length,
      assistantCount: covered.filter((i) => i.role === "assistant").length,
    };
  });
  const counts = Object.fromEntries(["active", "covered", "replaced", "removed", "unknown"]
    .map((status) => [status, items.filter((i) => i.status === status).length]));
  const stateCounts = Object.fromEntries(["summary-covered", "retained-with-thinking", "retained", "summary-active"]
    .map((state) => [state, items.filter((i) => i.coverageState === state).length]));
  return { items, summaries, counts, stateCounts };
}
