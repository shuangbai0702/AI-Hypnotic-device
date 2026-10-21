import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { rewriteMessage, rewriteSummary, summaryBody, contentRevision, physicalEdit, setMessageBlocks } from "../plugins/dsh-session-editor/lib/physical-edit.js";
import { assertReleasedV4Relationships } from "../app/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js";
import { buildReplacementEvent, registerEditRoutes } from "../plugins/dsh-session-editor/lib/edit.js";
import { planAdapter } from "../plugins/dsh-session-editor/host-adapter.mjs";
import { Session } from "../app/node_modules/@deepseek-ai/dsh-session/lib/index.js";
import { projectTurnFooters } from './native-chat-projection.mjs';

const message = (seq, text, from) => ({ seq, type: "user/message", time: 1,
  data: { id: `m${seq}`, role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
  surfaceOp: from === undefined ? "append" : { op: "replace", startSeq: from, endSeq: from },
  ...(from === undefined ? {} : { sourceEventSeqs: [from] }) });

test("shipped client save keeps reasoning/images and the full edited text", () => {
  const clientRoot = process.env.EDITOR_PACKAGE_ROOT ?? resolve("plugins/dsh-session-editor");
  const source = readFileSync(join(clientRoot, "lib/client.js"), "utf8");
  const start = source.indexOf("    function editedBlocks(");
  const end = source.indexOf("    function useLifetime(", start);
  assert.ok(start >= 0 && end > start);
  const edit = runInNewContext(`(() => { ${source.slice(start, end)}; return editedBlocks; })()`);
  const reasoning = { type: "reasoning", text: "keep private reasoning", signature: "sig" };
  const image = { type: "image", url: "attachment://test" };
  const blocks = [reasoning, { type: "text", text: "first" }, image, { type: "text", text: "second" }];
  const full = "长".repeat(12000);
  const result = edit(blocks, full);
  assert.equal(result.length, 3);
  assert.equal(result[0], reasoning);
  assert.equal(result[1].text, full);
  assert.equal(result[2], image);
  assert.equal(blocks[1].text, "first");
  const cleared = edit(blocks, full, true);
  assert.equal(cleared.length, 2);
  assert.equal(cleared[0].text, full);
  assert.equal(cleared[1], image);
  assert.equal(blocks[0], reasoning);
  const thoughtsEdited = edit(blocks, full, false, { 0: "updated thought" });
  assert.equal(thoughtsEdited[0].text, "updated thought");
  assert.equal(reasoning.text, "keep private reasoning");
});

test("assistant edits align replay metadata and preserve unchanged tool signatures", () => {
  const thought = { type: "reasoning", text: "old belief" };
  const tool = { type: "tool-call", id: "call-1", name: "read", arguments: "{}" };
  const original = { seq: 0, type: "assistant/message", data: { message: {
    content: [thought, { type: "text", text: "old answer" }, tool],
    source: { kind: "model", provider: "test", model: "test", replayState: {
      response: { kind: "pi-ai", version: 2, provider: "test", model: "test", responseId: "old-id" },
      blocks: [{ type: "reasoning", thinkingSignature: "reasoning_content" }, { type: "text", textSignature: "old-sig" }, { type: "tool-call", thoughtSignature: "tool-sig" }]
    } }
  } } };
  const edited = buildReplacementEvent(original, [thought, { type: "text", text: "new answer" }, tool]);
  const state = edited.data.message.source.replayState;
  assert.equal(state.blocks[0].thinkingSignature, "reasoning_content");
  assert.equal(state.blocks[1].textSignature, undefined);
  assert.equal(state.blocks[2].thoughtSignature, "tool-sig");
  assert.equal(state.response.responseId, undefined);
  rewriteMessage([original], 0, [{ type: "text", text: "new answer" }, tool]);
  assert.deepEqual(original.data.message.source.replayState.blocks,
    [{ type: "text" }, { type: "tool-call", thoughtSignature: "tool-sig" }]);
  const unknown = structuredClone(original);
  unknown.data.message.source.replayState.response.kind = "other-adapter";
  setMessageBlocks(unknown, [{ type: "text", text: "another answer" }]);
  assert.equal(unknown.data.message.source.replayState, undefined);
});

test("long replacement chain reaches actual original; assistant uses nested content", () => {
  const events = Array.from({ length: 80 }, (_, i) => message(i, String(i), i ? i - 1 : undefined));
  assert.equal(rewriteMessage(events, 79, [{ type: "text", text: "new" }]).originSeq, 0);
  assert.equal(events[0].data.content[0].text, "new");
  assert.equal(events[78].data.content[0].text, "78");
  const assistant = { type: "assistant/message", data: { turn: 1, step: 1, message: { content: [], id: "a" }, usage: {} } };
  const edited = buildReplacementEvent(assistant, [{ type: "text", text: "answer" }]);
  assert.equal(edited.data.message.content[0].text, "answer");
  assert.equal(assistant.data.message.content.length, 0);
  assert.equal(edited.data.content, undefined);
});

test("ambiguous ranges and checkpoints cannot rewrite unrelated original history", () => {
  const events = [message(0, "one"), message(1, "two"), message(2, "summary", 0)];
  events[2].surfaceOp.endSeq = 1;
  assert.throws(() => rewriteMessage(events, 2, []), /不是一对一/);
  assert.equal(events[0].data.content[0].text, "one");
  events[2].data.content[0].text = "<compacted-summary>x</compacted-summary>";
  events[2].data.source = { kind: "compact-checkpoint", compactionId: "test" };
  assert.throws(() => rewriteMessage(events, 2, []), /压缩摘要/);
});

test("summary editing preserves command identity, survives repeated disk validation and retains provider output", () => {
  const header = { id: "session-summary-test", version: 4, createdAt: 1, isSeeded: false };
  const rows = [message(0, "original"),
    { seq: 1, time: 1, type: "command/run", data: { commandId: "cmd-native", name: "compact", args: "", source: { kind: "user" } } },
    { seq: 2, time: 1, type: "compaction/start", data: { compactionId: "native", sourceCommandId: "cmd-native", turn: null } },
    { seq: 3, time: 1, type: "compaction/summary", data: { compactionId: "native", sourceCommandId: "cmd-native", summary: [{type: "text", text: "old"}], rawOutput: [{type: "text", text: "provider-original"}], shadowedRange: {start: 0, end: 0}, shadowedSeqs: [0], shadowedTokenCount: 1 } },
    { ...message(4, "<compacted-summary>old</compacted-summary>", 0), data: { ...message(4, "<compacted-summary>old</compacted-summary>").data, source: {kind: "compact-checkpoint", compactionId: "native", sourceCommandId: "cmd-native"} } },
    { seq: 5, time: 1, type: "compaction/end", data: {compactionId: "native", sourceCommandId: "cmd-native", turn: null} }];
  const validate = (events) => assertReleasedV4Relationships({header, events, inheritedEventCount: 0}, new Set(events.map(e => e.type)));
  validate(rows);
  for (const value of ["updated summary", "second edit " + "长".repeat(12000)]) {
    rewriteSummary(rows, 4, value);
    validate(JSON.parse(JSON.stringify(rows)));
    assert.equal(summaryBody(rows[4].data.content.map(b => b.text).join("\n")), value);
    assert.equal(rows[3].data.summary[0].text, value);
    assert.equal(rows[3].data.rawOutput[0].text, "provider-original");
    assert.equal(rows[4].data.source.sourceCommandId, "cmd-native");
    assert.equal(rows.length, 6);
  }
  const broken = structuredClone(rows);
  delete broken[2].data.sourceCommandId;
  delete broken[3].data.sourceCommandId;
  delete broken[5].data.sourceCommandId;
  assert.throws(() => validate(broken), /compaction checkpoint has no matching/);
});

test("POST operations on same session reject overlap and release guard after failure", async () => {
  const routes = new Map();
  let entered, finish;
  const ready = new Promise((r) => entered = r);
  const barrier = new Promise((r) => finish = r);
  const ctx = { sessions: { get() { entered(); return undefined; } }, get() { return {}; },
    agents: { async resume() { await barrier; throw new Error("controlled failure"); } } };
  registerEditRoutes(ctx, (p, _m, h) => routes.set(p, h), null);
  const call = () => routes.get("/api/session-editor/attach")(new Request("http://local/attach", { method: "POST", body: JSON.stringify({ id: "test" }) }));
  const first = call();
  await ready;
  assert.equal((await call()).status, 409);
  finish();
  assert.equal((await first).status, 500);
  assert.equal((await call()).status, 500);
});

test("physical sync releases live owner, holds write lease, validates and keeps event count", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-editor-log-"));
  const id = "session-editor-test";
  const dir = join(root, "sessions", "workspace", id);
  mkdirSync(dir, { recursive: true });
  const header = { type: "session", id, version: 4, createdAt: 1, cwd: root, isSeeded: false };
  const rows = [message(0, "old"), message(1, "edited", 0)];
  const file = join(dir, "session.v4.jsonl.zstd");
  writeFileSync(file, [header, ...rows].map(JSON.stringify).join("\n") + "\n");
  const before = readFileSync(file);
  let live = {}, leased = false;
  const order = [];
  const ctx = { agents: { get: () => ({ status: "idle" }), async releaseIdle() { order.push("release"); live = null; } },
    sessions: { get: () => live, prepare(id, options) { assert.ok(leased); order.push("validate"); return Session.create(id, options.seed, options.meta); } },
    sessionPersistence: { async open() { assert.equal(live, null); leased = true; order.push("lease"); return { header, inheritedEventCount: 0,
      async close() { leased = false; order.push("close"); } }; } } };
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    const body = { id, seq: 1, blocks: [{ type: "text", text: "final" }], expectRevision: "outdated" };
    await assert.rejects(physicalEdit(ctx, body, async () => {}), /版本冲突/);
    assert.deepEqual(readFileSync(file), before);
    body.expectRevision = contentRevision(rows);
    order.length = 0;
    const result = await physicalEdit(ctx, body, async () => {});
    assert.equal(result.ok, true);
    assert.deepEqual(order, ["lease", "validate", "close"]);
    assert.equal(result.edit.newSeq, 1);
    assert.equal(leased, false);
  } finally { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; }
});

