import type { NotificationDto } from '@cinevault/shared';
import { describe, expect, it } from 'vitest';
import { pickNew } from '../src/notifications/pick';

const now = Date.parse('2026-10-18T12:00:00Z');
const n = (id: number, extra: Partial<NotificationDto> = {}): NotificationDto => ({
  id,
  type: 'new-episodes',
  title: `Serie ${id}`,
  body: 'Nieuwe aflevering',
  createdAt: new Date(now - 60_000).toISOString(),
  read: false,
  ...extra,
});

describe('pickNew', () => {
  it('shows nothing the first time, but remembers what is there', () => {
    expect(pickNew([n(3), n(2), n(1)], undefined, now)).toEqual({ show: [], seen: [3, 2, 1] });
  });

  it('shows new unread ones, oldest first', () => {
    const result = pickNew([n(5), n(4, { read: true }), n(3), n(2)], [2], now);
    expect(result.show.map((x) => x.id)).toEqual([3, 5]);
    expect(result.seen).toEqual([5, 4, 3, 2]);
    // Next time: nothing again.
    expect(pickNew([n(5), n(4), n(3), n(2)], result.seen, now).show).toEqual([]);
  });

  it('skips old ones, and sums up many at once', () => {
    const old = n(9, { createdAt: new Date(now - 3 * 86_400_000).toISOString() });
    expect(pickNew([old], [1], now).show).toEqual([]);
    const many = [n(16), n(15), n(14), n(13), n(12)];
    const result = pickNew(many, [1], now);
    expect(result.show).toEqual([]);
    expect(result.summary).toMatchObject({ count: 5, latest: { id: 16 } });
  });
});
