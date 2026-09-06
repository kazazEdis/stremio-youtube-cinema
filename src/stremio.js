#!/usr/bin/env node
/**
 * stremio.js — serve the resolved catalog as a live Stremio addon.
 *
 * Same routes and same JSON as publish.js writes statically; this exists so the
 * addon can be tried without a deploy. For anything permanent prefer the static
 * build, which does not depend on this process staying alive.
 *
 * Usage:
 *   node src/stremio.js --in out/resolved.json --port 7000
 */

import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';

import { buildManifest, toMeta, toStream } from './publish.js';

const PAGE = 100;

function parseArgs(argv) {
  // Serves the published mart, which the warehouse pipeline writes. Same
  // shape as the old out/resolved.json, and it keeps out/ off the serve path.
  const a = { in: 'docs/catalog.json', port: Number(process.env.PORT) || 7000, host: '0.0.0.0' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'port') a.port = Number(argv[++i]);
    else if (k in a) a[k] = argv[++i];
  }
  return a;
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Stremio's web client fetches cross-origin; without this it silently
    // fails to install with no useful error.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'public, max-age=300',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/** Parse Stremio's `key=value&key=value` extra segment. */
function parseExtra(segment) {
  const out = {};
  if (!segment) return out;
  for (const pair of decodeURIComponent(segment).replace(/\.json$/, '').split('&')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

function lanAddresses(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${port}`);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const doc = JSON.parse(await fsp.readFile(args.in, 'utf8'));
  const movies = doc.movies || [];
  if (!movies.length) {
    console.error(`no movies in ${args.in} — run the resolver first`);
    process.exit(1);
  }

  const films = movies.filter(m => (m.stremioType ?? 'movie') === 'movie');
  const episodes = movies.filter(m => m.stremioType === 'series');
  const groups = [...new Set(films.map(m => m.group).filter(Boolean))].sort();
  const seriesGroups = [...new Set(episodes.map(m => m.group).filter(Boolean))].sort();
  const manifest = buildManifest(films, groups, '', seriesGroups);

  // Films are looked up by tconst; episodes by the composite id Stremio sends,
  // which is tconst:season:episode and would miss a tconst-keyed map entirely.
  const byId = new Map([...films.map(m => [m.imdbId, m]),
                        ...episodes.map(m => [m.id, m])]);
  const shows = new Map();
  for (const e of episodes) if (!shows.has(e.imdbId)) shows.set(e.imdbId, e);

  const pool = { movie: films, series: [...shows.values()] };
  const byGroup = {
    movie: new Map(groups.map(g => [`ytc-${slug(g)}`, films.filter(m => m.group === g)])),
    series: new Map(seriesGroups.map(g => [`ytc-${slug(g)}`,
      [...new Map(episodes.filter(m => m.group === g).map(m => [m.imdbId, m])).values()]])),
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*',
                           'Access-Control-Allow-Headers': '*' });
      return res.end();
    }

    if (parts.length === 0) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        `<h1>YouTube Cinema</h1><p>${movies.length} films.</p>` +
        `<p>Install in Stremio with:</p><ul>` +
        lanAddresses(args.port).map(u => `<li><code>${u}/manifest.json</code></li>`).join('') +
        `</ul>`);
    }

    if (parts[0] === 'manifest.json') return send(res, 200, manifest);

    // /catalog/<type>/<id>.json  or  /catalog/<type>/<id>/<extra>.json
    if (parts[0] === 'catalog' && (parts[1] === 'movie' || parts[1] === 'series')) {
      const type = parts[1];
      const id = parts[2].replace(/\.json$/, '');
      const extra = parseExtra(parts[3]);
      let list = id === 'ytc-all' ? pool[type] : (byGroup[type].get(id) || []);
      if (extra.genre) list = list.filter(m => m.group === extra.genre);
      if (extra.search) {
        const q = extra.search.toLowerCase();
        list = list.filter(m => (m.name || '').toLowerCase().includes(q));
      }
      const skip = Number(extra.skip) || 0;
      return send(res, 200, { metas: list.slice(skip, skip + PAGE).map(m => toMeta(m, type)) });
    }

    // /stream/movie/<tconst>.json or /stream/series/<tconst>:<season>:<episode>.json
    if (parts[0] === 'stream' && (parts[1] === 'movie' || parts[1] === 'series')) {
      const m = byId.get(decodeURIComponent(parts[2]).replace(/\.json$/, ''));
      return send(res, 200, { streams: m ? [toStream(m)] : [] });
    }

    send(res, 404, { err: 'not found' });
  });

  server.listen(args.port, args.host, () => {
    console.log(`[serve]  ${films.length} films` +
                (episodes.length ? `, ${episodes.length} episodes across ${shows.size} shows` : '') +
                `, ${groups.length + seriesGroups.length} groups`);
    for (const u of lanAddresses(args.port)) console.log(`[serve]  ${u}/manifest.json`);
    console.log(`[serve]  local: http://127.0.0.1:${args.port}/manifest.json`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
