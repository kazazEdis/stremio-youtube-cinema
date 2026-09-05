/**
 * core.js — the conformed layer: dimensions and facts.
 *
 * Rebuilt from staging by transform.js, with one deliberate exception noted
 * below. Business rules live here rather than in extract or stage, so changing
 * one costs a replay instead of quota.
 *
 * Supersedes the earlier src/catalog.js, which was never wired to anything;
 * its thumbnail-tier trick and pragma set are carried over unchanged.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Poster tiers, best first. Stored as an index because every observed poster
// URL is exactly i.ytimg.com/vi/<ytId>/<tier>.jpg -- measured true for
// 8,276 of 8,276 films, so one integer reconstructs a 55-character URL.
const TIERS = ['maxresdefault', 'sddefault', 'hqdefault'];
const THUMB_BASE = 'https://i.ytimg.com/vi';

export const STATUS = { accept: 0, review: 1, reject: 2 };
const STATUS_NAME = ['accept', 'review', 'reject'];
export const statusName = n => STATUS_NAME[n] ?? 'reject';

export const thumbUrl = (ytId, tier) =>
  tier >= 0 && tier < TIERS.length ? THUMB_BASE + '/' + ytId + '/' + TIERS[tier] + '.jpg' : null;

export function tierOf(posterUrl, ytId) {
  if (!posterUrl) return -1;
  const m = /^https:\/\/i\.ytimg\.com\/vi\/([\w-]{11})\/(\w+)\.jpg$/.exec(posterUrl);
  if (!m || m[1] !== ytId) return -1;
  const i = TIERS.indexOf(m[2]);
  return i >= 0 ? i : -1;
}

const PRAGMAS = [
  'PRAGMA page_size = 4096;',
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA cache_size = -8000;',
  'PRAGMA temp_store = MEMORY;',
  'PRAGMA foreign_keys = ON;',
].join('\n');

const SCHEMA = [
  // Natural key, not a surrogate. With 23 channels an integer key saves nothing
  // and would need a version to point at once the dimension is SCD2; the ref
  // from config/channels.json is stable across renames, which is the whole
  // case the history is here to record.
  `CREATE TABLE IF NOT EXISTS dim_channel (
     channel_ref      TEXT NOT NULL,
     valid_from       TEXT NOT NULL,
     valid_to         TEXT,                          -- NULL = current row
     yt_channel_id    TEXT,
     name             TEXT NOT NULL,                 -- YouTube title; what cleanTitle() is given
     grp              TEXT NOT NULL,
     eu               INTEGER NOT NULL DEFAULT 0,
     in_config        INTEGER NOT NULL DEFAULT 1,    -- 0 = dropped from config, uploads retained
     uploads_playlist TEXT,
     PRIMARY KEY (channel_ref, valid_from)
   ) WITHOUT ROWID;`,
  `CREATE INDEX IF NOT EXISTS idx_dim_chan_yt ON dim_channel(yt_channel_id);`,

  // Grain: one upload. Ineligible rows are KEPT with a drop_reason rather than
  // deleted -- being able to ask "what did we drop and why" is exactly how the
  // 8,139 no-candidates diagnosis was possible, and it makes report.js's
  // scanned/per-channel counts a query instead of a third input file.
  //
  // channel_name and grp are denormalised on purpose: channel_name is the exact
  // string cleanTitle() was given and the string published as `channel`, so
  // parity depends on storing it rather than re-deriving it from a dimension
  // row that may since have changed.
  `CREATE TABLE IF NOT EXISTS fct_upload (
     ytId            TEXT PRIMARY KEY,
     channel_ref     TEXT NOT NULL,
     channel_name    TEXT NOT NULL,
     grp             TEXT NOT NULL,
     raw_title       TEXT NOT NULL,
     clean_title     TEXT NOT NULL,
     extracted_year  INTEGER,
     duration_s      INTEGER NOT NULL,
     runtime_min     INTEGER NOT NULL,
     thumb_tier      INTEGER NOT NULL DEFAULT -1,
     published_at    TEXT,
     view_count      INTEGER,
     licensed        INTEGER,
     embeddable      INTEGER,
     blocked_regions TEXT,
     allowed_regions TEXT,
     drop_reason     TEXT,                           -- NULL = eligible. Region is NOT here.
     input_hash      TEXT NOT NULL,
     transformed_at  TEXT NOT NULL,
     run_id          INTEGER
   ) WITHOUT ROWID;`,
  `CREATE INDEX IF NOT EXISTS idx_upload_chan ON fct_upload(channel_ref);`,
  `CREATE INDEX IF NOT EXISTS idx_upload_live ON fct_upload(ytId) WHERE drop_reason IS NULL;`,

  // Grain: one upload, not one film. Duplicate settling has to happen after the
  // region filter, so it belongs at publish -- which means this table keeps the
  // demoted duplicates and the rejects for free.
  //
  // match_name is the IMDb primaryTitle and ONLY that. The resolver's output
  // reuses `name` for two different things (IMDb title when matched, cleaned
  // YouTube title when not); splitting them here kills the ambiguity at the
  // boundary, and publish reconstructs it as (match_name ?? clean_title).
  `CREATE TABLE IF NOT EXISTS fct_resolution (
     ytId             TEXT PRIMARY KEY REFERENCES fct_upload(ytId) ON DELETE CASCADE,
     status           INTEGER NOT NULL,
     reason           TEXT,
     imdb_id          TEXT,
     match_name       TEXT,
     imdb_year        INTEGER,
     imdb_runtime     INTEGER,
     genres           TEXT,
     confidence       REAL,
     margin           REAL,
     score            REAL,
     candidate_count  INTEGER,
     sig_title        REAL,
     sig_year         INTEGER,
     sig_runtime      INTEGER,
     sig_corrob       INTEGER,
     is_override      INTEGER NOT NULL DEFAULT 0,
     tier             TEXT,
     dataset          TEXT NOT NULL,
     input_hash       TEXT NOT NULL,
     overrides_hash   TEXT NOT NULL,
     resolver_version INTEGER NOT NULL,
     resolved_at      TEXT NOT NULL,
     run_id           INTEGER
   ) WITHOUT ROWID;`,
  `CREATE INDEX IF NOT EXISTS idx_res_status ON fct_resolution(status);`,
  `CREATE INDEX IF NOT EXISTS idx_res_imdb ON fct_resolution(imdb_id) WHERE imdb_id IS NOT NULL;`,

  `CREATE TABLE IF NOT EXISTS fct_candidate (
     ytId    TEXT NOT NULL REFERENCES fct_upload(ytId) ON DELETE CASCADE,
     rank    INTEGER NOT NULL,
     imdb_id TEXT NOT NULL,
     name    TEXT,
     year    INTEGER,
     runtime INTEGER,
     score   REAL,
     kind    TEXT,
     PRIMARY KEY (ytId, rank)
   ) WITHOUT ROWID;`,

  // The one non-regenerable fact in the pipeline: when a film entered the
  // PUBLISHED catalog. Written once, never updated, owned by publish rather
  // than transform -- a film that resolves but is geo-blocked has not entered
  // the catalog and must not accrue a date it never earned.
  //
  // Keyed on imdb_id, not ytId: report.js deliberately treats a changed ytId
  // for the same film as a re-upload rather than an add plus a remove, so
  // keying on ytId would reset the date every time a channel re-posts.
  `CREATE TABLE IF NOT EXISTS fct_first_seen (
     imdb_id      TEXT PRIMARY KEY,
     first_seen   TEXT NOT NULL,
     first_run_id INTEGER,
     source       TEXT NOT NULL                      -- 'seed' | 'publish'
   ) WITHOUT ROWID;`,

  `CREATE TABLE IF NOT EXISTS core_meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;`,
].join('\n');

export function openCore(file = 'data/warehouse.sqlite', { create = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(PRAGMAS);
  if (create) db.exec(SCHEMA);
  return db;
}

export const setCoreMeta = (db, k, v) =>
  db.prepare('INSERT OR REPLACE INTO core_meta (key,value) VALUES (?,?)').run(k, String(v));

export const getCoreMeta = (db, k) =>
  db.prepare('SELECT value FROM core_meta WHERE key = ?').get(k)?.value ?? null;

/**
 * Hash of exactly the fields resolveOne reads, in a fixed order.
 *
 * This is what makes the checkpoint precise: a stored resolution is reusable
 * only while the inputs that produced it are byte-identical. Widening the
 * resolver's input surface without bumping RESOLVER_VERSION would silently
 * keep stale resolutions, so the field list here is a contract, not a
 * convenience.
 */
