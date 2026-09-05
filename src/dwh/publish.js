#!/usr/bin/env node
/**
 * publish.js — core into the Stremio marts.
 *
 * Region is applied HERE and only here. That is the point of recording
 * blocked_regions in staging rather than filtering during the fetch: serving
 * another region becomes a loop in this file instead of a re-collection.
 *
 * The mart shape is unchanged, so the pure helpers in src/publish.js are
 * imported rather than reimplemented — only the data source moves.
 *
 * Usage:
 *   node src/dwh/publish.js --region HR --out docs [--seed-first-seen docs/catalog.json]
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { openCore, seedFirstSeen, noteFirstSeen, thumbUrl, statusName, getCoreMeta } from './core.js';
import { openLanding, startRun, finishRun } from './landing.js';
import { settleDuplicates, THRESHOLDS } from '../resolve/index.js';
import { loadExclusions, excludedByImdb } from '../resolve/exclude.js';
import { toMeta, toStream, buildManifest } from '../publish.js';
import {
  diffCatalogs, summarizeReview, perChannel, findSilentChannels,
} from '../report.js';

const PAGE = 100;
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function parseArgs(argv) {
  const a = { warehouse: 'data/warehouse.sqlite', landing: 'data/landing.sqlite',
              out: 'docs', region: process.env.YT_REGION || 'HR',
              prev: 'docs/catalog.json', seed: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'seed-first-seen') a.seed = argv[++i];
    else if (k in a) a[k] = argv[++i];
  }
  return a;
}

const readJson = (p, fb = null) =>
  fsp.readFile(p, 'utf8').then(t => (t.trim() ? JSON.parse(t) : fb)).catch(e => {
    if (e.code === 'ENOENT') return fb; throw e;
  });

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data));
}

// #region ---------------------------------------------------------- region
/**
 * Mirrors the original playableInRegion: a blocked list wins outright,
 * otherwise an allowed list must contain the region, otherwise it plays.
 */
export function playableIn(region, blockedCsv, allowedCsv) {
  if (blockedCsv) return !blockedCsv.split(',').includes(region);
  if (allowedCsv) return allowedCsv.split(',').includes(region);
  return true;
}
// #endregion

// #region ---------------------------------------------------------- shape
/**
 * A core row back into the object shape the rest of the pipeline expects.
 *
 * Key order follows publicShape so docs/catalog.json stays byte-comparable
 * with the old path, and `name` re-applies the polymorphism core deliberately
 * split apart: the IMDb title when matched, the cleaned YouTube title when not.
 */
export function toResolutionShape(r) {
  const signals = r.is_override
    ? { override: 100 }
    : { title: r.sig_title, year: r.sig_year,
        runtime: r.sig_runtime, corroboration: r.sig_corrob };
  const shape = {
    status: statusName(r.status),
    ytId: r.ytId,
    imdbId: r.imdb_id ?? undefined,
    name: r.match_name ?? r.clean_title,
    rawTitle: r.raw_title,
    year: r.imdb_year ?? null,
    confidence: r.confidence ?? undefined,
    margin: r.margin ?? undefined,
    signals,
    ytRuntimeMin: r.runtime_min,
    imdbRuntimeMin: r.imdb_runtime ?? null,
    channel: r.channel_name,
    group: r.grp,
    poster: thumbUrl(r.ytId, r.thumb_tier),
    genres: r.genres ?? null,
  };
  if (r.tier) shape.tier = r.tier;
  if (r.reason) shape.reason = r.reason;
  if (r.candidate_count != null) shape.candidateCount = r.candidate_count;
  if (r.is_override) shape.override = true;
  return shape;
}
// #endregion

