#!/usr/bin/env node
/**
 * transform.js — staging into core. Where the business rules live.
 *
 * This is the layer that was missing, and its absence caused the two data
 * losses this pipeline was rebuilt to prevent: title cleaning ran during the
 * fetch (so improving it forced a re-clean of the whole catalog) and the region
 * filter ran during the fetch (so 2,779 films were destroyed at collection).
 * Both rules now live here, where changing one costs a replay and no quota.
 *
 * Region is deliberately NOT applied here either -- it belongs at publish, and
 * `blocked_regions` is carried through untouched.
 *
 * Usage:
 *   node src/dwh/transform.js [--skip-resolve] [--fresh] [--limit N]
 */

import fsp from 'node:fs/promises';

import { openLanding, startRun, finishRun } from './landing.js';
import {
  syncRatings,
  openCore, upsertChannel, currentChannels, inputHash, hashObject,
  thumbUrl, STATUS, setCoreMeta,
} from './core.js';
import { cleanTitle, extractYear } from '../transform/title.js';
import { parseEpisode } from '../transform/episode.js';
import { loadExclusions, excludeReason } from '../resolve/exclude.js';
import { buildIndex, resolveOne } from '../resolve/index.js';

/**
 * Bump when resolve/index.js changes scoring semantics. Stored on every
 * resolution so a stale one is recomputed rather than silently trusted.
 */
export const RESOLVER_VERSION = 13;  // 13: recent-year exempts the rights-holder channels
                                     // 10: episodes earn the yearless lift from type agreement
                                     // 9: dash segments and a shouted "<cast> in <TITLE>" as derived keys
                                     // 8: derived keys only when the title as written finds nothing
                                     // 7: fuzzy tier repaired after 6 silently disabled it
                                     // 6: bracket-derived lookup keys, and print labels stripped
                                     // 5: that lift moved to the winner alone, so margins do not shift
                                     // 4: a missing year is neutral-12 when the runtime corroborates
                                     // 3: type filter applied before the candidate cap

const BATCH = 500;

function parseArgs(argv) {
  const a = {
    landing: 'data/landing.sqlite', warehouse: 'data/warehouse.sqlite',
    cache: '.cache', minMinutes: 60, maxMinutes: 300,
    // Episodes need their own window: 20-50 minutes is normal television and
    // sits entirely below the feature floor.
    epMinMinutes: 15, epMaxMinutes: 90,
    skipResolve: false, fresh: false, limit: 0,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--skip-resolve') a.skipResolve = true;
    else if (k === '--fresh') a.fresh = true;
    else if (k === '--limit') a.limit = Number(argv[++i]);
    else if (k === '--min-minutes') a.minMinutes = Number(argv[++i]);
    else if (k === '--max-minutes') a.maxMinutes = Number(argv[++i]);
    else if (k === '--landing') a.landing = argv[++i];
    else if (k === '--warehouse') a.warehouse = argv[++i];
    else if (k === '--cache') a.cache = argv[++i];
  }
  return a;
}

const readJson = (p, fb = null) =>
  fsp.readFile(p, 'utf8').then(t => (t.trim() ? JSON.parse(t) : fb)).catch(e => {
    if (e.code === 'ENOENT') return fb;
    throw e;
  });

// #region ---------------------------------------------------------- dimension
/**
 * ytId -> config channel ref. landing.landed_video records this at extract
 * time, which is the only place the association is known for certain: staging
 * carries YouTube's own channel id and title, and neither matches a config ref
 * like "@Mosfilm_eng".
 */
export function channelRefMap(landing) {
  return new Map(landing.prepare('SELECT ytId, channel_ref FROM landed_video').all()
    .map(r => [r.ytId, r.channel_ref]));
}

