import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PiAiAdapter } from '../app/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js';
import { streamSimple } from '../app/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js';
import { buildReplacementEvent } from '../plugins/dsh-session-editor/lib/edit.js';

test('unmodified DSH adapter sends retained thinking and excludes explicitly cleared thinking', async () => {
  const captures = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    captures.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'qa', object: 'chat.completion.chunk', model: 'qa', created: 1 };
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'OK' }, null], [{}, 'stop']])
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const model = { id: 'qa', name: 'QA', provider: 'qa', api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: true,
      input: ['text'], contextWindow: 8000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const snapshot = { profiles: new Map([['qa', { reasoning: 'off', streamIdleTimeoutMs: 5000, modelErrors: new Map(), piProvider: {} }]]),
      models: { getModel: () => model, streamSimple } };
    const adapter = new PiAiAdapter({ resolveApiKey: async () => 'local-test' });
    const thought = { type: 'reasoning', text: 'OLD-THOUGHT: first message was original greeting' };
    const event = { type: 'assistant/message', data: { message: { role: 'assistant', id: 'qa-a',
      content: [thought, { type: 'text', text: 'old answer' }],
      source: { kind: 'model', provider: 'qa', model: 'qa', replayState: {
        response: { kind: 'pi-ai', version: 2, api: 'openai-completions', provider: 'qa', model: 'qa', stopReason: 'stop' },
        blocks: [{ type: 'reasoning', thinkingSignature: 'reasoning_content' }, { type: 'text' }]
      } } } } };
    for (const mode of ['keep', 'edit', 'clear']) {
      const editedThought = mode === 'edit' ? { ...thought, text: 'NEW-THOUGHT: first message was updated greeting' } : thought;
      const blocks = [...(mode === 'clear' ? [] : [editedThought]), { type: 'text', text: 'updated greeting' }];
      const edited = buildReplacementEvent(event, blocks).data.message;
      const messages = [
        { role: 'user', content: [{ type: 'text', text: '<compacted-summary>first: updated greeting</compacted-summary>' }] },
        edited, { role: 'user', content: [{ type: 'text', text: 'Repeat first message' }] }
      ];
      for await (const chunk of adapter.streamWithSnapshot({ provider: 'qa', model: 'qa', messages, maxTokens: 100 }, snapshot)) {
        assert.notEqual(chunk.type, 'error', JSON.stringify(chunk));
      }
      const wire = captures.at(-1).messages.find(m => m.role === 'assistant');
      assert.equal(wire.content, 'updated greeting');
      assert.equal(wire.reasoning_content ?? '', mode === 'clear' ? '' : editedThought.text);
      assert.equal(JSON.stringify(captures.at(-1)).includes('OLD-THOUGHT'), mode === 'keep');
    }
    assert.equal(captures.length, 3);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
