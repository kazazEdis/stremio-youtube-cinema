/**
 * index.js — candidate generation, scoring and the accept/review/reject call.
 *
 * Public surface is spec §8. The four score* functions are pure and exported
 * individually because tuning the weights means calling them in isolation,
 * without an index and without a network.
 *
 * The governing rule from the brief: a wrong match is worse than no match. A
 * bad tconst makes every other addon in the user's stack confidently serve the
 * wrong thing. When in doubt this module routes to review, never to accept.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalize, normVariants, similarity, stripTrailingYear } from './normalize.js';

// §3 — beyond this the title is too generic to resolve safely.
const MAX_CANDIDATES = 25;
// §3 tier 3 — below this a fuzzy candidate is not worth scoring.
const FUZZY_FLOOR = 0.85;

export const THRESHOLDS = { accept: 85, margin: 12, review: 60 };

const SERIES_TYPES = new Set(['tvSeries', 'tvMiniSeries']);

// Default for opts.currentReleaseChannels: no channel is exempt from the
// recent-year flag unless the caller names it. A probe or a test that knows
// nothing about config/channels.json therefore gets the strict §5 behaviour.
const EMPTY_SET = new Set();

// #region ---------------------------------------------------------- index
/**
 * Open the SQLite index built by build-index.js.
 *
 * Everything stays in SQLite and is reached through prepared statements. The
 * box this runs on has under 4 GB and, on the Android VM, no balloon device to
 * hand memory back with — so the one thing we must not do is pull the title
 * table into a JS Map for convenience.
 */
export async function buildIndex({ cacheDir = '.cache', dbPath } = {}) {
  const file = dbPath || path.join(cacheDir, 'imdb.sqlite');
  await fsp.access(file).catch(() => {
    throw new Error(`no index at ${file} — run: node src/resolve/build-index.js --cache ${cacheDir}`);
  });

  const db = new DatabaseSync(file, { readOnly: true });

  const qExact = db.prepare(`
    SELECT t.tconst, t.titleType, t.primaryTitle, t.originalTitle, t.isAdult,
           t.startYear, t.runtimeMinutes, t.genres, n.source, n.region, n.language
    FROM title_norm n JOIN titles t ON t.tconst = n.tconst
    WHERE n.norm = ?`);

  // The length bound is in SQL rather than JS on purpose. Dice similarity
  // cannot reach the fuzzy floor between strings of very different lengths, so
  // those rows are dead weight — and materialising a whole 3-year window of
  // them is what exhausted a 1 GB heap on the first full catalog run.
  const qYearWindow = db.prepare(`
    SELECT DISTINCT n.norm, n.source, t.tconst, t.titleType, t.primaryTitle,
           t.originalTitle, t.isAdult, t.startYear, t.runtimeMinutes, t.genres
    FROM title_norm n JOIN titles t ON t.tconst = n.tconst
    WHERE t.startYear BETWEEN ? AND ?
      AND LENGTH(n.norm) BETWEEN ? AND ?`);

  const qCredits = db.prepare(
    `SELECT category, name, tokens FROM credits WHERE tconst = ?`);

  const qMeta = db.prepare(`SELECT value FROM meta WHERE key = ?`);

  return {
    db,
    dataset: qMeta.get('dataset')?.value ?? null,
    built: qMeta.get('built')?.value ?? null,
    titleCount: Number(qMeta.get('titles')?.value ?? 0),

    exact(norm) {
      return qExact.all(norm);
    },

    /** Streams rather than returning an array — see the note on qYearWindow. */
    yearWindow(lo, hi, minLen, maxLen) {
      return qYearWindow.iterate(lo, hi, minLen, maxLen);
    },

    credits(tconst) {
      return qCredits.all(tconst);
    },

    close() { db.close(); },
  };
}
// #endregion

// #region ---------------------------------------------------------- scoring
/**
 * §4 title, max 50. `kind` is how the candidate was found, not how good it is:
 * an exact hit on a localized aka is slightly weaker evidence than an exact hit
 * on the primary title, because akas are noisier and more numerous.
 */
export function scoreTitle(kind, ratio = 1) {
  if (kind === 'primary' || kind === 'original') return 50;
  if (kind === 'aka') return 44;
  return 50 * ratio;
}

