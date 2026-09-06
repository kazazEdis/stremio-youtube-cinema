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

import { openCore, seedFirstSeen, noteFirstSeen, thumbUrl, statusName, getCoreMeta,
         quarantinedYtIds } from './core.js';
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

/**
 * Every playable upload of one film, best first.
 *
 * Stremio's stream endpoint is an array and this addon has only ever put one
 * thing in it, so 579 films quietly threw away a second working copy. That is
 * also why the age-gate swap only helps one gated upload in seven: a film with
 * a spare did not need choosing between, it needed both offered.
 *
 * The settled winner stays first, because it is the one the scorer trusts most.
 * Anything a real client could not play sorts last however good its match is —
 * a viewer scanning the list should reach a working stream before a gated one.
 */
export function streamsFor(winner, scanned, quarantine) {
  const id = winner.id ?? winner.imdbId;
  const alts = scanned
    .filter(r => (r.published_id ?? r.imdb_id) === id && r.ytId !== winner.ytId)
    .map(r => ({ ...toResolutionShape(r), playback: quarantine.has(r.ytId) ? 'age-gated' : undefined }))
    .sort((a, b) => (a.playback ? 1 : 0) - (b.playback ? 1 : 0)
                 || (b.confidence ?? 0) - (a.confidence ?? 0));
  return [winner, ...alts].map(toStream);
}

/**
 * Read back every stream file the catalogue promises, and fail loudly if one
 * of them is not there, is empty, or does not carry the ytId we just wrote.
 *
 * This exists because a publish once left a zero-byte tt0317268.json: the host
 * VM was killed mid-run, and a kill here is power loss -- the page cache went
 * with it. The catalogue still listed the film, so Stremio would have shown it
 * and then offered no stream at all, and nothing in the pipeline would ever
 * have said so. It was found by a determinism check, by accident.
 *
 * Re-reading three thousand small files costs under a second, which is nothing
 * against a mart that is silently missing a title.
 */
