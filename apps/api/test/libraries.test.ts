import { describe, expect, it } from 'vitest';
import { sortLibraries } from '../src/libraries.js';

describe('library order', () => {
  it('puts films first, then series, then anime', () => {
    const libraries = [
      { name: 'Anime', type: 'SHOWS' as const },
      { name: 'Series', type: 'SHOWS' as const },
      { name: 'Movies', type: 'MOVIES' as const },
      { name: 'Kids', type: 'MOVIES' as const },
      { name: 'Japan', type: 'ANIME' as const },
    ];
    expect(sortLibraries(libraries).map((l) => l.name)).toEqual([
      'Kids',
      'Movies',
      'Series',
      'Anime',
      'Japan',
    ]);
  });
});
