import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BodyLink } from '../core/behavior/body-link.ts';

describe('body link waits', () => {
  let link: BodyLink | undefined;
  afterEach(() => { link?.close(); link = undefined; });

  it('rejects an outstanding body event wait when the body disconnects', async () => {
    link = new BodyLink();
    const address = await link.start(0);
    const client = new WebSocket(address);
    await once(client, 'open');
    const waiting = link.waitFor((message) => message.t === 'clip');

    client.close();
    await expect(waiting).rejects.toThrow('body disconnected');
    client.terminate();
  });

  it('rejects immediately when no body is connected', async () => {
    link = new BodyLink();
    await link.start(0);
    await expect(link.waitFor(() => true)).rejects.toThrow('body disconnected');
  });
});
