/**
 * landing.js — the immutable landing layer.
 *
 * Every API response is stored exactly as received, before anything is parsed,
 * filtered or interpreted. This is the only layer whose loss costs quota and
 * wall-clock; everything downstream is rebuildable from it offline.
 *
 * The rule this enforces: extraction records, it does not decide. The previous
 * design applied a region filter while fetching, which discarded 2,779 films
 * at the moment of collection and made them recoverable only by re-fetching.
 */

import { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PRAGMAS = `
PRAGMA page_size = 4096;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -8000;
PRAGMA foreign_keys = ON;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run (
  run_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  stage       TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',
  rows_in     INTEGER,
  rows_out    INTEGER,
  notes       TEXT
);

-- Bodies are gzipped BLOBs. Landing is written once and read rarely, so the
-- CPU is free and JSON compresses roughly 85%.
CREATE TABLE IF NOT EXISTS api_response (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES run(run_id),
  fetched_at  TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  params      TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  body        BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_lookup ON api_response(endpoint, params_hash);
CREATE INDEX IF NOT EXISTS idx_api_run    ON api_response(run_id);

-- Per-channel high-water mark. playlistItems returns newest first, so paging
-- can stop as soon as it reaches something already landed.
CREATE TABLE IF NOT EXISTS extract_watermark (
  channel_ref    TEXT PRIMARY KEY,
  uploads_playlist TEXT,
  last_ytid      TEXT,
  last_published TEXT,
  last_run_id    INTEGER,
  updated_at     TEXT
) WITHOUT ROWID;

-- Which video ids have ever been landed, so staging and the incremental
-- extract can both answer "have we seen this?" without decompressing bodies.
CREATE TABLE IF NOT EXISTS landed_video (
  ytId        TEXT PRIMARY KEY,
  channel_ref TEXT NOT NULL,
  first_run_id INTEGER NOT NULL,
  last_run_id  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_landed_chan ON landed_video(channel_ref);
`;

export function openLanding(file = 'data/landing.sqlite') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(PRAGMAS);
  db.exec(SCHEMA);
  return db;
}

export const hashParams = params =>
  createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16);

export function startRun(db, stage, notes = null) {
  db.prepare('INSERT INTO run (stage,started_at,status,notes) VALUES (?,?,?,?)')
    .run(stage, new Date().toISOString(), 'running', notes);
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

export function finishRun(db, runId, { status = 'ok', rowsIn = null, rowsOut = null, notes = null } = {}) {
  db.prepare(`UPDATE run SET finished_at=?, status=?, rows_in=?, rows_out=?,
              notes=COALESCE(?,notes) WHERE run_id=?`)
    .run(new Date().toISOString(), status, rowsIn, rowsOut, notes, runId);
}

/** Store one response verbatim. Returns its landing id. */
export function land(db, runId, endpoint, params, httpStatus, bodyText) {
  db.prepare(`INSERT INTO api_response
              (run_id,fetched_at,endpoint,params_hash,params,http_status,body)
              VALUES (?,?,?,?,?,?,?)`)
    .run(runId, new Date().toISOString(), endpoint, hashParams(params),
         JSON.stringify(params), httpStatus, gzipSync(Buffer.from(bodyText, 'utf8')));
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

/** Iterate landed bodies for an endpoint, newest run first. */
export function* readLanded(db, endpoint, { runId = null } = {}) {
  const sql = runId
    ? 'SELECT id,run_id,params,body FROM api_response WHERE endpoint=? AND run_id=? ORDER BY id'
    : 'SELECT id,run_id,params,body FROM api_response WHERE endpoint=? ORDER BY id';
  const stmt = db.prepare(sql);
  for (const row of (runId ? stmt.iterate(endpoint, runId) : stmt.iterate(endpoint))) {
    yield { id: row.id, runId: row.run_id, params: JSON.parse(row.params),
            body: JSON.parse(gunzipSync(row.body).toString('utf8')) };
  }
}

export const getWatermark = (db, ref) =>
  db.prepare('SELECT * FROM extract_watermark WHERE channel_ref=?').get(ref) ?? null;

export function setWatermark(db, ref, { uploadsPlaylist, lastYtId, lastPublished, runId }) {
  db.prepare(`INSERT INTO extract_watermark
              (channel_ref,uploads_playlist,last_ytid,last_published,last_run_id,updated_at)
              VALUES (?,?,?,?,?,?)
              ON CONFLICT(channel_ref) DO UPDATE SET
                uploads_playlist=excluded.uploads_playlist,
                last_ytid=excluded.last_ytid,
                last_published=excluded.last_published,
                last_run_id=excluded.last_run_id,
                updated_at=excluded.updated_at`)
    .run(ref, uploadsPlaylist ?? null, lastYtId ?? null, lastPublished ?? null,
         runId, new Date().toISOString());
}

export function markLanded(db, ytIds, channelRef, runId) {
  const stmt = db.prepare(`INSERT INTO landed_video (ytId,channel_ref,first_run_id,last_run_id)
                           VALUES (?,?,?,?)
                           ON CONFLICT(ytId) DO UPDATE SET last_run_id=excluded.last_run_id`);
  for (const id of ytIds) stmt.run(id, channelRef, runId, runId);
}

export const hasLanded = (db, ytId) =>
  !!db.prepare('SELECT 1 FROM landed_video WHERE ytId=?').get(ytId);
