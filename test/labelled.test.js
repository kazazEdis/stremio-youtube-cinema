/**
 * Spec §7 — precision on the accept tier, measured against hand-verified pairs.
 *
 * This is the only test that touches the real IMDb index, because it is the
 * only one whose question is "does this pick the right film out of 1.19M
 * titles". Everything in scoring.test.js uses a stub index on purpose: that
 * file tests the logic, this one tests the outcome.
 *
 * It SKIPS when .cache/imdb.sqlite is absent rather than failing. `npm test`
 * is documented as needing no network and no downloaded fixtures, and the
 * index is a ~1.3 GB build; making the suite depend on it would mean a fresh
 * clone could not run the tests at all. CI builds the index before it gets
 * here, so the assertion still runs on every catalogue build.
 *
 * §7 asks for precision >= 0.98 on accepts and says recall is secondary. Those
 * are asymmetric on purpose: a film left in review costs one film, a wrong
 * tconst costs a viewer's subtitle track and watch history. So a pair that
 * lands in review is NOT a failure here — only a wrong id is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildIndex, resolveOne } from '../src/resolve/index.js';
import { cleanTitle, extractYear } from '../src/transform/title.js';

const INDEX_PATH = '.cache/imdb.sqlite';
const haveIndex = fs.existsSync(INDEX_PATH);

const { pairs } = JSON.parse(fs.readFileSync('test/fixtures/labelled.json', 'utf8'));

test('labelled set: 40 pairs, weighted to the non-English channels', () => {
  assert.ok(pairs.length >= 40, `only ${pairs.length} pairs`);
  const nonEnglish = pairs.filter(p => /Mosfilm|Mei Ah|經典/.test(p.channel)).length;
  // §7: "The non-English ones are the whole point; don't stack the set with
  // easy English cases."
  assert.ok(nonEnglish >= 20, `only ${nonEnglish} non-English pairs`);
});

test('labelled set: accept-tier precision >= 0.98', { skip: haveIndex ? false : 'no .cache/imdb.sqlite' }, async () => {
  const index = await buildIndex({ cacheDir: '.cache' });
  try {
    const wrong = [], accepted = [], other = [];

    for (const p of pairs) {
      const name = cleanTitle(p.rawTitle);
      const r = resolveOne({
        ytId: 'fixture', name, rawTitle: p.rawTitle,
        year: extractYear(p.rawTitle), runtimeMin: p.runtimeMin,
        description: '', channel: p.channel, channelRef: p.channel, group: 'fixture',
      }, index);

      const row = { ...p, got: r.imdbId ?? null, status: r.status, conf: r.confidence };
      if (r.status === 'accept') {
        accepted.push(row);
        if (r.imdbId !== p.tconst) wrong.push(row);
      } else {
        other.push(row);
      }
    }

    // Printed, not just counted: the gained/lost list is the thing worth
    // reading when a weight changes, and a bare ratio hides which film moved.
    for (const w of wrong) {
      console.log(`  WRONG  ${w.tconst} -> ${w.got}  conf ${w.conf}  ${w.rawTitle.slice(0, 60)}`);
    }
    const precision = accepted.length ? (accepted.length - wrong.length) / accepted.length : 1;
    console.log(`  accepted ${accepted.length}/${pairs.length}  precision ${precision.toFixed(3)}  ` +
                `not-accepted ${other.length}`);

    assert.equal(wrong.length, 0, `${wrong.length} wrong id(s) on the accept tier`);
    assert.ok(precision >= 0.98, `precision ${precision}`);
  } finally {
    index.close();
  }
});