/**
 * §4 year, max 20. An absent year scores neutral rather than zero — plenty of
 * legitimate uploads omit it, and punishing absence just pushes good matches
 * under the floor where they cost a human a review instead.
 */
export function scoreYear(ytYear, imdbYear, runtimeCorroborates = false) {
  // §4 gives a missing year a neutral 8 so that absence does not push a good
  // match under the floor. Measured against the warehouse, 8 does exactly that:
  // 1,194 reviewed uploads score precisely 84, a five-fold spike over every
  // neighbouring bucket, because the commonest shape of a *correct* match is
  // 50 title + 8 year + 20 runtime + 6 corroboration. One point short.
  //
  // The year exists to separate same-titled films of different eras. When the
  // title matched exactly and the runtime lands in the top band, the era is
  // already pinned by the runtime, and the absence of a year is not evidence
  // against the match. Checked against a signal the scorer never reads -- the
  // year written in the YouTube description -- this set agrees 92.3% of the
  // time, against 94.0% for the yearless matches already published. It is the
  // same bar, applied consistently, not a lower one.
  if (ytYear == null || imdbYear == null) return runtimeCorroborates ? 12 : 8;
  const d = Math.abs(ytYear - imdbYear);
  if (d === 0) return 20;
  if (d === 1) return 14;
  if (d === 2) return 6;
  return 0;
}

/**
 * §4 runtime, max 20. Returns null to mean "reject this candidate outright" —
 * a delta that extreme says the upload is not this film at all.
 *
 * The PAL band is the one that looks like a bug and is not: 24fps film
 * transferred at 25fps runs about 4% *short*, so a systematic negative delta
 * around −4% is the signature of a normal European TV master.
 */
export function scoreRuntime(ytMin, imdbMin) {
  if (!ytMin || !imdbMin) return 0;
  const delta = (ytMin - imdbMin) / imdbMin;

  if (delta < -0.45) return null;   // part 1 of a split upload
  if (delta > 0.60) return null;    // double feature or compilation

  if (delta >= -0.02 && delta <= 0.03) return 20;   // direct match + intro/outro
  if (delta >= -0.06 && delta < -0.02) return 17;   // PAL speedup
  if (delta > 0.03 && delta <= 0.12) return 12;     // restored / director's cut
  if (delta >= -0.20 && delta < -0.06) return 6;    // TV edit or cut print
  return 0;
}

/**
 * §4 corroboration, max 10. Graded rather than binary: §4 caps this at 10 for a
 * director hit, but the worked example in §6 shows a corroboration of 6, which
 * only makes sense if a cast-only hit scores below a director hit. Directors
 * are also the stronger signal — channels put "starring" names in descriptions
 * far more loosely than they credit a director.
 */
export function scoreCorroboration(description, credits) {
  if (!description || !credits?.length) return 0;
  const hay = ` ${normalize(description)} `;

  let best = 0;
  for (const c of credits) {
    // build-index.js already dropped tokens under 4 chars: "de", "van" and
    // "kim" match ordinary prose and are not evidence of anything.
    const tokens = (c.tokens || '').split(' ').filter(Boolean);
    if (!tokens.length) continue;
    if (!tokens.some(t => hay.includes(` ${t} `))) continue;
    best = Math.max(best, c.category === 'director' ? 10 : 6);
  }
  return best;
}
/**
 * Type agreement, max 20. Replaces the runtime signal for series.
 *
 * Two problems, one mechanism.
 *
 * The runtime bands are calibrated for features: IMDb records a nominal slot
 * length for a series (30) against episodes that actually run 22-25, a -20%
 * delta that scores nothing. Without a replacement a perfect series match tops
 * out at 50 + 20 + 0 + 10 = 80, under the 85 floor, so no series could ever
 * publish.
 *
 * The other problem is worse. "The Beverly Hillbillies" matches ten movie and
 * video entries in the index, including the 1993 film, and nothing else in the
 * resolver looks at titleType. Scoring alone would eventually publish a 1962
 * sitcom episode against a feature film -- the wrong-tconst failure the spec
 * calls worse than no match at all.
 *
 * Returning null on a type mismatch makes that structurally impossible rather
 * than merely unlikely, in the same way scoreRuntime rejects a split upload.
 */
