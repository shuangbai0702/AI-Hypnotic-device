import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimePaths } from '../plugins/dsh-session-editor/lib/runtime-paths.js';
import { getDiagnostics, captureError } from '../plugins/dsh-session-editor/lib/diagnostics.js';
const root=()=>mkdtempSync(join(tmpdir(),'session-editor-diagnostics-'));
const context=home=>({sessionPersistence:{root:join(home,'sessions')}});

test('native root, explicit environment, install record and default home have deterministic precedence',()=>{
  const userHome=root();
  try {
    const opts={userHome,env:{},host:{}};
    assert.equal(runtimePaths({},opts).home,join(userHome,'.dsh'));
    assert.equal(runtimePaths({},{...opts,env:{DSH_HOME:'  '}}).source,'default');
    assert.equal(runtimePaths({},{...opts,host:{home:join(userHome,'installed')}}).source,'installation');
    assert.equal(runtimePaths({},{...opts,env:{DSH_HOME:'~/custom'},host:{home:'ignored'}}).home,join(userHome,'custom'));
    const actual=runtimePaths(context(join(userHome,'actual')),{...opts,env:{DSH_HOME:'ignored'}});
    assert.equal(actual.home,join(userHome,'actual'));assert.equal(actual.source,'persistence');
    const custom=runtimePaths({sessionPersistence:{root:join(userHome,'custom-logs')}},opts);
    assert.equal(custom.sessions,join(userHome,'custom-logs'));assert.equal(custom.home,join(userHome,'.dsh'));
  } finally {rmSync(userHome,{recursive:true,force:true});}
});

test('request IDs and original exception frames survive without logging secrets, body, reasoning or paths',async()=>{
  const home=root();
  try {
    const ctx=context(home), log=getDiagnostics(ctx,{name:'test',version:'test'});
    const secret='sk-'+ 'syntheticcredential'.repeat(3), body='PRIVATE_CHAT_SENTINEL', id='PRIVATE_SESSION_SENTINEL';
    const handler=log.wrap('/api/session-editor/edit',async()=>{
      const error=Object.assign(new TypeError('secret '+secret+' '+body+' '+home),{code:'ERR_INVALID_ARG_TYPE'});
      captureError(error);return Response.json({error:error.message},{status:500});
    });
    const response=await handler(new Request('http://local/edit?token='+secret,{method:'POST',headers:{authorization:'Bearer '+secret},body:JSON.stringify({id,text:body,thinking:body,apiKey:secret})}));
    const result=await response.json();assert.equal(result.requestId,response.headers.get('x-session-editor-request-id'));
    const report=log.export(), text=JSON.stringify(report), entry=report.records.find(e=>e.requestId===result.requestId);
    for(const value of [secret,body,id,home])assert.equal(text.includes(value),false,value);
    assert.equal(entry.error.type,'TypeError');assert.equal(entry.error.code,'ERR_INVALID_ARG_TYPE');assert.ok(entry.error.frames.length);
    assert.equal(entry.status,500);assert.equal(entry.route,'/api/session-editor/edit');
    // Restart-like logger instance reads the retained files, not only memory.
    assert.ok(getDiagnostics(context(home)).export().records.some(e=>e.requestId===result.requestId));
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('overlapping requests keep separate error context and correlated nested request IDs',async()=>{
  const home=root();
  try {
    const log=getDiagnostics(context(home));let release;const gate=new Promise(r=>release=r);
    const slow=log.wrap('/slow',async()=>{await gate;captureError(Object.assign(new Error('denied'),{code:'EACCES'}));return Response.json({error:'denied'},{status:403});});
    const fast=log.wrap('/fast',async()=>Response.json({ok:true}));
    const pending=slow(new Request('http://local/slow'));const second=await fast(new Request('http://local/fast'));release();const first=await pending;
    assert.notEqual(first.headers.get('x-session-editor-request-id'),second.headers.get('x-session-editor-request-id'));
    const records=log.export().records;
    assert.equal(records.find(e=>e.route==='/slow').error.code,'EACCES');assert.equal(records.find(e=>e.route==='/fast').error,undefined);
    const inner=log.wrap('/inner',async()=>Response.json({ok:true}));
    const outer=log.wrap('/outer',async()=>{await inner(new Request('http://local/inner'));return Response.json({ok:true});});
    const result=await outer(new Request('http://local/outer'));
    assert.equal(log.export().records.find(e=>e.route==='/inner').parentRequestId,result.headers.get('x-session-editor-request-id'));
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('rotation bounds disk use and corrupt records do not prevent diagnostic export',()=>{
  const home=root();
  try {
    const log=getDiagnostics(context(home));
    for(let n=0;n<2100;n++)log.record({event:'rotation-probe',operation:'x'.repeat(6000)});
    const dir=join(home,'logs','session-editor'), files=readdirSync(dir);
    assert.equal(files.length,5);assert.ok(files.every(f=>statSync(join(dir,f)).size<=2*1024*1024));
    writeFileSync(join(dir,'runtime.jsonl'),'invalid-json\n'+JSON.stringify({...log.export().records.at(-1),body:'PRIVATE_INJECTED_BODY'})+'\n');
    const report=log.export();assert.ok(report.warnings.includes('invalid-log-record-skipped'));assert.ok(report.records.length>=200);
    assert.equal(JSON.stringify(report).includes('PRIVATE_INJECTED_BODY'),false);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('logging write failure preserves committed success and remains visible in exported diagnostics',async()=>{
  const home=root();
  try {
    writeFileSync(join(home,'logs'),'blocks directory creation');
    const log=getDiagnostics(context(home));let committed=0;
    const response=await log.wrap('/save',async()=>{committed++;return Response.json({ok:true});})(new Request('http://local/save',{method:'POST'}));
    assert.equal(response.status,200);assert.equal(committed,1);assert.ok(log.status().writeFailure);assert.ok(log.export().records.some(e=>e.route==='/save'));
    rmSync(join(home,'logs'));log.record({event:'recovery',level:'info'});
    assert.equal(log.status().writeFailure,null);
    assert.ok(readdirSync(join(home,'logs','session-editor')).includes('runtime.jsonl'));
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('browser stack URL query and fragment never enter persistent diagnostics',()=>{
  const home=root();try {
    const log=getDiagnostics(context(home)), secret='SYNTHETIC_QUERY_CREDENTIAL';
    log.clientError('api-network',{name:'TypeError',stack:'TypeError\n    at sync (http://local/client.js?token='+secret+'#PRIVATE_FRAGMENT:12:3)'},'target');
    const report=log.export();
    assert.equal(JSON.stringify(report).includes(secret),false);
    assert.equal(JSON.stringify(report).includes('PRIVATE_FRAGMENT'),false);
    assert.ok(report.records.at(-1).error.frames[0].includes('client.js:12:3'));
  }finally{rmSync(home,{recursive:true,force:true});}
});
