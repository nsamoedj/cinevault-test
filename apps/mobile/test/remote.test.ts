import { describe, expect, it } from 'vitest';
import { remoteKey, seekStep } from '../src/tv/remoteKeys';

describe('remote keys', () => {
  it('reads a button that goes down', () => {
    expect(remoteKey({ eventType: 'left', eventKeyAction: 0 })).toBe('left');
    expect(remoteKey({ eventType: 'playPause', eventKeyAction: 0, tag: 12 })).toBe('playPause');
  });

  it('ignores releases, focus changes and unknown buttons', () => {
    expect(remoteKey({ eventType: 'left', eventKeyAction: 1 })).toBeUndefined();
    expect(remoteKey({ eventType: 'focus', eventKeyAction: -1, tag: 3 })).toBeUndefined();
    expect(remoteKey({ eventType: 'blur', eventKeyAction: -1 })).toBeUndefined();
    expect(remoteKey({ eventType: 'channelUp', eventKeyAction: 0 })).toBeUndefined();
    expect(remoteKey({})).toBeUndefined();
  });

  it('seeks faster the longer a button is held', () => {
    expect([0, 3, 4, 9, 10, 19, 20, 50].map(seekStep)).toEqual([10, 10, 30, 30, 60, 60, 120, 120]);
  });
});