test("install, reinstall, uninstall preserve host bytes; unknown builds are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-editor-install-"));
  const app = join(root, "app"), home = join(root, "home");
  cpSync(resolve('app/node_modules/js-yaml'), join(app, 'node_modules/js-yaml'), { recursive: true });
  const files = ["dsh-agent", "dsh-agent-loop"].map((pkg) => `node_modules/@deepseek-ai/${pkg}/lib/index.js`);
  files.push("node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js");
  for (const file of files) { mkdirSync(join(app, file, ".."), { recursive: true }); cpSync(resolve("app", file), join(app, file)); }
  // Obtain original bytes even when this working copy already has the adapter.
  const manifest = resolve("app/.session-editor-adapter/manifest.json");
  if (existsSync(manifest)) for (const m of JSON.parse(readFileSync(manifest, "utf8"))) {
    cpSync(resolve("app/.session-editor-adapter", m.original), join(app, m.path));
  }
  const originals = files.map((f) => readFileSync(join(app, f)));
  const installer = process.env.EDITOR_PACKAGE_ROOT ? join(process.env.EDITOR_PACKAGE_ROOT, "install.mjs") : "plugins/dsh-session-editor/install.mjs";
  const run = (...args) => spawnSync(process.execPath, [installer, "--app", app, "--home", home, ...args], { encoding: "utf8" });
  const check = run('--check'); assert.equal(check.status, 0, check.stderr);
  assert.equal(existsSync(join(home, '.session-editor-install/install.json')), false);
  files.forEach((f, i) => assert.deepEqual(readFileSync(join(app, f)), originals[i]));
  let installResult = run(); assert.equal(installResult.status, 0, installResult.stderr);
  const installedPrompt = join(home, 'profiles/web/node_modules/@shuangbai/dsh-session-editor/AGENT.md');
  writeFileSync(installedPrompt, 'user-customized assistant prompt');
  assert.equal(JSON.parse(readFileSync(join(home, 'profiles/web/node_modules/@shuangbai/dsh-session-editor/host.json'), 'utf8')).app, app);
  // Reproduce an existing 0.2 installation: only the two host lifecycle files
  // were managed there. Upgrade must add the client adapter and retain originals.
  const adapterManifest = join(app, ".session-editor-adapter/manifest.json");
  const installed = JSON.parse(readFileSync(adapterManifest, "utf8"));
  writeFileSync(adapterManifest, JSON.stringify(installed.slice(0, 2)));
  writeFileSync(join(app, files[2]), originals[2]);
  for (let i = 0; i < 2; i++) { const r = run(); assert.equal(r.status, 0, r.stderr); }
  assert.equal(readFileSync(installedPrompt, 'utf8'), 'user-customized assistant prompt');
  assert.equal(JSON.parse(readFileSync(adapterManifest, "utf8")).length, 3);
  assert.match(readFileSync(join(home, "profiles/web/cordis.patch.yml"), "utf8"), /session-editor/);
  const r = run("--uninstall"); assert.equal(r.status, 0, r.stderr);
  files.forEach((f, i) => assert.deepEqual(readFileSync(join(app, f)), originals[i]));
  writeFileSync(join(app, files[0]), "unrecognized build");
  assert.throws(() => planAdapter(app), /其他修改/);
});

