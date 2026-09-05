/**
 * title.js — turning a channel's YouTube title into something matchable.
 *
 * This is a *transform* concern, not an extraction one. It used to live in
 * src/indexer.js and run during the fetch, which meant the cleaned title was
 * stored as though it were a fact: improving a heuristic then forced a
 * re-clean of the whole catalog, done three times in one session. Keeping it
 * here means a heuristic change costs a replay, never a re-fetch.
 *
 * Every rule below exists because a real channel broke the previous one. The
 * cases are pinned in test/clean-title.test.js.
 */

const YEAR_RE = /\b(?:19\d{2}|20\d{2})\b/;
// Genre words belong here: channels lead with them ("Bollywood COMEDY Movie |
// Fool N Final"), and leaving them in lets a marketing segment outscore the
// actual title on length alone.
const MARKETING = /\b(full|free|hd|4k|1080p|720p|movie|film|subtitles?|subtitled|remastered|exclusive|premiere|classic|bollywood|drama|action|horror|thriller|comedy|western|romantic|superhit|blockbuster)\b/gi;
const CAST_HINT = /\b(starring|with|feat\.?|ft\.?)\b/i;

// "(1963)", "[1963]", "(MGM,1930)" — a parenthesised release year.
const YEAR_PAREN = /[([]\s*(?:[A-Za-z.&]{2,}\s*,\s*)?(?:19\d{2}|20\d{2})\s*[)\]]/;

// Symbols these channels use as separators: emoji, dingbats, and the shouty
// punctuation that ends a clickbait hook.
const BOUNDARY = /[|✦•●★◆♦♥♣※▶►—–!?:;~]+|[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/gu;

/**
 * Pull the film title out using the release year as an anchor.
 *
 * These channels wrap the title in marketing on both sides, with no pipe to
 * split on: "NEW HD RESTORATION🍕 The Crawling Hand (1963) Sci-Fi Horror
 * Classic, FULL HD MOVIE". Everything after the year is genre tags and cast;
 * everything before it is a hook ending in an emoji or exclamation. So the
 * title is the text immediately preceding the year, back to the nearest
 * separator — which is far more reliable than trying to enumerate the
 * marketing vocabulary, because every channel invents its own.
 */
function titleBeforeYear(s) {
  const m = YEAR_PAREN.exec(s);
  if (!m) return null;
  const head = s.slice(0, m.index);
  const parts = head.split(BOUNDARY).map(x => x.trim()).filter(Boolean);
  const pick = parts.length ? parts[parts.length - 1] : head.trim();
  // Guard against a hook that *is* the last segment, e.g. a bare "NEW".
  return pick.length >= 2 ? pick : null;
}

/**
 * True for "Sunny Deol, Shahid Kapoor" but not "The Good, the Bad and the Ugly".
 *
 * A cast list is commas joining capitalised names with no lowercase connective
 * words; a title that happens to contain a comma almost always has one. Getting
 * this apart matters because the cast segment is usually the *longest* clean
 * segment, so length-based scoring picks it every time.
 */
function looksLikeCastList(s) {
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every(p => /^[A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*){0,3}$/.test(p));
}

/**
 * Choose which pipe-separated segment is actually the film.
 *
 * The obvious rule — take the first segment carrying no marketing words —
 * inverts on the commonest layout there is:
 *
 *   "Cavalry Command (1963) Full HD Movie | John Agar, Richard Arlen"
 *
 * The marketing sits *on* the title, which leaves the cast list as the only
 * "clean" segment, so the naive rule picks the actors and the film resolves to
 * nonsense. The release year is the dependable signal instead: channels attach
 * it to the title and never to the cast or the marketing tail.
 */
function pickSegment(segments) {
  const withYear = segments.filter(s => YEAR_RE.test(s));
  if (withYear.length === 1) return withYear[0];

  const pool = withYear.length ? withYear : segments;
  const score = s => {
    const body = s.replace(MARKETING, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!body) return -Infinity;
    // Effectively exclude cast lists rather than merely penalise them: they are
    // reliably the longest clean segment, so any length-based score picks them.
    if (looksLikeCastList(s)) return -1000;
    return body.length - (CAST_HINT.test(s) ? 25 : 0);
  };
  return pool.reduce((best, s) => (score(s) > score(best) ? s : best), pool[0]);
}

/**
 * Strip channel marketing from titles so the resolver has something to match.
 * "FULL MOVIE | The Sea Wolf (1941) | Free Drama 4K" -> "The Sea Wolf (1941)"
 * "🍕Cavalry Command (1963) Full HD Movie | John Agar" -> "Cavalry Command (1963)"
 */
export function cleanTitle(raw, channel = '') {
  let input = raw;

  // Several channels brand every upload with their own name — "Wu Tang
  // Collection - The Bride with White Hair". Left in place it is carried into
  // the normalized key and matches nothing in IMDb, which silently rejects the
  // channel's entire catalog.
  if (channel) {
    const esc = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    input = input.replace(new RegExp(`^\\s*${esc}\\s*[-–—:|]+\\s*`, 'i'), '');
  }

  const segments = input.split('|').map(s => s.trim()).filter(Boolean);
  let t = segments.length > 1 ? pickSegment(segments) : input;

  // The year anchor beats every other heuristic when it is present.
  const anchored = titleBeforeYear(t);
  if (anchored) t = anchored;

  // Quality tokens first: "Full HD Movie" splits "full" from "movie", so the
  // phrase below cannot match until the "HD" between them is gone.
  t = t.replace(/\b(4k|hd|1080p|720p|remastered|english\s+subtitles?|subtitled|exclusive|premiere)\b/gi, ' ');
  t = t.replace(/\b(full|free)\s+(movie|film)\b/gi, ' ');
  t = t.replace(/\s+(movie|film)\s*$/gi, ' ');
  t = t.replace(/[\[\(]\s*[\]\)]/g, ' ');
  // Channel branding emoji and decoration lead the title on several of these
  // channels; normalize() would drop them later, but `name` is user-visible.
  t = t.replace(/^[^\p{L}\p{N}]+/u, '');
  t = t.replace(/\s{2,}/g, ' ').trim();

  // Some channels separate with dashes rather than pipes:
  // "THE IRON MONKEY - (ENGLISH Subtitled) - CHEN KUAN TAI". Drop trailing
  // dash segments that are empty or a shouted performer name, but keep the
  // first segment always — plenty of real titles are themselves all caps, and
  // dashes inside titles ("Ace Ventura - Pet Detective") must survive.
  // Whitespace on *either* side, not both: channels write "(ENGLISH )- NAME"
  // as often as " - NAME". Requiring a space on both sides still protects
  // hyphenated words like "Spider-Man", which have space on neither.
  const dashed = t.split(/\s+[-–—]+\s*|\s*[-–—]+\s+/).map(x => x.trim());
  if (dashed.length > 1) {
    const isNoise = x => !x || !/[A-Za-z0-9]/.test(x)
      || (!/[a-z]/.test(x) && x.replace(/[()]/g, ' ').trim().split(/\s+/).length <= 4)
      || looksLikeCastList(x);
    let end = dashed.length;
    while (end > 1 && isNoise(dashed[end - 1])) end--;
    t = dashed.slice(0, end).join(' - ');
  }

  t = t.replace(/\s{2,}/g, ' ').trim();
  t = t.replace(/^[-–—:,\s]+|[-–—:,\s]+$/g, '');
  return t || input.trim() || raw.trim();
}

export function extractYear(raw) {
  const m = /\b(19[0-9]{2}|20[0-2][0-9])\b/.exec(raw);
  return m ? Number(m[1]) : null;
}
