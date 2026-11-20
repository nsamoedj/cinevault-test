import { describe, expect, it } from 'vitest';
import { isLatinScript } from '../src/script.js';

describe('isLatinScript', () => {
  it('accepts Latin titles with accents, digits and punctuation', () => {
    for (const title of ['Fire Force', 'Pokémon: The Movie', 'Amélie', 'Ne Zha 2', '9-1-1', '']) {
      expect(isLatinScript(title), title).toBe(true);
    }
  });

  it('rejects titles with letters in other scripts', () => {
    for (const title of ['炎炎ノ消防隊', '诡秘之主', '神之塔 -Tower of God-', 'स्त्री 2', 'Брат']) {
      expect(isLatinScript(title), title).toBe(false);
    }
  });
});
