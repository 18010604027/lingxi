import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { startApi } from '../core/pet/api.ts';
import { TaskBus, UncertainTaskError, type Runner, type Worker } from '../core/agents/bus.ts';
import { CliCodeAgentAdapter } from '../core/agents/cli-adapter.ts';
import { readCombinedActivity } from '../core/runtime/activity.ts';
import { AppEvents } from '../core/runtime/app-events.ts';
const { call } = createRequire(import.meta.url)('../workbench/bridge.cjs');
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const waitFor = async (condition: () => boolean) => { for (let i=0;i<100;i++) { if(condition()) return; await new Promise(r=>setTimeout(r,10)); } throw new Error('activity not rendered'); };
describe('activity through real API and renderer', () => {
 it('projects persisted agent state without exposing provider payload and resumes from its cursor', () => {
  const dir=mkdtempSync(join(tmpdir(),'lingxi-agent-activity-'));
  const store=new AppEvents(join(dir, 'events.sqlite'));
  const source=(after:number) => ({items: after ? [] : [{sequence:1,task_id:'task',attempt:2,provider:'dsh',kind:'state',state:'started',created_at:'2026-11-04T00:00:00Z',secret:'do-not-project'}],sequence:1,hasMore:false,coverage:'partial' as const});
  try {
   const page=readCombinedActivity(store,{file:join(dir,'missing'),runId:'fixture'},undefined,50,source);
   expect(page.items).toContainEqual(expect.objectContaining({id:'agent:1',attempt:2,provider:'dsh',state:'started'}));
   expect(JSON.stringify(page)).not.toContain('do-not-project');
   expect(readCombinedActivity(store,{file:join(dir,'missing'),runId:'fixture'},page.cursor,50,source).items).toHaveLength(0);
  } finally { store.close();rmSync(dir,{recursive:true,force:true}); }
 });

 it('survives TaskBus close/reopen, deduplicates, and renders only safe agent state fields', async () => {
  const dir=mkdtempSync(join(tmpdir(),'lingxi-agent-activity-reopen-'));
  const store=new AppEvents(join(dir, 'events.sqlite'));
  const busFile=join(dir,'bus.sqlite');
  const adapter=new CliCodeAgentAdapter({id:'claude',label:'fixture Claude',command:'fixture',
   capabilities:{streaming:true,thoughts:true,resume:true,cancel:true,permissions:false,usage:true,structuredOutput:true,sandbox:false,networkPolicy:false},
   buildArgs:()=>[],spawnProcess:()=>{
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill:()=>true});
    queueMicrotask(()=>{child.emit('spawn');child.stdout.write(`${JSON.stringify({type:'session.started',session_id:'provider-session'})}\n`);child.stdout.write(`${JSON.stringify({type:'turn.completed',result:'private provider result'})}\n`);child.emit('close',0);});
    return child as never;
   }});
  let bus:TaskBus;
  const runner:Runner=async(task)=>{
   bus.bindCodeProvider(task.id,'claude');
   const result=await adapter.run({id:task.id,incidentId:task.incidentId,prompt:task.body,cwd:dir,writableRoot:dir,readRoots:[dir],network:'deny',acceptance:[],attempt:task.attempts,activityTools:['read']},{
    shouldStop:()=>false,onPermission:async()=>false,onRunRef:(ref)=>bus.bindCodeRunRef(task.id,ref),
    onActivity:(activity)=>{bus.appendCodeAgentActivity(activity);bus.appendCodeAgentActivity(activity);}
   });
   if(result.status==='unknown')throw new UncertainTaskError(result.summary||'provider outcome unknown');
   if(result.status!=='succeeded')throw new Error(result.summary||`provider ${result.status}`);
   return result.summary;
  };
  const runners:Record<Worker,Runner>={control:async()=>'',coder:runner};
  const createBus=()=>new TaskBus(busFile,{runners,now:()=>new Date('2026-11-04T01:00:00Z')});
  bus=createBus();
  let server: Awaited<ReturnType<typeof startApi>> | null=null;
  let dom: ReturnType<typeof JSDOM> | null=null;
  try {
  bus.start();
  const task=bus.submit({to:'coder',from:'control',body:'safe display fixture'});
  await bus.whenIdle();
  expect(bus.get(task.id)?.status).toBe('done');
  const first=bus.listCodeAgentActivity(0,50);
  expect(first.items).toHaveLength(2);
  expect(first.items.map((item)=>item.state)).toEqual(['started','succeeded']);
  expect(JSON.stringify(first)).not.toContain('private provider result');
  await bus.closeAsync();
  bus=createBus();
  const reopened=bus.listCodeAgentActivity(0,50);
  expect(reopened.items).toHaveLength(2);
  expect(reopened.items.map((item)=>item.state)).toEqual(['started','succeeded']);
  expect(JSON.stringify(reopened)).not.toContain('private provider result');
  server=await startApi({port:0,token:'b'.repeat(48)},{
   status:()=>({name:'test',paused:false,body:{connected:false,x:.5},feeling:''}),settings:()=>({name:'test',user:'test'}),asks:()=>[],behind:()=>null,
   history:()=>({available:true,cursor:0,lines:[]}),historySince:()=>({available:true,cursor:0,lines:[]}),outputs:()=>({available:true,cursor:0,outputs:[]}),
   activity:(c,n)=>readCombinedActivity(store,{file:join(dir,'missing-tools'),runId:'fixture'},c,n,(after,count)=>bus.listCodeAgentActivity(after,count)),
   memory:()=>({available:true,episodes:[]}),tasks:()=>null,noteTask:()=>false,cancelTask:()=>false,recoverTask:()=>false,
   say:async()=>false,answer:async()=>false,revoke:()=>({revoked:false,behind:null}),save:()=>({name:'test',user:'test'})
  });
  const address=server.address();if(!address||typeof address==='string')throw new Error('address');
  const access={port:address.port,token:'b'.repeat(48)};
  dom=new JSDOM('<div id="root"></div>',{runScripts:'outside-only',url:'file:///workbench/index.html'});
   const response=await call(access,'activity',{});
   expect(JSON.stringify(response)).not.toContain('private provider result');
   Object.assign(dom.window,{lingxi:{call:(op:string,body:unknown)=>call(access,op,body)}});
   dom.window.eval(readFileSync(join(process.cwd(),'workbench/renderer.js'),'utf8'));
   await waitFor(()=>!!dom.window.document.querySelector('#activity-toggle'));
   expect(dom.window.document.querySelector('#conversation').textContent).not.toContain('代码助手已启动');
   dom.window.document.querySelector('#activity-toggle').click();
   await waitFor(()=>{
     const text = dom.window.document.querySelector('#conversation').textContent;
     return text.includes('代码助手') && text.includes('执行状态') && text.includes('已启动') && text.includes('成功');
   });
   const timeline=dom.window.document.querySelector('#conversation').textContent;
   expect(timeline).toContain('Claude'); expect(timeline).toContain('第 1 次尝试');
   expect(timeline).not.toContain('private provider result');
  } finally {dom?.window.close();if(server)await new Promise<void>(r=>server!.close(()=>r()));await bus.closeAsync();store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('shows only projected records, preserves source gaps, and performs no writes while opened', async () => {
  const dir=mkdtempSync(join(tmpdir(),'lingxi-activity-'));
  const store=new AppEvents(join(dir, 'events.sqlite'));
  store.push({source:'pet',type:'pet.moved',origin:'internal',ts:new Date().toISOString(),text:'secret-file-content',meta:{token:'secret-token'}});
  const earlier = new Date(Date.now() - 10 * 60_000).toISOString();
  const recent = new Date().toISOString();
  const toolFile=join(dir,'toolcalls.jsonl');
  writeFileSync(toolFile,JSON.stringify({run:'fixture',ts:new Date().toISOString(),tool:'delegate_task',call:'call1',args:'secret-tool-args',receipt:'secret-result'})+'\n');
  const cursor=store.latestCursor();
  const server=await startApi({port:0,token:'a'.repeat(48)},{
   status:()=>({name:'test',paused:false,body:{connected:false,x:.5},feeling:''}), settings:()=>({name:'test',user:'test'}),asks:()=>[],behind:()=>null,
   history:()=>({available:true,cursor,lines:[
    { id:'history:1', run:'fixture', cursor:1, who:'person', kind:'said', text:'较早输入', ts:earlier },
    { id:'history:2', run:'fixture', cursor:2, who:'pet', kind:'say', text:'较晚回复', ts:recent },
   ]}), historySince:()=>({available:true,cursor,lines:[]}), outputs:()=>({available:true,cursor,outputs:[]}),
   activity:(c,n)=>readCombinedActivity(store,{file:toolFile,runId:'fixture'},c,n),memory:()=>({available:true,episodes:[]}), tasks:()=>null, noteTask:()=>false,cancelTask:()=>false,recoverTask:()=>false,
   say:async()=>false,answer:async()=>false,revoke:()=>({revoked:false,behind:null}),save:()=>({name:'test',user:'test'})
  });
  const address=server.address(); if(!address||typeof address==='string')throw new Error('address');
  const access={port:address.port,token:'a'.repeat(48)};
  const dom=new JSDOM('<div id="root"></div>',{runScripts:'outside-only',url:'file:///workbench/index.html'});
  try {
   Object.assign(dom.window,{lingxi:{call:(op:string,body:unknown)=>call(access,op,body)}});
   dom.window.eval(readFileSync(join(process.cwd(),'workbench/renderer.js'),'utf8'));
   await waitFor(()=>!!dom.window.document.querySelector('#activity-toggle'));
   await waitFor(()=>dom.window.document.querySelector('#conversation').textContent.includes('收到身体动作反馈'));
   expect(dom.window.document.querySelector('#conversation').textContent).not.toContain('委派任务');
   dom.window.document.querySelector('#activity-toggle').click();
   await waitFor(()=>dom.window.document.querySelector('#conversation').textContent.includes('委派任务'));
   expect(dom.window.document.querySelector('#activity-toggle').getAttribute('aria-checked')).toBe('true');
   const content=dom.window.document.querySelector('#conversation').textContent + dom.window.document.querySelector('#activity-status').textContent;
   expect(content).toContain('相隔 10 分钟');
   expect(content).toContain(earlier);
   expect(content).toContain(recent);
   expect(content).toContain('当前不可用');
   expect(content).not.toContain('secret');
   expect(store.latestCursor()).toBe(cursor);
   const response=await call(access,'activity',{});
   expect(JSON.stringify(response)).not.toContain('secret');
  } finally {dom.window.close();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}
 });
});
