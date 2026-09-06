/**
 * Spec §7 — the runtime bands at every boundary, the other three scorers, and
 * the accept/review/reject decision.
 *
 * The scorers are pure by design (§8) so none of this needs an index or a
 * network. The decision tests use a stub index instead of real IMDb rows: the
 * point here is that the *logic* picks correctly, and synthetic rows let each
 * signal be isolated. Precision against real data is the labelled fixture
 * set's job, not this file's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreTitle, scoreYear, scoreRuntime, scoreCorroboration, scoreTypeMatch,
  resolveOne, resolveAll, settleDuplicates, THRESHOLDS,
} from '../src/resolve/index.js';

// #region ---------------------------------------------------------- runtime
test('runtime: direct-match band, inclusive at both ends', () => {
  assert.equal(scoreRuntime(100, 100), 20);   // delta  0.00
  assert.equal(scoreRuntime(103, 100), 20);   // delta +0.03, upper edge
  assert.equal(scoreRuntime(98, 100), 20);    // delta -0.02, lower edge
});

test('runtime: PAL speedup scores well, not suspiciously', () => {
  // 24fps film run at 25fps finishes ~4% short. This is a normal European TV
  // master, so it must land in the 17 band and not be read as a cut print.
  assert.equal(scoreRuntime(96, 100), 17);    // delta -0.04
  assert.equal(scoreRuntime(97, 100), 17);    // delta -0.03, just past 20 band
  assert.equal(scoreRuntime(94, 100), 17);    // delta -0.06, lower edge
});

test('runtime: restored / director cut band', () => {
  assert.equal(scoreRuntime(104, 100), 12);   // delta +0.04
  assert.equal(scoreRuntime(112, 100), 12);   // delta +0.12, upper edge
});

test('runtime: TV edit band', () => {
  assert.equal(scoreRuntime(93, 100), 6);     // delta -0.07
  assert.equal(scoreRuntime(80, 100), 6);     // delta -0.20, lower edge
});

test('runtime: unscored gaps score zero without rejecting', () => {
  assert.equal(scoreRuntime(79, 100), 0);     // -0.21, past the TV-edit band
  assert.equal(scoreRuntime(113, 100), 0);    // +0.13, past the cut band
  assert.equal(scoreRuntime(55, 100), 0);     // -0.45 exactly: not yet a reject
  assert.equal(scoreRuntime(160, 100), 0);    // +0.60 exactly: not yet a reject
});

test('runtime: the two reject bands return null, not a low score', () => {
  // null means "this candidate is not this film" — a split upload or a double
  // feature — and must drop the candidate rather than merely cost it points.
  assert.equal(scoreRuntime(54, 100), null);  // delta -0.46, part 1 of 2
  assert.equal(scoreRuntime(161, 100), null); // delta +0.61, double feature
});

test('runtime: a missing runtime on either side scores zero', () => {
  assert.equal(scoreRuntime(0, 100), 0);
  assert.equal(scoreRuntime(100, 0), 0);
  assert.equal(scoreRuntime(undefined, 100), 0);
});
// #endregion

// #region ---------------------------------------------------------- others
test('title: exact primary beats exact aka beats fuzzy', () => {
  assert.equal(scoreTitle('primary'), 50);
  assert.equal(scoreTitle('original'), 50);
  assert.equal(scoreTitle('aka'), 44);
  assert.equal(scoreTitle('fuzzy', 0.9), 45);
  assert.ok(scoreTitle('aka') < scoreTitle('primary'));
});

test('year: exact, near, and neutral-on-absent', () => {
  assert.equal(scoreYear(1941, 1941), 20);
  assert.equal(scoreYear(1941, 1942), 14);
  assert.equal(scoreYear(1941, 1943), 6);
  assert.equal(scoreYear(1941, 1950), 0);
  // Absent scores neutral rather than zero, so a legitimate upload that simply
  // omits the year is not pushed under the floor for it.
  assert.equal(scoreYear(null, 1941), 8);
  assert.ok(scoreYear(null, 1941) > scoreYear(1941, 1950));
});

test('corroboration: director outranks cast, and short tokens are not evidence', () => {
  const director = [{ category: 'director', name: 'fritz lang', tokens: 'fritz lang' }];
  const cast = [{ category: 'cast', name: 'peter lorre', tokens: 'peter lorre' }];

  assert.equal(scoreCorroboration('Directed by Fritz Lang, 1931', director), 10);
  assert.equal(scoreCorroboration('Starring Peter Lorre', cast), 6);
  assert.equal(scoreCorroboration('A restored print', director), 0);
  assert.equal(scoreCorroboration('', director), 0);

  // build-index drops sub-4-char tokens; a credit left with none cannot match.
  assert.equal(scoreCorroboration('van de kim', [{ category: 'cast', name: 'kim', tokens: '' }]), 0);
  // Substrings must not count: "lang" inside "language" is not Fritz Lang.
  assert.equal(scoreCorroboration('English language version', director), 0);
});
// #endregion

// #region ---------------------------------------------------------- decision
/** Minimal stand-in for the SQLite-backed index (spec §8 shape). */
function stubIndex(rows, credits = {}) {
  const norm = new Map();
  for (const r of rows) {
    for (const key of r.norms) {
      if (!norm.has(key)) norm.set(key, []);
      norm.get(key).push({ ...r, source: r.source || 'primary' });
    }
  }
  return {
    db: { prepare: () => ({ get: id => rows.find(r => r.tconst === id) }) },
    exact: k => norm.get(k) || [],
    // Every indexed norm inside the year and length bounds, which is what the
    // real one streams out of title_norm.
    yearWindow: (lo, hi, minLen, maxLen) => rows.flatMap(r =>
      (r.startYear >= lo && r.startYear <= hi)
        ? r.norms.filter(n => n.length >= minLen && n.length <= maxLen).map(n => ({ ...r, norm: n }))
        : []),
    credits: t => credits[t] || [],
    close() {},
  };
}

