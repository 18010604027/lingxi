import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { createLocalFront } from '../core/runtime/local-app.ts';
import { ScriptedModel } from './fixtures/scripted-model.ts';

describe('front processing projection', () => {
  it.each(['pet.message','background.notice'])('projects processing for %s before the model finishes', async(type) => {
    const dir=mkdtempSync(join(tmpdir(),'lingxi-front-state-'));
    const states:string[]=[];
    let release!:()=>void;
    const wait=new Promise<void>(resolve=>{release=resolve});
    const model=new ScriptedModel([async()=>{await wait;return new AIMessage('done')}]);
    const front=createLocalFront({model,tools:[],log:console,eventFile:join(dir,'events.sqlite'),checkpointPath:join(dir,'front.sqlite'),sessionId:'front',
      context:()=>({system:'Lingxi',head:'',tail:''}),onState:state=>states.push(state)});
    try {
      front.source.enqueue({type,text:'controlled input'});
      const running=front.drain();
      await expect.poll(()=>states.at(-1)).toBe('processing');
      expect(front.events.pending()).toHaveLength(1);
      release();await running;
      expect(states.at(-1)).toBe('idle');
      expect(front.events.pending()).toHaveLength(0);
    } finally {release();await front.close();rmSync(dir,{recursive:true,force:true});}
  });
});