export async function verifyMarts(outDir, movies) {
  const bad = [];
  for (const m of movies) {
    const type = m.stremioType === 'series' ? 'series' : 'movie';
    const file = path.join(outDir, 'stream', type, `${m.id ?? m.imdbId}.json`);
    try {
      const text = await fsp.readFile(file, 'utf8');
      if (!text.trim()) { bad.push(`${file}: empty`); continue; }
      const got = JSON.parse(text)?.streams?.[0]?.ytId;
      if (got !== m.ytId) bad.push(`${file}: ytId ${got ?? '(none)'} != ${m.ytId}`);
    } catch (err) {
      bad.push(`${file}: ${err.code ?? err.message}`);
    }
  }
  if (bad.length) {
    console.error(`[publish]  ${bad.length} stream file(s) the catalogue promises are wrong:`);
    for (const b of bad.slice(0, 20)) console.error(`   ${b}`);
    throw new Error(`publish wrote ${bad.length} unusable stream file(s)`);
  }
  console.log(`[verify]   ${movies.length.toLocaleString()} stream files read back and match`);
}

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
    stremioType: r.stremio_type ?? 'movie',
    id: r.published_id ?? r.imdb_id ?? undefined,
    season: r.season ?? null,
    episode: r.episode ?? null,
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
  if (r.playback) shape.playback = r.playback;
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
           r.status, r.reason, r.imdb_id, r.stremio_type, r.published_id,
           r.season, r.episode, r.match_name, r.imdb_year, r.imdb_runtime,
           r.genres, r.confidence, r.margin, r.candidate_count,
           r.sig_title, r.sig_year, r.sig_runtime, r.sig_corrob, r.is_override, r.tier
    FROM fct_upload u JOIN fct_resolution r ON r.ytId = u.ytId
    WHERE u.drop_reason IS NULL`).all();

  // Region BEFORE settling, deliberately. A geo-blocked upload must not be
  // allowed to win a duplicate contest and then be filtered out, which would
  // drop the film entirely — the old path could not hit this because blocked
  // uploads never reached the resolver at all.
  //
  // Quarantine sits here for exactly the same reason. An age-gated upload is
  // one a real client cannot play, and letting it win the contest serves a dead
  // click for a film we hold another copy of: Ivan's Childhood was published
  // from a gated Mosfilm upload while an ungated one of the same 95 minutes sat
  // second. 16.4% of published films have a spare, which is how much of this
  // the swap can actually fix.
  // Quarantine only where there is something to swap to. Dropping the sole copy
  // of a film deletes it from the catalogue, and "re-resolve to another upload"
  // is not "delete when there is no other upload" — three of the first four
  // gated films found had no spare at all. Those keep their stream and are
  // marked `notWebReady` instead, which is the truth about them.
  const quarantine = quarantinedYtIds(wh);
  const regional = rows.filter(r => playableIn(region, r.blocked_regions, r.allowed_regions));
  const copies = new Map();
  for (const r of regional) {
    const id = r.published_id ?? r.imdb_id;
    if (id) copies.set(id, (copies.get(id) ?? 0) + 1);
  }
  const replaceable = r => quarantine.has(r.ytId)
    && (copies.get(r.published_id ?? r.imdb_id) ?? 0) > 1;

  // Only the *winner* has to be playable. Now that a stream file carries every
  // copy of a film, hiding the gated one helps nobody — a viewer signed in on
  // YouTube can play it, and it costs nothing to offer it last. So it is kept
  // out of the settle and put back in the list.
  const scanned = regional.filter(r => !replaceable(r));
  for (const r of regional) if (quarantine.has(r.ytId)) r.playback = 'age-gated';
  const { resolved, review, rejected } = settleDuplicates(scanned.map(toResolutionShape));

  const movies = resolved.filter(m => !excludedByImdb(m.imdbId, rules));
  movies.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return { movies, review, rejected, scanned, regional, quarantine };
}

/** Write-once, then read back. A replay must never rewrite history. */
export function applyFirstSeen(wh, movies, today, runId) {
  wh.exec('BEGIN');
  for (const m of movies) noteFirstSeen(wh, m.id ?? m.imdbId, today, runId, 'publish');
  wh.exec('COMMIT');
  const get = wh.prepare('SELECT first_seen FROM fct_first_seen WHERE published_id=?');
  for (const m of movies) {
    m.firstSeen = get.get(m.id ?? m.imdbId)?.first_seen ?? today;
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
  // Keyed on the published id: a show's episodes legitimately share a tconst,
  // and gating on imdbId would fail the build the first time a series appears.
  const seen = new Set(), dupes = new Set();
  for (const m of movies) {
    const k = m.id ?? m.imdbId;
    if (seen.has(k)) dupes.add(k);
    seen.add(k);
  }
  if (dupes.size) fails.push(`${dupes.size} duplicate published id among accepted`);
  return fails;
}
// #endregion

/**
 * Delete mart files the current run did not write.
 *
 * Without this the marts only ever grow: a film that stops resolving keeps its
 * stream file, so the addon goes on serving a title the catalogue no longer
 * lists, and every stale page ships to Pages forever. Measured at 46 orphans
 * after a handful of runs.
 */
async function prune(outDir, kind, keep) {
  const dir = path.join(outDir, 'stream', kind);
  let names;
  try { names = await fsp.readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const f of names) {
    if (keep.has(f)) continue;
    await fsp.rm(path.join(dir, f), { force: true });
    removed++;
  }
  return removed;
}

async function writeCatalog(outDir, type, id, metas) {
  await writeJson(path.join(outDir, 'catalog', type, `${id}.json`), { metas: metas.slice(0, PAGE) });
  for (let skip = PAGE; skip < metas.length; skip += PAGE) {
    await writeJson(path.join(outDir, 'catalog', type, id, `skip=${skip}.json`),
                    { metas: metas.slice(skip, skip + PAGE) });
  }
  return Math.ceil(metas.length / PAGE);
}

/**
 * One catalogue row per show, not per episode.
 *
 * Ninety-one episodes of One Step Beyond are ninety-one streams but a single
 * entry in the row; Stremio expands it into seasons itself from the series
 * tconst. Keeps the earliest-named episode's metadata as the show's.
 */
function showRows(episodes) {
  const byShow = new Map();
  for (const e of episodes) if (!byShow.has(e.imdbId)) byShow.set(e.imdbId, e);
  return [...byShow.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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

  const { movies, review, scanned, regional, quarantine } = loadCore(wh, { region: args.region, rules });
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

  const films = movies.filter(m => (m.stremioType ?? 'movie') === 'movie');
  const episodes = movies.filter(m => m.stremioType === 'series');
  const groups = [...new Set(films.map(m => m.group).filter(Boolean))].sort();
  const seriesGroups = [...new Set(episodes.map(m => m.group).filter(Boolean))].sort();

  await writeJson(path.join(args.out, 'manifest.json'),
                  buildManifest(films, groups, '', seriesGroups));

  let pages = await writeCatalog(args.out, 'movie', 'ytc-all', films.map(m => toMeta(m)));
  for (const g of groups) {
    pages += await writeCatalog(args.out, 'movie', `ytc-${slug(g)}`,
                                films.filter(m => m.group === g).map(m => toMeta(m)));
  }

  // Series: the catalogue lists shows, the streams are per episode.
  const shows = showRows(episodes);
  if (shows.length) {
    pages += await writeCatalog(args.out, 'series', 'ytc-all',
                                shows.map(m => toMeta(m, 'series')));
    for (const g of seriesGroups) {
      pages += await writeCatalog(args.out, 'series', `ytc-${slug(g)}`,
                                  showRows(episodes.filter(m => m.group === g))
                                    .map(m => toMeta(m, 'series')));
    }
  }

  for (const m of films) {
    await writeJson(path.join(args.out, 'stream', 'movie', `${m.imdbId}.json`),
                    { streams: streamsFor(m, regional, quarantine) });
  }
  // One file per episode, named with the composite id Stremio requests.
  for (const m of episodes) {
    await writeJson(path.join(args.out, 'stream', 'series', `${m.id}.json`),
                    { streams: streamsFor(m, regional, quarantine) });
  }

  const orphans =
    await prune(args.out, 'movie', new Set(films.map(m => `${m.imdbId}.json`))) +
    await prune(args.out, 'series', new Set(episodes.map(m => `${m.id}.json`)));
  if (orphans) console.log(`[publish]  pruned ${orphans} stream files no longer in the catalog`);
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

  await verifyMarts(args.out, movies);

  finishRun(landing, runId, { status: 'ok', rowsIn: scanned.length, rowsOut: movies.length });
  console.log(`[publish]  ${films.length.toLocaleString()} films` +
              (episodes.length ? `, ${episodes.length.toLocaleString()} episodes across ` +
                                 `${shows.length} shows` : '') +
              `, ${groups.length + seriesGroups.length} groups, ${pages} catalog pages -> ${args.out}/`);
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