export function inputHash(v) {
  return createHash('sha256').update(JSON.stringify([
    v.ytId, v.name, v.rawTitle, v.year, v.runtimeMin,
    v.description, v.channel, v.group, v.poster,
  ])).digest('hex').slice(0, 32);
}

export const hashObject = o =>
  createHash('sha256').update(JSON.stringify(o ?? null)).digest('hex').slice(0, 32);

/** Record a first sighting. Existing rows are never touched. */
export function noteFirstSeen(db, imdbId, day, runId, source = 'publish') {
  db.prepare(`INSERT INTO fct_first_seen (imdb_id,first_seen,first_run_id,source)
              VALUES (?,?,?,?) ON CONFLICT(imdb_id) DO NOTHING`)
    .run(imdbId, day, runId ?? null, source);
}

/**
 * Carry history forward from a previously published catalog.
 *
 * Without this the first warehouse publish stamps today on every film and
 * anything watching the feed sees the whole catalog as new. Safe to re-run:
 * DO NOTHING means the earliest recorded date always wins.
 */
export function seedFirstSeen(db, publishedCatalog, runId = null) {
  const movies = publishedCatalog?.movies || [];
  const before = db.prepare('SELECT COUNT(*) c FROM fct_first_seen').get().c;
  db.exec('BEGIN');
  for (const m of movies) {
    if (m.imdbId && m.firstSeen) noteFirstSeen(db, m.imdbId, m.firstSeen, runId, 'seed');
  }
  db.exec('COMMIT');
  return db.prepare('SELECT COUNT(*) c FROM fct_first_seen').get().c - before;
}

