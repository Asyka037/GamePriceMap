/**
 * Title matching for discovery pipelines — pure functions, no I/O.
 *
 * Unicode-safe normalization: keeps ALL letters/numbers (Latin, kana, kanji,
 * Cyrillic …), so pure-Japanese titles no longer normalize to '' and falsely
 * "exact-match" each other (review finding, 2026-07-10).
 */
export function normTitle(s) {
  return String(s ?? '')
    .toLowerCase()
    // NFKC expands symbols such as ™ into the letters "TM". Remove legal
    // marks first so official Nintendo titles still match catalog display
    // titles that intentionally omit trademark boilerplate.
    .replace(/[™®©℠]/gu, '')
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

/**
 * Exact normalized equality, optionally tolerating a known edition suffix.
 * Empty normalizations never match (guard against symbol-only titles).
 */
export function titleMatches(candidate, wanted) {
  const c = normTitle(candidate);
  const w = normTitle(wanted);
  if (!c || !w) return false;
  if (c === w) return true;
  return c.startsWith(w) && /^(fornintendoswitch|nintendoswitchedition)$/.test(c.slice(w.length));
}
