import type { BodyMessage } from '../behavior/body-link.ts';
import type { PetWorld } from '../pet/world.ts';

type BodyInputLink = { on(event: 'message', listener: (message: BodyMessage) => void): unknown };
type BodyInputWorld = Pick<PetWorld, 'typedFromBody' | 'actionsFromBody'> & Partial<Pick<PetWorld, 'answered'>>;

/** Route the body's text into the same PetWorld, where a unique pending ask may consume it as an answer. */
export function bindBodyInput(link: BodyInputLink, world: () => BodyInputWorld | null): void {
  link.on('message', (message) => {
    if (message.t === 'typed') void world()?.typedFromBody(message.text);
    else if (message.t === 'answer') void world()?.answered?.(message.question, message.text, message.questionId);
    else if (message.t === 'act') world()?.actionsFromBody(message.actions);
  });
}
