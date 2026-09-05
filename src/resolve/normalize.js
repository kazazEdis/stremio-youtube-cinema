/**
 * normalize.js — the single normalization function, used on both sides of every
 * comparison. Asymmetric normalization is the classic source of silent misses,
 * so nothing else in this package is allowed to lowercase or strip on its own.
 */

// NFD does not decompose these; without a map they survive as-is and break
// exact matching for Polish, Nordic and Balkan titles.
const TRANSLIT = new Map(Object.entries({
  'ø': 'o', 'đ': 'd', 'ł': 'l', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe',
  'ð': 'd', 'þ': 'th', 'ı': 'i', 'ŋ': 'n', 'ħ': 'h', 'ŧ': 't', 'ĸ': 'k',
}));

// Spec §2. Deliberately not extended: adding articles here silently changes
// what every indexed row normalizes to.
const ARTICLES = /^(?:the|a|an|le|la|les|el|los|der|die|das|il|lo)\s+/;

/**
 * NFD decompose, strip combining marks, lowercase, punctuation -> space,
 * collapse whitespace. Articles are NOT stripped here — see stripArticle().
 *
 * Trailing roman numerals survive on purpose: `Rocky II` is not `Rocky`.
 *
 * The closing NFC is not decorative. NFD splits Hangul syllables into Jamo,
 * and Jamo are letters rather than combining marks, so \p{M} does not remove
 * them and every Korean title would otherwise be stored decomposed — visually
 * identical, three times longer, and unequal to any precomposed string it is
 * compared against. Recomposing at the end cannot undo the accent stripping,
 * because those marks are already gone by then.
 */
export function normalize(s) {
  if (!s) return '';
  let t = String(s).normalize('NFD').replace(/\p{M}+/gu, '');
  t = t.toLowerCase();
  t = [...t].map(ch => TRANSLIT.get(ch) ?? ch).join('');
  // Anything that is not a letter or a number is a separator. Keeps CJK,
  // Hangul and Cyrillic intact so same-script akas rows still match exactly.
  t = t.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return t.trim().replace(/\s{2,}/g, ' ').normalize('NFC');
}

/** Leading article removed. Returns the input unchanged when there is none. */
export function stripArticle(norm) {
  return norm.replace(ARTICLES, '');
}

/**
 * Both indexed forms of a title, deduped. Index every variant, match against
 * every variant — that is what makes "The Killers" find "Killers" and back.
 */
export function normVariants(s) {
  const base = normalize(s);
  if (!base) return [];
  const stripped = stripArticle(base);
  return stripped === base ? [base] : [base, stripped];
}

/**
 * Dice coefficient over character bigrams. Cheap, order-aware enough for
 * titles, and stable in [0,1] — the fuzzy tier's `ratio` in §4.
 */
export function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = bigrams.get(g) || 0;
    if (n > 0) { bigrams.set(g, n - 1); hits++; }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

/**
 * A normalized title with a trailing release year removed, or null when there
 * is nothing left to match on.
 *
 * cleanTitle() in indexer.js deliberately keeps the year — "The Sea Wolf
 * (1941)" is its own documented example — but IMDb titles do not carry one, so
 * the normalized upload key ends "... 1941" and matches nothing. Callers try
 * both forms rather than picking one, which is also why this returns null for
 * a title that *is* a year: `1917` and `2012` must still find themselves.
 */
const TRAILING_YEAR = /\s(?:19\d{2}|20\d{2})$/;

export function stripTrailingYear(norm) {
  const out = norm.replace(TRAILING_YEAR, '').trim();
  return out && out !== norm ? out : null;
}