const title = (tconst, primaryTitle, startYear, runtimeMinutes, extra = {}) => ({
  tconst, titleType: 'movie', primaryTitle, originalTitle: primaryTitle,
  isAdult: 0, startYear, runtimeMinutes, genres: 'Drama',
  norms: [primaryTitle.toLowerCase()], ...extra,
});

const upload = (over = {}) => ({
  ytId: 'vid1', name: 'nosferatu', rawTitle: 'Nosferatu FULL MOVIE',
  year: null, runtimeMin: 94, description: '', channel: 'PizzaFlix',
  group: 'PublicDomain', ...over,
});

test('golden: three real collisions, separated on runtime alone', () => {
  // Same normalized title, same era, no year in the upload and no cast in the
  // description — runtime is the only signal left that can tell them apart.
  const index = stubIndex([
    title('tt0013442', 'nosferatu', 1922, 94),
    title('tt0080750', 'nosferatu', 1979, 107),
    title('tt0116625', 'nosferatu', 1995, 63),
  ]);

  const r = resolveOne(upload({ runtimeMin: 94 }), index);
  assert.equal(r.imdbId, 'tt0013442');       // discrimination is the point
  assert.equal(r.signals.runtime, 20);
  // Absent, so neutral -- 12 rather than 8 because the runtime is top-band.
  // The lift lands on the winner after the ranking and margin are settled, so
  // it cannot promote a rival past the pick. That is the property the whole
  // change rests on: it moves a match over the floor, never past another match.
  assert.equal(r.signals.year, 12);
  assert.ok(r.margin >= THRESHOLDS.margin);

  // Point the same title at the 1979 runtime and the pick must move with it.
  assert.equal(resolveOne(upload({ runtimeMin: 107 }), index).imdbId, 'tt0080750');
  assert.equal(resolveOne(upload({ runtimeMin: 63 }), index).imdbId, 'tt0116625');
});

