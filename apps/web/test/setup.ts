import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetPlaybackCache } from '../src/playback.js';

// jsdom has no media playback.
HTMLMediaElement.prototype.play = async () => {};
HTMLMediaElement.prototype.pause = () => {};
HTMLMediaElement.prototype.load = () => {};

// jsdom calls itself "Apple Computer, Inc." like Safari; the tests are Chrome unless they say so.
beforeEach(() => {
  vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Google Inc.');
});

afterEach(() => {
  resetPlaybackCache();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
