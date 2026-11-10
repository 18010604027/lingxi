import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { BodyMessage } from '../core/behavior/body-link.ts';
import { bindBodyInput } from '../core/runtime/body-input.ts';

describe('body input route', () => {
  it('sends only body typed messages to the current PetWorld answer-aware input', () => {
    const link = new EventEmitter();
    const typedFromBody = vi.fn(async () => true);
    const actionsFromBody = vi.fn();
    bindBodyInput(link as never, () => ({ typedFromBody, actionsFromBody }));

    link.emit('message', { t: 'click', x: 0.5 } satisfies BodyMessage);
    link.emit('message', { t: 'typed', text: 'tea' } satisfies BodyMessage);
    link.emit('message', { t: 'act', actions: ['wave'] } satisfies BodyMessage);

    expect(typedFromBody).toHaveBeenCalledTimes(1);
    expect(typedFromBody).toHaveBeenCalledWith('tea');
    expect(actionsFromBody).toHaveBeenCalledOnce();
    expect(actionsFromBody).toHaveBeenCalledWith(['wave']);
  });

  it('routes a clicked choice by question id and leaves interpretation to the front', () => {
    const link = new EventEmitter();
    const answered = vi.fn(async () => true);
    bindBodyInput(link as never, () => ({ typedFromBody: vi.fn(), actionsFromBody: vi.fn(), answered }));
    link.emit('message', { t: 'answer', questionId: 'q1', question: '继续吗？', text: '继续', requestId: 'perm-1' } satisfies BodyMessage);
    expect(answered).toHaveBeenCalledWith('继续吗？', '继续', 'q1');
  });
});