export function scoreTypeMatch(isEpisode, titleType) {
  const isSeries = SERIES_TYPES.has(titleType);
  if (isEpisode) return isSeries ? 20 : null;
  return isSeries ? null : 0;
}
// #endregion

// #region ---------------------------------------------------------- candidates
const rowToCandidate = (row, kind, ratio = 1) => ({
  tconst: row.tconst,
  titleType: row.titleType,
  primaryTitle: row.primaryTitle,
  originalTitle: row.originalTitle,
  isAdult: Number(row.isAdult) === 1,
  startYear: row.startYear ?? null,
  runtimeMinutes: row.runtimeMinutes,
  genres: row.genres ?? null,
  region: row.region ?? null,
  language: row.language ?? null,
  kind,
  ratio,
});

/**
 * §3, in tiers, stopping at the first tier that yields anything. Tier 3 only
 * runs when a year was extracted — an unfiltered fuzzy sweep over 1.1M titles
 * is both slow and, worse, a reliable source of confident nonsense.
 */
// A dash with space on both sides separates segments; a hyphen inside a word
// does not, so "Spider-Man" survives.
const DASH_SPLIT = /\s+[-–—]\s+/;

/**
 * A segment that is a label rather than a title: a bare year, or one shouted
 * word. Both reached the index and both were wrong -- "1952 - Invasion, U.S.A."
 * offered `1952`, and "Fist Of Shaolin - ENGLISH - RIP" offered `ENGLISH`,
 * which is a real film.
 */
