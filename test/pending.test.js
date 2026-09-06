import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { pendingSql } from '../src/dwh/transform.js';
import { openCore } from '../src/dwh/core.js';

const DATASET = '2026-09-01';
const VERSION = 3;

function warehouse(rows) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wh-')), 'core.sqlite');
  const db = openCore(file);
  // stg_blurb lives in the staging layer, which openCore does not create; the
  // work list left-joins it for the description.
  db.exec('CREATE TABLE IF NOT EXISTS stg_blurb (ytId TEXT PRIMARY KEY, text TEXT)');
  for (const r of rows) {
    db.prepare(`INSERT INTO fct_upload
        (ytId, channel_ref, channel_name, grp, raw_title, clean_title,
         duration_s, runtime_min, input_hash, transformed_at, drop_reason)
      VALUES (?,'ch','Channel','G','t','t',5400,90,?,'2026-09-06',NULL)`)
      .run(r.ytId, r.hash);
    if (r.resolution) {
      db.prepare(`INSERT INTO fct_resolution
        (ytId, status, input_hash, dataset, overrides_hash, resolver_version,
         is_override, resolved_at)
        VALUES (?,0,?,?,?,?,?,'2026-09-06')`)
        .run(r.ytId, r.resolution.hash, DATASET,
             r.resolution.overridesHash, VERSION, r.resolution.isOverride ? 1 : 0);
    }
  }
  return { db, file };
}

function pending(db, overridesHash, overrideIds) {
  return db.prepare(pendingSql(overrideIds.length))
    .all(DATASET, VERSION, overridesHash, ...overrideIds, 100)
    .map(r => r.ytId);
}

test('pinning one ytId does not put the whole warehouse back through the scorer', () => {
  // The regression this exists for: `overrides_hash` is a hash of the entire
  // file, so comparing it alone re-resolved all 11,979 eligible uploads to
  // correct a single film -- over two hours on the dev host.
  const { db } = warehouse([
    { ytId: 'aaa', hash: 'h1', resolution: { hash: 'h1', overridesHash: 'OLD' } },
    { ytId: 'bbb', hash: 'h2', resolution: { hash: 'h2', overridesHash: 'OLD' } },
    { ytId: 'ccc', hash: 'h3', resolution: { hash: 'h3', overridesHash: 'OLD' } },
  ]);
  assert.deepEqual(pending(db, 'NEW', ['bbb']), ['bbb']);
  db.close();
});

test('deleting an override re-resolves the row it used to pin', () => {
  // Without this the pinned match would survive its own removal, which is the
  // one way a wrong entry could become permanent and invisible.
  const { db } = warehouse([
    { ytId: 'aaa', hash: 'h1', resolution: { hash: 'h1', overridesHash: 'OLD' } },
    { ytId: 'bbb', hash: 'h2', resolution: { hash: 'h2', overridesHash: 'OLD', isOverride: true } },
  ]);
  assert.deepEqual(pending(db, 'NEW', []), ['bbb']);
  db.close();
});

test('the other three invalidation reasons are untouched', () => {
  const { db } = warehouse([
    { ytId: 'unresolved', hash: 'h1' },
    { ytId: 'retitled',   hash: 'h2', resolution: { hash: 'stale', overridesHash: 'NEW' } },
    { ytId: 'current',    hash: 'h3', resolution: { hash: 'h3', overridesHash: 'NEW' } },
  ]);
  assert.deepEqual(pending(db, 'NEW', []).sort(), ['retitled', 'unresolved']);

  // A new IMDb dataset, and a resolver version bump, each invalidate everything.
  const all = db.prepare(pendingSql(0)).all('OTHER-DATASET', VERSION, 'NEW', 100).map(r => r.ytId);
  assert.equal(all.length, 3);
  db.close();
});
