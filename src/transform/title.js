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

// normalize is shared with the resolver on purpose: the guard below asks "is
// anything left of this title?", and that question has to be answered the same
// way the index answers it.
import { normalize } from '../resolve/normalize.js';

const YEAR_RE = /\b(?:19\d{2}|20\d{2})\b/;
// Genre words belong here: channels lead with them ("Bollywood COMEDY Movie |
// Fool N Final"), and leaving them in lets a marketing segment outscore the
// actual title on length alone.
const MARKETING = /\b(full|free|hd|4k|1080p|720p|movie|film|subtitles?|subtitled|remastered|exclusive|premiere|classic|bollywood|drama|action|horror|thriller|comedy|western|romantic|superhit|blockbuster)\b/gi;
// The genre vocabulary MARKETING deliberately leaves out, because these words
// appear in real titles ("Crime Wave", "Family Plot") and stripping them from
// the *output* would be wrong. They are only used to decide whether a segment
// that already carries a marketing word has any title left underneath.
const GENRE = /\b(sci-?fi|science\s+fiction|crime|mystery|adventure|fantasy|war|wwii|noir|survival|disaster|apocalypse|family|sport|documentary|animation|animated|hollywood|feature|epic|suspense|supernatural|creature|monster|slasher|zombie|musical|biography|history|historical|british|american|cowboy|samurai|romance|double\s+bill|found\s+footage|martial\s+arts|kung\s+fu|movies|films|tv|series|episode|presents)\b/gi;

