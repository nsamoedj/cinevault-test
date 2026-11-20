import { describe, expect, it } from 'vitest';
import { bufferedAhead, diagnose, measureThroughput } from '../src/playbackStats.js';

function ranges(...list: [number, number][]) {
  return {
    length: list.length,
    start: (i: number) => list[i]![0],
    end: (i: number) => list[i]![1],
  } as TimeRanges;
}

/** A response whose reader advances a fake clock by `msPerChunk` on every read. */
function fakeStream(tick: (ms: number) => void, chunk: number, chunks: number, msPerChunk: number) {
  let sent = 0;
  const reader = {
    read: async () => {
      tick(msPerChunk);
      return sent++ < chunks
        ? { done: false, value: new Uint8Array(chunk) }
        : { done: true, value: undefined };
    },
    cancel: async () => {},
  };
  return { ok: true, status: 206, body: { getReader: () => reader } } as unknown as Response;
}

describe('measureThroughput', () => {
  it('reads a range of the stream and reports bits per second', async () => {
    let clock = 0;
    let requested: RequestInit | undefined;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      requested = init;
      // 1 MB per 100 ms = 80 Mbit/s
      return fakeStream((ms) => (clock += ms), 1_000_000, 5, 100);
    }) as typeof fetch;

    const result = await measureThroughput('/api/files/f/stream', {
      offset: 1000,
      maxBytes: 3_000_000,
      fetch: fakeFetch,
      now: () => clock,
    });
    expect(new Headers(requested?.headers).get('range')).toBe('bytes=1000-3000999');
    expect(result.bytes).toBe(3_000_000);
    expect(result.bps).toBeCloseTo(80_000_000, -5);
  });

  it('stops after the time limit', async () => {
    let clock = 0;
    const fakeFetch = (async () =>
      fakeStream((ms) => (clock += ms), 10, 1_000, 1_000)) as typeof fetch;
    const result = await measureThroughput('/x', {
      offset: 0,
      maxMs: 3_000,
      fetch: fakeFetch,
      now: () => clock,
    });
    expect(result.bytes).toBe(30);
  });

  it('fails on an HTTP error', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    await expect(measureThroughput('/x', { offset: 0, fetch: fakeFetch })).rejects.toThrow(
      'HTTP 404',
    );
  });
});

describe('bufferedAhead', () => {
  it('measures the buffered range around the playback position', () => {
    expect(bufferedAhead({ currentTime: 10, buffered: ranges([0, 4], [8, 30]) })).toBe(20);
    expect(bufferedAhead({ currentTime: 5, buffered: ranges([0, 4], [8, 30]) })).toBe(0);
    expect(bufferedAhead({ currentTime: 0, buffered: ranges() })).toBe(0);
  });
});

describe('diagnose', () => {
  const smooth = { droppedFrames: 0, totalFrames: 1000, stalls: 0 };
  const mbit = (n: number) => ({ bytes: 0, ms: 1, bps: n * 1_000_000 });

  it('blames the decoder when frames drop', () => {
    expect(diagnose({ ...smooth, droppedFrames: 100 }, 60e6, mbit(500)).kind).toBe('decoder');
    // Too few frames to judge.
    expect(diagnose({ droppedFrames: 10, totalFrames: 50, stalls: 0 }, 60e6, undefined).kind).toBe(
      'ok',
    );
  });

  it('compares the speed with the bitrate of the file', () => {
    expect(diagnose(smooth, 60e6, mbit(40))).toMatchObject({ kind: 'network' });
    expect(diagnose(smooth, 60e6, mbit(70))).toMatchObject({ kind: 'tight' });
    expect(diagnose(smooth, 60e6, mbit(200)).kind).toBe('ok');
  });

  it('notes stalls it cannot explain', () => {
    expect(diagnose({ ...smooth, stalls: 2 }, 60e6, undefined).kind).toBe('unknown');
  });
});
