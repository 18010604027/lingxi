import { afterEach, describe, expect, it } from 'vitest';
import { VoiceQueue, splitSentences } from '../src/index.ts';
import { FakeBackend, FakeDevices, FakePlayer, clip } from './fakes.ts';

const queues: VoiceQueue[] = [];
const setup = (timeoutMs = 60_000) => {
  const backend = new FakeBackend(), devices = new FakeDevices(), player = new FakePlayer();
  const queue = new VoiceQueue({ backend, devices, player, synthesisTimeoutMs: timeoutMs }); queues.push(queue);
  return { queue, backend, devices, player };
};
afterEach(async () => { await Promise.all(queues.splice(0).map(q => q.stop())); });

describe('speech sequencing and interruption', () => {
  it('keeps source prefixes and Unicode offsets through sentence and length splitting', () => {
    for (const text of ['你好！下一句。\n再说。', 'The value is 3.14. Next sentence.', '🪴第一句。Second one!', '\n先说。\n\n再说。']) {
      const sentences = splitSentences(text, 12);
      expect(sentences.map(s => s.text).join('')).toBe(text);
      for (const s of sentences) expect(Array.from(text).slice(s.startCharacter, s.endCharacter).join('')).toBe(s.text);
    }
    expect(splitSentences(' \n ')).toEqual([]);
  });

  it('prefetches the next sentence but plays in source order when synthesis finishes out of order', async () => {
    const { queue, backend, player } = setup();
    const task = queue.enqueue('第一句。第二句。第三句。');
    await expect.poll(() => backend.calls.length).toBe(2);
    backend.calls[1]!.response.resolve(clip());
    await new Promise(resolve => setImmediate(resolve)); expect(player.plays).toHaveLength(0);
    backend.calls[0]!.response.resolve(clip());
    await expect.poll(() => player.plays.length).toBe(1); player.finish(0);
    await expect.poll(() => player.plays.length).toBe(2);
    await expect.poll(() => backend.calls.length).toBe(3);
    backend.calls[2]!.response.resolve(clip()); player.finish(1);
    await expect.poll(() => player.plays.length).toBe(3); player.finish(2);
    expect((await task.done).heard.confirmedText).toBe('第一句。第二句。第三句。');
  });

  it('does not synthesize blank leading paragraphs and maps aligned progress back to the original prefix', async () => {
    const { queue, backend, player } = setup();
    const task = queue.enqueue('\n\n甲乙。');
    await expect.poll(() => backend.calls.length).toBe(1);
    expect(backend.calls[0]!.text).toBe('甲乙。');
    backend.calls[0]!.response.resolve(clip([{ endCharacter: 1, atMs: 100 }]));
    await expect.poll(() => player.plays.length).toBe(1); player.advance(0, 120);
    expect((await task.interrupt()).heard.confirmedText).toBe('\n\n甲');
  });

  it('stops sound, cancels prefetched work, and returns only aligned spoken characters', async () => {
    const { queue, backend, player } = setup();
    const task = queue.enqueue('甲乙丙。后续一句。还没开始。');
    await expect.poll(() => backend.calls.length).toBe(2);
    backend.calls[0]!.response.resolve(clip([{ endCharacter: 1, atMs: 100 }, { endCharacter: 2, atMs: 200 }]));
    await expect.poll(() => player.plays.length).toBe(1); player.advance(0, 160);
    const result = await task.interrupt();
    expect(player.plays[0]!.stopped).toBe(true);
    expect(result).toMatchObject({ kind: 'interrupted', heard: { sentenceIndex: 0, confirmedCharacters: 1, partialCharacters: 1, confirmedText: '甲' } });
    expect(backend.calls[1]!.signal.aborted).toBe(true);
    expect(backend.calls.map(c => c.text)).toEqual(['甲乙丙。', '后续一句。']);
    backend.calls[1]!.response.resolve(clip());
    await new Promise(resolve => setImmediate(resolve)); expect(player.plays).toHaveLength(1);
  });

  it('reports unknown partial text without inventing character timing', async () => {
    const { queue, backend, player } = setup();
    const task = queue.enqueue('第一句。第二句。');
    await expect.poll(() => backend.calls.length).toBe(2);
    backend.calls.forEach(c => c.response.resolve(clip()));
    await expect.poll(() => player.plays.length).toBe(1); player.finish(0);
    await expect.poll(() => player.plays.length).toBe(2); player.advance(1, 500);
    expect((await task.interrupt()).heard).toMatchObject({ completedSentences: 1, sentenceIndex: 1, partialCharacters: null, confirmedText: '第一句。' });
  });

  it('cancels a queued request immediately while an earlier one waits for confirmation', async () => {
    const { queue, devices, backend } = setup(); devices.change('room-output', 1);
    const first = queue.enqueue('待确认。'), second = queue.enqueue('取消这句。');
    await expect.poll(() => first.state.kind).toBe('confirmation-required');
    expect((await second.interrupt()).kind).toBe('interrupted');
    expect(backend.calls).toHaveLength(0);
  });

  it('contains a synthesis failure and lets the next request run', async () => {
    const { queue, backend, player } = setup();
    const bad = queue.enqueue('失败。'), good = queue.enqueue('继续。');
    await expect.poll(() => backend.calls.length).toBe(1);
    backend.calls[0]!.response.reject(new Error('Unavailable'));
    expect((await bad.done).kind).toBe('failed');
    await expect.poll(() => backend.calls.length).toBe(2); backend.calls[1]!.response.resolve(clip());
    await expect.poll(() => player.plays.length).toBe(1); player.finish(0);
    expect((await good.done).kind).toBe('completed');
  });

  it('times out an unresponsive synthesizer and aborts its request', async () => {
    const { queue, backend, player } = setup(20);
    const task = queue.enqueue('超时。');
    const result = await task.done;
    expect(result).toMatchObject({ kind: 'failed', reason: 'Synthesis timed out' });
    expect(backend.calls[0]!.signal.aborted).toBe(true); expect(player.plays).toHaveLength(0);
  });
});

