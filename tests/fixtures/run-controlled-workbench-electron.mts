import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TaskBus } from '../../core/agents/bus.ts';
import { readCombinedActivity } from '../../core/runtime/activity.ts';
import { AppEvents } from '../../core/runtime/app-events.ts';
const dir = mkdtempSync(join(tmpdir(), 'lingxi-ui-controlled-'));
const profile = join(dir, 'profile'); mkdirSync(profile);
const token = 'f'.repeat(48);
let cursor = 0, submitted = 0, noted = false, taskReads = 0, cancelRequested = false;
let runtimeSettings = { model:{ provider:'fixture', protocol:'responses', apiUrl:'http://127.0.0.1/v1', model:'fixture-model', keyConfigured:true }, executor:{ provider:'codex', sandboxMode:'workspace-write', networkAccess:'deny', taskDirectory:'C:/fixture/tasks', description:'受控执行器' }, apply:{ model:{ message:'后续请求生效' }, executor:{ message:'重启后生效' } } };
let workbenchSettings = { profile:{name:'灵犀',user:'测试者',constitution:'她喜欢安静地听人说话。'}, conversation:{language:'zh',context:{maxTokens:128000,softRatio:.85,keepRatio:.25,firstTurn:false},rounds:{soft:20,hard:40},apply:{context:'立即生效',rounds:'重启后生效'}} };
let acceptedAnswer: { question:string; text:string; questionId?:string } | undefined;
const outputs: Array<{ id:string; messageId:string; index:number; text:string; kind:string; cursor:number; ts:string }> = [];
const receipts: Array<{ channel:string; outputId:string; state:string }> = [];
const activityStore = new AppEvents(join(dir, 'events.sqlite'));
const activityBus = new TaskBus(join(dir, 'activity.sqlite'), { runners: { control: async () => '', coder: async () => '' } });
activityBus.appendCodeAgentActivity({ taskId:'task-ui-activity', attempt:2, provider:'codex', runId:'run-ui-activity', role:'coder', kind:'state', state:'started', idempotencyKey:'state:started' });
const activityDetailOnly = process.argv.includes('--activity-detail-only');
const detailAt = new Date().toISOString();
if (activityDetailOnly) {
  activityStore.push({ ts:detailAt, source:'pet', origin:'external', type:'pet.action', text:'[action] walk', meta:{state:'started',action:'walk',actionId:'12345678-1234-4234-8234-123456789abc'} });
  activityStore.push({ ts:new Date(Date.now()+10).toISOString(), source:'pet', origin:'external', type:'pet.interaction', text:'[touch] clicked', meta:{state:'completed',kind:'click',interactionId:'12345678-1234-4234-8234-123456789abd',x:.5,y:440} });
  activityBus.appendCodeAgentActivity({ taskId:'task-ui-activity', attempt:2, provider:'codex', runId:'run-ui-activity', role:'coder', kind:'tool', state:'finished', callId:'call-ui-grep', toolName:'grep_files', idempotencyKey:'tool:call-ui-grep:finished' });
  writeFileSync(join(dir,'toolcalls.jsonl'), `${JSON.stringify({ts:detailAt,run:'fixture-run',tool:'delegate_task',call:'call-front-delegate',receipt:'已提交后台整理任务 task-ui-backend。'})}\n`);
}
const fixtureHandoffs = activityDetailOnly ? [
  {id:'handoff:task-ui-backend',source:'agents',position:'task-ui-backend',role:'control',taskId:'task-ui-backend',at:detailAt,kind:'agent-handoff',summary:'交给后台：整理今天的待办',state:'submitted',detail:'整理今天的待办，按优先级返回。'},
  {id:'return:task-ui-backend',source:'agents',position:'task-ui-backend',role:'control',taskId:'task-ui-backend',at:new Date(Date.now()+20).toISOString(),kind:'agent-return',summary:'后台返回结果',state:'done',detail:'已按优先级整理 3 项待办。'},
] : [];
function output(text:string) { const id = `fixture-${++cursor}`; outputs.push({ id, messageId:id, index:0, text, kind:'say', cursor, ts:new Date().toISOString() }); }
const server = createServer(async (req,res) => {
  if (req.headers['x-lingxi-token'] !== token) { res.writeHead(401).end(); return; }
  const bodyParts: Buffer[] = []; for await (const part of req) bodyParts.push(part as Buffer);
  const body = bodyParts.length ? JSON.parse(Buffer.concat(bodyParts).toString()) : {};
  const path = new URL(req.url ?? '', 'http://localhost').pathname;
  let data: unknown = {};
  if (path === '/lingxi/status') data = { name:'灵犀', paused:false, body:{connected:false,x:.5}, feeling:'rested; restless', feelingState:{codes:['rested','restless'],text:'rested; restless',summary:'精力充足；有点无聊，想活动'}, front:process.argv.includes('--interaction-only') ? {state:'failed',error:'fixture reconnect boundary',inputCursors:[0]} : {state:'processing',inputCursors:[1],updatedAt:detailAt} };
  else if (path === '/lingxi/settings') data = {name:'灵犀',user:'测试者'};
  else if (path === '/lingxi/runtime-settings' && req.method === 'GET') data = runtimeSettings;
  else if (path === '/lingxi/runtime-settings' && req.method === 'POST') { runtimeSettings = { ...runtimeSettings, model:{ ...runtimeSettings.model, ...Object.fromEntries(Object.entries(body.model || {}).filter(([key]) => key !== 'apiKey')), keyConfigured:runtimeSettings.model.keyConfigured || Boolean(body.model?.apiKey) }, executor:{ ...runtimeSettings.executor, ...(body.executor || {}) } }; data=runtimeSettings; }
  else if (path === '/lingxi/workbench-settings' && req.method === 'GET') data = workbenchSettings;
  else if (path === '/lingxi/workbench-settings' && req.method === 'POST') { workbenchSettings = { ...workbenchSettings, profile:{ ...workbenchSettings.profile, ...(body.profile || {}) }, conversation:{ ...workbenchSettings.conversation, ...(body.conversation || {}), context:{ ...workbenchSettings.conversation.context, ...(body.conversation?.context || {}) }, rounds:{ ...workbenchSettings.conversation.rounds, ...(body.conversation?.rounds || {}) } } }; data=workbenchSettings; }
  else if (path === '/lingxi/asks') data = process.argv.includes('--interaction-only') && !acceptedAnswer
    ? [{ id:'ask-ui-1', question:'先处理哪一项？', options:[] }] : [];
  else if (path === '/lingxi/history') data = {available:true,cursor:0,lines:activityDetailOnly ? [{run:'fixture-run',cursor:1,ts:detailAt,who:'person',kind:'said',text:'请帮我整理待办。'},{run:'fixture-run',cursor:2,ts:new Date(Date.now()+5).toISOString(),who:'pet',kind:'say',text:'好，我先整理一下。'}] : []};
  else if (path === '/lingxi/history-since') data = {available:true,cursor:0,lines:[]};
  else if (path === '/lingxi/activity') {
    const query = new URL(req.url ?? '', 'http://localhost').searchParams;
    data = readCombinedActivity(activityStore, { file:join(dir, activityDetailOnly ? 'toolcalls.jsonl' : 'missing-tool-log'), runId:'fixture-run' }, query.get('cursor') ?? undefined,
      Number(query.get('limit') ?? 50), (after, limit) => activityBus.listCodeAgentActivity(after, limit), () => fixtureHandoffs);
  }
  else if (path === '/lingxi/outputs') { const after = Number(new URL(req.url ?? '', 'http://localhost').searchParams.get('after') ?? 0); data = {available:true,cursor,outputs:outputs.filter(o=>o.cursor>after),receipts}; }
  else if (path === '/lingxi/output-receipt') { if (!receipts.some(r=>r.outputId===body.id)) receipts.push({channel:'workbench',outputId:body.id,state:'presented'}); data={recorded:true}; }
  else if (path === '/lingxi/say') { submitted++; if (submitted===1) output('收到，我会整理。'); else output('猫喜欢晒太阳，因为温暖。'); data={delivered:true}; }
  else if (path === '/lingxi/answer') { acceptedAnswer = body; data={delivered:true}; }
  else if (path === '/lingxi/task-cancel') { cancelRequested=true; data={cancelling:true}; }
  else if (path === '/lingxi/task-note') { noted=true; data={updated:true}; }
  else if (path === '/lingxi/test-state') data={submitted,cancelRequested,acceptedAnswer,runtimeSettings,workbenchSettings};
  else if (path === '/lingxi/tasks') {
    if (process.argv.includes('--interaction-only')) {
      data={open:[
        {id:'cancel-ui-1',status:cancelRequested?'cancelling':'running',runnerId:'framework-v1',what:'可取消任务'},
        {id:'unknown-ui-1',status:'unknown',runnerId:'framework-v1',what:'中断后状态未知',result:'连接中断，结果未知'},
      ],done:[]};
    }
    else {
    if (submitted >= 2 && noted) taskReads++;
    if (taskReads >= 2 && !outputs.some(o=>o.text.includes('周五'))) { output('周一交报告，周三讨论。'); output('周五复查，验收标准：逐项确认。'); }
    const task={id:'task-fixture',status:taskReads>=2?'done':'running',runnerId:'framework-v1',what:'整理材料',result:'整理完毕'};
    data=task.status==='done'?{open:[],done:[task,{id:'follow-up',status:'done',runnerId:'framework-v1',what:'处理补充',result:'整理完毕'}]}:{open:[task],done:[]};
    }
  }
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(data));
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const addr=server.address(); if (!addr || typeof addr==='string') throw new Error('address');
const env:NodeJS.ProcessEnv={...process.env,WORKBENCH_TEST_PORT:String(addr.port),WORKBENCH_TEST_TOKEN:token,WORKBENCH_TEST_PROFILE:profile,WORKBENCH_TEST_EVIDENCE:dir};
delete env.ELECTRON_RUN_AS_NODE;
const activityOnly = process.argv.includes('--activity-only');
const interactionOnly = process.argv.includes('--interaction-only');
if (!activityOnly) env.WORKBENCH_TEST_WINDOW_CONTROLS = '1';
if (process.argv.includes('--narrow')) env.WORKBENCH_TEST_NARROW = '1';
const closeEarly = process.argv.includes('--close-early');
const settingsOnly = process.argv.includes('--settings-only');
const activityDetail = process.argv.includes('--activity-detail-only');
if (activityOnly) env.WORKBENCH_TEST_ACTIVITY_ONLY = '1';
if (interactionOnly) env.WORKBENCH_TEST_INTERACTION_ONLY = '1';
if (closeEarly) env.WORKBENCH_TEST_CLOSE_AFTER_READY = '1';
if (settingsOnly) env.WORKBENCH_TEST_SETTINGS_ONLY = '1';
if (activityDetail) env.WORKBENCH_TEST_ACTIVITY_DETAIL_ONLY = '1';
const electron = resolve('node_modules/electron/dist/electron.exe');
const runElectron = (launchEnv: NodeJS.ProcessEnv) => new Promise<number>((done,reject)=>{const child=spawn(electron,[resolve('tests/fixtures/real-workbench-electron.cjs')],{env:launchEnv,stdio:'inherit',windowsHide:true}); child.once('error',reject);child.once('exit',v=>done(v??1));});
const code=await runElectron(env);
let reopenCode: number | undefined;
let interactionEvidence: {ok?:boolean;steps?:Array<{step:string;outputIds?:string[]}>}|undefined;
let reopenEvidence: {ok?:boolean;steps?:Array<{step:string}>}|undefined;
if (interactionOnly && code === 0) {
  try { interactionEvidence=JSON.parse(readFileSync(join(dir,'ui-session-evidence.json'),'utf8')); } catch {}
  reopenCode=await runElectron({...env,WORKBENCH_TEST_INTERACTION_REOPEN:'1'});
  try { reopenEvidence=JSON.parse(readFileSync(join(dir,'ui-reopen-evidence.json'),'utf8')); } catch {}
  if (interactionEvidence && reopenEvidence) writeFileSync(join(dir,'ui-evidence.json'),JSON.stringify({ok:interactionEvidence.ok===true&&reopenEvidence.ok===true,
    steps:[...(interactionEvidence.steps??[]),...(reopenEvidence.steps??[])], screenshots:['workbench.png','workbench-reopened.png']},null,2));
}
await new Promise<void>(r=>server.close(()=>r()));
await activityBus.closeAsync();
let evidence: {ok?:boolean;steps?:Array<{step:string;outputIds?:string[]}>}|undefined;
try { evidence=JSON.parse(readFileSync(join(dir,'ui-evidence.json'),'utf8')); } catch {}
let settingsEvidence: {ok?:boolean;steps?:Array<{step:string}>}|undefined;
if (settingsOnly) { try { settingsEvidence=JSON.parse(readFileSync(join(dir,'settings-acceptance.json'),'utf8')); } catch {} }
let activityDetailEvidence: {ok?:boolean;timelineKinds?:string[]}|undefined;
if (activityDetail) { try { activityDetailEvidence=JSON.parse(readFileSync(join(dir,'activity-detail-acceptance.json'),'utf8')); } catch {} }
const final=evidence?.steps?.find(s=>s.step==='result-rendered-and-receipted');
const activity=evidence?.steps?.find(s=>s.step==='agent-activity-rendered');
const interaction=evidence?.steps?.find(s=>s.step==='interaction-session-complete');
const reopened= evidence?.steps?.find(s=>s.step==='application-reopened-state-restored');
const ok=activityDetail ? code===0 && activityDetailEvidence?.ok===true && existsSync(join(dir,'activity-switch-off.png')) && existsSync(join(dir,'activity-switch-on.png')) : settingsOnly ? code===0 && settingsEvidence?.ok===true : closeEarly ? code!==0 && evidence?.ok===false : activityOnly ? code===0 && evidence?.ok===true && !!activity && existsSync(join(dir,'workbench.png')) : interactionOnly ? code===0 && reopenCode===0 && evidence?.ok===true && !!interaction && !!reopened && existsSync(join(dir,'workbench.png')) && existsSync(join(dir,'workbench-reopened.png')) : code===0 && evidence?.ok===true && !!final?.outputIds?.length && final.outputIds.every(id=>receipts.some(r=>r.outputId===id)) && existsSync(join(dir,'workbench.png'));
process.stdout.write(JSON.stringify({dir,code,reopenCode,ok,settingsEvidence,activityDetailEvidence,outputCount:outputs.length,receiptCount:receipts.length,finalIds:final?.outputIds,acceptedAnswer,cancelRequested})+'\n');
process.exitCode=ok?0:1;