// #region ---------------------------------------------------------- load
export function loadCore(wh, { region, rules }) {
  const rows = wh.prepare(`
    SELECT u.ytId, u.channel_name, u.grp, u.raw_title, u.clean_title, u.runtime_min,
           u.thumb_tier, u.blocked_regions, u.allowed_regions,
           r.status, r.reason, r.imdb_id, r.match_name, r.imdb_year, r.imdb_runtime,
           r.genres, r.confidence, r.margin, r.candidate_count,
           r.sig_title, r.sig_year, r.sig_runtime, r.sig_corrob, r.is_override, r.tier
    FROM fct_upload u JOIN fct_resolution r ON r.ytId = u.ytId
    WHERE u.drop_reason IS NULL`).all();

  // Region BEFORE settling, deliberately. A geo-blocked upload must not be
  // allowed to win a duplicate contest and then be filtered out, which would
  // drop the film entirely — the old path could not hit this because blocked
  // uploads never reached the resolver at all.
  const scanned = rows.filter(r => playableIn(region, r.blocked_regions, r.allowed_regions));
  const { resolved, review, rejected } = settleDuplicates(scanned.map(toResolutionShape));

  const movies = resolved.filter(m => !excludedByImdb(m.imdbId, rules));
  movies.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return { movies, review, rejected, scanned };
}

/** Write-once, then read back. A replay must never rewrite history. */
export function applyFirstSeen(wh, movies, today, runId) {
  wh.exec('BEGIN');
  for (const m of movies) noteFirstSeen(wh, m.imdbId, today, runId, 'publish');
  wh.exec('COMMIT');
  const get = wh.prepare('SELECT first_seen FROM fct_first_seen WHERE imdb_id=?');
  for (const m of movies) {
    m.firstSeen = get.get(m.imdbId)?.first_seen ?? today;
    m.lastVerified = today;
  }
}
// #endregion

// #region ---------------------------------------------------------- gates
/** Refuse to publish a catalog that looks broken. Returns a list of failures. */
export function qualityGates(movies, prevCatalog) {
  const fails = [];
  const prev = prevCatalog?.movies?.length ?? 0;
  if (!movies.length) fails.push('catalog is empty');
  if (prev > 50 && movies.length < prev * 0.7) {
    fails.push(`catalog shrank from ${prev} to ${movies.length} (>30%)`);
  }
  const low = movies.filter(m => !m.override && m.confidence < THRESHOLDS.accept);
  if (low.length) fails.push(`${low.length} accepted below the confidence floor`);
  const seen = new Set(), dupes = new Set();
  for (const m of movies) { if (seen.has(m.imdbId)) dupes.add(m.imdbId); seen.add(m.imdbId); }
  if (dupes.size) fails.push(`${dupes.size} duplicate imdbId among accepted`);
  return fails;
}
// #endregion

async function writeCatalog(outDir, id, metas) {
  await writeJson(path.join(outDir, 'catalog', 'movie', `${id}.json`), { metas: metas.slice(0, PAGE) });
  for (let skip = PAGE; skip < metas.length; skip += PAGE) {
    await writeJson(path.join(outDir, 'catalog', 'movie', id, `skip=${skip}.json`),
                    { metas: metas.slice(skip, skip + PAGE) });
  }
  return Math.ceil(metas.length / PAGE);
}

