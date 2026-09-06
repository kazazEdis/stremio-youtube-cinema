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
         quarantinedYtIds, deadYtIds } from './core.js';
import { openLanding, startRun, finishRun } from './landing.js';
import { settleDuplicates, THRESHOLDS } from '../resolve/index.js';
import { loadExclusions, excludedByImdb } from '../resolve/exclude.js';
import { toMeta, toStream, buildManifest, SORTS } from '../publish.js';
import {
  diffCatalogs, summarizeReview, perChannel, findSilentChannels,
} from '../report.js';

const PAGE = 100;
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function parseArgs(argv) {
  // `region` is the *root* build and defaults to FREE — the unrestricted set,
  // which is the only catalogue that is honest for a viewer anywhere. `regions`
  // are the variants published alongside it under region=xx/.
  const a = { warehouse: 'data/warehouse.sqlite', landing: 'data/landing.sqlite',
              out: 'docs', region: process.env.YT_REGION || null,
              regions: (process.env.YT_REGIONS || '').split(',').map(r => r.trim()).filter(Boolean),
              prev: 'docs/catalog.json', seed: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'seed-first-seen') a.seed = argv[++i];
    else if (k === 'regions') a.regions = argv[++i].split(',').map(r => r.trim()).filter(Boolean);
    else if (k === 'region') a.region = (argv[++i] || '').toUpperCase() || null;
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
    // Accepted uploads only. Without this the list filtered on the published id
    // alone and happily offered matches the scorer had *rejected* as too
    // uncertain — 127 films were served a low-score or narrow-margin upload as
    // a playable alternative. A viewer picking the second stream and getting a
    // different film is worse than a film with one stream.
    .filter(r => r.status === 0)
    .filter(r => (r.published_id ?? r.imdb_id) === id && r.ytId !== winner.ytId)
    .map(r => ({ ...toResolutionShape(r), playback: quarantine.has(r.ytId) ? 'age-gated' : undefined }))
    // Unplayable last, then the sharper copy. Between two accepted matches of
    // the same film a viewer wants the better picture, and confidence has
    // already done its job by getting both into the list at all — 12.6% of the
    // catalogue is below 480p and 46.7% is 1080p, so the difference is real.
    .sort((a, b) => (a.playback ? 1 : 0) - (b.playback ? 1 : 0)
                 || (b.maxHeight ?? 0) - (a.maxHeight ?? 0)
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
export const FREE = null;   // the region that is no region

/**
 * `FREE` means "carries no restriction at all", not "playable where I am".
 *
 * That distinction is the whole point of the unrestricted build: a viewer in
 * Bogotá and one in Zagreb must be able to install the same URL and have every
 * stream in it work. An upload allowed only in the US passes `playableIn('US')`
 * and must not pass this — 2,551 of 3,963 films have a copy that qualifies.
 */
export function playableIn(region, blockedCsv, allowedCsv) {
  if (region === FREE) return !blockedCsv && !allowedCsv;
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
    viewCount: r.view_count ?? null,
    rating: r.rating ?? null,
    votes: r.votes ?? null,
    imdbRuntimeMin: r.imdb_runtime ?? null,
    channel: r.channel_name,
    group: r.grp,
    poster: thumbUrl(r.ytId, r.thumb_tier),
    genres: r.genres ?? null,
  };
  if (r.playback) shape.playback = r.playback;
  if (r.max_height) shape.maxHeight = r.max_height;
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
           u.thumb_tier, u.blocked_regions, u.allowed_regions, u.view_count,
           r.status, r.reason, r.imdb_id, r.stremio_type, r.published_id,
           r.season, r.episode, r.match_name, r.imdb_year, r.imdb_runtime,
           r.genres, r.confidence, r.margin, r.candidate_count,
           r.sig_title, r.sig_year, r.sig_runtime, r.sig_corrob, r.is_override, r.tier,
           p.max_height, d.average AS rating, d.votes
    FROM fct_upload u JOIN fct_resolution r ON r.ytId = u.ytId
    LEFT JOIN fct_playback p ON p.ytId = u.ytId
    LEFT JOIN dim_rating d ON d.imdb_id = r.imdb_id
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

  // A confirmed-dead upload is removed before anything else looks at it. Unlike
  // a gated one there is no viewer who can play it, so keeping it would serve a
  // click that always fails, and a film left with no copy at all leaves the
  // catalogue. Three did: The Little Princess, The Brave One and Gulliver's
  // Travels, each reproducibly "This video is not available" while the Data API
  // reported them public and embeddable.
  const dead = deadYtIds(wh);
  const regional = rows.filter(r => !dead.has(r.ytId)
                                 && playableIn(region, r.blocked_regions, r.allowed_regions));
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

/**
 * The orderings offered as Stremio `genre` chips.
 *
 * `genre` is the only filter slot the protocol gives a catalogue, and using it
 * for sort orders is the convention. Group names are still kept out of it —
 * "Archive/Soviet" contains a slash, and Stremio hands the value back as a path
 * segment, which any server reads as a directory. "Popular" and "Year" do not
 * have that problem.
 *
 * Popularity is the YouTube view count of the upload we serve, which is the
 * only popularity signal in the pipeline — IMDb's datasets carry no ratings.
 * It measures the *upload*, not the film, so a famous picture with one obscure
 * print sits below a minor one that went viral. That is worth knowing but it is
 * still the honest answer to "what are people watching here".
 */
export const ORDERINGS = {
  Popular: (a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0)
                  || (a.name || '').localeCompare(b.name || ''),
  Year:    (a, b) => (b.year ?? 0) - (a.year ?? 0)
                  || (a.name || '').localeCompare(b.name || ''),
  Rating:  (a, b) => (b.wr ?? -1) - (a.wr ?? -1)
                  || (a.name || '').localeCompare(b.name || ''),
};

/**
 * A rating you can sort on, rather than the raw average.
 *
 * Raw averages put a 9.6 from eleven votes above Nosferatu, and this catalogue
 * is full of obscure prints with a handful of votes — the shape that breaks a
 * naive sort. The standard weighting pulls a thinly-voted title toward the
 * catalogue mean and leaves a well-voted one where it is:
 *
 *     wr = v/(v+m)·R + m/(v+m)·C
 *
 * C is the mean of the rated titles here, not of IMDb: this is a public-domain
 * and licensed-upload catalogue and its middle sits lower than the site's. m is
 * the vote count at which a title is trusted on its own — 500 rather than
 * IMDb's 25,000, because almost nothing here would clear that.
 *
 * Unrated titles sort last with `wr` left undefined rather than 0, which would
 * put them above genuinely bad films.
 */
export function weightRatings(metas, m = 500) {
  const rated = metas.filter(x => x.rating != null && x.votes != null);
  if (!rated.length) return metas;
  const C = rated.reduce((t, x) => t + x.rating, 0) / rated.length;
  for (const x of metas) {
    if (x.rating == null || x.votes == null) continue;
    const v = x.votes;
    x.wr = (v / (v + m)) * x.rating + (m / (v + m)) * C;
  }
  return metas;
}

/**
 * One page set per ordering, plus the default.
 *
 * Stremio asks for `/catalog/{type}/{id}/{extraArgs}.json` where extraArgs is a
 * stringified query object — `genre=Year&skip=100`. The key order in that
 * string is the client's to choose, so both orders are written: one duplicated
 * small file beats a catalogue that stops dead at a hundred entries because we
 * guessed wrong about which came first.
 */
async function writeCatalog(outDir, type, id, rows, toRow, sorts) {
  const dir = path.join(outDir, 'catalog', type);
  let pages = 0;

  // Sort the rich rows and reduce to protocol shape only on the way out. The
  // meta Stremio receives carries no view count, rating or numeric year — and
  // padding every catalogue page with fields the client ignores, purely so we
  // can sort what we already hold, would be the wrong trade.
  const writeSet = async (prefix, ordered) => {
    const metas = ordered.map(toRow);
    const head = prefix ? path.join(dir, id, `${prefix}.json`) : path.join(dir, `${id}.json`);
    await writeJson(head, { metas: metas.slice(0, PAGE) });
    pages++;
    for (let skip = PAGE; skip < metas.length; skip += PAGE) {
      const body = { metas: metas.slice(skip, skip + PAGE) };
      if (prefix) {
        await writeJson(path.join(dir, id, `${prefix}&skip=${skip}.json`), body);
        await writeJson(path.join(dir, id, `skip=${skip}&${prefix}.json`), body);
      } else {
        await writeJson(path.join(dir, id, `skip=${skip}.json`), body);
      }
      pages++;
    }
  };

  weightRatings(rows);
  await writeSet('', rows);
  for (const name of sorts) {
    await writeSet(`genre=${name}`, [...rows].sort(ORDERINGS[name]));
  }
  return pages;
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

const REGION_NAMES = {
  US: 'United States', CA: 'Canada', GB: 'United Kingdom', AU: 'Australia',
  IE: 'Ireland', NZ: 'New Zealand', DE: 'Germany', FR: 'France', IT: 'Italy',
  ES: 'Spain', NL: 'Netherlands', PL: 'Poland', HR: 'Croatia', RS: 'Serbia',
  BR: 'Brazil', IN: 'India', JP: 'Japan', MX: 'Mexico', SE: 'Sweden', TR: 'Türkiye',
};

/**
 * The configure page, generated from what was actually built.
 *
 * Hand-writing it would let the list drift from the trees on disk, and a region
 * offered here that does not exist is a 404 the viewer reads as a broken addon.
 */
async function writeConfigure(outDir, free, regions) {
  const rows = regions.map(([code, films, eps]) => `
      <label class="r">
        <input type="checkbox" value="${code.toLowerCase()}">
        <span class="n">${REGION_NAMES[code] ?? code}</span>
        <span class="c">${films.toLocaleString()} films${eps ? ` \u00b7 ${eps} episodes` : ''}</span>
      </label>`).join('');

  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube Cinema</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --dim:#666; --line:#ddd; --acc:#0b6bcb; --bg:#fff; --ok:#1a7f37; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --dim:#9a9a9a; --line:#333; --acc:#5aa9f0; --bg:#141414; --ok:#3fb950; }
  }
  body { margin:0 auto; padding:2rem 1.25rem 5rem; max-width:44rem; background:var(--bg); color:var(--fg);
         font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  h1 { font-size:1.4rem; margin:0 0 .3rem; } h2 { font-size:1rem; margin:2rem 0 .4rem; }
  p { color:var(--dim); margin:.35rem 0 1rem; }
  .r { display:flex; align-items:baseline; gap:.6rem; padding:.5rem .7rem; border:1px solid var(--line);
       border-radius:7px; margin:.3rem 0; cursor:pointer; }
  .r:hover { border-color:var(--acc); }
  .r input { margin:0; }
  .n { font-weight:600; } .c { color:var(--dim); font-size:.85em; margin-left:auto; }
  .base { border-color:var(--acc); }
  #out { margin-top:1.25rem; }
  .lnk { display:flex; align-items:center; gap:.5rem; margin:.35rem 0; }
  .lnk code { flex:1; overflow-x:auto; white-space:nowrap; background:rgba(128,128,128,.14);
              padding:.4rem .55rem; border-radius:6px; font-size:12px; }
  button { padding:.45rem .8rem; font:inherit; border:0; border-radius:6px; background:var(--acc);
           color:#fff; cursor:pointer; white-space:nowrap; }
  button.ghost { background:transparent; color:var(--acc); border:1px solid var(--acc); }
  .none { color:var(--dim); font-style:italic; }
</style>

<h1>YouTube Cinema</h1>
<p>Feature films and TV legally on YouTube, resolved to IMDb ids so Stremio brings its own
   artwork, cast and subtitles. Tick every country you watch from — you can pick more than one.</p>

<label class="r base">
  <input type="checkbox" id="freeOnly">
  <span class="n">Anywhere only</span>
  <span class="c">${free.films.toLocaleString()} films${free.eps ? ` \u00b7 ${free.eps} episodes` : ''}</span>
</label>
<p style="margin:.2rem 0 1.2rem;font-size:.88em">Just the uploads with no country restriction at all.
   Every country below already includes these, so tick this only if you want nothing else.</p>
${rows}

<div id="out"></div>

<h2>Picking more than one</h2>
<p style="font-size:.88em">Each country is its own addon and Stremio merges them, so installing two gives
   you the films either one can play, with every copy of a film offered together. Install them one after
   another — they sit side by side rather than replacing each other.</p>

<h2>Why the lists differ</h2>
<p style="font-size:.88em">A rights holder can allow an upload in some countries and not others.
   Choosing your country adds the films it lets you see and never adds one you cannot play. Where a film
   has several copies on YouTube all of them are offered, sharpest first, with anything needing a
   YouTube sign-in last.</p>

<script>
  const base = location.origin + location.pathname
    .replace(/\\/configure\\/?$/, '')
    .replace(/\\/region=[a-z]{2}$/i, '')
    .replace(/\\/$/, '');
  const out = document.getElementById('out');
  const freeOnly = document.getElementById('freeOnly');
  const boxes = [...document.querySelectorAll('.r input[type=checkbox]')].filter(b => b !== freeOnly);

  const urlFor = v => base + (v ? '/region=' + v : '') + '/manifest.json';

  function render() {
    const picked = boxes.filter(b => b.checked).map(b => b.value);
    if (freeOnly.checked) { boxes.forEach(b => { b.checked = false; }); }
    const list = freeOnly.checked ? [''] : picked;
    out.innerHTML = '';
    if (!list.length) {
      out.innerHTML = '<p class="none">Tick a country above, or “Anywhere only”.</p>';
      return;
    }
    for (const v of list) {
      const u = urlFor(v);
      const row = document.createElement('div');
      row.className = 'lnk';
      const c = document.createElement('code'); c.textContent = u;
      const install = document.createElement('button');
      install.textContent = 'Install';
      install.onclick = () => { location.href = u.replace(/^https?:/, 'stremio:'); };
      const copy = document.createElement('button');
      copy.className = 'ghost'; copy.textContent = 'Copy';
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(u); copy.textContent = 'Copied'; setTimeout(() => copy.textContent = 'Copy', 1200); }
        catch { const t = document.createElement('textarea'); t.value = u; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
      };
      row.append(c, install, copy);
      out.append(row);
    }
  }
  freeOnly.addEventListener('change', () => { if (freeOnly.checked) boxes.forEach(b => b.checked = false); render(); });
  boxes.forEach(b => b.addEventListener('change', () => { if (b.checked) freeOnly.checked = false; render(); }));
  render();
</script>
`;
  await fsp.mkdir(path.join(outDir, 'configure'), { recursive: true });
  await fsp.writeFile(path.join(outDir, 'configure', 'index.html'), html);
  // `/` was a 404. Torrentio serves its wizard at the root and so do we.
  await fsp.writeFile(path.join(outDir, 'index.html'), html);
}

/**
 * A redirect, not a copy.
 *
 * `behaviorHints.configurable` makes Stremio link the gear to
 * `<manifest base>/configure`, which for a regional install is
 * `/region=hr/configure` — and that 404'd for anyone who tapped it, the one
 * button the whole scheme depends on. But there is only one wizard: it is
 * global, it lists every region, and twenty copies of it would be twenty things
 * to drift. So each tree points at the canonical page instead of holding one.
 */
async function writeConfigureRedirect(outDir) {
  // The two files sit at different depths and cannot share one relative target:
  // from region=hr/configure/ the wizard is two levels up, from region=hr/ it is
  // one. Getting that wrong points the page at itself, which is a redirect loop
  // rather than a 404 and reads to a viewer as the app hanging.
  const page = up => `<!doctype html>
<meta charset="utf-8">
<title>YouTube Cinema \u2014 configure</title>
<meta http-equiv="refresh" content="0; url=${up}configure/">
<link rel="canonical" href="${up}configure/">
<p>Taking you to <a href="${up}configure/">the configuration page</a>\u2026</p>
`;
  await fsp.mkdir(path.join(outDir, 'configure'), { recursive: true });
  await fsp.writeFile(path.join(outDir, 'configure', 'index.html'), page('../../'));
  await fsp.writeFile(path.join(outDir, 'index.html'), page('../'));
}

/**
 * One complete addon tree: manifest, catalogues, stream files.
 *
 * Stremio resolves every path against the manifest's own base and never falls
 * back to a parent, so a regional variant cannot share the root's files — each
 * one has to be whole. That is the cost of the Torrentio-style config segment
 * on a static host, and it is why the trees are generated rather than linked.
 */
export async function writeTree(outDir, { movies, regional, quarantine, region }) {
  const films = movies.filter(m => (m.stremioType ?? 'movie') === 'movie');
  const episodes = movies.filter(m => m.stremioType === 'series');
  const groups = [...new Set(films.map(m => m.group).filter(Boolean))].sort();
  const seriesGroups = [...new Set(episodes.map(m => m.group).filter(Boolean))].sort();

  // Only offer Rating where there is something to rank on. IMDb rates most of
  // what we match, but an index built before the ratings pass has none, and a
  // chip that silently sorts by nothing reads as a broken addon.
  const sorts = SORTS.filter(n => n !== 'Rating' || movies.some(m => m.rating != null));

  await writeJson(path.join(outDir, 'manifest.json'),
                  buildManifest(films, groups, '', seriesGroups, region, sorts));

  let pages = await writeCatalog(outDir, 'movie', 'ytc-all', films, m => toMeta(m), sorts);
  for (const g of groups) {
    pages += await writeCatalog(outDir, 'movie', `ytc-${slug(g)}`,
                                films.filter(m => m.group === g), m => toMeta(m), sorts);
  }

  // Series: the catalogue lists shows, the streams are per episode.
  const shows = showRows(episodes);
  if (shows.length) {
    pages += await writeCatalog(outDir, 'series', 'ytc-all',
                                shows, m => toMeta(m, 'series'), sorts);
    for (const g of seriesGroups) {
      pages += await writeCatalog(outDir, 'series', `ytc-${slug(g)}`,
                                  showRows(episodes.filter(m => m.group === g)),
                                  m => toMeta(m, 'series'), sorts);
    }
  }

  for (const m of films) {
    await writeJson(path.join(outDir, 'stream', 'movie', `${m.imdbId}.json`),
                    { streams: streamsFor(m, regional, quarantine) });
  }
  // One file per episode, named with the composite id Stremio requests.
  for (const m of episodes) {
    await writeJson(path.join(outDir, 'stream', 'series', `${m.id}.json`),
                    { streams: streamsFor(m, regional, quarantine) });
  }

  const orphans =
    await prune(outDir, 'movie', new Set(films.map(m => `${m.imdbId}.json`))) +
    await prune(outDir, 'series', new Set(episodes.map(m => `${m.id}.json`)));
  if (orphans) console.log(`[publish]  pruned ${orphans} stream files no longer in ${outDir}`);

  // Which episode ids this tree actually publishes, keyed by show. Stremio does
  // not need it — it learns the episode list from Cinemeta — but nothing else
  // can tell from outside whether a listed show has any episode behind it, and
  // the full catalog.json dump only exists in the root. Ten kilobytes per tree
  // makes every variant checkable remotely instead of only the one.
  const byShow = {};
  for (const e of episodes) (byShow[e.imdbId] ??= []).push(e.id);
  await writeJson(path.join(outDir, 'episodes.json'), byShow);

  await verifyMarts(outDir, movies);
  return { films, episodes, groups, seriesGroups, shows, pages };
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
  const runId = startRun(landing, 'publish', `region=${args.region ?? 'free'}`);
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

  const { films, episodes, shows, groups, seriesGroups, pages } =
    await writeTree(args.out, { movies, regional, quarantine, region: args.region });

  // The regional variants, in Torrentio's shape: a `key=value` segment between
  // the host and manifest.json. Torrentio parses that per request because it is
  // a live server; on a static host each value has to be a real directory, so
  // the trees are generated. That is affordable here only because the config is
  // one key with a handful of values rather than providers x qualities x keys.
  const regionCounts = [];
  for (const region of args.regions) {
    const dir = path.join(args.out, `region=${region.toLowerCase()}`);
    const built = loadCore(wh, { region, rules });
    const t = await writeTree(dir, {
      movies: built.movies, regional: built.regional,
      quarantine: built.quarantine, region,
    });
    regionCounts.push([region, t.films.length, t.episodes.length]);
  }
  if (regionCounts.length) {
    console.log(`[regions]  ${regionCounts.map(([r, f]) => `${r} ${f.toLocaleString()}`).join('  ')}`);
  }
  await writeConfigure(args.out, { films: films.length, eps: episodes.length }, regionCounts);
  for (const region of args.regions) {
    await writeConfigureRedirect(path.join(args.out, `region=${region.toLowerCase()}`));
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
    run: { region: args.region ?? 'free', regions: args.regions,
           imdbDataset: getCoreMeta(wh, 'imdb_dataset') },
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
  console.log(`[publish]  ${args.region ?? 'unrestricted'}: ${scanned.length.toLocaleString()} of ` +
              `${wh.prepare('SELECT COUNT(*) c FROM fct_upload WHERE drop_reason IS NULL').get().c.toLocaleString()}` +
              ` eligible uploads playable, ${review.length.toLocaleString()} in review`);
  wh.close(); landing.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