test('a yearless upload still needs corroboration, but no longer needs luck', () => {
  // Was KNOWN ISSUE: exact primary title (50) + absent year (8) + a *perfect*
  // runtime (20) + no corroboration = 78, so a flawless match on a title like
  // "Nosferatu FULL MOVIE" could never be published, only reviewed.
  //
  // The neutral is now 12 when the runtime corroborates, which is 82 — still
  // under the floor, and deliberately so. A title and a runtime are two
  // signals; the floor asks for a third. What changed is that the third can
  // now be a *weak* one: a cast mention (6) reaches 88 where it used to reach
  // 84 and fail. On the warehouse that is the difference between 1,194
  // reviewed uploads and none, because 84 was where the commonest shape of a
  // correct match landed.
  const index = stubIndex([title('tt0013442', 'nosferatu', 1922, 94)]);
  const r = resolveOne(upload({ runtimeMin: 94 }), index);

  assert.equal(r.confidence, 82);
  assert.equal(r.status, 'review');
  assert.equal(r.reason, 'low-score');

  // A director credit in the description carries it over: 82 + 10 = 92.
  const withCredit = stubIndex(
    [title('tt0013442', 'nosferatu', 1922, 94)],
    { tt0013442: [{ category: 'director', name: 'friedrich murnau', tokens: 'friedrich murnau' }] });
  const ok = resolveOne(
    upload({ runtimeMin: 94, description: 'Directed by F. W. Murnau' }), withCredit);
  assert.equal(ok.confidence, 92);
  assert.equal(ok.status, 'accept');
});

test('the relaxed neutral is earned by the runtime, not handed out', () => {
  // The year separates same-titled films of different eras. A top-band runtime
  // has already pinned the era, so absence stops being evidence against. A
  // loose runtime has not, and a fuzzy title has not matched in the first
  // place, so both keep the strict neutral.
  assert.equal(scoreYear(null, 1922), 8);
  assert.equal(scoreYear(null, 1922, true), 12);
  assert.equal(scoreYear(null, null, true), 12);

  // Present years are untouched in every band.
  assert.equal(scoreYear(1922, 1922, true), 20);
  assert.equal(scoreYear(1923, 1922, true), 14);
  assert.equal(scoreYear(1930, 1922, true), 0);

  const idx = r => stubIndex([title('tt0013442', 'nosferatu', 1922, 94, { runtimeMinutes: r })]);
  // 94 vs 94 is the top band; 84 vs 94 is -10.6%, the "TV edit" band at 6.
  assert.equal(resolveOne(upload({ runtimeMin: 94 }), idx(94)).signals.year, 12);
  assert.equal(resolveOne(upload({ runtimeMin: 84 }), idx(94)).signals.year, 8);
});

test('two close candidates go to review, not to a coin flip', () => {
  const index = stubIndex([
    title('tt0000001', 'django', 1966, 91),
    title('tt0000002', 'django', 1966, 92),
  ]);
  const r = resolveOne(upload({ name: 'django', year: 1966, runtimeMin: 91 }), index);
  assert.equal(r.status, 'review');
  assert.equal(r.reason, 'narrow-margin');
  assert.ok(r.margin < THRESHOLDS.margin);
  assert.ok(r.candidates.length >= 2);
});

test('a split upload is rejected rather than mis-scored', () => {
  const index = stubIndex([title('tt0013442', 'nosferatu', 1922, 94)]);
  // Part 1 of 2 at 45 minutes: delta -0.52, past the reject band.
  const r = resolveOne(upload({ runtimeMin: 45 }), index);
  assert.equal(r.status, 'reject');
  assert.equal(r.reason, 'runtime-rejected');
});

test('hard flags override a high score', () => {
  const now = new Date('2026-09-05T00:00:00Z');
  const recent = stubIndex([title('tt9999999', 'nosferatu', 2024, 94)]);
  const r = resolveOne(upload({ year: 2024 }), recent, { now });
  assert.equal(r.status, 'review');
  assert.equal(r.reason, 'recent-year');

  const adult = stubIndex([title('tt8888888', 'nosferatu', 1922, 94, { isAdult: 1 })]);
  assert.equal(resolveOne(upload(), adult, { now }).reason, 'adult');
});

