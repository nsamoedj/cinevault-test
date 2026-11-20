/**
 * True when every letter is in the Latin script: "Fire Force" and "Pokémon"
 * are, "炎炎ノ消防隊" and "स्त्री" are not. Titles are shown in English
 * (CLAUDE.md); a title in another script means no English title was found.
 */
export function isLatinScript(text: string): boolean {
  return !/(?=\p{L})\P{Script=Latin}/u.test(text);
}