export function buildDimChannel(wh, landing, cfg, day) {
  // The YouTube-side title and id come from whatever staging observed, keyed
  // back through landed_video.
  const observed = new Map();
  for (const row of wh.prepare(`SELECT yt_channel_id, channel_title, COUNT(*) n
                                FROM stg_upload GROUP BY yt_channel_id, channel_title`).all()) {
    observed.set(row.yt_channel_id, row);
  }
  const refByYt = new Map();
  for (const [ytId, ref] of channelRefMap(landing)) {
    const up = wh.prepare('SELECT yt_channel_id FROM stg_upload WHERE ytId=?').get(ytId);
    if (up?.yt_channel_id) refByYt.set(up.yt_channel_id, ref);
  }

  const byRef = new Map(cfg.channels.map(c => [c.ref, c]));
  const tally = { new: 0, versioned: 0, unchanged: 0 };

  for (const [ytChannelId, obs] of observed) {
    // No channel id, no dimension row. This crashed a CI run with "NOT NULL
    // constraint failed: dim_channel.channel_ref" one run after the rows were
    // written, which is the worst place to learn about it.
    if (!ytChannelId) continue;
    const ref = refByYt.get(ytChannelId) ?? ytChannelId;
    const conf = byRef.get(ref);
    const r = upsertChannel(wh, {
      ref,
      ytChannelId,
      name: obs.channel_title ?? ref,
      // A channel dropped from config keeps its uploads and its history; they
      // simply stop being eligible. Deleting them would lose the record of why
      // the catalog shrank.
      grp: conf?.group ?? '_unmapped',
      eu: conf?.eu ? 1 : 0,
      inConfig: conf ? 1 : 0,
      day,
    });
    tally[r]++;
  }
  return tally;
}
// #endregion

// #region ---------------------------------------------------------- upload
/**
 * Why this upload is not a catalog candidate, or null.
 *
 * Precedence is fixed so the reason is stable run to run. Region is absent by
 * design. Rows are kept either way -- "what did we drop and why" is a query.
 */
export function dropReason(row, rules, args) {
  // Two windows, chosen by what the title says the upload is. Applying the
  // feature floor to an episode drops every one of them before the resolver
  // ever sees it.
  const [lo, hi] = row.isEpisode
    ? [args.epMinMinutes, args.epMaxMinutes]
    : [args.minMinutes, args.maxMinutes];
  if (row.duration_s < lo * 60 || row.duration_s > hi * 60) {
    return row.isEpisode ? 'duration-episode' : 'duration';
  }
  // Matches the original `status.embeddable === false`: an absent value passes.
  if (row.embeddable === 0) return 'not-embeddable';
  const ex = excludeReason({ ytId: row.ytId, group: row.grp, rawTitle: row.raw_title }, rules);
  return ex ? `excl:${ex}` : null;
}

export function toResolverInput(u, description) {
  return {
    ytId: u.ytId,
    name: u.clean_title,
    season: u.season ?? null,
    episode: u.episode ?? null,
    rawTitle: u.raw_title,
    year: u.extracted_year,
    runtimeMin: u.runtime_min,
    description: description ?? '',
    channel: u.channel_name,
    // The ref, not the name: config/channels.json keys on it and it survives
    // the renames dim_channel exists to track. hardFlag's recent-year
    // exemption is looked up with it.
    channelRef: u.channel_ref,
    group: u.grp,
    poster: thumbUrl(u.ytId, u.thumb_tier),
  };
}