test('overrides bypass scoring entirely', () => {
  const index = stubIndex([title('tt0013442', 'nosferatu', 1922, 94)]);
  const r = resolveOne(upload({ runtimeMin: 5 }), index, {
    overrides: { vid1: 'tt0013442' },
  });
  assert.equal(r.status, 'accept');
  assert.equal(r.confidence, 100);
  assert.equal(r.override, true);
});

test('duplicates keep the stronger match and send the loser to review', () => {
  const index = stubIndex([title('tt0013442', 'nosferatu', 1922, 94)]);
  // Both carry a year so both clear the accept floor; the runtimes separate
  // them. Without a year neither could be accepted at all — see KNOWN ISSUE.
  const { resolved, review } = resolveAll({
    movies: [
      upload({ ytId: 'weak', year: 1922, runtimeMin: 92 }),    // PAL band, 87
      upload({ ytId: 'strong', year: 1922, runtimeMin: 94 }),  // direct, 90
    ],
  }, index);

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].ytId, 'strong');
  const dup = review.find(r => r.reason === 'duplicate');
  assert.equal(dup.ytId, 'weak');
  assert.equal(dup.duplicateOf, 'strong');
});
// #endregion

test('duplicate ties are settled deterministically, not by arrival order', () => {
  // Two uploads of one film scoring identically must always yield the same
  // winner regardless of the order they are seen in, or the published ytId
  // churns between runs and report.js reports phantom re-uploads.
  const index = stubIndex([title('tt0013442', 'nosferatu', 1922, 94)]);
  const a = upload({ ytId: 'aaa', year: 1922, runtimeMin: 94 });
  const z = upload({ ytId: 'zzz', year: 1922, runtimeMin: 94 });

  const forward = resolveAll({ movies: [a, z] }, index).resolved[0].ytId;
  const reverse = resolveAll({ movies: [z, a] }, index).resolved[0].ytId;
  assert.equal(forward, reverse);
  assert.equal(forward, 'aaa');
});

// #region ---------------------------------------------------------- series
test('type agreement replaces runtime for episodes, and rejects on mismatch', () => {
  // An episode matched against its series scores the full 20.
  assert.equal(scoreTypeMatch(true, 'tvSeries'), 20);
  assert.equal(scoreTypeMatch(true, 'tvMiniSeries'), 20);
  // "The Beverly Hillbillies" matches ten films in the index. Returning null
  // makes publishing a 1962 sitcom episode against the 1993 feature
  // structurally impossible rather than merely improbable.
  assert.equal(scoreTypeMatch(true, 'movie'), null);
  assert.equal(scoreTypeMatch(true, 'tvMovie'), null);
  // And the reverse: a feature upload must not resolve to a series.
  assert.equal(scoreTypeMatch(false, 'tvSeries'), null);
  assert.equal(scoreTypeMatch(false, 'movie'), 0);
});

test('an episode reaches the accept floor where runtime alone could not', () => {
  // Without type agreement the best a series can score is
  // title 50 + year 20 + runtime 0 + corroboration 10 = 80, under the floor.
  const index = stubIndex([
    { tconst: 'tt0052514', titleType: 'tvSeries', primaryTitle: 'one step beyond',
      originalTitle: 'one step beyond', isAdult: 0, startYear: 1959,
      runtimeMinutes: null, genres: 'Mystery', norms: ['one step beyond'] },
  ]);
  const r = resolveOne(
    upload({ name: 'one step beyond', year: 1959, runtimeMin: 25 }),
    index, { episode: { season: 2, episode: 17 } });

  assert.equal(r.status, 'accept');
  assert.equal(r.imdbId, 'tt0052514');
  assert.equal(r.signals.typeMatch, 20);
  assert.equal(r.signals.runtime, 0);      // deliberately unused for episodes
  assert.equal(r.id, 'tt0052514:2:17');    // the id Stremio requests
  assert.equal(r.stremioType, 'series');
  assert.equal(r.season, 2);
});