const isLabel = s => /^[\d\s.,'-]+$/.test(s)
  || (!/[a-z]/.test(s) && s.trim().split(/\s+/).length === 1);

export function generateCandidates(video, index) {
  // Query-side only, and additive: we look up more keys, we do not normalize
  // differently. The year has already been extracted into video.year, so the
  // copy still sitting in the title text is noise that matches nothing.
  const variants = [];
  const push = (raw, derived) => {
    for (const v of normVariants(raw || '')) {
      variants.push({ v, derived });
      const noYear = stripTrailingYear(v);
      if (noYear) variants.push({ v: noYear, derived });
    }
  };
  push(video.name, false);

  // Two channel habits put the film's name inside brackets rather than beside
  // them, and neither survives a straight lookup:
  //
  //   The Taste Of The Savage (Eye For An Eye) Western Movie in Full Length
  //   笑傲江湖II東方不敗 (Swordsman II)｜李連杰、關之琳｜粵語中字｜美亞影院
  //
  // The first hangs marketing off the title; the second is Cinema Mei Ah,
  // which writes the Chinese title and puts the English release title in
  // parentheses -- 151 uploads, and the channel published nothing at all.
  // So try the text before the first bracket, and each parenthetical, as
  // additional keys. Still query-side and still additive: more lookups, not a
  // different normalization.
  const derive = () => {
    const name = video.name || '';
    const cut = name.search(/[（([]/);
    if (cut > 3) push(name.slice(0, cut), true);
    for (const m of name.matchAll(/[（([]([^)）\]]{3,60})[)）\]]/g)) {
      if (!/^[\d\s.,-]+$/.test(m[1])) push(m[1], true);
    }

    // Public Domain Movies files its uploads as "<year> - <title> - <tagline>",
    // and the martial-arts channels put the English and the Spanish title on
    // either side of a dash. Every dash segment is a key, and the scorer sorts
    // out which one is the film: "Roy Rogers - 1946 - My Pal Trigger - ..."
    // offers both the star and the picture, and runtime decides.
    for (const seg of name.split(DASH_SPLIT)) {
      const t = seg.trim();
      if (t.length >= 4 && !isLabel(t)) push(t, true);
    }

    // "Jason Statham, Ben Foster in THE MECHANIC". Shouting is what makes this
    // safe: matched case-insensitively, "in" is an ordinary preposition and
    // this rule sent "Shaolin Roar In The Woods" to The Woods. Requiring the
    // tail to carry no lowercase at all took it from half wrong to 27 for 27.
    const cast = /\sin\s+([A-Z0-9][^a-z]{3,})$/.exec(name.trim());
    if (cast) push(cast[1].trim(), true);
  };
  if (!variants.length) return { candidates: [], tier: 'none' };

  // Tier 1 + 2 share a lookup; separate them by which source matched so the
  // scorer can tell an exact primary hit from an exact aka hit.
  const byTconst = new Map();
  const lookup = () => {
    for (const { v, derived } of variants) {
      for (const row of index.exact(v)) {
        const kind = row.source === 'aka' ? 'aka' : row.source;
        const prev = byTconst.get(row.tconst);
        // A tconst can match on several norm rows; keep the strongest source.
        if (!prev || scoreTitle(kind) > scoreTitle(prev.kind)) {
          byTconst.set(row.tconst, { ...rowToCandidate(row, kind), derived });
        }
      }
    }
  };
  lookup();

  // Only reach into the brackets when the title as written found nothing. A
  // rebuilt key must never dilute a direct hit: "Ever After (Reloaded)" is its
  // own real title, and offering "Reloaded" alongside it pulled in a rival
  // that closed the margin to 10 and dropped a published film.
  if (!byTconst.size) { derive(); lookup(); }

  if (byTconst.size) {
    const exact = [...byTconst.values()];
    // A title we had to reconstruct scores the same but is labelled apart, so
    // a bad match from a bracket is visible in the review queue instead of
    // hiding among the ordinary exact hits.
    const tier = exact.every(c => c.derived) ? 'exact-derived'
      : exact.some(c => c.kind !== 'aka') ? 'exact-primary' : 'exact-aka';
    return { candidates: exact, tier };
  }

  if (video.year == null) return { candidates: [], tier: 'none' };

  // Tier 3 — fuzzy, bounded to ±1 year per §3 and to a plausible length band.
  // Read off the keys, not the wrappers. When `variants` became {v, derived}
  // objects this line kept saying `v.length`, which is undefined on an object,
  // so `lens` emptied and the whole fuzzy tier returned early -- silently, and
  // for every upload. Fourteen published films went to no-candidates before
  // the publish diff caught it.
  const keys = variants.map(x => x.v);
  const lens = keys.map(v => v.length).filter(Boolean);
  if (!lens.length) return { candidates: [], tier: 'none' };
  const bound = FUZZY_FLOOR - 0.05;
  const minLen = Math.floor(Math.min(...lens) * bound);
  const maxLen = Math.ceil(Math.max(...lens) / bound);

  const fuzzy = new Map();
  for (const row of index.yearWindow(video.year - 1, video.year + 1, minLen, maxLen)) {
    for (const v of keys) {
      const ratio = similarity(v, row.norm);
      if (ratio < FUZZY_FLOOR) continue;
      const prev = fuzzy.get(row.tconst);
      if (!prev || ratio > prev.ratio) fuzzy.set(row.tconst, rowToCandidate(row, 'fuzzy', ratio));
    }
    // A title generic enough to fuzzy-match this much is not resolvable
    // safely; stop early rather than build a huge set we will reject anyway.
    if (fuzzy.size > MAX_CANDIDATES * 4) break;
  }
  return { candidates: [...fuzzy.values()], tier: fuzzy.size ? 'fuzzy' : 'none' };
}
// #endregion

// #region ---------------------------------------------------------- resolve
/**
 * Lift the yearless neutral from 8 to 12 on the winning candidate.
 *
 * A missing year is a property of the *upload*: it is absent for every
 * candidate or none. Applying the lift inside scoreCandidate therefore looked
 * right and was not -- the condition reads the candidate's own runtime, so a
 * rival with a better runtime gained four points that the winner did not, and
 * the margin moved. That is runtime re-weighted from 20 to 24 by the back
 * door, and it cost four already-published films their margin (Expelled, The
 * Clones, Scared to Death, The Dynamite Trio all fell from accept to
 * narrow-margin at 9).
 *
 * So the lift happens here instead: after the ranking and the margin are both
 * settled, on the winner alone. It can move a match over the accept floor. It
 * can never move a match past another match.
 */
function relaxYearless(video, best) {
  if (video.year != null) return;
  if (best.kind === 'fuzzy') return;          // the title never matched exactly

  // What pins the era differs by type, and reading only the runtime shut
  // episodes out of this entirely: scoreCandidate zeroes runtime for them on
  // purpose, because IMDb's series runtime is a nominal slot length. So the
  // same cliff formed again on the series side -- 107 episodes at exactly 84.
  //
  // For an episode the type agreement *is* the corroboration: the candidate is
  // a tvSeries carrying that exact title, which is what the marker claimed.
  // A year would not have helped anyway, since IMDb's startYear is when the
  // show began and the upload carries the episode's own date.
  // 17, not 20. Both bands mean *the same cut of the film*: 20 is a direct
  // match, 17 is the -2%..-6% PAL speedup, which is a mechanical artifact of
  // the transfer rather than a difference in content. Band 6 is where a print
  // is actually cut, and that stays out.
  //
  // Measured on the 2,617 accepted matches whose year agreed exactly -- a
  // population confirmed by a signal other than runtime -- the bands land:
  //
  //     20   1,590   60.8%
  //     17     484   18.5%
  //     12     180    6.9%
  //      6     362   13.8%
  //
  // So requiring 20 withheld the lift from nearly a fifth of the matches that
  // are demonstrably correct. It gains 170 films, every sampled one right:
  // exact title, a cast hit in the description, and a runtime 2-5 minutes
  // under IMDb's because IMDb counts the credits.
  const pinned = (best.signals.runtime ?? 0) >= 17
              || (best.signals.typeMatch ?? 0) >= 20;
  if (!pinned) return;

  best.signals.year = 12;
  best.score = Number((best.score + 4).toFixed(1));
}

function scoreCandidate(video, candidate, index, isEpisode) {
  const typeMatch = scoreTypeMatch(isEpisode, candidate.titleType);
  if (typeMatch === null) return null;      // a film is not an episode's show

  // An episode scores type agreement where a film scores runtime; IMDb's series
  // runtime is a nominal slot length and does not survive the feature bands.
  const runtime = isEpisode ? 0 : scoreRuntime(video.runtimeMin, candidate.runtimeMinutes);
  if (runtime === null) return null;        // §4 hard reject band

  const title = scoreTitle(candidate.kind, candidate.ratio);
  // Strict neutral here, always. The relaxed one is applied once to the winner
  // in resolveOne, after the ranking is settled -- see relaxYearless.
  const year = scoreYear(video.year, candidate.startYear);
  const corroboration = scoreCorroboration(video.description, index.credits(candidate.tconst));

  const signals = {
    title: Number(title.toFixed(1)),
    year,
    runtime,
    corroboration,
  };
  if (isEpisode) signals.typeMatch = typeMatch;
  return {
    ...candidate,
    signals,
    score: Number((title + year + runtime + corroboration + typeMatch).toFixed(1)),
  };
}

/**
 * §5 hard flags. These override the score and always route to review — a high
 * score on a film that came out last year is a well-matched piracy upload, not
 * a catalog entry.
 *
 * `currentReleaseChannels` is the exception, and it exists because the spec's
 * premise for `recent-year` is "a recent theatrical title *on a free channel*".
 * That premise fails for the four channels that are the rights holder: their
 * catalogue *is* current releases, so the year carries no information about
 * whether the upload is licensed, and the flag was rejecting the whole modern
 * half of their output.
 *
 * Measured over the 526 flagged uploads: 500 are on those channels, and of the
 * 333 that also clear the score floor and the margin the runtime delta against
 * IMDb has a median of 0.00% with 291 inside ±3% — runtime being the one signal
 * the year flag knows nothing about. The flag was not catching piracy there.
 *
 * It is kept everywhere else, and that is not caution for its own sake: all
 * five genuinely wrong matches in the bucket were on *archive* channels, where
 * a modern hit is anomalous — `Spider Island (1962)` reaching a 2026 title of
 * the same name, `Goodbye Love (1933)` reaching a 2025 one. On a channel whose
 * median film is from 1943 the recency *is* the evidence, so it still fires.
 */
function hardFlag(candidate, score, now = new Date(), currentReleases = false) {
  if (candidate.isAdult) return 'adult';
  if (!currentReleases
      && candidate.startYear != null && candidate.startYear >= now.getFullYear() - 5) {
    return 'recent-year';
  }
  if (candidate.titleType === 'video' && score < 90) return 'video-type';
  return null;
}

const publicShape = (video, best, margin, extra = {}) => ({
  ytId: video.ytId,
  imdbId: best.tconst,
  // The Stremio type, and for an episode the id it actually requests. imdbId
  // stays the bare series tconst so the catalogue can group a show's episodes
  // under one entry; `id` is what a stream file is named after.
  stremioType: SERIES_TYPES.has(best.titleType) ? 'series' : 'movie',
  season: video.__episode?.season ?? null,
  episode: video.__episode?.episode ?? null,
  id: video.__episode
    ? `${best.tconst}:${video.__episode.season}:${video.__episode.episode}`
    : best.tconst,
  name: best.primaryTitle,
  // Spec §2: every record keeps rawTitle, accepted ones included. Without it
  // an accepted-but-wrong match is undebuggable — you cannot see what the
  // channel actually called the film.
  rawTitle: video.rawTitle,
  year: best.startYear,
  confidence: best.score,
  margin,
  signals: best.signals,
  ytRuntimeMin: video.runtimeMin,
  imdbRuntimeMin: best.runtimeMinutes,
  channel: video.channel,
  group: video.group,
  poster: video.poster ?? null,
  genres: best.genres,
  ...extra,
});

/**
 * Resolve one video. Returns { status: 'accept' | 'review' | 'reject', ... }.
 *
 * `opts.overrides` is the human escape hatch from §6: a ytId -> imdbId map that
 * is consulted before any scoring happens and is trusted absolutely.
 */
export function resolveOne(video, index, opts = {}) {
  const { overrides = {}, now = new Date(), episode = null,
          currentReleaseChannels = EMPTY_SET } = opts;
  // Carried on the video rather than passed down every call site; publicShape
  // and scoreCandidate are the only readers.
  video = episode ? { ...video, __episode: episode } : video;
  const isEpisode = Boolean(episode);

  const override = overrides[video.ytId];
  if (override) {
    const row = index.exact(normalize(video.name)).find(r => r.tconst === override)
      ?? index.db.prepare(
           `SELECT tconst, titleType, primaryTitle, originalTitle, isAdult,
                   startYear, runtimeMinutes, genres FROM titles WHERE tconst = ?`
         ).get(override);
    if (row) {
      const c = rowToCandidate(row, 'primary');
      return {
        status: 'accept',
        ...publicShape(video, { ...c, score: 100, signals: { override: 100 } }, 100),
        override: true,
      };
    }
  }

  const generated = generateCandidates(video, index);
  const { tier } = generated;
  // Drop type-incompatible candidates BEFORE the cap, not after. The cap exists
  // to catch titles too generic to resolve safely, and counting candidates the
  // scorer is guaranteed to reject inflates it: adding 377k series to the index
  // pushed "Choices", "Flight" and "Framed" past 25 and into review even though
  // every one of the new candidates was a series a film could never match.
  const candidates = generated.candidates
    .filter(c => scoreTypeMatch(isEpisode, c.titleType) !== null);

  if (!candidates.length) {
    // Distinguish "the title matched nothing" from "it matched, but only films
    // when we needed a series". The second is a title-parsing or coverage
    // problem and wants a different fix, so it gets its own reason.
    const reason = generated.candidates.length && isEpisode
      ? 'no-series-match' : 'no-candidates';
    return { status: 'reject', ytId: video.ytId, name: video.name, rawTitle: video.rawTitle,
             channel: video.channel, reason, candidates: [] };
  }
  if (candidates.length > MAX_CANDIDATES) {
    return { status: 'review', ytId: video.ytId, name: video.name, rawTitle: video.rawTitle,
             channel: video.channel, reason: 'too-many-candidates',
             candidateCount: candidates.length, candidates: [] };
  }

  const scored = candidates
    .map(c => scoreCandidate(video, c, index, isEpisode))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return { status: 'reject', ytId: video.ytId, name: video.name, rawTitle: video.rawTitle,
             channel: video.channel,
             // With an episode in hand the usual cause is that every candidate
             // was a film rather than a series, not the runtime bands.
             reason: isEpisode ? 'no-series-match' : 'runtime-rejected',
             candidates: [] };
  }

  const best = scored[0];
  // §5 — a lone candidate has nothing to be confused with, so its margin is
  // full. Two candidates at 88 and 86 is a coin flip dressed up as confidence.
  const margin = scored.length > 1 ? Number((best.score - scored[1].score).toFixed(1)) : 100;

  // Kept before the lift, and written to fct_resolution.score, because the two
  // numbers answer different questions: `confidence` is what the floor judged,
  // `score` is what §4 alone produced. Both columns existed and neither was
  // ever written -- score was NULL on every accepted row and candidate_count on
  // all but one rejection path, which is the shape of a diagnostic nobody can
  // use for the tuning it exists to serve.
  const rawScore = best.score;
  const candidateCount = scored.length;

  relaxYearless(video, best);

  const top5 = scored.slice(0, 5).map(c => ({
    imdbId: c.tconst, name: c.primaryTitle, year: c.startYear,
    runtimeMinutes: c.runtimeMinutes, score: c.score, kind: c.kind, signals: c.signals,
  }));

  const flag = hardFlag(best, best.score, now, currentReleaseChannels.has(video.channelRef));
  if (flag) {
    return { status: 'review', ...publicShape(video, best, margin, { rawScore, candidateCount }),
             rawTitle: video.rawTitle, reason: flag, tier, candidates: top5 };
  }
  if (best.score >= THRESHOLDS.accept && margin >= THRESHOLDS.margin) {
    return { status: 'accept', ...publicShape(video, best, margin, { rawScore, candidateCount }), tier };
  }
  if (best.score >= THRESHOLDS.review) {
    return { status: 'review', ...publicShape(video, best, margin, { rawScore, candidateCount }),
             reason: best.score >= THRESHOLDS.accept ? 'narrow-margin' : 'low-score',
             tier, candidates: top5 };
  }
  return { status: 'reject', ytId: video.ytId, name: video.name, rawTitle: video.rawTitle,
           channel: video.channel, reason: 'low-score', score: best.score, candidates: top5 };
}

