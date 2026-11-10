import { describe, expect, it } from 'vitest';
import { createModel } from '../packages/lingxi-provider/src/index.ts';

describe('memory model configuration', () => {
  it('uses the standard adapter without thinking while leaving front configuration intact', () => {
    const entry = {baseUrl:'http://127.0.0.1:9/v1',spec:{model:'fixture',thinking:true,reasoningEffort:'high' as const}};
    const front = createModel(entry);
    const memory = createModel({...entry,spec:{...entry.spec,thinking:false,reasoningEffort:'none'}});
    expect(memory.reasoning).toMatchObject({effort:'none'});
    expect(front.reasoning).toMatchObject({effort:'high'});
    expect(entry.spec.thinking).toBe(true);
  });
});
