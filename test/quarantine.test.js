import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openCore, recordPlayback, quarantinedYtIds, deadYtIds, UNPLAYABLE } from '../src/dwh/core.js';

const core = () => openCore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'q-')), 'core.sqlite'));

test('a region verdict never votes, because it is about the prober', () => {
  // region-blocked reflects wherever the probe ran — CI is in the US, the dev
  // box is not — so it says nothing about the region we publish for and must
  // not reach either set.
  const db = core();
  recordPlayback(db, [
    { ytId: 'gated',  verdict: 'age-gated', maxHeight: null, durationSec: null, subtitles: [] },
    { ytId: 'region', verdict: 'region-blocked' },
    { ytId: 'fine',   verdict: 'ok', maxHeight: 1080, durationSec: 5400, subtitles: ['en'] },
  ], 1);
  recordPlayback(db, [{ ytId: 'region', verdict: 'region-blocked' }], 2);

  assert.deepEqual([...quarantinedYtIds(db)], ['gated']);
  assert.deepEqual([...deadYtIds(db)], [], 'twice region-blocked is still not dead');
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

test('the resolution diagnostics reach a warehouse that predates them', () => {
  // Third time. `season` on fct_upload, then `fail_count` on fct_playback, and
  // now rival_count/sig_type_match on fct_resolution: declaring a column in the
  // DDL is not enough, because CREATE TABLE IF NOT EXISTS does nothing to a
  // table that already exists and migrateColumns' map is hand-maintained rather
  // than read from the DDL. Miss the map and every existing warehouse dies at
  // the INSERT with "table fct_resolution has no column named rival_count"
  // while a fresh one passes every test.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'old-res-')), 'core.sqlite');
  const first = openCore(file);
  first.exec('ALTER TABLE fct_resolution DROP COLUMN rival_count');
  first.exec('ALTER TABLE fct_resolution DROP COLUMN sig_type_match');
  first.close();

  const reopened = openCore(file);            // migrateColumns runs here
  const cols = new Set(reopened.prepare("SELECT name FROM pragma_table_info('fct_resolution')")
    .all().map(c => c.name));
  assert.ok(cols.has('rival_count'), 'rival_count was not migrated back');
  assert.ok(cols.has('sig_type_match'), 'sig_type_match was not migrated back');
  reopened.close();
});

test('gated and dead are different problems and get different treatment', () => {
  // A gated upload still works for a viewer signed in on YouTube, which is why
  // it is kept and labelled when it is the only copy. Nothing else that fails
  // to play has that property, so nothing else belongs in UNPLAYABLE.
  assert.deepEqual([...UNPLAYABLE], ['age-gated']);

  const db = core();
  recordPlayback(db, [
    { ytId: 'gated',  verdict: 'age-gated' },
    { ytId: 'priv',   verdict: 'private' },
    { ytId: 'once',   verdict: 'unreachable' },
    { ytId: 'region', verdict: 'region-blocked' },
    { ytId: 'fine',   verdict: 'ok', maxHeight: 720 },
  ], 1);

  assert.deepEqual([...quarantinedYtIds(db)], ['gated']);
  // One unreachable probe is not enough to delete a film; private is.
  assert.deepEqual([...deadYtIds(db)].sort(), ['priv']);

  recordPlayback(db, [{ ytId: 'once', verdict: 'unreachable' }], 2);
  assert.deepEqual([...deadYtIds(db)].sort(), ['once', 'priv']);

  // And it lets go: one success clears the count and the film comes back.
  recordPlayback(db, [{ ytId: 'once', verdict: 'ok', maxHeight: 480 }], 3);
  assert.deepEqual([...deadYtIds(db)].sort(), ['priv']);
  db.close();
});
