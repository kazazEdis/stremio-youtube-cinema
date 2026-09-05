#!/usr/bin/env node
/**
 * extract.js — YouTube API into the landing layer. Records, never decides.
 *
 * No filtering by duration, region, embeddability or anything else happens
 * here. Those are business rules and belong in transform, where changing one
 * costs a replay instead of a re-fetch. Extraction's only judgement is *what
 * to ask for*, and even that is driven by a watermark rather than a rule.
 *
 * Incremental by default. playlistItems returns uploads newest-first, so paging
 * stops once it reaches a video already landed for that channel. A full run
 * previously re-fetched up to 3,000 videos per channel every week; almost none
 * of them had changed.
 *
 * Usage:
 *   node --env-file=.env src/dwh/extract.js [--eu-only] [--full] [--only @ref]
 */

import fsp from 'node:fs/promises';
import {
  openLanding, startRun, finishRun, land,
  getWatermark, setWatermark, markLanded, hasLanded,
} from './landing.js';

const API = 'https://www.googleapis.com/youtube/v3';
const KEY = process.env.YT_API_KEY;

// Pages of 50 to keep looking past the watermark before trusting it. Uploads
// playlists are not strictly monotonic — a re-published video can reappear
// above older ones — so a hard stop on the first known id can miss entries.
const OVERLAP_PAGES = 1;

function parseArgs(argv) {
  const a = { euOnly: false, full: false, only: null, db: 'data/landing.sqlite',
              maxPerChannel: 3000 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--eu-only') a.euOnly = true;
    else if (k === '--full') a.full = true;                 // ignore watermarks
    else if (k === '--only') a.only = argv[++i].split(',').map(s => s.trim());
    else if (k === '--db') a.db = argv[++i];
    else if (k === '--max-per-channel') a.maxPerChannel = Number(argv[++i]);
  }
  return a;
}

/** One API call, landed verbatim, returned parsed. */
async function call(db, runId, endpoint, params) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', KEY);

  const res = await fetch(url);
  const text = await res.text();
  // Failures are landed too: a 403 quota error is evidence about the run, and
  // discarding it would make the gap in the data unexplainable later.
  land(db, runId, endpoint, params, res.status, text);
  if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function resolveChannel(db, runId, ref) {
  const params = { part: 'snippet,contentDetails' };
  if (ref.startsWith('UC')) params.id = ref;
  else params.forHandle = ref.startsWith('@') ? ref : `@${ref}`;
  const data = await call(db, runId, 'channels', params);
  const c = data.items?.[0];
  if (!c) throw new Error(`could not resolve ${ref}`);
  return { id: c.id, title: c.snippet.title,
           uploads: c.contentDetails.relatedPlaylists.uploads };
}

/**
 * Walk the uploads playlist, newest first, stopping at the watermark.
 * Returns every video id seen this run, in playlist order.
 */
async function walkUploads(db, runId, playlistId, { stopAt, limit }) {
  const ids = [];
  let pageToken, seenWatermark = false, pagesAfterHit = 0;

  do {
    const page = await call(db, runId, 'playlistItems', {
      part: 'contentDetails', playlistId, maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const it of page.items || []) {
      const id = it.contentDetails?.videoId;
      if (!id) continue;
      if (stopAt && id === stopAt) seenWatermark = true;
      ids.push(id);
    }
    if (seenWatermark && ++pagesAfterHit > OVERLAP_PAGES) break;
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < limit);

  return { ids: ids.slice(0, limit), hitWatermark: seenWatermark };
}

const chunk = (a, n) =>
  Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function extractChannel(db, runId, entry, args) {
  const wm = args.full ? null : getWatermark(db, entry.ref);

  // The uploads playlist id is stable, so a cached one saves a channels.list
  // call per channel per run.
  const ch = wm?.uploads_playlist
    ? { uploads: wm.uploads_playlist, title: entry.name ?? entry.ref, id: null }
    : await resolveChannel(db, runId, entry.ref);

  const { ids, hitWatermark } = await walkUploads(db, runId, ch.uploads, {
    stopAt: wm?.last_ytid ?? null,
    limit: args.maxPerChannel,
  });
  if (!ids.length) return { seen: 0, hydrated: 0, incremental: !!wm };

  // Hydrate only what is new. On a quiet week this is zero calls.
  //
  // The cost of that thrift is staleness: a video deleted or newly geo-blocked
  // since the last run is only noticed when it is re-hydrated. That is what
  // --full is for, and why it should run periodically rather than never — a
  // weekly incremental plus a monthly full refresh keeps quota near zero
  // without letting dead entries accumulate in the catalog.
  const toHydrate = args.full ? ids : ids.filter(id => !hasLanded(db, id));
  let hydrated = 0;
  for (const batch of chunk(toHydrate, 50)) {
    const data = await call(db, runId, 'videos', {
      part: 'snippet,contentDetails,status,statistics', id: batch.join(','),
    });
    hydrated += (data.items || []).length;
  }

  markLanded(db, ids, entry.ref, runId);
  setWatermark(db, entry.ref, {
    uploadsPlaylist: ch.uploads,
    lastYtId: ids[0],                    // newest upload seen this run
    lastPublished: null,
    runId,
  });
  return { seen: ids.length, hydrated, skipped: ids.length - toHydrate.length,
           incremental: !!wm, hitWatermark };
}

async function main() {
  if (!KEY) { console.error('YT_API_KEY is not set'); process.exit(1); }
  const args = parseArgs(process.argv);
  const cfg = JSON.parse(await fsp.readFile('config/channels.json', 'utf8'));
  let targets = args.euOnly ? cfg.channels.filter(c => c.eu) : cfg.channels;
  if (args.only) targets = targets.filter(c => args.only.includes(c.ref));

  const db = openLanding(args.db);
  const runId = startRun(db, 'extract', args.full ? 'full refresh' : 'incremental');
  console.log(`[run ${runId}] extract, ${targets.length} channels, ${args.full ? 'FULL' : 'incremental'}`);

  let totalSeen = 0, ok = 0;
  for (const entry of targets) {
    try {
      const r = await extractChannel(db, runId, entry, args);
      totalSeen += r.seen;
      ok++;
      const mode = r.incremental ? (r.hitWatermark ? 'incr' : 'incr*') : 'first';
      console.log(`[${mode.padEnd(5)}] ${entry.ref.padEnd(26)} ${String(r.seen).padStart(5)} walked, ` +
                  `${String(r.hydrated).padStart(5)} hydrated, ${String(r.skipped).padStart(5)} already landed`);
    } catch (err) {
      console.error(`[fail ] ${entry.ref.padEnd(26)} ${err.message.slice(0, 90)}`);
    }
  }

  finishRun(db, runId, { status: ok ? 'ok' : 'failed', rowsOut: totalSeen,
                         notes: `${ok}/${targets.length} channels` });
  console.log(`[run ${runId}] landed ${totalSeen.toLocaleString()} video references from ${ok}/${targets.length} channels`);
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
