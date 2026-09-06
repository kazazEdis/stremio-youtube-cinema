#!/usr/bin/env node
/**
 * stage.js — landing into staging. Parse and type only; decide nothing.
 *
 * One row per source record, still shaped like the source. In particular
 * `blocked_regions` and `allowed_regions` are *recorded*, never applied: that
 * is the whole reason serving another region later is a mart change rather
 * than a re-collection. The previous pipeline applied the region rule during
 * the fetch and permanently lost 2,779 films to it.
 *
 * Rebuilt from landing on every run, so it is disposable by construction. If
 * this layer is wrong, fix the parser and replay — no network, no quota.
 *
 * Usage:
 *   node src/dwh/stage.js [--landing data/landing.sqlite] [--warehouse data/warehouse.sqlite]
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { openLanding, readLanded, startRun, finishRun } from './landing.js';

const PRAGMAS = `
PRAGMA page_size = 4096;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -8000;
`;

const SCHEMA = `
-- Grain: one YouTube upload. Latest landed observation wins.
CREATE TABLE IF NOT EXISTS stg_upload (
  ytId            TEXT PRIMARY KEY,
  yt_channel_id   TEXT,
  channel_title   TEXT,
  raw_title       TEXT NOT NULL,
  duration_s      INTEGER NOT NULL,
  published_at    TEXT,
  view_count      INTEGER,
  embeddable      INTEGER,          -- 1 | 0 | NULL when the API omitted it
  licensed        INTEGER,
  privacy         TEXT,
  upload_status   TEXT,
  blocked_regions TEXT,             -- CSV, recorded not applied
  allowed_regions TEXT,
  thumb_tier      INTEGER NOT NULL DEFAULT -1,
  src_run_id      INTEGER NOT NULL,
  staged_at       TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS stg_blurb (
  ytId TEXT PRIMARY KEY REFERENCES stg_upload(ytId) ON DELETE CASCADE,
  text TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stg_chan ON stg_upload(yt_channel_id);
`;

const TIERS = ['maxresdefault', 'sddefault', 'hqdefault'];

/** ISO-8601 PT#H#M#S -> seconds. 0 for unparseable or live content. */
export function durationToSeconds(iso) {
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  const [, d, h, mi, s] = m.map(v => (v ? Number(v) : 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

/**
 * Index into TIERS for the best thumbnail present, or -1 for none.
 * Stored as one integer because the URL is always
 * i.ytimg.com/vi/<ytId>/<tier>.jpg — measured true for 8,276 of 8,276 films.
 */
function bestTier(snippet) {
  const t = snippet?.thumbnails || {};
  if (t.maxres) return 0;
  if (t.standard) return 1;
  if (t.high || t.medium || t.default) return 2;
  return -1;
}

export function toStagedRow(v, runId) {
  const rr = v.contentDetails?.regionRestriction;
  return {
    ytId: v.id,
    yt_channel_id: v.snippet?.channelId ?? null,
    channel_title: v.snippet?.channelTitle ?? null,
    raw_title: v.snippet?.title ?? '',
    duration_s: durationToSeconds(v.contentDetails?.duration),
    published_at: v.snippet?.publishedAt ?? null,
    view_count: Number(v.statistics?.viewCount ?? 0),
    embeddable: v.status?.embeddable == null ? null : (v.status.embeddable ? 1 : 0),
    licensed: v.contentDetails?.licensedContent == null
      ? null : (v.contentDetails.licensedContent ? 1 : 0),
    privacy: v.status?.privacyStatus ?? null,
    upload_status: v.status?.uploadStatus ?? null,
    blocked_regions: Array.isArray(rr?.blocked) ? rr.blocked.join(',') : null,
    allowed_regions: Array.isArray(rr?.allowed) ? rr.allowed.join(',') : null,
    thumb_tier: bestTier(v.snippet),
    description: (v.snippet?.description ?? '').slice(0, 900),
    src_run_id: runId,
  };
}

function openWarehouse(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(PRAGMAS);
  db.exec(SCHEMA);
  return db;
}

function parseArgs(argv) {
  const a = { landing: 'data/landing.sqlite', warehouse: 'data/warehouse.sqlite', runId: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'run') a.runId = Number(argv[++i]);
    else if (k in a) a[k] = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const landing = openLanding(args.landing);
  const wh = openWarehouse(args.warehouse);
  const runId = startRun(landing, 'stage', args.runId ? `from run ${args.runId}` : 'all landed');

  const ins = wh.prepare(`INSERT OR REPLACE INTO stg_upload
    (ytId,yt_channel_id,channel_title,raw_title,duration_s,published_at,view_count,
     embeddable,licensed,privacy,upload_status,blocked_regions,allowed_regions,
     thumb_tier,src_run_id,staged_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insB = wh.prepare('INSERT OR REPLACE INTO stg_blurb (ytId,text) VALUES (?,?)');

  const now = new Date().toISOString();
  let responses = 0, rows = 0;
  wh.exec('BEGIN');
  let skipped = 0;
  for (const resp of readLanded(landing, 'videos', { runId: args.runId })) {
    responses++;
    for (const v of resp.body.items || []) {
      if (!v.id) continue;
      // A response without `snippet` was fetched for some other purpose and
      // cannot be staged: every downstream row keys off the channel, and one
      // with no channel id breaks the dim_channel build a run later, where the
      // cause is nowhere in sight. Skip it and say so.
      if (!v.snippet) { skipped++; continue; }
      const r = toStagedRow(v, resp.runId);
      ins.run(r.ytId, r.yt_channel_id, r.channel_title, r.raw_title, r.duration_s,
              r.published_at, r.view_count, r.embeddable, r.licensed, r.privacy,
              r.upload_status, r.blocked_regions, r.allowed_regions, r.thumb_tier,
              r.src_run_id, now);
      if (r.description) insB.run(r.ytId, r.description);
      rows++;
    }
  }
  wh.exec('COMMIT');

  const total = wh.prepare('SELECT COUNT(*) c FROM stg_upload').get().c;
  const geo = wh.prepare('SELECT COUNT(*) c FROM stg_upload WHERE blocked_regions IS NOT NULL').get().c;
  finishRun(landing, runId, { rowsIn: responses, rowsOut: rows });

  console.log(`[stage]  ${responses} landed responses -> ${rows.toLocaleString()} rows` +
              (skipped ? `, ${skipped.toLocaleString()} skipped for having no snippet` : ''));
  console.log(`[stage]  stg_upload now holds ${total.toLocaleString()} uploads, ` +
              `${geo.toLocaleString()} carry region restrictions (recorded, not applied)`);
  wh.close(); landing.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
