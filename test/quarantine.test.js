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