/**
 * Resolve a whole catalog, then settle duplicates.
 *
 * Two videos landing on one tconst is common — channels re-upload, and two
 * channels carry the same public-domain print. §5 says keep the higher score
 * and flag the loser, which also keeps the published catalog keyed 1:1 on
 * imdbId the way the Stremio handler and the report diff both assume.
 */
export function settleDuplicates(results) {
  // Keyed on the published id, not imdbId. Ninety-one episodes of one show
  // share a series tconst and are ninety-one distinct entries, not ninety
  // duplicates -- keying on the tconst would discard an entire series but one
  // episode, and trip the duplicate quality gate on the way.
  const accepted = new Map();   // published id -> resolution
  const review = [];
  const rejected = [];

  for (const r of results) {
    if (r.status === 'accept') {
      const key = r.id ?? r.imdbId;
      const prev = accepted.get(key);
      if (!prev) { accepted.set(key, r); continue; }
      // Ties must not be settled by iteration order. Two uploads of the same
      // film frequently score identically, and letting whichever arrived first
      // win makes the published ytId depend on how the rows happened to be
      // read -- so the catalog churns between runs and report.js reports
      // re-uploads that never happened. Measured: 156 of 2,102 films.
      //
      // ytId is an arbitrary but stable discriminator. Preferring the
      // most-viewed upload would be a better answer and needs view_count
      // threaded through the resolution shape; see docs/TODO.md.
      const better = r.confidence !== prev.confidence
        ? r.confidence > prev.confidence
        : r.ytId < prev.ytId;
      const [winner, loser] = better ? [r, prev] : [prev, r];
      accepted.set(key, winner);
      review.push({ ...loser, status: 'review', reason: 'duplicate',
                    duplicateOf: winner.ytId, candidates: [] });
    } else if (r.status === 'review') {
      review.push(r);
    } else {
      rejected.push(r);
    }
  }
  return { resolved: [...accepted.values()], review, rejected };
}

export function resolveAll(catalog, index, opts = {}) {
  const videos = catalog.movies || catalog;
  // Duplicate settling is separated out so a caller that needs to checkpoint
  // its way through a long catalog can drive resolveOne itself and still get
  // identical duplicate handling at the end.
  return settleDuplicates(videos.map(v => resolveOne(v, index, opts)));
}
// #endregion
