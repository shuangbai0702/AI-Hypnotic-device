import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync('plugins/dsh-session-editor/lib/client.js','utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const h=(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity).filter(c=>c!==null&&c!==undefined&&c!==false)});
const walk=n=>n&&typeof n==='object'?[n,...n.children.flatMap(walk)]:[];
const text=n=>typeof n==='object'?n.children.map(text).join(''):String(n??'');
function fixture(name,end,extra={}) {
  const state=[],refs=[],effects=[];let index=0,ri=0,ei=0;
  const context={h,useState:initial=>{const i=index++;if(!(i in state))state[i]=initial;return [state[i],v=>state[i]=typeof v==='function'?v(state[i]):v];},
    useRef:initial=>refs[ri++]??(refs[ri-1]={current:initial}),useEffect:fn=>{effects[ei++]=fn;},useCallback:fn=>fn,
    sty:new Proxy({},{get:()=>({})}),useLifetime:()=>({current:true}),...extra};
  const View=runInNewContext(source.slice(source.indexOf('    function '+name+'('),source.indexOf('    function '+end+'('))+';'+name,context);
  const render=props=>{index=ri=ei=0;return View(props);};
  return {render,effects,refs,state,find:(props,label)=>walk(render(props)).find(n=>n.type==='button'&&text(n)===label)};
}
test('selected assistant task waits for explicit send and uses fixed target',async()=>{
  const calls=[];let released=0;
  const f=fixture('MemoryAssistant','WorkbenchView',{hostSessions:{retain:id=>({sessionId:id,binding:{},ready:Promise.resolve(),release:()=>released++})},
    post:async(path,body)=>{calls.push({path,body});return {sessionId:'assistant',changeCount:0,status:'idle'};},SessionProvider:()=>{},refreshConversation:async()=>{}});
  const p={sessionId:'target',taskDraft:{sessionId:'target',text:'只起草 #2 到 #7'},SessionProvider:()=>{},renderSlot:()=>null,onChanged:()=>{},onReview:()=>{}};
  f.render(p); const cleanup=f.effects[1]();
  assert.equal(calls.length,0);
  await f.find(p,'发送给助手起草').props.onClick();
  assert.deepEqual(calls.map(c=>c.path),['/assistant/open','/assistant/prompt']);
  assert.equal(calls[1].body.id,'target');assert.equal(calls[1].body.text,'只起草 #2 到 #7');
  assert.equal(released,0);cleanup();assert.equal(released,1);
});
test('leaving while assistant opens releases its late reference without sending draft',async()=>{
  const gate=deferred(),calls=[];let released=0;
  const f=fixture('MemoryAssistant','WorkbenchView',{hostSessions:{retain:id=>({sessionId:id,binding:{},ready:gate.promise,release:()=>released++})},
    post:async(path,body)=>{calls.push({path,body});return {sessionId:'assistant',changeCount:0};},refreshConversation:async()=>{}});
  const p={sessionId:'target',taskDraft:{sessionId:'target',text:'draft'},onChanged:()=>{}};
  f.render(p);const cleanup=f.effects[1]();
  const request=f.find(p,'发送给助手起草').props.onClick();await new Promise(r=>setImmediate(r));
  cleanup();gate.resolve();await request;
  assert.equal(released,1);assert.equal(calls.some(c=>c.path==='/assistant/prompt'),false);
});
test('tab navigation retains visited editor instances and uses four primary actions',()=>{
  const dummy=()=>{};
  const f=fixture('EditorPanel','currentSessionId',{ContextView:dummy,WorkbenchView:dummy,MemoryAssistant:dummy,CoverageView:dummy,SummaryView:dummy,HistoryView:dummy,currentSessionId:()=> 'target'});
  const props={sessionId:'target'};
  const first=f.render(props);const context=walk(first).find(n=>n.props.key==='target:context');
  assert.equal(first.children[0].children.length,4);
  assert.ok(context);assert.equal(context.props.hidden,false);
  f.find(props,'记忆工作台').props.onClick();
  const second=f.render(props);assert.equal(walk(second).find(n=>n.props.key==='target:context').props.hidden,true);
  assert.ok(walk(second).find(n=>n.props.key==='target:workbench'));
  f.find(props,'有效上下文').props.onClick();
  assert.equal(walk(f.render(props)).find(n=>n.props.key==='target:context').props.hidden,false);
});

test('message and summary saves retain the editor until native sync settles, then refresh only the live view',async()=>{
  for (const name of ['ContextView','SummaryView']) for (const leave of [false,true]) {
    const gate=deferred(),alive={current:true};let changes=0,syncStarted=false;
    const f=fixture(name,name==='ContextView'?'SummaryView':'CoverageView',{
      useLifetime:()=>alive,post:async()=>({ok:true}),refreshConversation:async()=>{syncStarted=true;await gate.promise;},
      editChanges:()=>['body'],editedBlocks:()=>[],messageLabel:()=> '用户消息',roleColor:()=> '#000',
      visualFor:()=>({label:'有效'}),ChangePreview:()=>{},MessageBody:()=>{}
    });
    const message={seq:2,role:'user',tokens:1,editText:'old',blocks:[]};
    f.state[0]={contentRevision:'r1',messages:[message],summaries:[message],messageCount:1,totalTokens:1};
    f.state[2]={seq:2,text:'new',originalText:'old',revision:'r1',blocks:[]};
    const props={sessionId:'target',reloadKey:0,onChanged:()=>changes++};
    const run=f.find(props,name==='ContextView'?'保存':'保存摘要').props.onClick();
    await new Promise(r=>setImmediate(r));assert.equal(syncStarted,true);assert.equal(changes,0);
    assert.ok(f.state[2]);assert.equal(f.state[3],true);
    if(leave)alive.current=false;
    gate.resolve();await run;assert.equal(changes,leave?0:1);
    if(!leave)assert.equal(f.state[2],null);
  }
});