function buildFctUpload(wh, landing, cfg, rules, args, runId, now) {
  const refByYt = new Map();
  for (const [ytId, ref] of channelRefMap(landing)) refByYt.set(ytId, ref);
  const grpByRef = new Map(currentChannels(wh).map(c => [c.channel_ref, c.grp]));

  // ON CONFLICT DO UPDATE, never INSERT OR REPLACE: REPLACE is a DELETE plus an
  // INSERT, which fires fct_resolution's ON DELETE CASCADE and silently throws
  // away every resolution on each re-run. Verified.
  const ins = wh.prepare(`INSERT INTO fct_upload
    (ytId,channel_ref,channel_name,grp,raw_title,clean_title,extracted_year,
     season,episode,
     duration_s,runtime_min,thumb_tier,published_at,view_count,licensed,embeddable,
     blocked_regions,allowed_regions,drop_reason,input_hash,transformed_at,run_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(ytId) DO UPDATE SET
      channel_ref=excluded.channel_ref, channel_name=excluded.channel_name,
      grp=excluded.grp, raw_title=excluded.raw_title, clean_title=excluded.clean_title,
      extracted_year=excluded.extracted_year,
      season=excluded.season, episode=excluded.episode, duration_s=excluded.duration_s,
      runtime_min=excluded.runtime_min, thumb_tier=excluded.thumb_tier,
      published_at=excluded.published_at, view_count=excluded.view_count,
      licensed=excluded.licensed, embeddable=excluded.embeddable,
      blocked_regions=excluded.blocked_regions, allowed_regions=excluded.allowed_regions,
      drop_reason=excluded.drop_reason, input_hash=excluded.input_hash,
      transformed_at=excluded.transformed_at, run_id=excluded.run_id`);

  const rows = wh.prepare(`SELECT s.*, b.text AS description
                           FROM stg_upload s LEFT JOIN stg_blurb b ON b.ytId = s.ytId`).all();
  const unmapped = [];
  const drops = {};
  let n = 0;

  wh.exec('BEGIN');
  for (const s of rows) {
    const ref = refByYt.get(s.ytId);
    if (!ref) { unmapped.push(s.ytId); continue; }
    const grp = grpByRef.get(ref) ?? '_unmapped';
    const channelName = s.channel_title ?? ref;

    // The computations that used to happen during the fetch. For an episode the
    // show name is what resolves, so cleanTitle is given the text before the
    // marker rather than the whole string.
    const ep = parseEpisode(s.raw_title);
    const clean = cleanTitle(ep ? ep.showTitle : s.raw_title, channelName);
    const year = extractYear(s.raw_title);
    const runtimeMin = Math.round(s.duration_s / 60);

    const shaped = {
      ytId: s.ytId, raw_title: s.raw_title, duration_s: s.duration_s,
      embeddable: s.embeddable, grp, isEpisode: Boolean(ep),
    };
    const reason = dropReason(shaped, rules, args);
    if (reason) drops[reason] = (drops[reason] || 0) + 1;

    const hash = inputHash({
      ytId: s.ytId, name: clean, rawTitle: s.raw_title, year, runtimeMin,
      description: s.description ?? '', channel: channelName, group: grp,
      poster: thumbUrl(s.ytId, s.thumb_tier),
      season: ep?.season ?? null, episode: ep?.episode ?? null,
    });

    ins.run(s.ytId, ref, channelName, grp, s.raw_title, clean, year,
            ep?.season ?? null, ep?.episode ?? null,
            s.duration_s, runtimeMin, s.thumb_tier, s.published_at, s.view_count,
            s.licensed, s.embeddable, s.blocked_regions, s.allowed_regions,
            reason, hash, now, runId);
    n++;
  }
  wh.exec('COMMIT');

  // A resolution that predates an exclusion must not survive it — the same
  // class of bug the JSON checkpoint had to guard against.
  const stale = wh.prepare(`DELETE FROM fct_resolution WHERE ytId IN
                            (SELECT ytId FROM fct_upload WHERE drop_reason IS NOT NULL)`).run();
  return { n, unmapped, drops, staleCleared: stale.changes ?? 0 };
}
// #endregion

// #region ---------------------------------------------------------- resolve
/**
 * The work list, which IS the checkpoint: a stored resolution is reused only
 * while every input that produced it is unchanged. No separate progress file.
 *
 * The override clause is deliberately narrow. `overrides_hash` is one hash of
 * the whole file, so comparing it alone put all 11,979 eligible uploads back
 * through the scorer whenever a single ytId was pinned -- over two hours on
 * this host, to correct one film. Only two kinds of row can be affected: one
 * whose ytId the file now pins, and one that was last resolved *by* an
 * override, so that deleting an entry re-resolves it honestly.
 *
 * Bound parameters, in order: dataset, resolverVersion, overridesHash,
 * ...overrideIds, limit.
 */
export function pendingSql(overrideCount) {
  const inList = overrideCount
    ? `u.ytId IN (${Array.from({ length: overrideCount }, () => '?').join(',')})` : '0';
  return `
    SELECT u.*, b.text AS description
    FROM fct_upload u
    LEFT JOIN stg_blurb b ON b.ytId = u.ytId
    LEFT JOIN fct_resolution r ON r.ytId = u.ytId
    WHERE u.drop_reason IS NULL
      AND (r.ytId IS NULL OR r.input_hash <> u.input_hash OR r.dataset <> ?
           OR r.resolver_version <> ?
           OR (r.overrides_hash <> ? AND (r.is_override = 1 OR ${inList})))
    LIMIT ?`;
}

