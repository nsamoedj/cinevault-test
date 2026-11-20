import type { Candidate, SearchQuery } from './types.js';

/** Lowercase, no accents or punctuation, "&" → "and", no leading article. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/^(the|a|an|de|het|een)\s+/, '')
    .replace(/\s+/g, '');
}

function bigrams(text: string): Map<string, number> {
  const result = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    result.set(gram, (result.get(gram) ?? 0) + 1);
  }
  return result;
}

/** Dice coefficient on character bigrams of the normalized titles, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const gramsX = bigrams(x);
  const gramsY = bigrams(y);
  let overlap = 0;
  for (const [gram, count] of gramsX) overlap += Math.min(count, gramsY.get(gram) ?? 0);
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
  titleScore: number;
}

export function scoreCandidate(
  query: SearchQuery,
  candidate: Candidate,
  rank: number,
): ScoredCandidate {
  const titleScore = Math.max(
    titleSimilarity(query.title, candidate.title),
    candidate.originalTitle ? titleSimilarity(query.title, candidate.originalTitle) : 0,
  );
  let score = titleScore - rank * 0.01;
  if (query.year && candidate.year) {
    const diff = Math.abs(query.year - candidate.year);
    score += diff === 0 ? 0.2 : diff === 1 ? 0.1 : -0.3;
  }
  return { candidate, score, titleScore };
}

/**
 * Picks the best search result, or nothing when no result is convincing.
 * Rather unmatched (and fixed by hand) than silently wrong.
 */
export function pickBest(query: SearchQuery, candidates: Candidate[]): ScoredCandidate | undefined {
  const scored = candidates
    .map((candidate, rank) => scoreCandidate(query, candidate, rank))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return undefined;

  const yearDiff =
    query.year && best.candidate.year ? Math.abs(query.year - best.candidate.year) : undefined;
  if (yearDiff !== undefined && yearDiff > 1) return undefined;
  // With a matching year a close title is enough; without a year we want (near) equality.
  const needed = yearDiff !== undefined ? 0.8 : 0.9;
  return best.titleScore >= needed ? best : undefined;
}

/**
 * Extra queries for titles a provider's search may not find as written, e.g.
 * "A Marvel Television Special Presentation - The Punisher - One Last Kill".
 */
export function alternativeTitles(title: string): string[] {
  const result: string[] = [];
  if (title.includes(' - ')) {
    result.push(title.replace(/ - /g, ': '));
    const parts = title.split(' - ');
    for (let i = 1; i < parts.length - 1; i++) result.push(parts.slice(i).join(': '));
  }
  return result.filter((t) => t !== title);
}
