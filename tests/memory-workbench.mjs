import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session, foldSurface } from "../app/node_modules/@deepseek-ai/dsh-session/lib/index.js";
import { assertReleasedV4Relationships } from "../app/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js";
import { createWorkbench, trimToolBlocks, changeMemoryBlocks, compressionRanges, selectedRegion } from "../plugins/dsh-session-editor/lib/workbench.js";
import { contentRevision } from "../plugins/dsh-session-editor/lib/physical-edit.js";
const user = (seq, text) => ({ seq, time: 1, type: "user/message", surfaceOp: "append", data: { id: `m${seq}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] } });
test("suggested compression ranges respect surface order, protected gaps and rich blocks", () => {
  const events = [user(8, 'a'), user(2, 'b'),
    { seq: 4, type: 'system/message', data: { message: { role: 'system', content: [{type:'text',text:'protected'}] } } },
    user(1, 'c'), { ...user(5, 'attachment'), data: { role:'user', content:[{type:'image',url:'attachment://x'}] } }, user(9, 'd')];
  const snapshot = { events, fold: { nodes: events.map(e => e.seq) } };
  const ranges = compressionRanges(snapshot);
  assert.deepEqual(ranges.map(r => r.members), [[8,2],[1],[9]]);
  for (const range of ranges) assert.deepEqual(selectedRegion(snapshot,range.startSeq,range.endSeq).map(e=>e.seq),range.members);
  assert.throws(()=>selectedRegion(snapshot,8,1),/系统/);
  assert.throws(()=>selectedRegion(snapshot,1,9),/附件/);
});
function fixture(rows = [user(0, "original fact ".repeat(300)), user(1, "other fact ".repeat(300)), user(2, "recent keep")]) {
  const home = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "memory-workbench-"));
  const previous = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const id = "workbench-test", header = { id, version: 4, createdAt: 1, cwd: home, isSeeded: false };
  let session = Session.create(id, structuredClone(rows), header), live = true, running = false, flushes = 0;
  const dir = join(home, "sessions", "workspace", id); mkdirSync(dir, { recursive: true });
  const persist = () => writeFileSync(join(dir, "session.v4.jsonl.zstd"), [{ type: "session", ...header }, ...session.snapshotEvents()].map(JSON.stringify).join("\n") + "\n"); persist();
  const agent = { get status() { return running ? "running" : "idle"; }, get session() { return session; }, runMaintenance: async fn => { if (running) throw Error("busy"); return fn(new AbortController().signal); } };
  const ctx = { get: () => ({}), agents: { get: () => agent, releaseIdle: async () => { live = false; } }, sessionPersistence: { open: async () => ({ header, inheritedEventCount: 0, close: async () => {} }) }, sessions: { get: () => live ? session : undefined,
    prepare: (id, opts) => { if (live) throw Error("session already exists: real store rejects preparing a live id"); return Session.create(id, opts.seed, opts.meta); }, flush: async () => { flushes++; persist(); } } };
  const compute = async () => { if (!live) { const { loadSession } = await import("../plugins/dsh-session-editor/lib/shadowing.js"); session = Session.create(id, loadSession(dir).events.slice(1), header); } const events = session.snapshotEvents(); return { events, fold: foldSurface(events), bySeq: new Map(events.map(e => [e.seq, e])) }; };
  return { id, home, header, ctx, service: createWorkbench(ctx, compute), get session() { return session; }, revision: () => contentRevision(session.snapshotEvents()), running: v => running = v,
    replace: events => { session = Session.create(id, events, header); persist(); }, validate: () => assertReleasedV4Relationships({ header, events: session.snapshotEvents(), inheritedEventCount: 0 }, new Set(session.snapshotEvents().map(e => e.type))),
    close: () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; } };
}
test("local compaction previews, keeps recent tail, preserves originals and supports nested summaries", async () => {
  const f = fixture(); try {
    const before = f.session.snapshotEvents().length;
    const a = await f.service.propose(f.id, { kind: "compress", startSeq: 0, endSeq: 1, text: "two facts", expectRevision: f.revision() });
    assert.equal(f.session.snapshotEvents().length, before);
    await f.service.apply(f.id, a.candidate.candidateId);
    f.validate(); assert.equal(f.session.surface.nodes.length, 2);
    assert.equal(f.session.deriveMessages().at(-1).content[0].text, "recent keep");
    const original = (await f.service.originals(f.id, "original fact")).items[0];
    assert.equal(original.active, false); assert.equal(original.readOnly, true);
    const id2 = f.session.surface.nodes[0];
    assert.equal(original.summarySeq, id2);
    const summary = await f.service.originals(f.id, "", id2);
    assert.equal(summary.readOnly, false); assert.equal(summary.editable, true); assert.equal(summary.editKind, "summary");
    f.session.append("user/message", { id: "new", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "more facts ".repeat(200) }] }, { surfaceOp: "append" });
    const b = await f.service.propose(f.id, { kind: "compress", startSeq: id2, endSeq: f.session.surface.nodes.at(-1), text: "all facts", expectRevision: f.revision() });
    await f.service.apply(f.id, b.candidate.candidateId); f.validate();
    assert.equal(f.session.surface.nodes.length, 1);
    const count = f.session.snapshotEvents().length;
    assert.equal((await f.service.apply(f.id, b.candidate.candidateId)).alreadyApplied, true);
    assert.equal(f.session.snapshotEvents().length, count);
  } finally { f.close(); }
});
test("candidate members survive outside append but reject changed targets, running state and cancellation", async () => {
  const f = fixture(); try {
    const a = await f.service.propose(f.id, { kind: "compress", startSeq: 0, endSeq: 1, text: "facts", expectRevision: f.revision() });
    f.session.append("user/message", { id: "new", role: "user", content: [{ type: "text", text: "outside selection" }], source: { kind: "user" } }, { surfaceOp: "append" });
    f.running(true); await assert.rejects(f.service.apply(f.id, a.candidate.candidateId), /正在生成/); f.running(false);
    const aborted = AbortSignal.abort(); await assert.rejects(f.service.apply(f.id, a.candidate.candidateId, aborted));
    const events = structuredClone(f.session.snapshotEvents()); events[0].data.content[0].text = "changed"; f.replace(events);
    const count = f.session.snapshotEvents().length;
    await assert.rejects(f.service.apply(f.id, a.candidate.candidateId), /已变化/); assert.equal(f.session.snapshotEvents().length, count);
    await assert.rejects(f.service.propose(f.id, { kind: "compress", startSeq: 0, endSeq: 1, text: "x", expectRevision: "old" }), /版本冲突/);
  } finally { f.close(); }
});
test("tool trim preserves Unicode and rich blocks; draft and restore keep call identity and original bytes", async () => {
  const rich = { type: "image", url: "attachment://keep" }, text = "😀日志".repeat(1000);
  const blocks = [{ type: "text", text }, rich]; const trimmed = trimToolBlocks(blocks, 20, 10, 9);
  assert.equal(trimmed.at(-1), rich); assert.ok(trimmed[0].text.startsWith(Array.from(text).slice(0,20).join("")));
  assert.ok(trimmed[0].text.endsWith(Array.from(text).slice(-10).join(""))); assert.equal(blocks[0].text, text);
  assert.throws(() => trimToolBlocks(blocks, 20000, 2), /没有节省/);
});
test("memory candidate modifies only requested fields and rejects protected ranges", async () => {
  const blocks = [{ type: "reasoning", text: "keep", signature: "s" }, { type: "text", text: "old" }, { type: "tool-call", id: "t", name: "Read", arguments: "{}" }];
  const changed = changeMemoryBlocks(blocks, { text: "new" }); assert.equal(changed[0], blocks[0]); assert.equal(changed[2], blocks[2]);
  assert.throws(() => changeMemoryBlocks(blocks, { thinking: [{ index: 2, text: "bad" }] }), /编号/);
  const f = fixture(); try {
    const bad = await f.service.propose(f.id, { kind: "message", seq: 0, text: "draft", expectRevision: f.revision() });
    await f.service.reject(f.id, bad.candidate.candidateId); await assert.rejects(f.service.apply(f.id,bad.candidate.candidateId), /拒绝/);
    const loaded = createWorkbench(f.ctx, async () => ({ events: f.session.snapshotEvents(), fold: f.session.surface }));
    assert.equal((await loaded.list(f.id)).candidates[0].status,"rejected");
  } finally { f.close(); }
});


test("recall adds exactly one supplemental message and repeated apply never duplicates", async () => {
  const f = fixture(); try {
    const c = await f.service.propose(f.id, { kind: "compress", startSeq: 0, endSeq: 1, text: "facts", expectRevision: f.revision() });
    await f.service.apply(f.id, c.candidate.candidateId);
    const recall = await f.service.propose(f.id, { kind: "recall", seq: 0, expectRevision: f.revision() });
    const before = f.session.snapshotEvents().length;
    await f.service.apply(f.id, recall.candidate.candidateId); f.validate();
    assert.equal(f.session.snapshotEvents().length, before + 1);
    assert.match(f.session.deriveMessages().at(-1).content[0].text, /original fact/);
    const { readFileSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const file = join(f.home, "session-editor", "candidates", createHash("sha256").update(JSON.stringify(f.id)).digest("hex") + ".json");
    const queue = JSON.parse(readFileSync(file, "utf8"));
    queue.items.at(-1).status = "pending"; writeFileSync(file, JSON.stringify(queue));
    await f.service.apply(f.id, recall.candidate.candidateId);
    assert.equal(f.session.snapshotEvents().length, before + 1);
  } finally { f.close(); }
});

test("workbench shares target write guard with direct editor and releases after rejection", async () => {
  const { withSessionWrite } = await import("../plugins/dsh-session-editor/lib/edit.js");
  const f = fixture(); try {
    const c = await f.service.propose(f.id, { kind: "compress", startSeq: 0, endSeq: 1, text: "facts", expectRevision: f.revision() });
    await withSessionWrite(f.ctx, f.id, async () => {
      await assert.rejects(f.service.apply(f.id, c.candidate.candidateId), /正在编辑/);
    });
    await f.service.apply(f.id, c.candidate.candidateId); f.validate();
  } finally { f.close(); }
});


test("tool trim/restore commits obey native content-only replacement and retain call metadata", async () => {
  const content = [{ type: "text", text: "日志😀".repeat(1000) }];
  const source = { kind: "tool", callId: "call-1" };
  const result = { seq: 4, time: 1, type: "tool/result", surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "result-1", role: "tool", source, toolCallId: "call-1", isError: false, content } } };
  const event = (seq, type, data, extra = {}) => ({ seq, time: 1, type, data, ...extra });
  const rows = [event(0, "turn/start", { turn: 1 }), event(1, "step/start", { turn: 1, step: 1 }),
    event(2, "assistant/message", { turn: 1, step: 1, stream: [], message: { id: "a", role: "assistant", source: { kind: "model", provider: "qa", model: "qa" }, content: [{ type: "tool-call", id: "call-1", name: "read", arguments: "{}" }] } }, { surfaceOp: "append" }),
    event(3, "tool/call", { turn: 1, step: 1, callId: "call-1", name: "read", arguments: "{}" }), result,
    event(5, "step/end", { turn: 1, step: 1 }), event(6, "turn/end", { turn: 1 })];
  const f = fixture(rows); try {
    const a = await f.service.propose(f.id, { kind: "tool-trim", seq: 4, head: 20, tail: 10, expectRevision: f.revision() });
    await f.service.apply(f.id, a.candidate.candidateId); await f.service.list(f.id); f.validate();
    const current = 4;
    assert.equal(f.session.snapshotEvents()[current].data.message.id, "result-1");
    const b = await f.service.propose(f.id, { kind: "tool-restore", seq: current, sourceCandidateId: a.candidate.candidateId, expectRevision: f.revision() });
    await f.service.apply(f.id, b.candidate.candidateId); await f.service.list(f.id); f.validate();
    assert.deepEqual(f.session.deriveMessages()[1].content, content);
    assert.deepEqual(f.session.deriveMessages()[1].source, source);
    const archived = await f.service.originals(f.id, "日志");
    assert.ok(archived.items.some(r => r.archiveId === a.candidate.candidateId));
  } finally { f.close(); }
});


test("body and summary field recovery is another reviewed candidate and preserves later fields", async () => {
  const f = fixture(); try {
    const a = await f.service.propose(f.id, { kind: "message", seq: 0, text: "changed body", expectRevision: f.revision() });
    await f.service.apply(f.id, a.candidate.candidateId); await f.service.list(f.id);
    const restore = await f.service.propose(f.id, { kind: "field-restore", seq: 0, sourceCandidateId: a.candidate.candidateId, fields: ["body"], expectRevision: f.revision() });
    assert.equal(f.session.deriveMessages()[0].content[0].text, "changed body");
    await f.service.apply(f.id, restore.candidate.candidateId); await f.service.list(f.id); f.validate();
    assert.equal(f.session.deriveMessages()[0].content[0].text, "original fact ".repeat(300));
  } finally { f.close(); }
});



test("cancel after releasing the live owner closes the write lease without changing history", async () => {
  const f=fixture();try {
    const a=await f.service.propose(f.id,{kind:"message",seq:0,text:"must not commit",expectRevision:f.revision()});
    const controller=new AbortController(), open=f.ctx.sessionPersistence.open;let closes=0;
    f.ctx.sessionPersistence.open=async(...args)=>{const handle=await open(...args);controller.abort();return {...handle,close:async()=>{closes++;await handle.close();}};};
    await assert.rejects(f.service.apply(f.id,a.candidate.candidateId,controller.signal));
    const list=await f.service.list(f.id);
    assert.equal(closes,1);assert.equal(list.candidates[0].status,"pending");
    assert.equal(f.session.deriveMessages()[0].content[0].text,"original fact ".repeat(300));
  }finally{f.close();}
});