test('remove gate rejects running, stale and inactive nodes before any append', async () => {
  const routes = new Map(), events = [message(0, 'keep')];
  let running = false, active = true, appends = 0;
  const session = { snapshotEvents: () => events, get surface() { return { nodes: active ? [0] : [], contentGeneration: 0 }; }, append() { appends++; throw new Error('unexpected write'); } };
  registerEditRoutes({ sessions: { get: () => session }, agents: { get: () => ({ status: running ? 'running' : 'idle' }) } }, (path, _methods, handler) => routes.set(path, handler), null);
  const call = expectRevision => routes.get('/api/session-editor/delete-node')(new Request('http://local/delete', { method: 'POST', body: JSON.stringify({ id: 'test', seq: 0, expectRevision }) }));
  assert.equal((await call('stale')).status, 409);
  running = true; assert.equal((await call(contentRevision(events))).status, 409);
  running = false; active = false; assert.equal((await call(contentRevision(events))).status, 409);
  assert.equal(appends, 0);
});

test('three consecutive removals survive native chat projection and reopen without losing history', async () => {
  const header = { type: 'session', id: 'session-remove-test', version: 4, createdAt: 1, cwd: tmpdir(), isSeeded: false };
  const rows = [
    { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, time: 1, type: 'system/message', surfaceOp: 'append', data: { turn: 1, step: 1,
      message: { id: 'original-system', role: 'system', content: [{ type: 'text', text: 'protected' }], source: { kind: 'system-prompt' } } } },
    { seq: 3, time: 1, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 4, time: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    message(5, 'first'), message(6, 'second'), message(7, 'third')
  ];
  const session = Session.create(header.id, rows, header);
  const routes = new Map(); let flushed;
  registerEditRoutes({ sessions: { get: () => session, async flush(s) { flushed = s.snapshotEvents(); } },
    agents: { get: () => ({ status: 'idle' }) } }, (p, _m, h) => routes.set(p, h), null);
  const replacements = [];
  for (const seq of [5, 6, 7]) {
    const response = await routes.get('/api/session-editor/delete-node')(new Request('http://local/delete', {
      method: 'POST', body: JSON.stringify({ id: header.id, seq, expectRevision: contentRevision(session.snapshotEvents()) })
    }));
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    replacements.push(result.edit.newSeq);
    assert.equal(projectTurnFooters(flushed).length, replacements.length + 1);
    assertReleasedV4Relationships({ header, events: flushed, inheritedEventCount: 0 }, new Set(flushed.map(e => e.type)));
    const reopened = Session.create(header.id, flushed, header);
    assert.ok(!reopened.surface.nodes.includes(seq));
    assert.deepEqual(flushed.slice(0, rows.length), rows);
  }
  const removed = replacements.map(seq => flushed.find(e => e.seq === seq));
  assert.equal(new Set(removed.map(e => e.data.message.id)).size, 3);
  assert.ok(removed.every(e => e.data.message.source.kind === 'system-prompt' && e.data.message.content.length === 0));
  const oldBug = structuredClone(flushed);
  delete oldBug.findLast(e => e.type === 'turn/end').data.reason;
  assert.throws(() => projectTurnFooters(oldBug), /kind/);
});

function boundaryFixture() {
  const header = { type: 'session', id: 'session-boundary-test', version: 4, createdAt: 1, cwd: tmpdir(), isSeeded: false };
  const session = Session.create(header.id, undefined, header);
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 });
  session.append('system/message', { turn: 1, step: 1, message: { id: 'system', role: 'system', source: { kind: 'system-prompt' }, content: [] } }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const target = session.append('user/message', message(0, 'memory').data, { surfaceOp: 'append' }).seq;
  let running = false;
  const routes = new Map();
  registerEditRoutes({ sessions: { get: () => session, flush: async () => {} }, agents: { get: () => ({ status: running ? 'running' : 'idle' }) } }, (p, _m, h) => routes.set(p, h), null);
  return { session, target, running: value => running = value,
    call: (route, body) => routes.get('/api/session-editor' + route)(new Request('http://local' + route, { method: 'POST', body: JSON.stringify({ id: header.id, ...body }) })),
    validate: () => { const events = session.snapshotEvents(); Session.create(header.id, events, header);
      assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, new Set(events.map(e => e.type))); projectTurnFooters(events); } };
}

