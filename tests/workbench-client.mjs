import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source=readFileSync('plugins/dsh-session-editor/lib/client.js','utf8');
const component=source.slice(source.indexOf('    function WorkbenchView('),source.indexOf('    function EditorPanel('));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
function harness() {
  const state=[], effects=[], calls=[];let index=0,changes=0,syncFails=false,postGate,syncGate;
  const drafts=[];
  const alive={current:true};
  const candidate={candidateId:'c1',kind:'message',members:[2],seq:2,status:'pending',before:'old',after:'new',tokensBefore:10,tokensAfter:5};
  const data={contentRevision:'r1',rows:[{seq:2,canCompact:true,preview:'memory',role:'assistant'}],candidates:[candidate]};
  const h=(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity).filter(c=>c!==false&&c!==null&&c!==undefined)});
  const context={h,AbortController,useState:initial=>{const i=index++;if(!(i in state))state[i]=initial;return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v;}];},
    useLifetime:()=>alive,useEffect:fn=>{if(!effects.length)effects.push(fn);},sty:new Proxy({},{get:()=>({})}),
    api:async path=>{calls.push(['GET',path]);return path.includes('/originals')?{total:0,offset:0,nextOffset:null,items:[]}:data;},
    post:async(path,body)=>{calls.push(['POST',path,body]);if(postGate)await postGate.promise;return {ok:true};},
    refreshConversation:async id=>{calls.push(['sync',id]);if(syncGate)await syncGate.promise;if(syncFails)throw Error('mock synchronization failed');},encodeURIComponent};
  const View=runInNewContext(component+';WorkbenchView',context);
  const render=()=>{index=0;return View({sessionId:'target',reloadKey:0,onChanged:()=>changes++,onAssistant:text=>drafts.push(text)});};
  const walk=node=>node&&typeof node==='object'?[node,...node.children.flatMap(walk)]:[];
  const text=node=>typeof node==='object'?node.children.map(text).join(''):String(node??'');
  const find=label=>walk(render()).find(n=>n.type==='button'&&text(n)===label);
  return {calls,state,alive,render,find,text,walk,data,drafts,get changes(){return changes;},failSync:()=>syncFails=true,gate:v=>postGate=v,gateSync:v=>syncGate=v,load:async()=>{render();effects[0]();await new Promise(r=>setImmediate(r));}};
}

test('workbench refresh waits for native restore marker and suppresses refresh after leaving during sync',async()=>{
  for (const leave of [false,true]) {
    const f=harness();await f.load();const gate=deferred();f.gateSync(gate);
    const run=f.find('应用此候选').props.onClick();await new Promise(r=>setImmediate(r));
    assert.ok(f.calls.some(c=>c[0]==='sync'));assert.equal(f.changes,0);
    if(leave)f.alive.current=false;
    gate.resolve();await run;assert.equal(f.changes,leave?0:1);
  }
});
test('workbench apply reports saved despite native sync failure and refreshes once',async()=>{
  const f=harness();await f.load();f.failSync();
  await f.find('应用此候选').props.onClick();
  assert.equal(f.calls.filter(c=>c[1]==='/workbench/apply').length,1);assert.equal(f.changes,1);
  assert.match(f.text(f.render()),/内容已保存，左侧同步失败/);
  assert.equal(f.calls.find(c=>c[0]==='sync')[1],'target');
});
test('leaving the workbench during a committed request suppresses late view writes and sync',async()=>{
  const f=harness();await f.load();const gate=deferred();f.gate(gate);
  const run=f.find('应用此候选').props.onClick();f.alive.current=false;gate.resolve();await run;
  assert.equal(f.changes,0);assert.equal(f.calls.some(c=>c[0]==='sync'),false);
});
test('find originals opens visible search results and draft pins original revision',async()=>{
  const f=harness();await f.load();await f.find('找回原件').props.onClick();
  assert.match(f.text(f.render()),/共 0 条/);
  assert.ok(f.walk(f.render()).some(n=>n.type==='details'&&n.props.open&&f.text(n).includes('检索历史原件')));
  f.find('局部压缩').props.onClick();assert.equal(f.state[4].expectRevision,'r1');
  f.data.contentRevision='r2';
  assert.match(f.text(f.render()),/会话已有变化，草稿保留/);
});
test('legal range shortcut prepares an explicit assistant draft without sending or applying',async()=>{
  const f=harness(); f.data.rows.push({seq:7,canCompact:true,preview:'second',role:'user',tokens:40});
  f.data.compressionRanges=[{startSeq:2,endSeq:7,members:[2,7],tokens:60}]; await f.load();
  f.find('局部压缩').props.onClick();
  assert.equal(f.state[4].startSeq,2); assert.equal(f.state[4].endSeq,7);
  f.find('让助手起草此选区').props.onClick();
  assert.equal(f.drafts.length,1);assert.match(f.drafts[0],/#2 到 #7/);assert.match(f.drafts[0],/不直接应用/);
  assert.equal(f.calls.some(c=>c[0]==='POST'),false);
});
