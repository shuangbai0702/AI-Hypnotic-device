// Explicit opt-in: run only against a disposable, already-installed DSH copy.
// Owns its server process; uses a local model stub and restores its profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadSession } from '../plugins/dsh-session-editor/lib/shadowing.js';

assert.equal(process.env.EDITOR_TEST_DISPOSABLE, 'yes', 'explicit disposable target required');
assert.ok(process.env.EDITOR_TEST_APP && process.env.EDITOR_TEST_HOME);
const app = resolve(process.env.EDITOR_TEST_APP), home = resolve(process.env.EDITOR_TEST_HOME);
const port = Number(process.env.EDITOR_TEST_PORT);
assert.ok(port >= 1024 && port <= 65535 && ![3080, 3099].includes(port));
const requireHost = createRequire(join(app, 'package.json')), yaml = requireHost('js-yaml');
const { Session } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session')));
const { assertReleasedV4Relationships } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')));
const config = join(home, 'profiles/web/cordis.patch.yml'), original = fs.readFileSync(config);
const captures = []; let modelFailure, service, serviceOutput = '', cookie, id;
const mock = createServer(async (request, response) => {
  try {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); captures.push(payload);
    assert.ok(Array.isArray(payload.messages));
    const answer = captures.length === 1 ? 'QA_OLD_ASSISTANT_ANSWER' : 'QA_FOLLOWUP_' + captures.length;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'local-qa', object: 'chat.completion.chunk', model: 'qa', created: 1 };
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: answer }, null], [{}, 'stop']]) {
      response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    }
    response.end('data: [DONE]\n\n');
  } catch (error) { modelFailure = error; response.writeHead(500); response.end('local test failure'); }
});
await new Promise((done, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', done); });
const origin = `http://127.0.0.1:${port}`;
const pause = () => new Promise(done => setTimeout(done, 100));
async function waitFor(check, label) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (modelFailure) throw modelFailure;
    if (service && service.exitCode !== null) throw Error('Owned DSH process exited during ' + label);
    if (await check()) return;
    await pause();
  }
  throw Error('Timed out: ' + label);
}
async function stop() {
  if (!service) return;
  const owned = service; service = undefined;
  if (owned.exitCode === null) { const ended = once(owned, 'exit'); owned.kill(); await ended; }
}
async function start() {
  serviceOutput = '';
  service = spawn(process.execPath, [join(app, 'lib/bin.js'), 'web', '--port', String(port), '--no-open'], {
    env: { ...process.env, DSH_HOME: home, QA_LOCAL_API_KEY: 'local-model-only' }, cwd: home, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  service.stdout.on('data', chunk => { serviceOutput += chunk; });
  service.stderr.on('data', () => {});
  service.on('error', error => { modelFailure = error; });
  await waitFor(() => /\?token=([^\s\x1b]+)/.test(serviceOutput), 'launch token');
  const token = serviceOutput.match(/\?token=([^\s\x1b]+)/)[1];
  const auth = await fetch(origin + '/?token=' + encodeURIComponent(token), { redirect: 'manual' });
  cookie = auth.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie, 'authenticated cookie');
  const page = await fetch(origin, { headers: { cookie } }); assert.equal(page.status, 200);
  const html = await page.text();
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)) {
    const url = new URL(match[1], origin); assert.equal(url.origin, origin);
    const asset = await fetch(url, { headers: { cookie } }); assert.equal(asset.status, 200);
    assert.ok((await asset.arrayBuffer()).byteLength);
  }
}
async function request(path, body) {
  const result = await fetch(origin + path, { method: body ? 'POST' : 'GET',
    headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const value = await result.json(); assert.ok(result.ok, JSON.stringify(value)); return value;
}
async function rpc(method, input) {
  const value = await request('/api/session/' + method, { type: 'client-request', rpcId: randomUUID(),
    method: 'session/' + method, payload: { args: { request: input } } });
  assert.equal(value.result.ok, true, JSON.stringify(value.result)); return value.result.value;
}
const api = (path, body) => request('/api/session-editor' + path, body ? { id, ...body } : undefined);
const context = () => api('/context?id=' + id);
const workbench = () => api('/workbench?id=' + id);
async function apply(change) {
  const before = await workbench();
  const draft = await api('/workbench/propose', { ...change, expectRevision: before.contentRevision });
  await api('/workbench/apply', { candidateId: draft.candidate.candidateId });
}
async function prompt(text) {
  const count = captures.length;
  await rpc('prompt', { sessionId: id, requestId: randomUUID(), content: [{ type: 'text', text }], mode: 'queue' });
  await waitFor(async () => captures.length > count && (await context()).messages.some(m => m.role === 'assistant' && m.text.includes(count ? 'QA_FOLLOWUP_' : 'QA_OLD_ASSISTANT_ANSWER')), 'completed model reply');
  // Admission can publish a final message before its turn/end is flushed.
  await waitFor(async () => {
    const events = await api('/events?id=' + id);
    return events.events.findLast(e => e.type.startsWith('turn/'))?.type === 'turn/end';
  }, 'durable completed turn');
}
function validateStoredSession() {
  const directory = fs.readdirSync(join(home, 'sessions')).map(name => join(home, 'sessions', name, id)).find(path => fs.existsSync(join(path, 'session.v4.jsonl.zstd')));
  assert.ok(directory);
  const rows = loadSession(directory).events, header = rows[0], events = rows.slice(1);
  Session.create(id, events, header);
  assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, new Set(events.map(event => event.type)));
}
try {
  // Assert that no server already owns the target port before modifying files.
  const probe = createServer(); await new Promise((done, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', done); });
  await new Promise(done => probe.close(done));
  const patch = yaml.load(original.toString());
  patch.push({ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { auto: false } },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { qa: {
      displayName: 'local reliability test', apiKeyEnv: 'QA_LOCAL_API_KEY', api: 'openai-completions',
      defaultContextWindow: 32000, baseURL: `http://127.0.0.1:${mock.address().port}/v1`, models: [{ id: 'qa', name: 'local QA' }]
    } } } }, { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'qa', model: 'qa' } });
  fs.writeFileSync(config, yaml.dump(patch));
  await start(); id = (await rpc('create', { cwd: home })).sessionId; assert.ok(id);
  await prompt('QA_FIRST_USER_ORIGINAL '.repeat(400));
  let view = await context();
  const firstUser = view.messages.find(m => m.role === 'user' && m.text.includes('QA_FIRST_USER_ORIGINAL'));
  const firstAnswer = view.messages.find(m => m.role === 'assistant' && m.text.includes('QA_OLD_ASSISTANT_ANSWER'));
  assert.ok(firstUser && firstAnswer);
  await apply({ kind: 'compress', startSeq: firstUser.seq, endSeq: firstUser.seq, text: 'QA_SUMMARY_BEFORE_EDIT '.repeat(100) });
  view = await context(); const summary = view.messages.find(m => m.checkpoint); assert.ok(summary);
  const archived = await api('/workbench/originals?id=' + id + '&seq=' + firstUser.seq);
  assert.equal(archived.readOnly, true); assert.equal(summary.readOnly, false);
  await apply({ kind: 'summary', seq: summary.seq, text: 'QA_SUMMARY_EDITED '.repeat(70) });
  await apply({ kind: 'message', seq: firstAnswer.seq, text: 'QA_EDITED_ASSISTANT_ANSWER' });
  await prompt('Check edited memory, second turn');
  const wire = JSON.stringify(captures.at(-1).messages);
  for (const marker of ['QA_SUMMARY_EDITED', 'QA_EDITED_ASSISTANT_ANSWER']) assert.ok(wire.includes(marker), marker);
  for (const marker of ['QA_FIRST_USER_ORIGINAL', 'QA_SUMMARY_BEFORE_EDIT', 'QA_OLD_ASSISTANT_ANSWER']) assert.ok(!wire.includes(marker), marker);
  await apply({ kind: 'compress', startSeq: summary.seq, endSeq: summary.seq, text: 'QA_SUMMARY_AFTER_SECOND_COMPACTION' });
  await stop(); await start(); await prompt('Check memory after restart, third turn');
  const afterRestart = JSON.stringify(captures.at(-1).messages);
  assert.ok(afterRestart.includes('QA_SUMMARY_AFTER_SECOND_COMPACTION'));
  assert.ok(afterRestart.includes('QA_EDITED_ASSISTANT_ANSWER'));
  assert.ok(!afterRestart.includes('QA_OLD_ASSISTANT_ANSWER'));
  // Repeated removal must leave the native history/page RPC usable.
  for (let index = 0; index < 3; index++) {
    view = await context();
    const target = view.messages.find(m => m.role === 'assistant'); assert.ok(target);
    await api('/delete-node', { seq: target.seq, expectRevision: view.contentRevision });
    const history = await api('/events?id=' + id);
    const page = await rpc('page', { address: { kind: 'session', sessionId: id }, throughSeq: history.total - 1, maxMessages: 100 });
    assert.ok(page && typeof page === 'object');
    // A valid log immediately after removal is insufficient: the resident
    // loop may still hold the pre-edit turn counter until its next request.
    await prompt('Continue after removal ' + index);
    const retained = JSON.stringify(captures.at(-1).messages);
    assert.ok(!retained.includes(target.text), 'removed assistant must stay out of the next request');
    validateStoredSession();
  }
  for (const role of ['user', 'system', 'developer', 'assistant']) {
    view = await context();
    const text = 'QA_INSERTED_' + role.toUpperCase();
    await api('/insert', { role, blocks: [{ type: 'text', text }], expectRevision: view.contentRevision });
    assert.ok(JSON.stringify((await context()).messages).includes(text), 'insert is visible before next turn: ' + role);
    await prompt('Continue after inserting ' + role);
    // Native DSH rebuilds system prompts and filters developer messages on
    // this adapter route (dsh-llm capability projection). Preserve both native
    // contracts; user/assistant insertions remain in the actual request.
    assert.equal(JSON.stringify(captures.at(-1).messages).includes(text), ['user', 'assistant'].includes(role), 'next request follows native role semantics: ' + role);
    validateStoredSession();
  }
  await stop(); await start(); await prompt('Continue after edit and service restart');
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => context()));
  assert.ok(concurrent.every(value => value.contentRevision === concurrent[0].contentRevision));
  assert.ok(concurrent.every(value => JSON.stringify(value.messages) === JSON.stringify(concurrent[0].messages)));
  validateStoredSession();
  console.log(JSON.stringify({ ok: true, nativeWebSession: true, modelRequests: captures.length,
    summaryEdited: true, retainedAssistantEdited: true, archivedOriginalReadOnly: true,
    secondCompactionAndRestart: true, repeatedRemovalAndNativeHistory: true, continueAfterEachRemoval: true,
    insertRolesAndContinue: true, continueAfterServiceRestart: true, concurrentReads: 8, nativeValidation: true }));
} finally {
  await stop(); fs.writeFileSync(config, original);
  mock.closeAllConnections(); await new Promise(done => mock.close(done));
}