test('remove after restore or between steps keeps the existing turn and valid step ownership', async () => {
  for (const restored of [false, true]) for (const stepOpen of [false, true]) {
    const f = boundaryFixture();
    f.session.append('turn/start', { turn: 2 }); f.session.append('step/start', { turn: 2, step: 1 });
    if (!stepOpen) f.session.append('step/end', { turn: 2, step: 1 });
    if (restored) f.session.append('session/end-seed', {});
    f.validate();
    const response = await f.call('/delete-node', { seq: f.target, expectRevision: contentRevision(f.session.snapshotEvents()) });
    assert.equal(response.status, 200, await response.text()); f.validate();
    assert.equal(f.session.snapshotEvents().filter(e => e.type === 'turn/start').length, 2);
    assert.ok(!f.session.surface.nodes.includes(f.target));
    const inserted = await f.call('/insert', { role: 'system', blocks: [{ type: 'text', text: 'boundary test' }], expectRevision: contentRevision(f.session.snapshotEvents()) });
    assert.equal(inserted.status, 200, await inserted.text()); f.validate();
    assert.equal(f.session.snapshotEvents().filter(e => e.type === 'turn/start').length, 2);
  }
});

test('legacy mutation gates reject running, stale, archived and summary targets before writing', async () => {
  const f = boundaryFixture();
  const unchanged = async (route, body, status) => {
    const before = f.session.snapshotEvents(); const r = await f.call(route, body);
    assert.equal(r.status, status, await r.text()); assert.deepEqual(f.session.snapshotEvents(), before);
  };
  f.running(true);
  await unchanged('/insert', { role: 'user', blocks: [] }, 409);
  await unchanged('/edit', { seq: f.target, blocks: [] }, 409);
  f.running(false);
  await unchanged('/insert', { role: 'user', blocks: [], expectRevision: 'stale' }, 409);
  await unchanged('/edit', { seq: f.target, blocks: [], expectRevision: 'stale' }, 409);
  const original = f.session.eventAt(f.target);
  f.session.append('user/message', original.data, { surfaceOp: { op: 'replace', startSeq: f.target, endSeq: f.target }, sourceEventSeqs: [f.target] });
  await unchanged('/edit', { seq: f.target, blocks: [] }, 409);
  // The ordinary editing API must never duplicate a compaction checkpoint.
  const routes = new Map(); const summary = { ...message(0, 'summary'), data: { ...message(0, '').data, source: { kind: 'compact-checkpoint', compactionId: 'c' } } };
  registerEditRoutes({ sessions: { get: () => ({ snapshotEvents: () => [summary], eventAt: () => summary, surface: { nodes: [0], contentGeneration: 0 }, append: () => { throw Error('must not append checkpoint'); } }) }, agents: { get: () => ({ status: 'idle' }) } }, (p, _m, h) => routes.set(p, h), null);
  const r = await routes.get('/api/session-editor/edit')(new Request('http://local/edit', { method: 'POST', body: JSON.stringify({ id: 'test', seq: 0, blocks: [] }) }));
  assert.equal(r.status, 422, await r.text());
});