export function resolutionRow(r, ctx) {
  const s = r.signals || {};
  return [
    r.ytId, STATUS[r.status], r.reason ?? null, r.imdbId ?? null,
    r.stremioType ?? 'movie', r.id ?? r.imdbId ?? null,
    r.season ?? null, r.episode ?? null,
    // match_name is the IMDb title only; the resolver reuses `name` for the
    // cleaned YouTube title when there is no match, and publish rebuilds that.
    r.imdbId ? (r.name ?? null) : null,
    r.imdbId ? (r.year ?? null) : null,
    r.imdbRuntimeMin ?? null, r.genres ?? null,
    r.confidence ?? null, r.margin ?? null, r.rawScore ?? null,
    r.candidateCount ?? null, r.rivalCount ?? null,
    s.title ?? null, s.year ?? null, s.runtime ?? null, s.corroboration ?? null,
    s.typeMatch ?? null,
    r.override ? 1 : 0, r.tier ?? null,
    ctx.dataset, r.__hash, ctx.overridesHash, RESOLVER_VERSION, ctx.now, ctx.runId,
  ];
}

async function resolvePending(wh, index, ctx, args) {
  const ins = wh.prepare(`INSERT INTO fct_resolution
    (ytId,status,reason,imdb_id,stremio_type,published_id,season,episode,
     match_name,imdb_year,imdb_runtime,genres,
     confidence,margin,score,candidate_count,rival_count,
     sig_title,sig_year,sig_runtime,sig_corrob,sig_type_match,
     is_override,tier,dataset,input_hash,overrides_hash,resolver_version,resolved_at,run_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(ytId) DO UPDATE SET
      status=excluded.status, reason=excluded.reason, imdb_id=excluded.imdb_id,
      stremio_type=excluded.stremio_type, published_id=excluded.published_id,
      season=excluded.season, episode=excluded.episode,
      match_name=excluded.match_name, imdb_year=excluded.imdb_year,
      imdb_runtime=excluded.imdb_runtime, genres=excluded.genres,
      confidence=excluded.confidence, margin=excluded.margin, score=excluded.score,
      candidate_count=excluded.candidate_count, rival_count=excluded.rival_count,
      sig_type_match=excluded.sig_type_match, sig_title=excluded.sig_title,
      sig_year=excluded.sig_year, sig_runtime=excluded.sig_runtime,
      sig_corrob=excluded.sig_corrob, is_override=excluded.is_override,
      tier=excluded.tier, dataset=excluded.dataset, input_hash=excluded.input_hash,
      overrides_hash=excluded.overrides_hash, resolver_version=excluded.resolver_version,
      resolved_at=excluded.resolved_at, run_id=excluded.run_id`);
  const insCand = wh.prepare(`INSERT INTO fct_candidate
    (ytId,rank,imdb_id,name,year,runtime,score,kind) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(ytId,rank) DO UPDATE SET imdb_id=excluded.imdb_id, name=excluded.name,
      year=excluded.year, runtime=excluded.runtime, score=excluded.score, kind=excluded.kind`);
  const delCand = wh.prepare('DELETE FROM fct_candidate WHERE ytId=?');

  const overrideIds = Object.keys(ctx.overrides);
  const pending = wh.prepare(pendingSql(overrideIds.length));

  const total = wh.prepare(`SELECT COUNT(*) c FROM fct_upload WHERE drop_reason IS NULL`).get().c;
  let done = 0;
  let stopping = false;
  const stop = () => { stopping = true; console.log('\n[transform] stop requested — finishing batch'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  for (;;) {
    // Materialised, not iterated: inserting into the same connection while a
    // cursor is open over these tables invalidates the statement.
    const batch = pending.all(ctx.dataset, RESOLVER_VERSION, ctx.overridesHash,
                              ...overrideIds, BATCH);
    if (!batch.length) break;

    wh.exec('BEGIN');
    for (const u of batch) {
      const video = toResolverInput(u, u.description);
      const episode = u.season != null && u.episode != null
        ? { season: u.season, episode: u.episode } : null;
      const res = resolveOne(video, index, {
        overrides: ctx.overrides, episode,
        currentReleaseChannels: ctx.currentReleaseChannels,
      });
      res.__hash = u.input_hash;
      ins.run(...resolutionRow(res, ctx));
      delCand.run(u.ytId);
      (res.candidates || []).forEach((c, i) =>
        insCand.run(u.ytId, i, c.imdbId, c.name ?? null, c.year ?? null,
                    c.runtimeMinutes ?? null, c.score ?? null, c.kind ?? null));
      done++;
    }
    wh.exec('COMMIT');
    console.log(`[transform] resolved ${done.toLocaleString()} (of ${total.toLocaleString()} eligible)`);
    if (stopping || (args.limit && done >= args.limit)) break;
  }
  // Rows the predicate above deliberately skipped still carry the previous
  // file's hash. Stamping them keeps the column meaning what it says -- "the
  // overrides this row was last checked against" -- so the next run compares
  // against a truth rather than a permanent mismatch.
  if (!stopping) {
    wh.prepare('UPDATE fct_resolution SET overrides_hash=? WHERE overrides_hash<>?')
      .run(ctx.overridesHash, ctx.overridesHash);
  }
  return { done, total, stopped: stopping };
}
// #endregion

async function main() {
  const args = parseArgs(process.argv);
  const now = new Date().toISOString();
  const day = now.slice(0, 10);

  const cfg = JSON.parse(await fsp.readFile('config/channels.json', 'utf8'));
  const overridesDoc = await readJson('config/overrides.json', null);
  const rules = loadExclusions(await readJson('config/exclude.json', null));

  const landing = openLanding(args.landing);
  const wh = openCore(args.warehouse);
  const runId = startRun(landing, 'transform');

  const dims = buildDimChannel(wh, landing, cfg, day);
  console.log(`[dim]      channels ${JSON.stringify(dims)}`);

  if (args.fresh) {
    wh.exec('DELETE FROM fct_candidate; DELETE FROM fct_resolution;');
    console.log('[transform] --fresh: cleared resolutions');
  }

  const up = buildFctUpload(wh, landing, cfg, rules, args, runId, now);
  if (up.unmapped.length) {
    console.error(`[error]    ${up.unmapped.length} uploads could not be mapped to a channel ref` +
                  ` (first: ${up.unmapped.slice(0, 3).join(', ')})`);
  }
  const eligible = wh.prepare('SELECT COUNT(*) c FROM fct_upload WHERE drop_reason IS NULL').get().c;
  console.log(`[upload]   ${up.n.toLocaleString()} rows, ${eligible.toLocaleString()} eligible, ` +
              `dropped ${JSON.stringify(up.drops)}`);
  if (up.staleCleared) console.log(`[upload]   cleared ${up.staleCleared} resolutions now excluded`);

  let resolved = { done: 0, total: eligible, stopped: false };
  if (!args.skipResolve) {
    const index = await buildIndex({ cacheDir: args.cache });
    setCoreMeta(wh, 'imdb_dataset', index.dataset);
    resolved = await resolvePending(wh, index, {
      dataset: index.dataset,
      overrides: Object.fromEntries(Object.entries(overridesDoc?.overrides ?? {})
        .filter(([k]) => !k.startsWith('_'))),
      overridesHash: hashObject(overridesDoc?.overrides ?? {}),
      // §5's recent-year exemption, per channel. Not in dim_channel and not in
      // fct_upload on purpose: it is resolver *policy* read from config, the
      // same kind of input as overrides, and putting it in the warehouse would
      // freeze a policy decision into rows that a re-resolve then has to undo.
      currentReleaseChannels: new Set(
        (cfg.channels ?? []).filter(c => c.currentReleases).map(c => c.ref)),
      now, runId,
    }, args);
    // Ratings ride along with the index that is already open. Doing it here
    // rather than in publish is what lets a deploy run without the 1.6 GB
    // index at all.
    try {
      const r = syncRatings(wh, index.db, index.dataset);
      console.log(`[rating]   ${r.rated.toLocaleString()} of ${r.of.toLocaleString()} matched titles have an IMDb rating`);
    } catch (err) {
      // An index built before the ratings pass simply has no table. Not fatal:
      // the catalogue works without the sort, and the next index build adds it.
      console.log(`[rating]   skipped (${String(err.message).slice(0, 60)})`);
    }
    index.close();
  }

  const counts = wh.prepare(`SELECT status, COUNT(*) c FROM fct_resolution GROUP BY status`).all();
  console.log('[core]     ' + counts.map(r => `${['accept','review','reject'][r.status]}=${r.c}`).join(' '));

  finishRun(landing, runId, {
    status: resolved.stopped ? 'interrupted' : 'ok',
    rowsIn: up.n, rowsOut: resolved.done,
  });
  wh.close(); landing.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