test('an episode never resolves to a same-named film', () => {
  // The exact hazard: only the 1993 movie is in the index, so the episode must
  // fail rather than publish against it.
  const index = stubIndex([title('tt0106normal', 'the beverly hillbillies', 1993, 93)]);
  const r = resolveOne(
    upload({ name: 'the beverly hillbillies', year: 1962, runtimeMin: 25 }),
    index, { episode: { season: 1, episode: 23 } });
  assert.equal(r.status, 'reject');
  assert.equal(r.reason, 'no-series-match');
});

test('episodes of one show are distinct entries, not duplicates', () => {
  // Keyed on imdbId, ninety-one episodes would collapse to one and trip the
  // duplicate quality gate on the way.
  const index = stubIndex([
    { tconst: 'tt0052514', titleType: 'tvSeries', primaryTitle: 'one step beyond',
      originalTitle: 'one step beyond', isAdult: 0, startYear: 1959,
      runtimeMinutes: null, genres: null, norms: ['one step beyond'] },
  ]);
  const mk = (ytId, ep) => resolveOne(
    upload({ ytId, name: 'one step beyond', year: 1959, runtimeMin: 25 }),
    index, { episode: { season: 2, episode: ep } });

  const { resolved, review } = settleDuplicates([mk('a', 17), mk('b', 18), mk('c', 19)]);
  assert.equal(resolved.length, 3);
  assert.equal(review.filter(r => r.reason === 'duplicate').length, 0);
  assert.deepEqual(resolved.map(r => r.id).sort(),
                   ['tt0052514:2:17', 'tt0052514:2:18', 'tt0052514:2:19']);
});
// #endregion

test('the yearless lift moves a match over the floor, never past another match', () => {
  // Applying it inside scoreCandidate read each candidate's own runtime, so a
  // rival with a better runtime gained four points the winner did not. That is
  // runtime re-weighted from 20 to 24 by the back door, and it cost four
  // already-published films their acceptance: Expelled, The Clones, Scared to
  // Death and The Dynamite Trio each fell from accept to narrow-margin at 9.
  //
  // Reproduced here. The winner matches on the primary title and sits in the
  // PAL band; the rival matches on an aka and is top-band:
  //
  //   winner  50 + 8 + 17 + 10 = 85   accept, margin 13
  //   rival   44 + 8 + 20 +  0 = 72
  //
  // Let the rival collect the lift on its own runtime and it reaches 76, the
  // margin closes to 9, and a correct match that has not changed in any way
  // drops out of the catalogue.
  const index = stubIndex([
    title('tt0000001', 'scared to death', 1980, 96),
    { ...title('tt0000002', 'scared to death', 1947, 91), source: 'aka' },
  ], {
    tt0000001: [{ category: 'director', name: 'william malone', tokens: 'william malone' }],
  });

  const r = resolveOne(upload({ name: 'scared to death', runtimeMin: 91,
                                description: 'directed by William Malone' }), index);
  assert.equal(r.imdbId, 'tt0000001');
  assert.equal(r.signals.year, 8);        // the winner is not top-band, so no lift
  assert.equal(r.margin, 13);             // 85 - 72, untouched by the rival's runtime
  assert.equal(r.status, 'accept');
});

test('the fuzzy tier is reachable, and catches a channel that drops apostrophes', () => {
  // These channels type titles by hand: "Cathys Curse", "Bulldog Drummonds
  // Peril", "Fathers Little Dividend". normalize() turns an apostrophe into a
  // space, so "Cathy's Curse" indexes as "cathy s curse" and the upload's
  // "cathys curse" is not an exact hit — the fuzzy tier is the only thing that
  // ever matched them, and fourteen published films depended on it.
  //
  // It broke in exactly the way a silent tier does: generateCandidates started
  // wrapping its lookup keys in {v, derived} objects, and the line reading
  // `v.length` off each key kept running, now on an object, producing an empty
  // length band and an early return for every upload in the catalogue.
  const index = stubIndex([title('tt0075820', "cathy s curse", 1977, 82)]);
  const r = resolveOne(upload({ name: 'cathys curse', year: 1977, runtimeMin: 82 }), index);
  assert.equal(r.imdbId, 'tt0075820');
  assert.equal(r.tier, 'fuzzy');
});

