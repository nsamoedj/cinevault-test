// What the players skip by themselves for a profile (User.skipSettings):
// the intro, the recap, the credits (with a next episode: that one at once)
// and the preview of the next episode. Nothing until the profile turns it on.

import type { SkipSettings } from '@cinevault/shared';

export function skipSettings(saved: unknown): SkipSettings {
  const value = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  return {
    intro: value.intro === true,
    recap: value.recap === true,
    credits: value.credits === true,
    preview: value.preview === true,
  };
}