// "starring" and "feat." are unambiguous credit markers. "with" is NOT:
// these channels write hooks like "Trapped With A Killer Dog", and every
// one of them is vetoed here rather than by looksLikeHook, which floors at
// six words. Narrowing this to a following capitalised name gained a handful
// of real titles ("Poker with Pistols") and lost eleven hooks, so the blunt
// version stays until looksLikeHook can carry its own weight.
const CAST_HINT = /\b(starring|feat\.?|ft\.?)\b/i;
// "with" carries three jobs on these channels and needs all three separated.
// It introduces a credit ("All Tied Up (1993) with Teri Hatcher"), it joins two
// noun phrases in an ordinary title ("Poker with Pistols", "Roll With It", "Go
// with God, Gringo"), and it hangs a prepositional phrase off a clickbait
// clause ("Trapped With A Killer Dog", "Husband's Secret Meetings with
// Mobsters"). looksLikeHook cannot reach the third: its six-word floor is
// load-bearing -- lowering it convicts "The Last Man On Earth" and "Attack Of
// The Crab Monsters", which are the same shape as a hook and Title-Cased the
// same way.
//
// Length separates the remaining two. A title spends its words on the two
// nouns, so the whole segment is short; a hook has already said something
// before it reaches "with". Five words is where the corpus splits, and it
// splits cleanly: every one of the eleven hooks is at least five words, and
// none of the titles under five is a hook.
const WITH_NAME = /\bwith\s+[A-Z][\p{L}'\u2019.-]+\s+[A-Z]/u;
const WITH_CLAUSE = /\bwith\b/i;
const castHint = (s) => {
  if (CAST_HINT.test(s) || WITH_NAME.test(s)) return true;
  if (!WITH_CLAUSE.test(s)) return false;
  return s.trim().split(/\s+/).filter(Boolean).length >= 5;
};

// "(1963)", "[1963]", "(MGM,1930)" — a parenthesised release year.
// "(1963)", "(MGM,1930)", "(1975 Action film)", "(1972 Horror)" -- studios and
// distributors precede the year, genre words follow it, and both appear.
// "(1963)", "(MGM,1930)", "(TV-1954)", "(1975 Action film)", "(1972 Horror)".
// Studios and broadcast markers precede the year separated by a comma or a
// hyphen; genre words follow it. All four forms occur in the catalogue.
const YEAR_PAREN = /[([]\s*(?:[A-Za-z.&]{2,}\s*[,\-]\s*)?(?:19\d{2}|20\d{2})(?:\s+[A-Za-z][\w'-]*){0,3}\s*[)\]]/;

// Channels that carry several dubs of the same film label the print in the
// title: "The Shaolin Invincibles WIDESCREEN", "Kung Fu King DUTCH", "Exposed
// to Danger (ENGLISH )", "Shaolin Vs Manchu (Subtítulos en Español)". The
// language of the print is not part of the film's name, and left in place it
// goes into the normalized key and matches nothing -- 470 Wu Tang uploads
// reached no candidate at all for this reason alone.
//
// Only a *trailing* run is stripped, and only a bracket that holds nothing
// else. "The English Patient" keeps its language, because that is where the
// language belongs.
const PRINT_TAG = /^(?:widescreen|fullscreen|uncut|uncensored|dub(?:bed)?|sub(?:bed|s|titulos?|titulado|titles?)?|multisub|espanol|english|spanish|french|german|italian|portuguese|dutch|russian|mandarin|cantonese|tagalog|korean|japanese|arabic|turkish|greek|polish|colou?rized|restored|version|audio|en|de|la|el|y)$/i;
// An article on its own is not a title, so it cannot be what a strip leaves.
const BARE_ARTICLE = /^(?:the|a|an|le|la|les|el|los|der|die|das|il|lo)$/i;
const TRAILING_TAG = /[\s,\-–—|]*\b(widescreen|fullscreen|dub(?:bed)?|subbed|multisub|english|spanish|french|german|italian|portuguese|dutch|russian|mandarin|cantonese|tagalog|korean|japanese|arabic|turkish|greek|polish|colou?rized)\b[\s.]*$/i;

/** Drop the print label a channel appended, in either place it appears. */
export function stripPrintTag(t) {
  // A bracket made entirely of tag words is a label, not an alternate title.
  let out = t.replace(/[（([]\s*([^)）\]]{0,44})\s*[)）\]]/g, (whole, inner) => {
    // Accents must not hide a tag: "Subtítulos en Español" is the same label
    // as "Subtitulos en Espanol", and only one of them is spelled the way a
    // word list expects.
    const words = String(inner).normalize('NFD').replace(/\p{M}+/gu, '')
      .split(/[\s,+/&·-]+/).filter(Boolean);
    return words.length && words.every(w => PRINT_TAG.test(w)) ? ' ' : whole;
  });
  // Never strip a title down to nothing. "The Korean" ends in a language and
  // is not labelled with one; taking the word left "The", which then matched
  // whatever it liked. If an article is all that survives, the word was the
  // title.
  for (let prev = null; prev !== out; ) {
    prev = out;
    const next = out.replace(TRAILING_TAG, '');
    if (next === out) break;
    if (!normalize(next).split(' ').some(w => w && !BARE_ARTICLE.test(w))) break;
    out = next;
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

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
/**
 * True for a clickbait hook: "Single Mother Fights To Save Her Daughter From
 * Armed Invaders", "She Married An Older Farmer... But Fell For The Farmhand!"
 *
 * These channels lead with a sentence describing the plot and put the actual
 * title second. A hook is a clause -- it runs long and contains lowercase
 * function words (to, her, from, is) that a title-cased film name does not.
 */
function looksLikeHook(s) {
  // Count title words, not the marketing around them: "Cavalry Command (1963)
  // Full HD Movie" is three words plus noise.
  const words = s.replace(MARKETING, ' ').trim().split(/\s+/).filter(Boolean);
  // Short is never a hook. Spaghetti westerns are full of titles like
  // "Don't Wait, Django... Shoot!" whose punctuation would otherwise convict
  // them; length is what separates a punchy title from a plot summary.
  if (words.length < 6) return false;
  // A colon is title punctuation ("Blood Hunters: Rise Of The Hybrids"),
  // essentially never used in these channels' hooks.
  if (s.includes(':')) return false;
  // Punctuation is deliberately NOT a signal. Ellipses and exclamation marks
  // are all over real titles of this era -- "Have a Good Funeral, My Friend...
  // Sartana Will Pay", "God Made Them... I Kill Them" -- and casing already
  // catches the hooks that use them ("She Married An Older Farmer... But Fell
  // For The Farmhand!" Title-Cases every word).
  // Typesetting is the signal: a title keeps its articles and
  // prepositions lowercase, while a hook Title-Cases every word.
  return !words.slice(1).some(w => /^[a-z]/.test(w));
}

/**
 * Shaped like a bare performer name: "Richard Harrison", "Casper Van Dien".
 *
 * Shape alone cannot decide: "Warning Shot" and "Hunt Club" are real titles
 * with the identical shape. See castIndices for what actually separates them.
 */
function looksLikePerson(s) {
  // Marketing is not a person, even when it is shaped like one: "Full Movie"
  // and "Action Survival" are two capitalised words apiece, and counting them
  // made an entire title list look like a cast run.
  if (s.replace(MARKETING, ' ').trim() !== s.trim()) return false;
  const w = s.trim().split(/\s+/).filter(Boolean);
  if (w.length < 2 || w.length > 3) return false;
  return w.every(x => /^[A-Z][\p{L}'’.-]*$/u.test(x));
}

/**
 * Choose which pipe-separated segment is the film.
 *
 * Scoring by length is wrong for the two commonest layouts, because in both the
 * decoy is the longest segment: "Hunt Club | Full Movie | Action Survival |
 * Casper Van Dien" ends in cast names, and "Single Mother Fights To Save Her
 * Daughter | Warning Shot | Full Thriller" opens with a plot sentence.
 *
 * Position carries the signal instead: the title is the earliest segment that
 * is neither marketing, nor a hook, nor a cast list. Falling back to length
 * only when every segment fails that test.
 */
/**
 * Indices of segments that are cast credits rather than titles.
 *
 * Shape is ambiguous -- "Warning Shot" and "Mickey Rourke" are both two
 * capitalised words. What is not ambiguous is that cast names arrive in a run:
 * channels list two or more of them together at the end. A lone name-shaped
 * segment surrounded by marketing is a title.
 */
function castIndices(segments) {
  // The lead segment is never a credit: "Doc Hooker's Bunch | DUB TAYLOR" and
  // "Gentleman Killer | Anthony Steffen" both open with the title and follow
  // with an actor, and treating the pair as a run swallowed both.
  const shaped = segments.map((s, i) => i > 0 && looksLikePerson(s));
  const out = new Set();
  let run = 0;
  for (let i = 0; i <= shaped.length; i++) {
    if (shaped[i]) { run++; continue; }
    if (run >= 2) for (let j = i - run; j < i; j++) out.add(j);
    run = 0;
  }
  return out;
}

function pickSegment(segments) {
  const body = s => s.replace(MARKETING, ' ').replace(/\s{2,}/g, ' ').trim();
  const cast = castIndices(segments);
  // A body with no letters is a bare year or a rating, never a title.
  const usable = (s, i) => /\p{L}/u.test(body(s)) && !looksLikeHook(s)
                      && !looksLikeCastList(s) && !castHint(s)
                      && !cast.has(i);

  // A parenthesised year beats every heuristic below, because titleBeforeYear
  // can pull the title out of the segment carrying it -- even when the segment
  // also holds a hook ("THOU SHALT NOT KILL... Absolution (1978)") or a cast
  // credit ("All Tied Up (1993) with Teri Hatcher"), both of which the hook and
  // cast tests would otherwise veto.
  const parenYear = segments.filter(s => YEAR_PAREN.test(s));
  if (parenYear.length === 1) return parenYear[0];

  // A bare year only identifies the title segment when that segment survives
  // the marketing strip: "... | 2025 Thriller Romance Movie" carries its year
  // on a pure genre tag.
  const withYear = segments.filter((s, i) => YEAR_RE.test(s) && usable(s, i));
  if (withYear.length === 1) return withYear[0];

  const pool = withYear.length ? withYear : segments;

  // A real title seldom contains marketing words, while a genre tag is made of
  // them: "Black Drama", "Funny Western", "Aromanian Full Movie" all shrink
  // under the strip, and each of them beat the actual film before this.
  const intact = s => body(s) === s.trim();

  // Marketing is glued *onto* real titles as often as it stands alone, and
  // "New World Disorder FULL MOVIE" shrinks under the strip exactly as "Action
  // Movies" does. Demanding an untouched segment therefore handed the pick to
  // whatever came later and happened to be clean -- which on these channels is
  // the star, so the catalogue grew films called "Rutger Hauer" and "Ray
  // Liotta". What is left after *both* strips separates them: a title leaves
  // real words behind, a genre tag leaves nothing.
  const titled = s => body(s).replace(GENRE, ' ').replace(/\s{2,}/g, ' ')
                            .trim().split(/\s+/).filter(Boolean).length >= 2;

  const at = pred => {
    const i = pool.findIndex(s => usable(s, segments.indexOf(s)) && pred(s));
    return i < 0 ? Infinity : i;
  };
  // The relaxed test is confined to the opening segment, and only wins there
  // when nothing untouched precedes it. That is where these channels put the
  // title; letting it reach further down turned genre tails -- "Hemingway
  // Fishing Drama", "Seriously Amazing Action Thriller" -- into films, at the
  // cost of the real titles sitting ahead of them.
  const strict = at(intact), loose = at(titled);
  if (loose === 0 && loose < strict) return pool[0];
  if (strict < Infinity) return pool[strict];

  // Nothing clean survived the usable test, so trust an untouched segment even
  // if it reads long -- "Go Tell It On The Mountain" is a title that happens to
  // look like a hook, and the alternative here is always a genre tag.
  const untouched = pool.find(s => /\p{L}/u.test(s) && intact(s)
                                   && !looksLikeCastList(s) && !cast.has(segments.indexOf(s)));
  if (untouched) return untouched;

  const first = pool.find(s => usable(s, segments.indexOf(s)));
  if (first) return first;

  const score = s => (body(s) ? body(s).length : -Infinity)
                     - (looksLikeCastList(s) ? 1000 : 0)
                     - (castHint(s) ? 25 : 0);
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

  // Several CJK channels stamp every upload with a bracketed language label —
  // 【粵語】 (Cantonese), 【國語】 (Mandarin). The bracket rule below only knew
  // the ASCII and fullwidth pairs, so 【 was stripped later as leading junk
  // while the 】 survived mid-string: 九龍冰室 came out as "粵語】九龍冰室" and
  // matched nothing. That left 經典華語老電影 rejecting 92 of its 99 uploads as
  // no-candidates — the whole channel dark on one unhandled bracket.
  //
  // Removing the label is the entire fix: IMDb carries these films under the
  // plain Chinese title in title.akas (九龍冰室 -> tt0304098, 賭神 -> tt0097244),
  // so there is no need to prefer the English segment instead. Bounded to 12
  // characters so it stays a label and cannot eat a bracketed title.
  input = input.replace(/^\s*【[^】]{0,12}】\s*/u, '');

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
  t = stripPrintTag(t) || t;
  return t || input.trim() || raw.trim();
}

export function extractYear(raw) {
  const m = /\b(19[0-9]{2}|20[0-2][0-9])\b/.exec(raw);
  return m ? Number(m[1]) : null;
}