test('a derived key is only reached for when the title as written finds nothing', () => {
  // "Ever After (Reloaded)" is its own real title. Offering "Reloaded" beside
  // it pulled in a rival that closed the margin to 10 and dropped a published
  // film, so a rebuilt key must never dilute a direct hit.
  const index = stubIndex([
    title('tt1971393', 'ever after reloaded', 2011, 92),
    title('tt9999999', 'reloaded', 2011, 92),
  ]);
  const r = resolveOne(upload({ name: 'ever after reloaded', year: 2011, runtimeMin: 92 }), index);
  assert.equal(r.imdbId, 'tt1971393');
  assert.equal(r.margin, 100);            // the rival was never generated
  assert.equal(r.tier, 'exact-primary');
});

test('a dash segment and a shouted cast credit are keys of last resort', () => {
  // Public Domain Movies files uploads as "<year> - <title> - <tagline>"; the
  // martial-arts channels put two languages either side of a dash. Neither
  // title matches as written, so every segment becomes a key and the scorer
  // decides which one is the film.
  const idx1 = stubIndex([title('tt0050723', 'monster from green hell', 1957, 71)]);
  const r1 = resolveOne(upload({
    name: '1957 - Monster from Green Hell - Atomic mutations with an appetite for flesh!',
    year: 1957, runtimeMin: 71 }), idx1);
  assert.equal(r1.imdbId, 'tt0050723');
  assert.equal(r1.tier, 'exact-derived');

  // Shouting is what makes the cast rule safe. Lower-cased, "in" is an ordinary
  // preposition and this sent "Shaolin Roar In The Woods" to The Woods.
  const idx2 = stubIndex([title('tt0290103', 'wanted man', 2005, 95)]);
  assert.equal(resolveOne(upload({ name: 'Dolph Lundgren in WANTED MAN', year: 2005, runtimeMin: 95 }), idx2).imdbId,
               'tt0290103');
  const idx3 = stubIndex([title('tt0380066', 'the woods', 2006, 91)]);
  assert.equal(resolveOne(upload({ name: 'Shaolin Roar In The Woods', year: 2006, runtimeMin: 91 }), idx3).imdbId,
               undefined);
});

test('an episode earns the yearless lift from its type, not a runtime it never has', () => {
  // scoreCandidate zeroes runtime for episodes on purpose — IMDb's series
  // runtime is a nominal slot length — so a rule that read only the runtime
  // shut episodes out of the lift entirely and let the same cliff form again:
  // 107 episodes at exactly 84, one point under the floor.
  const index = stubIndex(
    [{ ...title('tt0062573', 'joe 90', 1968, 25), titleType: 'tvSeries' }],
    { tt0062573: [{ category: 'cast', name: 'rupert davies', tokens: 'rupert davies' }] });

  const ep = resolveOne(
    upload({ name: 'joe 90', year: null, runtimeMin: 25, description: 'starring Rupert Davies' }),
    index, { episode: { season: 1, episode: 1 } });

  assert.equal(ep.signals.runtime, 0);       // never scored for an episode
  assert.equal(ep.signals.typeMatch, 20);    // this is what pins it instead
  assert.equal(ep.signals.year, 12);
  assert.equal(ep.status, 'accept');
  assert.equal(ep.id, 'tt0062573:1:1');
});

test('two signals still do not carry an episode', () => {
  // An exact show title and type agreement reach 82, and stay in review. The
  // floor asks for a third signal from a series exactly as it does from a film.
  const index = stubIndex([{ ...title('tt0052442', 'one step beyond', 1959, 30), titleType: 'tvSeries' }]);
  const ep = resolveOne(upload({ name: 'one step beyond', year: null, runtimeMin: 26 }),
                        index, { episode: { season: 2, episode: 17 } });
  assert.equal(ep.confidence, 82);
  assert.equal(ep.status, 'review');
});
