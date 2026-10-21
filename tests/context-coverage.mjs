import test from 'node:test';
import assert from 'node:assert/strict';
import { foldSurface, deriveEventMessage } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { contextCoverage } from '../plugins/dsh-session-editor/lib/coverage.js';
const user = (seq, text, replaced, checkpoint = false) => ({ seq, type: 'user/message', time: 1,
  data: { id: String(seq), role: 'user', content: [{type:'text',text}], source: checkpoint ? {kind:'compact-checkpoint',compactionId:String(seq)} : {kind:'user'} },
  surfaceOp: replaced ? {op:'replace',startSeq:replaced[0],endSeq:replaced.at(-1)} : 'append',
  ...(replaced ? {sourceEventSeqs:replaced} : {}) });
test('canonical coverage distinguishes retained replies, nested compaction and ordinary replacement', () => {
  const events = [user(0,'original'), user(1,'keep outside summary'), user(2,'edited original',[0]),
    user(3,'<compacted-summary>first</compacted-summary>',[2],true),
    user(4,'<compacted-summary>second</compacted-summary>',[3],true),
    {seq:5,time:1,type:'turn/start',data:{turn:1}},
    {seq:6,time:1,type:'step/start',data:{turn:1,step:1}},
    {seq:7,time:1,type:'assistant/message',surfaceOp:'append',data:{turn:1,step:1,message:{role:'assistant',content:[{type:'reasoning',text:'kept thought'},{type:'text',text:'retained answer'}],source:{kind:'model',provider:'qa',model:'qa'}}}}];
  const result = contextCoverage(events,foldSurface(events),deriveEventMessage);
  const item = seq => result.items.find(i => i.seq === seq);
  assert.equal(item(0).status,'covered');
  assert.deepEqual(item(0).chain,[2,3,4]);
  assert.deepEqual(item(0).summarySeqs,[3,4]);
  assert.equal(item(0).finalSeq,4);
  assert.equal(item(0).readOnly,true); assert.equal(item(0).editable,false); assert.equal(item(0).summarySeq,4);
  assert.equal(item(3).readOnly,true); assert.equal(item(3).editKind,null);
  assert.equal(item(4).readOnly,false); assert.equal(item(4).editable,true); assert.equal(item(4).editKind,'summary');
  assert.equal(item(1).status,'active');
  assert.equal(item(7).status,'active');
  assert.equal(item(7).thoughtCount,1);
  assert.deepEqual(result.summaries[0].coveredSeqs,[0,2,3]);
  assert.deepEqual(result.summaries[0].directSeqs,[3]);
  const beforeCompaction = contextCoverage(events.slice(0,3),foldSurface(events.slice(0,3)),deriveEventMessage);
  assert.equal(beforeCompaction.items[0].status,'replaced');
});
test('explicit empty replacement is removed, not claimed as summary coverage', () => {
  const events = [user(0,'remove me'), {seq:1,time:1,type:'turn/start',data:{turn:1}},
    {seq:2,time:1,type:'step/start',data:{turn:1,step:1}},
    {seq:3,time:1,type:'system/message',data:{turn:1,step:1,message:{role:'system',content:[]}},surfaceOp:{op:'replace',startSeq:0,endSeq:0},sourceEventSeqs:[0]}];
  const result=contextCoverage(events,foldSurface(events),deriveEventMessage);
  assert.equal(result.items[0].status,'removed');
  assert.equal(result.summaries.length,0);
});

test('coverage replaces body and thinking together and keeps later replies intact', () => {
  const events = [user(0, 'first'),
    { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, time: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 3, time: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'old thought' }, { type: 'text', text: 'old answer' }] } } },
    user(4, '<compacted-summary>new memory</compacted-summary>', [0, 3], true),
    { seq: 5, time: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'later thought' }, { type: 'text', text: 'later answer' }] } } }];
  const result = contextCoverage(events, foldSurface(events), deriveEventMessage);
  const item = seq => result.items.find(i => i.seq === seq);
  assert.equal(item(3).coverageState, 'summary-covered');
  assert.equal(item(3).thoughtState, 'summary-covered');
  assert.equal(item(3).fullySummaryCovered, true);
  assert.equal(item(3).surfaceActive, false);
  assert.equal(item(4).coverageState, 'summary-active');
  assert.equal(item(5).coverageState, 'retained-with-thinking');
  assert.equal(item(5).thoughtState, 'retained');
  assert.equal(item(5).fullySummaryCovered, false);
  assert.equal(item(5).surfaceActive, true);
  assert.equal(result.stateCounts['retained-with-thinking'], 1);
});

test('ordinary text containing summary tags never becomes a checkpoint', () => {
  const events = [user(0, 'original'), user(1, 'I typed <compacted-summary>example</compacted-summary>', [0])];
  const result = contextCoverage(events, foldSurface(events), deriveEventMessage);
  assert.equal(result.items[0].status, 'replaced');
  assert.equal(result.items[1].checkpoint, false);
  assert.equal(result.items[1].coverageState, 'retained');
  assert.equal(result.summaries.length, 0);
});
