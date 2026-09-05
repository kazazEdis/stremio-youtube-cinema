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
  scoreTitle, scoreYear, scoreRuntime, scoreCorroboration,
  resolveOne, resolveAll, THRESHOLDS,
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
    yearWindow: () => [],
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
  assert.equal(r.signals.year, 8);           // absent, so neutral
  assert.ok(r.margin >= THRESHOLDS.margin);

  // Point the same title at the 1979 runtime and the pick must move with it.
  assert.equal(resolveOne(upload({ runtimeMin: 107 }), index).imdbId, 'tt0080750');
  assert.equal(resolveOne(upload({ runtimeMin: 63 }), index).imdbId, 'tt0116625');
});

test('KNOWN ISSUE: the §4 weights cannot accept a yearless upload', () => {
  // Exact primary title (50) + absent year (8) + a *perfect* runtime (20) +
  // no corroboration = 78, which is under the 85 floor. So a flawless match on
  // a title like "Nosferatu FULL MOVIE" can never be published, only reviewed.
  //
  // §4 justifies the neutral 8 by saying that penalising an absent year "just
  // pushes good matches under the floor" — but at 8 points it does precisely
  // that. The weights need tuning against the §7 labelled set before this
  // resolver will publish anything from a channel that omits years, which is
  // most of the public-domain ones. Pinned so the tuning is a deliberate act.
  const index = stubIndex([title('tt0013442', 'nosferatu', 1922, 94)]);
  const r = resolveOne(upload({ runtimeMin: 94 }), index);

  assert.equal(r.confidence, 78);
  assert.equal(r.status, 'review');
  assert.equal(r.reason, 'low-score');

  // A single director credit in the description is currently the only thing
  // that lifts the same match over the line: 78 + 10 = 88.
  const withCredit = stubIndex(
    [title('tt0013442', 'nosferatu', 1922, 94)],
    { tt0013442: [{ category: 'director', name: 'friedrich murnau', tokens: 'friedrich murnau' }] });
  const ok = resolveOne(
    upload({ runtimeMin: 94, description: 'Directed by F. W. Murnau' }), withCredit);
  assert.equal(ok.confidence, 88);
  assert.equal(ok.status, 'accept');
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