describe('output permission', () => {
  it('requires a new single-use confirmation for every non-headphone utterance', async () => {
    const { queue, backend, devices, player } = setup(); devices.change('room-output', 1);
    const first = queue.enqueue('这一次。');
    await expect.poll(() => first.state.kind).toBe('confirmation-required');
    const token = first.state.challenge!.id;
    expect(await first.confirm(token)).toBe(true); expect(await first.confirm(token)).toBe(false);
    await expect.poll(() => backend.calls.length).toBe(1); backend.calls[0]!.response.resolve(clip());
    await expect.poll(() => player.plays.length).toBe(1); player.finish(0); await first.done;
    const next = queue.enqueue('下一次。');
    await expect.poll(() => next.state.kind).toBe('confirmation-required');
    expect(await next.confirm(token)).toBe(false); expect(backend.calls).toHaveLength(1);
  });

  it('invalidates confirmation through A→B→A and stops an active headphone stream on a change', async () => {
    const { queue, backend, devices, player } = setup(); devices.change('room-output', 1);
    const waiting = queue.enqueue('待确认。');
    await expect.poll(() => waiting.state.kind).toBe('confirmation-required'); const token = waiting.state.challenge!.id;
    devices.change('other-output', 1); devices.change('room-output', 1);
    expect(await waiting.confirm(token)).toBe(false); expect((await waiting.done).reason).toBe('device-changed');
    devices.change('wired-output', 3);
    const active = queue.enqueue('耳机播放。');
    await expect.poll(() => backend.calls.length).toBe(1); backend.calls[0]!.response.resolve(clip());
    await expect.poll(() => player.plays.length).toBe(1); devices.change('room-output', 1);
    expect((await active.done).reason).toBe('device-changed'); expect(player.plays[0]!.stopped).toBe(true);
    expect(player.plays[0]!.endpointId).toBe('wired-output');
  });

  it('fails closed for unknown form factors and absent endpoints', async () => {
    const { queue, devices, backend } = setup(); devices.change('uncertain-output', null);
    const uncertain = queue.enqueue('未知。');
    await expect.poll(() => uncertain.state.kind).toBe('confirmation-required'); await uncertain.interrupt();
    devices.endpoint = null; const absent = queue.enqueue('无设备。');
    expect((await absent.done).kind).toBe('failed'); expect(backend.calls).toHaveLength(0);
  });
});
