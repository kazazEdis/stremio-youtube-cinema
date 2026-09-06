#!/usr/bin/env node
/**
 * publish.js — render the resolved catalog into a static Stremio addon.
 *
 * Everything here is a plain JSON file on disk, because the addon protocol is
 * just HTTP GETs of fixed paths. That lets GitHub Pages host the whole addon
 * with no server, which matters: the alternative is keeping a process alive,
 * and the machine this repo is developed on cannot keep one alive for twenty
 * minutes.
 *
 * Usage:
 *   node src/publish.js --in out/resolved.json --out docs
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

const PAGE = 100;   // Stremio pages catalogs in 100s via skip=

// #region ---------------------------------------------------------- args
function parseArgs(argv) {
  const a = {
    in: 'out/resolved.json',
    out: 'docs',
    report: 'out/report.json',
    baseUrl: process.env.ADDON_BASE_URL || '',
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k in a) a[k] = argv[++i];
  }
  return a;
}

async function readJson(p, fallback = null) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data));
}
// #endregion

// #region ---------------------------------------------------------- shapes
/**
 * A catalog row, deliberately minimal.
 *
 * This addon is a *stream source*, not a metadata provider. The manifest
 * declares only `catalog` and `stream`, so Stremio never asks us for `meta` —
 * the detail page, synopsis, cast, ratings and genres all come from Cinemeta
 * via the tconst. Emitting a synopsis or genres here would duplicate that at
 * best and contradict it at worst.
 *
 * What stays is only what Stremio needs to *draw the catalog row itself*:
 * name, poster and year. Those are not enriched from Cinemeta at catalog time,
 * so omitting them leaves blank tiles.
 */
export function toMeta(m, type = 'movie') {
  return {
    // A series row points at the show, not the episode: Stremio renders the
    // season and episode list itself from the series tconst via Cinemeta.
    id: m.imdbId,
    type,
    name: m.name,
    poster: m.poster || undefined,
    posterShape: 'poster',
    releaseInfo: m.year ? String(m.year) : undefined,
  };
}

/**
 * A stream. `ytId` is the important field — Stremio has a native YouTube
 * player, so handing it the video id plays in-app rather than bouncing the
 * user out to a browser. externalUrl is the fallback for clients that lack it.
 */
/** How a viewer would name the picture, or nothing if it was never probed. */
export const quality = h =>
  !h ? null : h >= 2000 ? '4K' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : `${h}p`;

