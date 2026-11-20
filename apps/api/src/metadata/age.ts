// Age ratings: from which age a title is meant, for kids profiles. TMDB has
// the ratings per country (movies in release_dates, shows in content_ratings).
// The Dutch Kijkwijzer comes first; without it Germany (FSK), the UK (BBFC)
// or the US (MPA, TV Parental Guidelines), converted to an age.

export interface AgeRating {
  /** From this age; 0 is for everyone ("AL"). */
  age: number;
  /** As given, with the country: "NL 12", "US PG-13". */
  certification: string;
}

const COUNTRIES = ['NL', 'DE', 'GB', 'US'] as const;

const GB: Record<string, number> = {
  U: 0,
  PG: 8,
  '12': 12,
  '12A': 12,
  '15': 15,
  '18': 18,
  R18: 18,
};
const US: Record<string, number> = {
  G: 0,
  PG: 8,
  'PG-13': 13,
  R: 17,
  'NC-17': 18,
  'TV-Y': 0,
  'TV-Y7': 7,
  'TV-Y7-FV': 7,
  'TV-G': 0,
  'TV-PG': 8,
  'TV-14': 14,
  'TV-MA': 17,
};

/** One country's rating as an age; undefined when it isn't one we know. */
export function ageOf(country: string, rating: string): number | undefined {
  const value = rating.trim().toUpperCase();
  if (!value) return undefined;
  switch (country) {
    case 'NL':
      if (value === 'AL' || value === 'ALL') return 0;
      return /^(6|9|12|14|16|18)\+?$/.test(value) ? Number.parseInt(value, 10) : undefined;
    case 'DE':
      return /^(0|6|12|16|18)$/.test(value) ? Number(value) : undefined;
    case 'GB':
      return GB[value];
    case 'US':
      return US[value];
    default:
      return undefined;
  }
}

/** The best rating of a title from TMDB's ratings per country. */
export function pickAgeRating(
  ratings: { country: string; rating: string }[],
): AgeRating | undefined {
  for (const country of COUNTRIES) {
    for (const r of ratings.filter((x) => x.country === country)) {
      const age = ageOf(country, r.rating);
      if (age !== undefined) return { age, certification: `${country} ${r.rating.trim()}` };
    }
  }
  return undefined;
}
