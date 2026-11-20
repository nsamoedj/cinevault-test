// TranscoderClient.fingerprint against a transcoder that reports progress:
// it waits as long as the read goes on (a 4K remux on a slow disk), gives up
// when nothing new comes, and still talks to an older transcoder.

import { describe, expect, it } from 'vitest';
import { TranscoderClient, TranscoderError } from '../src/transcoder.js';

const RESULT = { hop: 0.031, count: 2, frames: 'AAAAAAAAAAA=', chapters: [], start: 0 };

/** A transcoder answering with these lines, one every `everyMs`; `hang` keeps it open after. */
function streaming(lines: unknown[], everyMs: number, hang = false) {
  const asked: unknown[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    asked.push(JSON.parse(String(init.body)));
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let i = 0;
        const next = () => {
          if (i < lines.length) {
            controller.enqueue(encoder.encode(`${JSON.stringify(lines[i++])}\n`));
            timer = setTimeout(next, everyMs);
          } else if (!hang) {
            controller.close();
          }
        };
        next();
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          try {
            controller.error(new DOMException('aborted', 'AbortError'));
          } catch {
            // Closed already.
          }
        });
      },
      cancel() {
        clearTimeout(timer);
      },
    });
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
  }) as unknown as typeof fetch;
  return {
    client: new TranscoderClient({ url: 'http://t', token: 'x'.repeat(20), fetch: fetchFn }),
    asked,
  };
}

const request = { path: 'Series/Reacher/S02E05.mkv', seconds: 600 };

describe('fingerprints with progress', () => {
  it('waits past the old timeout while the transcoder reads on', async () => {
    const progress = [1, 2, 3, 4, 5, 6].map((read) => ({ progress: { queued: false, read } }));
    const { client, asked } = streaming([...progress, { result: RESULT }], 30);
    const seen: number[] = [];
    // The old timeout (50 ms) would give up long before the result (~200 ms).
    const result = await client.fingerprint(request, 50, {
      stallMs: 100,
      maxMs: 5_000,
      onRead: (read) => seen.push(read),
    });
    expect(result).toEqual(RESULT);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    expect(asked[0]).toMatchObject({ progress: true });
  });

  it('gives up when nothing new is read, and says how far it got', async () => {
    const { client } = streaming(
      [
        { progress: { queued: false, read: 40 } },
        { progress: { queued: false, read: 40 } },
        { progress: { queued: false, read: 40 } },
        { progress: { queued: false, read: 40 } },
      ],
      30,
      true,
    );
    const error = await client
      .fingerprint(request, 50, { stallMs: 80, maxMs: 5_000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranscoderError);
    expect((error as TranscoderError).statusCode).toBe(408);
    expect((error as TranscoderError).message).toMatch(/nothing read in 0 s \(40 of 600 s read\)/);
  });

  it('keeps waiting while the job waits in line, up to the cap', async () => {
    const queued = Array.from({ length: 20 }, () => ({ progress: { queued: true, read: 0 } }));
    const { client } = streaming(queued, 20, true);
    const error = await client
      .fingerprint(request, 50, { stallMs: 60, maxMs: 200 })
      .catch((e: unknown) => e);
    expect((error as TranscoderError).statusCode).toBe(408);
    expect((error as TranscoderError).message).toMatch(/longer than 0 min/);
  });

  it('passes on an error of the file', async () => {
    const { client } = streaming(
      [{ progress: { queued: true, read: 0 } }, { error: 'no such file', status: 404 }],
      5,
    );
    const error = await client
      .fingerprint(request, 1_000, { stallMs: 1_000, maxMs: 5_000 })
      .catch((e: unknown) => e);
    expect((error as TranscoderError).statusCode).toBe(404);
  });

  it('works with an older transcoder that answers at the end', async () => {
    const fetchFn = (async () => Response.json(RESULT)) as unknown as typeof fetch;
    const client = new TranscoderClient({ url: 'http://t', token: 'x'.repeat(20), fetch: fetchFn });
    expect(await client.fingerprint(request, 1_000, { stallMs: 10, maxMs: 20 })).toEqual(RESULT);
  });
});