export function toStream(m) {
  // An age-gated upload we could not replace is still served, because a viewer
  // signed in on YouTube can play it and no entry at all helps nobody. But
  // `notWebReady: false` would be a lie about it: the embedded player is
  // exactly where age-gating bites, so the honest hint sends Stremio to the
  // external URL instead of failing silently inside the app.
  const gated = m.playback === 'age-gated';
  return {
    ytId: m.ytId,
    name: 'YouTube Cinema',
    // Resolution first among the optional parts: with 567 films offering more
    // than one copy, it is the thing a viewer actually chooses on, and the API
    // never knew it — this comes from probing the video itself.
    title: [m.channel, quality(m.maxHeight),
            m.imdbRuntimeMin ? `${m.imdbRuntimeMin} min` : null,
            m.confidence < 100 ? `match ${m.confidence}` : 'manual',
            gated ? 'sign-in required' : null]
           .filter(Boolean).join(' • '),
    externalUrl: `https://www.youtube.com/watch?v=${m.ytId}`,
    behaviorHints: { notWebReady: gated },
  };
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function buildManifest(movies, groups, baseUrl, seriesGroups = [], region = null) {
  return {
    // A distinct id per region, because Stremio keys an installed addon on it:
    // share one and installing the second replaces the first, which is exactly
    // what has to work for someone who wants two countries at once.
    id: region ? `org.stremio.youtube-cinema.${region.toLowerCase()}`
               : 'org.stremio.youtube-cinema',
    version: '0.1.0',
    // The name never carries the region. Several of these can be installed
    // together and they are all the same addon; what differs is the catalogue,
    // so that is where the country belongs.
    name: 'YouTube Cinema',
    description:
      `${movies.length} feature films legally on YouTube — licensed uploads and ` +
      `public domain prints, resolved to IMDb ids so subtitles and metadata work. ` +
      (region
        ? `Everything playable in ${region}, including uploads the rights holder ` +
          `restricted to it.`
        : `Only uploads with no region restriction at all, so every stream works ` +
          `wherever you are. Pick your country at /configure for the rest.`),
    logo: 'https://www.youtube.com/s/desktop/dcb2a4a1/img/favicon_144x144.png',
    resources: ['catalog', 'stream'],
    types: ['movie', 'series'],
    // Only ever asked about real IMDb ids; without this Stremio would query us
    // for every id in every other addon's catalog too.
    idPrefixes: ['tt'],
    catalogs: [
      {
        type: 'movie',
        id: 'ytc-all',
        name: region ? `YouTube Cinema — ${region}` : 'YouTube Cinema',
        // No `genre` extra on purpose. Group names contain a slash
        // ("Archive/Soviet"), and Stremio would request the literal value back
        // as a path segment — which any web server decodes into a directory
        // separator, 404ing on a static host. The per-group catalogs below do
        // the same job with slug filenames, and read better as their own rows.
        extra: [{ name: 'skip' }],
      },
      ...groups.map(g => ({
        type: 'movie',
        id: `ytc-${slug(g)}`,
        name: region ? `YouTube Cinema ${region} — ${g}` : `YouTube Cinema — ${g}`,
        extra: [{ name: 'skip' }],
      })),
      // Series catalogues reuse the same ids under a different type; Stremio
      // keys a catalogue on (type, id), and the mart paths differ by type too.
      ...(seriesGroups.length ? [{
        type: 'series',
        id: 'ytc-all',
        name: region ? `YouTube Cinema ${region} — TV` : 'YouTube Cinema — TV',
        extra: [{ name: 'skip' }],
      }] : []),
      ...seriesGroups.map(g => ({
        type: 'series',
        id: `ytc-${slug(g)}`,
        name: region ? `YouTube Cinema ${region} TV — ${g}` : `YouTube Cinema TV — ${g}`,
        extra: [{ name: 'skip' }],
      })),
    ],
    // Torrentio's convention: the addon advertises that it has a configuration
    // page, and the chosen value rides in a path segment before manifest.json.
    // configurationRequired stays false because the unrestricted root is a
    // complete, correct addon on its own.
    behaviorHints: { configurable: true, configurationRequired: false },
    ...(baseUrl ? { contactEmail: undefined } : {}),
  };
}
// #endregion

// #region ---------------------------------------------------------- main
/** Write a catalog plus every skip= page Stremio might ask for. */
async function writeCatalog(outDir, id, metas) {
  const body = { metas: metas.slice(0, PAGE) };
  await writeJson(path.join(outDir, 'catalog', 'movie', `${id}.json`), body);

  for (let skip = PAGE; skip < metas.length; skip += PAGE) {
    await writeJson(
      path.join(outDir, 'catalog', 'movie', id, `skip=${skip}.json`),
      { metas: metas.slice(skip, skip + PAGE) });
  }
  return Math.ceil(metas.length / PAGE);
}

async function main() {
  const args = parseArgs(process.argv);
  const doc = await readJson(args.in);
  if (!doc) {
    console.error(`missing ${args.in} — run the resolver first`);
    process.exit(1);
  }
  const movies = doc.movies || [];
  if (!movies.length) {
    console.error('resolved catalog is empty — refusing to publish an empty addon');
    process.exit(1);
  }

  const groups = [...new Set(movies.map(m => m.group).filter(Boolean))].sort();
  const outDir = args.out;

  await writeJson(path.join(outDir, 'manifest.json'),
                  buildManifest(movies, groups, args.baseUrl));

  const all = movies.map(toMeta);
  let pages = await writeCatalog(outDir, 'ytc-all', all);

  for (const g of groups) {
    const metas = movies.filter(m => m.group === g).map(toMeta);
    pages += await writeCatalog(outDir, `ytc-${slug(g)}`, metas);
  }

  for (const m of movies) {
    await writeJson(path.join(outDir, 'stream', 'movie', `${m.imdbId}.json`),
                    { streams: [toStream(m)] });
  }

  // Internal state, not part of the addon protocol: the next run diffs against
  // these two to decide whether the catalog shrank suspiciously.
  await writeJson(path.join(outDir, 'catalog.json'),
                  { generated: doc.generated, count: movies.length, movies });
  const report = await readJson(args.report);
  if (report) await writeJson(path.join(outDir, 'report.json'), report);

  console.log(`[publish] ${movies.length} movies, ${groups.length} groups, ` +
              `${pages} catalog pages -> ${outDir}/`);
  console.log(`[publish] install from <base-url>/manifest.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
// #endregion
