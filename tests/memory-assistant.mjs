import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAssistant, registerMemoryAssistant, selectedModel } from "../plugins/dsh-session-editor/lib/memory-assistant.js";
import { contentRevision, rewriteMessage } from "../plugins/dsh-session-editor/lib/physical-edit.js";
import { assertObjectJsonSchema, validateJsonSchemaValue } from "../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (v, status = 200) => new Response(JSON.stringify(v), { status });
function fixture() {
  const blocks = [{ type: "reasoning", text: "thought one" }, { type: "text", text: "old body" }, { type: "image", url: "attachment://image" },
    { type: "thinking", thinking: "thought two" }, { type: "text", text: "second paragraph" }, { type: "tool-call", id: "call", name: "test", arguments: "{}" }];
  let events = [{ seq: 0, type: "assistant/message", data: { message: { role: "assistant", content: blocks } } },
    { seq: 1, type: "user/message", data: { role: "user", source: { kind: "compact-checkpoint", compactionId: "test" }, content: [{ type: "text", text: "<compacted-summary>summary</compacted-summary>" }] } }];
  let visible = [0, 1], generation = 0;
  const persisted = new Map([["target", { id: "target", cwd: "D:\\workspace", createdAt: 1 }]]);
  const live = new Map(), tools = new Map(), handles = [], requests = [], listeners = new Map();
  const stats = { creates: 0, resumes: 0, closedReads: 0, writes: 0, locked: false, delay: null, failFlush: false };
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: "configured", model: "default", reasoningEffort: "high" }) },
    sessionPersistence: {
      stat: async id => persisted.has(id) ? { header: persisted.get(id) } : undefined,
      list: async () => [...persisted.values()].map(header => ({ header })),
      open: async (id, access) => { assert.ok(id === 'target' || id.startsWith('session-editor-memory-')); assert.equal(access, "read"); return { read: async (offset, limit) => ({ events: id === 'target' ? events.slice(offset, offset + limit) : [] }), close: async () => { stats.closedReads++; } }; },
    },
    sessions: { flush: async () => { if (stats.failFlush) throw new Error("flush failed"); } },
    agents: { get: id => live.get(id), create: async o => { stats.creates++; return build(o, false); }, resume: async o => { stats.resumes++; return build(o, true); } },
    on: (event, fn) => { if (event === 'dispose') ctx.unload = fn; else listeners.set(event, fn); },
  };
  async function build(o, resume) {
    const id = resume ? o.resumeSessionId : o.sessionId;
    const defs = new Map();
    const scopedListeners = new Map();
    const scoped = { on: (event, fn) => { scopedListeners.set(event, fn); }, tools: { restrict: v => assert.deepEqual(v, { allow: [] }), presentAs: v => assert.equal(v, "native"),
      guard: fn => { assert.ok(fn({ name: "Bash" })); assert.equal(fn({ name: "read_context" }), undefined); },
      register: def => { assertObjectJsonSchema(def.parameters); assertObjectJsonSchema(def.output.schema); defs.set(def.name, def); } },
      systemPrompt: { suppressRuntimeContext: () => { stats.suppressed = (stats.suppressed ?? 0) + 1; }, section: p => { assert.equal(p.complete, true); assert.match(p.text, /expectRevision/); assert.match(p.text, /未知/); } } };
    const agent = { id, options: o.agentOptions, status: "idle", ctx: scoped, session: { header: resume ? persisted.get(id) : { id, ...o.meta }, append: (type, data) => { assert.equal(type, 'model/selection'); assert.deepEqual(data, o.agentOptions); } },
      cancel: cause => { agent.cancelCause = cause; agent.status = "idle"; }, followup: message => { agent.message = message; agent.status = "running"; } };
    const commit = await o.setup?.(scoped, agent);
    commit?.commit();
    await listeners.get('agent/created')?.({ agent });
    if (stats.delay) await stats.delay.promise; // Intentionally ignore signal to simulate a late factory.
    tools.set(id, defs);
    if (!resume) persisted.set(id, { id, ...o.meta, createdAt: 10 + stats.creates });
    live.set(id, agent);
    const handle = { agent, scopedListeners, disposed: 0, dispose: async () => { handle.disposed++; scopedListeners.get('dispose')?.(); live.delete(id); } };
    handles.push(handle);
    return handle;
  }
  function context() {
    return { ok: true, contentRevision: contentRevision(events), messages: [...new Set([...visible, ...events.filter(e => e.seq >= 2).map(e => e.seq)])].map(seq => {
      const event = events.find(e => e.seq === seq), message = event.type === 'user/message' ? event.data : event.data?.message;
      return { seq, type: event.type, role: message?.role ?? (event.type === 'user/message' ? 'user' : 'assistant'), checkpoint: seq === 1,
        source: message?.source?.kind, blocks: message?.content ?? [], chars: 100 };
    }) };
  }
  async function dispatch(req) {
    const path = new URL(req.url).pathname.split("/").pop();
    const body = req.method === "POST" ? await req.json() : null;
    requests.push({ path, body });
    assert.equal(body?.id ?? new URL(req.url).searchParams.get("id"), "target");
    if (path === "context") return response(context());
    if (path === "summary") return response({ ok: true, contentRevision: contentRevision(events), summaries: [{ seq: 1, chars: 7, editText: "summary" }] });
    if (path === "nodes") return response({ ok: true, contentGeneration: generation });
    if (path === "attach") {
      if (!live.has("target")) live.set("target", { status: "idle", session: { snapshotEvents: () => events }, runMaintenance: async fn => fn() });
      return response({ ok: true });
    }
    if (stats.locked) return response({ error: "locked" }, 409);
    if (body.expectRevision !== contentRevision(events)) return response({ error: "revision conflict" }, 409);
    if (path === "propose") return response({ ok: true, candidate: { candidateId: "draft-1", kind: body.kind, members: [body.seq ?? body.startSeq], status: "pending" } });
    if (path === "edit" && body.blocks) { assert.equal(body.physical, true); rewriteMessage(events, body.seq, body.blocks); }
    else if (path === "edit") events[1].data.content = [{ type: "text", text: body.text }];
    else if (path === "delete-node") { assert.equal(body.expectGeneration, generation); visible = visible.filter(seq => seq !== body.seq); events.push({ seq: events.length, type: "tombstone" }); }
    else throw new Error(`unexpected route ${path}`);
    generation++; stats.writes++;
    return response({ ok: true, contentRevision: contentRevision(events) });
  }
  const assistant = createMemoryAssistant(ctx, dispatch);
  async function invoke(name, args = {}, signal = new AbortController().signal) {
    const id = assistant.status("target").sessionId;
    const def = tools.get(id).get(name);
    assert.deepEqual(validateJsonSchemaValue(def.parameters, args), []);
    const result = await def.execute(args, { signal });
    assert.deepEqual(validateJsonSchemaValue(def.output.schema, result), []);
    assert.equal(typeof def.output.render(args, result)[0].text, "string");
    return result;
  }
  return { assistant, ctx, invoke, stats, handles, tools, persisted, live, requests, blocks, listeners, revision: () => contentRevision(events), events: () => events, context };
}

