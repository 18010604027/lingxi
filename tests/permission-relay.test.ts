import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { Agents } from '../core/agents/roles.ts';
import { LingxiPersona } from '../core/persona.ts';
import { PetWorld } from '../core/pet/world.ts';
import { BodyLink } from '../core/behavior/body-link.ts';
import { Behavior } from '../core/behavior/behavior.ts';
import { loadPack } from '../core/behavior/pack.ts';
import { createLocalFront } from '../core/runtime/local-app.ts';
import { ScriptedModel } from './fixtures/scripted-model.ts';
import type { CodeAgentAdapter } from '../core/agents/code-agent.ts';

describe('a permission relayed through the standard front', () => {
  it('wakes thinking, lets the front ask, accepts one shared answer and keeps chatting', async () => {
    const dir=mkdtempSync(join(tmpdir(),'lingxi-permission-relay-'));
    let front!:ReturnType<typeof createLocalFront>;
    const persona=new LingxiPersona({memoryDir:dir,front:()=>front.source});
    const link=new BodyLink();const {figure}=loadPack(process.cwd(),'tests/fixtures/pack');
    const behavior=new Behavior(link,figure,figure.bodyWidth);
    let agents!:Agents;
    const world=new PetWorld({link,behavior,figure,timezone:'UTC',userName:()=> '朋友',sleep:async()=>{},
      onQuestion:(question,state,channel)=>agents.markPermissionQuestion(question,state,channel)});
    let decisions=0;
    const ref={provider:'fixture',runId:'permission-fixture'};
    const adapter:CodeAgentAdapter={id:'fixture',label:'fixture',running:false,takesImages:false,
      capabilities:{streaming:false,thoughts:false,resume:false,cancel:false,permissions:true,usage:false,structuredOutput:false,sandbox:true,networkPolicy:true},
      detect:async()=>({id:'fixture',available:true}),start:async()=>{},close:async()=>{},onExit:()=>()=>{},
      run:async(_task,options)=>{options.onStarted?.(ref);const allow=await options.onPermission({run:ref,title:'write',detail:'one note outside the task folder',input:{path:'fixture/notes'}});decisions++;return{ref,status:'succeeded',summary:allow?'allowed once':'refused',resumed:false}}};
    agents=new Agents({dataDir:dir,log:console,front:()=>front.source,fileTools:()=>persona.fileTools(),codeAgent:adapter,
      codeWorkspace:{cwd:dir,writableRoot:dir,readRoots:[dir]}});
    persona.setAgents(agents);
    const states:string[]=[];let requestId='';let continued=false;
    const end=(id:string)=>new AIMessage({content:'',tool_calls:[{id,name:'end_turn',args:{}}]});
    const model=new ScriptedModel([
      messages=>{const input=JSON.stringify(messages);requestId=/\[permission (perm-[^\] ]+)\]/.exec(input)?.[1]??'';expect(requestId).not.toBe('');return new AIMessage({content:'',tool_calls:[{id:'ask',name:'pet_ask',args:{question:'我想把这份记录保存到任务目录外，可以吗？',options:['仅这次可以','不可以'],requestId}}]})},
      end('end-ask'),
      messages=>{expect(JSON.stringify(messages)).toContain(`[permission requestId: ${requestId}`);return new AIMessage({content:'',tool_calls:[{id:'answer',name:'answer_permission',args:{id:requestId,allow:true}}]})},
      end('end-answer'),
      ...Array.from({length:4},(_,index)=>(messages:import('@langchain/core/messages').BaseMessage[])=> {
        if (!continued && JSON.stringify(messages).includes('继续聊吧')) { continued=true; return new AIMessage({content:'',tool_calls:[{id:'say',name:'pet_say',args:{script:'好呀，我们接着聊。'}}]}); }
        return end('end-followup-'+index);
      }),
    ]);
    front=createLocalFront({model,tools:persona.frontTools(world.tools()),log:console,eventFile:join(dir,'events.sqlite'),checkpointPath:join(dir,'front.sqlite'),sessionId:'front',
      context:async({events})=>{await persona.onEvents(events);return persona.context()},onState:state=>states.push(state)});
    persona.setStore(front.events);
    await world.start({store:front.events,pushEvent:(event,options)=>front.events.pushEvent(event,options)});
    try {
      agents.start();const task=agents.bus.submit({to:'coder',from:'front',body:'write one note'});
      await expect.poll(()=>front.events.pending().some(event=>event.text.includes('[permission '))).toBe(true);
      await front.drain();
      const question=world.pendingAsks()[0]!;expect(question.requestId).toBe(requestId);
      expect(agents.permissionContext()).toContain('relay=asked');expect(states).toContain('processing');
      await world.outputReceipt(world.outputs().outputs.find(part=>part.messageId===question.id)!.id);
      expect(agents.permissionContext()).toContain('presented=workbench');
      await Promise.all([world.answered(question.question,'仅这次可以',question.id),world.answered(question.question,'仅这次可以',question.id)]);
      await front.drain();
      await expect.poll(()=>agents.bus.get(task.id)?.status).toBe('done');
      await front.drain();
      expect(decisions).toBe(1);expect(front.events.range({}).filter(event=>event.type==='pet.answer')).toHaveLength(1);
      expect(agents.permissionContext()).toBe('');
      await world.typed('继续聊吧');await front.drain();
      expect(world.outputs().outputs.some(part=>part.text==='好呀，我们接着聊。')).toBe(true);
      expect(states).not.toContain('failed');
    } finally {await world.stop();await agents.closeAsync();await front.close();await persona.close();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
});