async function main() {
  const args = parseArgs(process.argv);
  const today = new Date().toISOString().slice(0, 10);
  const wh = openCore(args.warehouse);

  if (args.seed) {
    const n = seedFirstSeen(wh, await readJson(args.seed, { movies: [] }));
    console.log(`[seed]     ${n.toLocaleString()} first-seen dates carried forward from ${args.seed}`);
  }

  const landing = openLanding(args.landing);
  const runId = startRun(landing, 'publish', `region=${args.region}`);
  const rules = loadExclusions(await readJson('config/exclude.json', null));

  const { movies, review, scanned } = loadCore(wh, { region: args.region, rules });
  const prevCatalog = await readJson(args.prev, { movies: [] });
  // Read before publishing overwrites it: the silent-channel check compares
  // this run's per-channel output against the previous run's.
  const prevReport = await readJson(path.join(args.out, 'report.json'), null);

  const fails = qualityGates(movies, prevCatalog);
  if (fails.length) {
    fails.forEach(f => console.error(`[gate]     FAIL ${f}`));
    finishRun(landing, runId, { status: 'failed', notes: fails.join('; ') });
    process.exit(2);
  }

  applyFirstSeen(wh, movies, today, runId);

  const groups = [...new Set(movies.map(m => m.group).filter(Boolean))].sort();
  await writeJson(path.join(args.out, 'manifest.json'), buildManifest(movies, groups, ''));
  let pages = await writeCatalog(args.out, 'ytc-all', movies.map(toMeta));
  for (const g of groups) {
    pages += await writeCatalog(args.out, `ytc-${slug(g)}`,
                                movies.filter(m => m.group === g).map(toMeta));
  }
  for (const m of movies) {
    await writeJson(path.join(args.out, 'stream', 'movie', `${m.imdbId}.json`),
                    { streams: [toStream(m)] });
  }
  // No `generated` timestamp in either committed artifact. It is the only
  // thing that changes on a run where the catalog did not, so writing it makes
  // every scheduled run produce a commit, rebuild Pages, and bury the runs
  // that genuinely changed something. Git's commit date already records when
  // this was produced, and more trustworthily.
  await writeJson(path.join(args.out, 'catalog.json'),
                  { count: movies.length, movies });

  // The health report. Built here rather than in a separate stage because this
  // is the only point where the previous catalog, the new one, the review queue
  // and the pre-settle scanned set all exist at once -- as three separate JSON
  // files it needed three reads and could disagree with itself.
  const scannedShapes = scanned.map(r => ({ channel: r.channel_name, group: r.grp }));
  const channels = perChannel({ movies: scannedShapes }, movies);
  const diff = diffCatalogs(prevCatalog.movies, movies);
  const reviewSummary = summarizeReview({ movies: review });
  const report = {
    run: { region: args.region, imdbDataset: getCoreMeta(wh, 'imdb_dataset') },
    counts: {
      scanned: scanned.length,
      published: movies.length,
      review: reviewSummary.total,
      rejected: Math.max(0, scanned.length - movies.length - reviewSummary.total),
    },
    diff,
    review: reviewSummary,
    channels,
    health: {
      resolveRate: scanned.length ? Number((movies.length / scanned.length).toFixed(3)) : 0,
      deadRate: prevCatalog.movies?.length
        ? Number((diff.removed / prevCatalog.movies.length).toFixed(4)) : 0,
      silentChannels: findSilentChannels(prevReport, channels),
    },
  };
  await writeJson(path.join(args.out, 'report.json'), report);

  finishRun(landing, runId, { status: 'ok', rowsIn: scanned.length, rowsOut: movies.length });
  console.log(`[publish]  ${movies.length.toLocaleString()} movies, ${groups.length} groups, ` +
              `${pages} catalog pages -> ${args.out}/`);
  console.log(`[report]   +${diff.added} added, -${diff.removed} dead, ` +
              `~${diff.resourceChanged} re-uploaded, ${(report.health.resolveRate * 100).toFixed(1)}% resolved`);
  if (report.health.silentChannels.length) {
    console.log(`::warning::silent channels: ${report.health.silentChannels.join(', ')}`);
  }
  if (diff.removedTitles.length) {
    console.log(`[report]   dead: ${diff.removedTitles.slice(0, 5).join(' | ')}`);
  }
  console.log(`[publish]  region ${args.region}: ${scanned.length.toLocaleString()} of ` +
              `${wh.prepare('SELECT COUNT(*) c FROM fct_upload WHERE drop_reason IS NULL').get().c.toLocaleString()}` +
              ` eligible uploads playable, ${review.length.toLocaleString()} in review`);
  wh.close(); landing.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
