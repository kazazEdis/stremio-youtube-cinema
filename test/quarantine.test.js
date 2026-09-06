import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openCore, recordPlayback, quarantinedYtIds, UNPLAYABLE } from '../src/dwh/core.js';

const core = () => openCore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'q-')), 'core.sqlite'));

test('only the verdicts a viewer can never get past are quarantined', () => {
  // region-blocked reflects wherever the probe ran — CI is in the US, the dev
  // box is not — and unreachable can be a dropped connection as easily as a
  // dead video. Neither is a stable property of the upload, so neither votes.
  assert.deepEqual([...UNPLAYABLE].sort(), ['age-gated', 'members-only', 'private']);

  const db = core();
  recordPlayback(db, [
    { ytId: 'gated',  verdict: 'age-gated', maxHeight: null, durationSec: null, subtitles: [] },
    { ytId: 'priv',   verdict: 'private' },
    { ytId: 'region', verdict: 'region-blocked' },
    { ytId: 'flaky',  verdict: 'unreachable' },
    { ytId: 'fine',   verdict: 'ok', maxHeight: 1080, durationSec: 5400, subtitles: ['en'] },
  ], 1);

  assert.deepEqual([...quarantinedYtIds(db)].sort(), ['gated', 'priv']);
  db.close();
});

test('a later probe overwrites an earlier verdict', () => {
  // A gated upload can be ungated, and a quarantine that never lifts would
  // strand the film on a worse copy for good.
  const db = core();
  recordPlayback(db, [{ ytId: 'x', verdict: 'age-gated' }], 1);
  assert.deepEqual([...quarantinedYtIds(db)], ['x']);

  recordPlayback(db, [{ ytId: 'x', verdict: 'ok', maxHeight: 720, durationSec: 60, subtitles: [] }], 2);
  assert.deepEqual([...quarantinedYtIds(db)], []);
  assert.equal(db.prepare('SELECT max_height FROM fct_playback WHERE ytId=?').get('x').max_height, 720);
  db.close();
});

test('an empty table quarantines nothing', () => {
  const db = core();
  assert.equal(quarantinedYtIds(db).size, 0);
  db.close();
});

test('consecutive failures are counted, and one success clears them', () => {
  // One probe is not evidence: yt-dlp reports a throttled request and a deleted
  // video in much the same breath. Any policy that removes a film should read
  // the count, never a single verdict.
  const db = core();
  const count = () => db.prepare('SELECT fail_count FROM fct_playback WHERE ytId=?').get('x').fail_count;

  recordPlayback(db, [{ ytId: 'x', verdict: 'unreachable' }], 1);
  assert.equal(count(), 1);
  recordPlayback(db, [{ ytId: 'x', verdict: 'unreachable' }], 2);
  assert.equal(count(), 2);
  recordPlayback(db, [{ ytId: 'x', verdict: 'age-gated' }], 3);
  assert.equal(count(), 3, 'a different failure still counts as a failure');

  recordPlayback(db, [{ ytId: 'x', verdict: 'ok', maxHeight: 720 }], 4);
  assert.equal(count(), 0);
  db.close();
});

test('the fail_count column reaches a warehouse that predates it', () => {
  // CREATE TABLE IF NOT EXISTS adds no columns, which is how "table fct_upload
  // has no column named season" happened once already.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'old-')), 'core.sqlite');
  const first = openCore(file);
  first.exec('ALTER TABLE fct_playback DROP COLUMN fail_count');
  first.close();

  const reopened = openCore(file);            // migrateColumns runs here
  recordPlayback(reopened, [{ ytId: 'y', verdict: 'unreachable' }], 1);
  assert.equal(reopened.prepare('SELECT fail_count FROM fct_playback WHERE ytId=?').get('y').fail_count, 1);
  reopened.close();
});