/**
 * Slowly-changing channel dimension.
 *
 * A new version is opened only when something meaningful changed, so the
 * history stays short and readable. Channels get renamed and terminated —
 * report.js already alarms on ones that produced last week and nothing now —
 * and that is the history worth keeping.
 */
export function upsertChannel(db, { ref, ytChannelId, name, grp, eu = 0, inConfig = 1, uploadsPlaylist, day }) {
  const cur = db.prepare(
    'SELECT * FROM dim_channel WHERE channel_ref=? AND valid_to IS NULL').get(ref);

  const same = cur && cur.name === name && cur.grp === grp && cur.in_config === inConfig
    && (cur.yt_channel_id ?? null) === (ytChannelId ?? null);
  if (same) return 'unchanged';

  if (cur) {
    db.prepare('UPDATE dim_channel SET valid_to=? WHERE channel_ref=? AND valid_from=?')
      .run(day, ref, cur.valid_from);
  }
  db.prepare(`INSERT INTO dim_channel
              (channel_ref,valid_from,valid_to,yt_channel_id,name,grp,eu,in_config,uploads_playlist)
              VALUES (?,?,NULL,?,?,?,?,?,?)`)
    .run(ref, day, ytChannelId ?? null, name, grp, eu ? 1 : 0, inConfig ? 1 : 0,
         uploadsPlaylist ?? null);
  return cur ? 'versioned' : 'new';
}

export const currentChannels = db =>
  db.prepare('SELECT * FROM dim_channel WHERE valid_to IS NULL').all();
