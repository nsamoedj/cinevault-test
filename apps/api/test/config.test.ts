import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults and treats empty optional values as unset', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://localhost/cinevault',
      TMDB_API_KEY: '',
    });

    expect(config.API_PORT).toBe(3000);
    expect(config.MEDIA_ROOT).toBe('/media');
    expect(config.TMDB_API_KEY).toBeUndefined();
  });

  it('coerces the port from a string', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://localhost/cinevault',
      API_PORT: '8080',
    });

    expect(config.API_PORT).toBe(8080);
  });

  it('fails with a readable message when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});

describe('loadConfig metadata settings', () => {
  it('defaults the metadata language, also when it is empty', () => {
    const base = { DATABASE_URL: 'postgresql://localhost/cinevault' };
    expect(loadConfig(base).METADATA_LANGUAGE).toBe('nl-NL');
    expect(loadConfig({ ...base, METADATA_LANGUAGE: '' }).METADATA_LANGUAGE).toBe('nl-NL');
    expect(loadConfig({ ...base, METADATA_LANGUAGE: 'en-US' }).METADATA_LANGUAGE).toBe('en-US');
    expect(() => loadConfig({ ...base, METADATA_LANGUAGE: 'dutch' })).toThrow(/METADATA_LANGUAGE/);
  });

  it('reads SCAN_ON_STARTUP as a boolean', () => {
    const base = { DATABASE_URL: 'postgresql://localhost/cinevault' };
    expect(loadConfig(base).SCAN_ON_STARTUP).toBe(false);
    expect(loadConfig({ ...base, SCAN_ON_STARTUP: 'true' }).SCAN_ON_STARTUP).toBe(true);
  });
});
