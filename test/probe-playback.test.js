import test from 'node:test';
import assert from 'node:assert/strict';

import { seededPick, summarise, verdict, watchUrl, verdictFromError } from '../src/dwh/probe-playback.js';

test('a ytId is passed as a URL, because ids start with a dash', () => {
  // yt-dlp read "-rg5GhmZ5zo" as the -r rate-limit flag and died with a usage
  // error, which the script recorded as "unreachable". 79 of 4,868 published
  // ids begin with a dash, so a bare id silently mis-measures 1.6% of the
  // catalogue as broken.
  assert.equal(watchUrl('-rg5GhmZ5zo'), 'https://www.youtube.com/watch?v=-rg5GhmZ5zo');
  assert.equal(watchUrl('b12gZKrL-k4'), 'https://www.youtube.com/watch?v=b12gZKrL-k4');
});

test('the sample is stable and spread across channels', () => {
  // Math.random would make each run a fresh sample of a different population,
  // which is not a measurement. And taking the n best hashes overall would hand
  // PizzaFlix 40% of the sample, telling you least about the channels most
  // likely to be broken.
  const rows = [
    ...Array.from({ length: 50 }, (_, i) => ({ ytId: `big${i}`, grp: 'PublicDomain' })),
    ...Array.from({ length: 3 }, (_, i) => ({ ytId: `small${i}`, grp: 'Filipino' })),
    ...Array.from({ length: 4 }, (_, i) => ({ ytId: `mid${i}`, grp: 'Western' })),
  ];
  const a = seededPick(rows, 9, 7);
  const b = seededPick(rows, 9, 7);
  assert.deepEqual(a.map(r => r.ytId), b.map(r => r.ytId));      // stable for a seed
  assert.equal(a.length, 9);

  const groups = new Set(a.map(r => r.grp));
  assert.equal(groups.size, 3);                                   // all three represented
  assert.ok(a.filter(r => r.grp === 'PublicDomain').length <= 4,
            'the largest group must not dominate a spread sample');
});

test('a different seed probes different videos', () => {
  // A fixed sample checks the same forty videos forever and the quarantine
  // never learns anything new. The seed defaults to the ISO week, so weekly
  // runs turn a sample into coverage.
  const rows = Array.from({ length: 60 }, (_, i) => ({ ytId: `v${i}`, grp: 'G' }));
  const w1 = seededPick(rows, 10, 1).map(r => r.ytId);
  const w2 = seededPick(rows, 10, 2).map(r => r.ytId);
  assert.notDeepEqual(w1, w2);
  const overlap = w1.filter(id => w2.includes(id)).length;
  assert.ok(overlap < 6, `two seeds should not mostly agree, got ${overlap}/10`);
});

test('a sample larger than the population returns everything, once', () => {
  const rows = [{ ytId: 'a', grp: 'X' }, { ytId: 'b', grp: 'Y' }];
  const picked = seededPick(rows, 10);
  assert.equal(picked.length, 2);
  assert.equal(new Set(picked.map(r => r.ytId)).size, 2);
});

test('summarise takes the tallest format, not the first', () => {
  const s = summarise({
    id: 'x', duration: 5400,
    formats: [{ height: 360 }, { height: 1080 }, { height: null }, { height: 720 }],
    subtitles: { en: [{}] }, automatic_captions: { en: [{}], fr: [{}] },
  });
  assert.equal(s.maxHeight, 1080);
  assert.deepEqual(s.subtitles, ['en']);
  assert.equal(s.autoCaptions, 2);
});

test('age-gating is the verdict the Data API cannot reach', () => {
  // status.embeddable stays true on an age-gated video, so verify-streams
  // passes it and a viewer still gets nothing.
  const base = { maxHeight: 720, durationSec: 5400, ageLimit: 0, liveStatus: 'not_live' };
  assert.equal(verdict(base, 90), 'ok');
  assert.equal(verdict({ ...base, ageLimit: 18 }, 90), 'age-gated');
  assert.equal(verdict({ ...base, availability: 'needs_auth' }, 90), 'availability:needs_auth');
  assert.equal(verdict({ ...base, maxHeight: null }, 90), 'no-video-format');
});

test('a re-cut upload no longer matches the runtime it was matched on', () => {
  // Runtime carries 20 of the 100 points in §4. If the video is not the length
  // we scored, the evidence behind the match has gone with it.
  const base = { maxHeight: 720, ageLimit: 0, liveStatus: 'not_live' };
  assert.equal(verdict({ ...base, durationSec: 90 * 60 }, 90), 'ok');
  assert.equal(verdict({ ...base, durationSec: 91 * 60 }, 90), 'ok');       // within two minutes
  assert.equal(verdict({ ...base, durationSec: 120 * 60 }, 90), 'duration-drift');
  // No stored runtime to compare against is not a failure.
  assert.equal(verdict({ ...base, durationSec: 120 * 60 }, null), 'ok');
});

test('an age-gated video is told apart from a dead one', () => {
  // yt-dlp refuses to fetch metadata for a gated video and exits non-zero, so
  // the age_limit flag never arrives — the message is the only signal. It has
  // to be separated from "gone", because they are different problems: a gated
  // upload still exists and could be replaced by another copy of the film, and
  // it is the one case the Data API gets actively wrong, reporting it as public
  // and embeddable.
  assert.equal(verdictFromError('ERROR: [youtube] 6Lnb1bI0VIk: Sign in to confirm your age.'),
               'age-gated');
  assert.equal(verdictFromError('ERROR: [youtube] x: Private video. Sign in if you have been granted access'),
               'private');
  assert.equal(verdictFromError('ERROR: [youtube] x: Join this channel to get access to members-only content'),
               'members-only');
  assert.equal(verdictFromError('ERROR: [youtube] x: Video unavailable'), 'unreachable');
  assert.equal(verdictFromError(''), 'unreachable');
});

test('the batch is drawn from what has never been probed', () => {
  // Sampling the whole catalogue blind re-probes what is already known, and the
  // wasted share grows with coverage. seededPick over the unprobed remainder is
  // what makes coverage monotonic rather than asymptotic.
  const all = Array.from({ length: 30 }, (_, i) => ({ ytId: `v${i}`, grp: 'G' }));
  const seen = new Set(['v0', 'v1', 'v2', 'v3', 'v4']);
  const picked = seededPick(all.filter(r => !seen.has(r.ytId)), 10, 3).map(r => r.ytId);
  assert.equal(picked.length, 10);
  assert.equal(picked.filter(id => seen.has(id)).length, 0);
});
