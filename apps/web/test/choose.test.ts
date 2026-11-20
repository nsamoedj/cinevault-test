import type { SubtitleOption } from '@cinevault/shared';
import { describe, expect, it } from 'vitest';
import { chooseSubtitle } from '../src/subtitles/choose.js';

const option = (
  id: string,
  language: string,
  extra: Partial<SubtitleOption> = {},
): SubtitleOption => ({
  id,
  source: 'embedded',
  language,
  forced: false,
  hearingImpaired: false,
  offsetMs: 0,
  supported: true,
  ...extra,
});

describe('chooseSubtitle', () => {
  const options = [
    option('en-forced', 'eng', { forced: true }),
    option('en', 'eng'),
    option('nl-pgs', 'nld', { supported: false }),
    option('nl', 'nld', { source: 'external' }),
  ];

  it('shows Dutch, else English, for audio in another language (anime)', () => {
    expect(chooseSubtitle(options, 'jpn', undefined)?.id).toBe('nl');
    expect(chooseSubtitle(options.slice(0, 3), 'jpn', undefined)?.id).toBe('en');
  });

  it('shows only forced subtitles for audio that is read here', () => {
    expect(chooseSubtitle(options, 'eng', undefined)?.id).toBe('en-forced');
    expect(chooseSubtitle(options, 'nld', undefined)).toBeUndefined();
  });

  it('follows the choice made before on this device', () => {
    expect(chooseSubtitle(options, 'jpn', 'off')).toBeUndefined();
    expect(chooseSubtitle(options, 'eng', 'eng')?.id).toBe('en');
    // The preferred language is not there: the usual rules apply.
    expect(chooseSubtitle(options, 'jpn', 'fra')?.id).toBe('nl');
  });
});