test("concurrent open coalesces; native scoped tools and configured model", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.assistant.open("target"), f.assistant.open("target")]);
  assert.equal(a.sessionId, b.sessionId); assert.equal(f.stats.creates, 1);
  assert.deepEqual(a.model, { provider: "configured", model: "default", reasoningEffort: "high" });
  assert.equal(f.tools.get(a.sessionId).size, 9);
  assert.equal(a.targetId, "target");
  await f.assistant.dispose(); assert.equal(f.handles[0].disposed, 1);
});

test("reads page full originals explicitly, search and summaries carry revision", async () => {
  const f = fixture(); await f.assistant.open("target");
  const page = await f.invoke("read_context", { limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.nextOffset, 1); assert.equal(page.contentRevision, f.revision());
  assert.equal((await f.invoke("read_history", { limit: 1 })).nextOffset, 1);
  let assembled = "", offset = 0, r;
  do { r = await f.invoke("read_message", { seq: 0, source: "history", charOffset: offset, charLimit: 40 }); assembled += r.text; offset = r.nextCharOffset; } while (offset !== null);
  const original = JSON.parse(assembled);
  assert.equal(original.seq, 0); assert.equal(original.blocks[0].text, "thought one");
  assert.deepEqual(original.blocks[2], { index: 2, type: "protected", editable: false });
  assert.equal(original.blocks[3].index, 3); assert.equal(original.blocks[3].thinking, "thought two");
  assert.equal(original.blocks[5].type, "protected"); assert.equal(original.data, undefined);
  // Reading through history does not make a currently retained message read-only.
  assert.equal(r.readOnly, false); assert.equal(r.editable, true); assert.equal(r.editKind, "message");
  const summary = await f.invoke("read_message", { seq: 1, source: "history" });
  assert.equal(summary.editable, true); assert.equal(summary.editKind, "summary");
  assert.equal((await f.invoke("search_memory", { query: "thought two" })).items[0].seq, 0);
  assert.equal((await f.invoke("search_memory", { query: "old body", source: "history" })).total, 1);
  assert.equal((await f.invoke("read_summaries", { seq: 1 })).text, "summary");
  assert.equal((await f.invoke("read_message", { seq: 999 })).ok, false);
  assert.ok(f.stats.closedReads > 1);
  await f.assistant.dispose();
});

test("edit preserves protected blocks, updates indexed thoughts, explicitly clears", async () => {
  const f = fixture(); await f.assistant.open("target");
  const edited = await f.invoke("edit_message", { seq: 0, expectRevision: f.revision(), text: "new body", thinking: [{ index: 3, text: "new thought" }] });
  assert.equal(edited.ok, true);
  const b = f.events()[0].data.message.content;
  assert.deepEqual(b[0], f.blocks[0]); assert.equal(b[1].text, "new body"); assert.deepEqual(b[2], f.blocks[2]);
  assert.equal(b[3].thinking, "new thought"); assert.deepEqual(b[4], f.blocks[5]);
  assert.equal((await f.invoke("edit_message", { seq: 0, expectRevision: f.revision(), clearThinking: true })).ok, true);
  assert.deepEqual(f.events()[0].data.message.content.map(b => b.type), ["text", "image", "tool-call"]);
  assert.equal(f.assistant.status("target").changeCount, 2);
  await f.assistant.dispose();
});

test("write gates reject stale revision, running target, locks and covered originals", async () => {
  const f = fixture(); await f.assistant.open("target");
  let r = await f.invoke("edit_message", { seq: 0, expectRevision: "stale", text: "bad" }); assert.equal(r.status, 409);
  f.live.set("target", { status: "running" });
  r = await f.invoke("edit_message", { seq: 0, expectRevision: f.revision(), text: "bad" }); assert.match(r.error, /生成/);
  f.live.delete("target"); f.stats.locked = true;
  r = await f.invoke("edit_message", { seq: 0, expectRevision: f.revision(), text: "bad" }); assert.match(r.error, /locked/);
  f.stats.locked = false;
  assert.equal((await f.invoke("remove_from_context", { seq: 0, expectRevision: f.revision() })).ok, true);
  assert.equal((await f.invoke("edit_message", { seq: 0, expectRevision: f.revision(), text: "bad" })).ok, false);
  assert.equal((await f.invoke("read_message", { seq: 0, source: "history" })).readOnly, true);
  assert.equal(f.stats.writes, 1); assert.equal(f.assistant.status("target").changeCount, 1);
  await f.assistant.dispose();
});

test("summary uses guarded business API and history remains readable", async () => {
  const f = fixture(); await f.assistant.open("target");
  assert.equal((await f.invoke("edit_summary", { seq: 0, text: "no", expectRevision: f.revision() })).ok, false);
  assert.equal((await f.invoke("edit_summary", { seq: 1, text: "updated", expectRevision: f.revision() })).ok, true);
  assert.equal(f.requests.at(-1).body.text, "updated");
  assert.equal(f.assistant.status("target").results.at(-1).name, "edit_summary");
  await f.assistant.dispose();
});

test("close/restart resumes only plugin lineage and reinstalls tools; reset creates new", async () => {
  const f = fixture(); const a = await f.assistant.open("target"); await f.assistant.close("target");
  const resumed = createMemoryAssistant(f.ctx, async () => response(f.context()));
  f.persisted.set("foreign", { id: "foreign", origin: "subagent", parentSession: "target", createdAt: 999 });
  assert.equal((await resumed.open("target")).sessionId, a.sessionId);
  assert.equal(f.stats.resumes, 1); assert.equal(f.tools.get(a.sessionId).size, 9);
  const next = await resumed.open("target", true); assert.notEqual(next.sessionId, a.sessionId);
  await resumed.dispose();
});

test("late create after close and unload is cancelled and disposed exactly once", async () => {
  for (const unload of [false, true]) {
    const f = fixture(); f.stats.delay = deferred();
    const pending = f.assistant.open("target");
    while (!f.stats.creates) await new Promise(resolve => setImmediate(resolve));
    const closing = unload ? f.assistant.dispose() : f.assistant.close("target");
    f.stats.delay.resolve();
    await assert.rejects(pending, /取消|关闭/); await closing;
    assert.equal(f.handles.length, 1); assert.equal(f.handles[0].disposed, 1); assert.equal(f.live.size, 0);
    if (unload) await assert.rejects(f.assistant.open("target"), /卸载/);
  }
});

test("failed durable flush cleans owned handle; HTTP prompt/cancel/close are native", async () => {
  const f = fixture(); f.stats.failFlush = true;
  await assert.rejects(f.assistant.open("target"), /flush failed/); assert.equal(f.handles[0].disposed, 1);
  f.stats.failFlush = false; await f.assistant.open("target");
  const request = (action, body) => f.assistant.handle(new Request(`http://local/api/session-editor/assistant/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "target", ...body }) }));
  assert.equal((await request("prompt", { text: "read memory" })).status, 200);
  const agent = f.handles.at(-1).agent; assert.equal(agent.message.source.kind, "user"); assert.equal(agent.message.content[0].text, "read memory");
  await request("cancel"); assert.deepEqual(agent.cancelCause, { kind: "user" });
  await request("close"); assert.equal(f.handles.at(-1).disposed, 1);
});

test("registration exposes exact endpoints and unload drains ownership", async () => {
  const f = fixture(), routes = new Map();
  const a = registerMemoryAssistant(f.ctx, (path, methods, handler) => routes.set(path, { methods, handler }), async () => response({ ok: true }));
  assert.equal(routes.size, 5);
  assert.deepEqual(routes.get("/api/session-editor/assistant/status").methods, ["GET"]);
  await a.open("target"); await f.ctx.unload(); assert.equal(f.handles[0].disposed, 1);
});

test("malformed arguments and cancellation fail without business writes", async () => {
  const f = fixture(); await f.assistant.open("target");
  const defs = f.tools.get(f.assistant.status("target").sessionId);
  const exec = { signal: new AbortController().signal };
  assert.equal((await defs.get("edit_message").execute({ seq: 0, text: "bad" }, exec)).ok, false);
  assert.equal((await defs.get("read_context").execute({ id: "another-target" }, exec)).ok, false);
  assert.equal((await defs.get("read_context").execute({ limit: 51 }, exec)).ok, false);
  const abort = new AbortController(); abort.abort();
  assert.equal((await f.invoke("edit_message", { seq: 0, text: "bad", expectRevision: f.revision() }, abort.signal)).ok, false);
  assert.equal(f.stats.writes, 0);
  await f.assistant.dispose();
});

test("concurrent resets merge and a later close cancels queued reset", async () => {
  const f = fixture(); await f.assistant.open("target");
  const [a, b] = await Promise.all([f.assistant.open("target", true), f.assistant.open("target", true)]);
  assert.equal(a.sessionId, b.sessionId); assert.equal(f.stats.creates, 2);
  const reset = f.assistant.open("target", true);
  const closing = f.assistant.close("target");
  await assert.rejects(reset, /取消/); await closing;
  assert.equal(f.assistant.status("target").sessionId, null);
  await f.assistant.dispose();
});

test('durable model selection restores pending and last-used choices', () => {
  const a = { provider: 'configured', model: 'A' }, b = { provider: 'configured', model: 'B', reasoningEffort: 'high' };
  const request = config => ({ type: 'request/header', data: { header: { config } } });
  const select = data => ({ type: 'model/selection', data });
  assert.equal(selectedModel([]), undefined);
  assert.deepEqual(selectedModel([request(a)]), a);
  assert.deepEqual(selectedModel([request(a), select(b), request(a)]), b);
  assert.deepEqual(selectedModel([select(b), request(b), request(a)]), a);
});

test('every memory read and search excludes non-memory events and protected metadata', async () => {
  const f = fixture();
  const hidden = 'FORBIDDEN-OUTSIDE-MEMORY';
  f.blocks[0].signature = hidden;
  f.blocks[2].url = 'attachment://' + hidden;
  f.blocks[5].arguments = hidden;
  f.events()[0].data.stream = [{ text: hidden }];
  f.events()[0].data.message.source = { kind: 'model', replayState: { hidden } };
  const forbidden = [
    { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: hidden }] } } },
    { type: 'developer/message', data: { message: { role: 'developer', content: [{ type: 'text', text: hidden }] } } },
    { type: 'tool/result', data: { content: hidden } },
    { type: 'request/header', data: { header: { hidden } } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: hidden }] } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: hidden }] } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'unknown-automatic-source' }, content: [{ type: 'text', text: hidden }] } },
  ];
  for (const e of forbidden) f.events().push({ seq: f.events().length, ...e });
  await f.assistant.open('target');
  const revision = f.revision();
  const history = await f.invoke('read_history', { limit: 50 });
  assert.deepEqual(history.items.map(m => m.seq), [0, 1]);
  assert.equal(history.contentRevision, revision);
  for (const source of ['context', 'history']) {
    assert.equal((await f.invoke('search_memory', { query: hidden, source })).total, 0);
    assert.equal((await f.invoke('search_memory', { query: 'thought one', source })).total, 1);
    const read = await f.invoke('read_message', { seq: 0, source, charLimit: 12000 });
    assert.equal(read.ok, true); assert.ok(!JSON.stringify(read).includes(hidden));
    for (let seq = 2; seq < f.events().length; seq++) {
      assert.equal((await f.invoke('read_message', { seq, source })).ok, false);
    }
  }
  for (const name of ['edit_message', 'remove_from_context']) {
    const result = await f.invoke(name, { seq: 2, expectRevision: revision, ...(name === 'edit_message' ? { text: 'bad' } : {}) });
    assert.equal(result.ok, false);
  }
  assert.equal(f.stats.writes, 0);
  assert.equal((await f.invoke('edit_message', { seq: 0, text: 'safe edit', expectRevision: revision })).ok, true);
  assert.equal(f.events()[0].data.message.content.find(b => b.type === 'tool-call').arguments, hidden);
  assert.equal(f.events()[0].data.message.content.find(b => b.type === 'image').url, 'attachment://' + hidden);
  assert.ok(!JSON.stringify(f.assistant.status('target').results.at(-1)).includes(hidden));
  await f.assistant.dispose();
});

test('ordinary web resume reinstalls isolation and legacy assistants cannot bypass it', async () => {
  const f = fixture();
  const legacy = 'session-editor-memory-legacy';
  f.persisted.set(legacy, { id: legacy, cwd: f.persisted.get('target').cwd, parentSession: 'target', createdAt: 999 });
  await assert.rejects(f.ctx.agents.resume({ resumeSessionId: legacy }), /旧版记忆助手/);
  f.persisted.set('session-editor-memory-v1-unopenable', { id: 'session-editor-memory-v1-unopenable', parentSession: 'target', createdAt: 1000 });
  await assert.rejects(f.ctx.agents.resume({ resumeSessionId: 'session-editor-memory-v1-unopenable' }), /旧版记忆助手/);
  const first = await f.assistant.open('target');
  assert.ok(first.sessionId.startsWith('session-editor-memory-v1-'));
  assert.equal(first.legacyArchived, true); assert.equal(first.isolation, 'memory-only-v1');
  assert.equal(f.handles.at(-1).agent.session.header.cwd, f.persisted.get('target').cwd);
  await f.assistant.close('target');
  const direct = await f.ctx.agents.resume({ resumeSessionId: first.sessionId });
  assert.equal(f.tools.get(first.sessionId).size, 9);
  assert.equal(f.stats.suppressed, 2);
  const messages = [{ source: { kind: 'user' }, content: [] }, { source: { kind: 'runtime-context' }, content: [] }, { source: { kind: 'skill-catalog' }, content: [] }];
  const decision = await direct.scopedListeners.get('agent/pre-step')({}, async () => ({ kind: 'enter', messages }));
  assert.deepEqual(decision.messages, [messages[0]]);
  const assembled = await direct.scopedListeners.get('system-prompt/assemble')({}, {}, async () => ({ tools: [{ name: 'read_context' }, { name: 'Bash' }] }));
  assert.deepEqual(assembled.tools, [{ name: 'read_context' }]);
  assert.equal((await f.tools.get(first.sessionId).get('read_context').execute({}, {})).ok, true);
  await direct.dispose();
  assert.equal((await f.tools.get(first.sessionId).get('read_context').execute({}, {})).ok, false);
  await f.assistant.dispose();
});


test('AI candidate tool never applies and rejects protected endpoints and stale input', async () => {
  const f = fixture(); await f.assistant.open('target');
  const before = f.revision();
  const draft = await f.invoke('propose_memory', { kind: 'message', seq: 0, text: 'review me', reason: 'user requested preview', expectRevision: before });
  assert.equal(draft.ok, true); assert.equal(draft.applied, false);
  assert.equal(f.stats.writes, 0); assert.equal(f.revision(), before);
  assert.equal(f.requests.at(-1).path, 'propose');
  assert.equal(f.requests.at(-1).body.id, 'target');
  assert.equal((await f.invoke('propose_memory', { kind: 'message', seq: 999, text: 'bad', reason: 'test', expectRevision: before })).ok, false);
  assert.equal((await f.invoke('propose_memory', { kind: 'message', seq: 0, text: 'bad', reason: 'test', expectRevision: 'old' })).ok, false);
  assert.equal(f.stats.writes, 0);
  await f.assistant.dispose();
});
