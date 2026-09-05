#!/usr/bin/env bash
# bootstrap.sh — lay down the settled files for stremio-youtube-cinema.
# Run from the repo root. Safe to re-run; it overwrites what it owns.
set -euo pipefail

mkdir -p config src/resolve docs .github/workflows

# ============================================================ .gitignore
cat > .gitignore <<'EOF_GITIGNORE'
node_modules/

# build output — regenerated every run, only docs/ is committed
out/

# IMDb datasets and derived index. ~2GB of third-party data under a
# non-commercial licence. Never commit.
.cache/
*.tsv
*.tsv.gz
*.sqlite

.env
.DS_Store
EOF_GITIGNORE

# ============================================================ package.json
cat > package.json <<'EOF_PKG'
{
  "name": "stremio-youtube-cinema",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Stremio addon surfacing feature films from licensed and public-domain YouTube channels, resolved to IMDb ids.",
  "engines": { "node": ">=18" },
  "scripts": {
    "index": "node src/indexer.js --eu-only --region HR --out out/raw.json",
    "resolve": "node src/resolve/run.js --in out/raw.json --cache .cache",
    "report": "node src/report.js",
    "publish": "node src/publish.js --in out/resolved.json --out docs",
    "serve": "node src/stremio.js",
    "build": "npm run index && npm run resolve && npm run report && npm run publish"
  }
}
EOF_PKG

# ============================================================ channels.json
cat > config/channels.json <<'EOF_CHANNELS'
{
  "_comment": "Whitelist of channels uploading full features under licence or public domain. 'ref' is an @handle or a UC... id. 'eu' flags general playability outside the US.",
  "channels": [
    { "ref": "@themidnightscreening",  "group": "Licensed",       "eu": true  },
    { "ref": "UCGBzBkV-MinlBvHBzZawfLQ", "name": "Movie Central", "group": "Licensed", "eu": true },
    { "ref": "@FilmRise",              "group": "Licensed",       "eu": true  },
    { "ref": "@ShoutStudios",          "group": "Licensed",       "eu": true  },
    { "ref": "@ScreamFactoryTV",       "group": "Horror",         "eu": true  },
    { "ref": "@Popcornflix",           "group": "Licensed",       "eu": false },
    { "ref": "@FreeMoviesByCONtv",     "group": "Licensed",       "eu": false },
    { "ref": "@FlixForFree",           "group": "Horror",         "eu": false },
    { "ref": "@gem-filmlibrary",       "group": "Licensed",       "eu": true  },

    { "ref": "@PizzaFlix",             "group": "PublicDomain",   "eu": true  },
    { "ref": "@TimelessClassicMovies", "group": "PublicDomain",   "eu": true  },
    { "ref": "@CultCinemaClassics",    "group": "PublicDomain",   "eu": true  },
    { "ref": "@publicdomainmovies379", "group": "PublicDomain",   "eu": true  },
    { "ref": "@TheBestFilmArchives",   "group": "PublicDomain",   "eu": true  },

    { "ref": "@Mosfilm_eng",           "group": "Archive/Soviet", "eu": true  },
    { "ref": "@KoreanClassicFilm",     "group": "Archive/Korea",  "eu": true  },
    { "ref": "@chnclassic",            "group": "Archive/China",  "eu": true  },
    { "ref": "@CinemaMeiAh",           "group": "Archive/HK",     "eu": true  },
    { "ref": "UCUpbgPbDccjoB9PxI-nI7oA", "name": "Wu Tang Collection", "group": "MartialArts", "eu": true },

    { "ref": "@GrjngoWesternMovies",   "group": "Western",        "eu": true  },
    { "ref": "@GoldminesTelefilms",    "group": "Indian",         "eu": true  },
    { "ref": "@shemaroomovies",        "group": "Indian",         "eu": true  },
    { "ref": "@rajshri",               "group": "Indian",         "eu": true  },
    { "ref": "@PenMultiplex",          "group": "Indian",         "eu": true  },
    { "ref": "@CineMoChannel",         "group": "Filipino",       "eu": true  },
    { "ref": "@alefilmy",              "group": "Polish",         "eu": true  },
    { "ref": "@airbudtv",              "group": "Family",         "eu": false }
  ]
}
EOF_CHANNELS

# ============================================================ indexer.js
cat > src/indexer.js <<'EOF_INDEXER'
#!/usr/bin/env node
/**
 * indexer.js — build a normalized catalog of feature-length uploads from a
 * channel whitelist. Output feeds the IMDb resolver.
 *
 * Usage:
 *   YT_API_KEY=xxx node src/indexer.js --eu-only --region HR --out out/raw.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const API = 'https://www.googleapis.com/youtube/v3';
const KEY = process.env.YT_API_KEY;

// #region ---------------------------------------------------------- args
function parseArgs(argv) {
  const a = {
    minMinutes: 60,
    maxMinutes: 300,
    region: process.env.YT_REGION || 'HR',
    euOnly: false,
    perChannel: 500,
    out: 'out/raw.json',
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--min-minutes') a.minMinutes = Number(argv[++i]);
    else if (k === '--max-minutes') a.maxMinutes = Number(argv[++i]);
    else if (k === '--region') a.region = argv[++i].toUpperCase();
    else if (k === '--eu-only') a.euOnly = true;
    else if (k === '--per-channel') a.perChannel = Number(argv[++i]);
    else if (k === '--out') a.out = argv[++i];
  }
  return a;
}
// #endregion

// #region ---------------------------------------------------------- http
async function api(endpoint, params) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', KEY);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${endpoint} ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}
// #endregion

// #region ---------------------------------------------------------- helpers
/** ISO-8601 PT#H#M#S -> seconds. Returns 0 for unparseable / live. */
export function durationToSeconds(iso) {
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  const [, d, h, mi, s] = m.map(v => (v ? Number(v) : 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

/** True if playable in `region` per YouTube's declared restrictions. */
export function playableInRegion(video, region) {
  const rr = video.contentDetails?.regionRestriction;
  if (!rr) return true;
  if (Array.isArray(rr.blocked)) return !rr.blocked.includes(region);
  if (Array.isArray(rr.allowed)) return rr.allowed.includes(region);
  return true;
}

function bestThumb(snippet) {
  const t = snippet?.thumbnails || {};
  return (t.maxres || t.standard || t.high || t.medium || t.default || {}).url || null;
}

/**
 * Strip channel marketing from titles so the resolver has something to match.
 * "FULL MOVIE | The Sea Wolf (1941) | Free Drama 4K" -> "The Sea Wolf (1941)"
 */
export function cleanTitle(raw) {
  const TAIL = /\b(full|free|hd|4k|1080p|720p|movie|film|subtitles?|subtitled|remastered|exclusive|premiere|drama|action|horror|thriller|comedy|western|classic)\b/i;
  const segments = raw.split('|').map(s => s.trim()).filter(Boolean);
  let t = segments.length > 1
    ? (segments.find(s => !TAIL.test(s)) ?? segments[0])
    : raw;

  t = t.replace(/\b(full|free)\s+(movie|film)\b/gi, ' ');
  t = t.replace(/\b(4k|hd|1080p|720p|remastered|english\s+subtitles?|subtitled|exclusive|premiere)\b/gi, ' ');
  t = t.replace(/[\[\(]\s*[\]\)]/g, ' ');
  t = t.replace(/\s{2,}/g, ' ').trim();
  t = t.replace(/^[-–—:,\s]+|[-–—:,\s]+$/g, '');
  return t || raw.trim();
}

export function extractYear(raw) {
  const m = /\b(19[0-9]{2}|20[0-2][0-9])\b/.exec(raw);
  return m ? Number(m[1]) : null;
}

const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
// #endregion

// #region ---------------------------------------------------------- resolve
async function resolveChannel(ref) {
  const params = { part: 'snippet,contentDetails' };
  if (ref.startsWith('UC')) params.id = ref;
  else params.forHandle = ref.startsWith('@') ? ref : `@${ref}`;

  const data = await api('channels', params);
  const c = data.items?.[0];
  if (!c) throw new Error(`could not resolve ${ref}`);
  return {
    id: c.id,
    title: c.snippet.title,
    uploadsPlaylist: c.contentDetails.relatedPlaylists.uploads,
  };
}
// #endregion

// #region ---------------------------------------------------------- fetch
async function listUploadIds(playlistId, limit) {
  const ids = [];
  let pageToken;
  do {
    const page = await api('playlistItems', {
      part: 'contentDetails',
      playlistId,
      maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const it of page.items || []) ids.push(it.contentDetails.videoId);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < limit);
  return ids.slice(0, limit);
}

async function hydrate(ids) {
  const out = [];
  for (const batch of chunk(ids, 50)) {
    const data = await api('videos', {
      part: 'snippet,contentDetails,status,statistics',
      id: batch.join(','),
    });
    out.push(...(data.items || []));
  }
  return out;
}
// #endregion

// #region ---------------------------------------------------------- pipeline
async function indexChannel(entry, args) {
  const ch = await resolveChannel(entry.ref);
  const ids = await listUploadIds(ch.uploadsPlaylist, args.perChannel);
  const videos = await hydrate(ids);

  const kept = [];
  const stats = { seen: videos.length, tooShort: 0, notEmbeddable: 0, geoBlocked: 0 };

  for (const v of videos) {
    const secs = durationToSeconds(v.contentDetails?.duration);
    if (secs < args.minMinutes * 60 || secs > args.maxMinutes * 60) { stats.tooShort++; continue; }
    if (v.status?.embeddable === false) { stats.notEmbeddable++; continue; }
    if (!playableInRegion(v, args.region)) { stats.geoBlocked++; continue; }

    kept.push({
      ytId: v.id,
      name: cleanTitle(v.snippet.title),
      rawTitle: v.snippet.title,
      year: extractYear(v.snippet.title),
      runtimeMin: Math.round(secs / 60),
      poster: bestThumb(v.snippet),
      description: (v.snippet.description || '').slice(0, 900),
      channel: ch.title,
      channelId: ch.id,
      group: entry.group,
      licensedContent: v.contentDetails?.licensedContent ?? null,
      published: v.snippet.publishedAt,
      views: Number(v.statistics?.viewCount || 0),
    });
  }
  return { channel: ch, kept, stats };
}

async function main() {
  if (!KEY) {
    console.error('YT_API_KEY is not set. console.cloud.google.com -> YouTube Data API v3.');
    process.exit(1);
  }
  const args = parseArgs(process.argv);
  const cfg = JSON.parse(await fs.readFile('config/channels.json', 'utf8'));
  const targets = args.euOnly ? cfg.channels.filter(c => c.eu) : cfg.channels;

  const all = [];
  for (const entry of targets) {
    try {
      const { channel, kept, stats } = await indexChannel(entry, args);
      all.push(...kept);
      console.log(
        `[ok]   ${channel.title.padEnd(28)} ${String(kept.length).padStart(4)} features ` +
        `(scanned ${stats.seen}, geo-dropped ${stats.geoBlocked})`
      );
    } catch (err) {
      console.error(`[fail] ${entry.ref.padEnd(28)} ${err.message}`);
    }
  }

  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify({
    generated: new Date().toISOString(),
    region: args.region,
    count: all.length,
    movies: all,
  }, null, 2));

  console.log(`\n${all.length} feature-length uploads -> ${args.out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
// #endregion
EOF_INDEXER

# ============================================================ report.js
cat > src/report.js <<'EOF_REPORT'
#!/usr/bin/env node
/**
 * report.js — diff this run against the last published catalog.
 * Runs after resolve, before the sanity check and commit.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// #region ---------------------------------------------------------- args
function parseArgs(argv) {
  const a = {
    current: 'out/resolved.json',
    previous: 'docs/report.json',
    catalog: 'docs/catalog.json',
    review: 'out/needs-review.json',
    raw: 'out/raw.json',
    out: 'out/report.json',
    startedAt: process.env.RUN_STARTED_AT || null,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k in a) a[k] = argv[++i];
  }
  return a;
}

async function readJson(p, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}
// #endregion

// #region ---------------------------------------------------------- diff
/**
 * Diff on imdbId — the identity users and other addons see. A film whose
 * ytId changed is not added+removed; it is the same entry with a new source.
 */
export function diffCatalogs(previous, current) {
  const prev = new Map((previous || []).map(m => [m.imdbId, m]));
  const curr = new Map(current.map(m => [m.imdbId, m]));

  const added = [], removed = [], resourceChanged = [];
  let unchanged = 0;

  for (const [id, m] of curr) {
    const before = prev.get(id);
    if (!before) added.push(m);
    else if (before.ytId !== m.ytId) resourceChanged.push({ ...m, previousYtId: before.ytId });
    else unchanged++;
  }
  for (const [id, m] of prev) {
    if (!curr.has(id)) removed.push(m);
  }

  const label = m => (m.year ? `${m.name} (${m.year})` : m.name);
  return {
    added: added.length,
    removed: removed.length,
    resourceChanged: resourceChanged.length,
    unchanged,
    addedTitles: added.map(label).sort(),
    removedTitles: removed.map(m => `${label(m)} [${m.imdbId}]`).sort(),
    resourceChangedTitles: resourceChanged.map(label).sort(),
  };
}

export function summarizeReview(review) {
  const byReason = {};
  for (const r of review?.movies || review || []) {
    const key = r.reason || 'unspecified';
    byReason[key] = (byReason[key] || 0) + 1;
  }
  return { total: Object.values(byReason).reduce((a, b) => a + b, 0), byReason };
}

export function perChannel(raw, current) {
  const rows = new Map();
  for (const m of raw?.movies || []) {
    const r = rows.get(m.channel) || { channel: m.channel, group: m.group, features: 0, published: 0 };
    r.features++;
    rows.set(m.channel, r);
  }
  for (const m of current) {
    const r = rows.get(m.channel);
    if (r) r.published++;
  }
  return [...rows.values()]
    .map(r => ({ ...r, resolveRate: r.features ? Number((r.published / r.features).toFixed(3)) : 0 }))
    .sort((a, b) => b.published - a.published);
}

/** Channels that produced last week and none this week — terminated or renamed. */
export function findSilentChannels(previousReport, channels) {
  const nowActive = new Set(channels.filter(c => c.published > 0).map(c => c.channel));
  return (previousReport?.channels || [])
    .filter(c => c.published > 0 && !nowActive.has(c.channel))
    .map(c => c.channel);
}
// #endregion

// #region ---------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv);

  const currentDoc = await readJson(args.current);
  if (!currentDoc) {
    console.error(`missing ${args.current} — run the resolver first`);
    process.exit(1);
  }
  const current = currentDoc.movies || [];

  const previousReport = await readJson(args.previous);
  const previousCatalog = await readJson(args.catalog);
  const review = await readJson(args.review, { movies: [] });
  const raw = await readJson(args.raw, { movies: [] });

  const diff = diffCatalogs(previousCatalog?.movies, current);
  const reviewSummary = summarizeReview(review);
  const channels = perChannel(raw, current);
  const scanned = (raw.movies || []).length;

  const report = {
    generated: new Date().toISOString(),
    run: {
      region: currentDoc.region || null,
      imdbDataset: currentDoc.imdbDataset || null,
      durationSec: args.startedAt
        ? Math.round((Date.now() - Number(args.startedAt) * 1000) / 1000)
        : null,
    },
    counts: {
      scanned,
      published: current.length,
      review: reviewSummary.total,
      rejected: Math.max(0, scanned - current.length - reviewSummary.total),
    },
    diff,
    review: reviewSummary,
    channels,
    health: {
      resolveRate: scanned ? Number((current.length / scanned).toFixed(3)) : 0,
      deadRate: previousCatalog?.movies?.length
        ? Number((diff.removed / previousCatalog.movies.length).toFixed(4))
        : 0,
      silentChannels: findSilentChannels(previousReport, channels),
    },
  };

  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(report, null, 2));

  console.log(
    `published ${report.counts.published}  ` +
    `(+${diff.added} / -${diff.removed} / ~${diff.resourceChanged} re-uploaded)`
  );
  console.log(`review queue ${reviewSummary.total}  ${JSON.stringify(reviewSummary.byReason)}`);
  console.log(`resolve rate ${(report.health.resolveRate * 100).toFixed(1)}%`);
  if (report.health.silentChannels.length) {
    console.log(`::warning::silent channels: ${report.health.silentChannels.join(', ')}`);
  }
  if (diff.removedTitles.length) {
    console.log(`dead:\n  ${diff.removedTitles.join('\n  ')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
// #endregion
EOF_REPORT

# ============================================================ workflow
cat > .github/workflows/build-catalog.yml <<'EOF_WORKFLOW'
name: build-catalog

on:
  schedule:
    # Off-the-hour on purpose — GitHub queues cron heavily at :00.
    - cron: '17 4 * * 1'
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: build-catalog
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 45

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Resolve IMDb dataset version
        id: imdb
        run: |
          STAMP=$(curl -sI https://datasets.imdbws.com/title.basics.tsv.gz \
                  | grep -i '^last-modified:' | cut -d' ' -f2- | tr -d '\r')
          echo "stamp=$(printf '%s' "$STAMP" | md5sum | cut -c1-12)" >> "$GITHUB_OUTPUT"

      - name: Cache IMDb index
        id: imdb-cache
        uses: actions/cache@v4
        with:
          path: .cache/imdb.sqlite
          key: imdb-index-${{ steps.imdb.outputs.stamp }}

      - name: Build IMDb index
        if: steps.imdb-cache.outputs.cache-hit != 'true'
        run: node src/resolve/build-index.js --cache .cache

      - name: Index YouTube channels
        env:
          YT_API_KEY: ${{ secrets.YT_API_KEY }}
        run: node src/indexer.js --eu-only --region HR --out out/raw.json

      - name: Resolve to IMDb ids
        run: node src/resolve/run.js --in out/raw.json --cache .cache

      - name: Generate report
        run: node src/report.js

      # A quota exhaustion returns a partial catalog that looks valid.
      # Fail loudly rather than publishing fragments.
      - name: Sanity check
        run: |
          NEW=$(jq '.counts.published' out/report.json)
          OLD=$(jq '.movies | length' docs/catalog.json 2>/dev/null || echo 0)
          echo "previous=$OLD new=$NEW"
          if [ "$OLD" -gt 50 ] && [ "$NEW" -lt $((OLD * 70 / 100)) ]; then
            echo "::error::catalog shrank from $OLD to $NEW (>30%) — refusing to publish"
            exit 1
          fi

      - name: Render addon endpoints
        run: node src/publish.js --in out/resolved.json --out docs

      - name: Upload review queue
        uses: actions/upload-artifact@v4
        with:
          name: needs-review
          path: out/needs-review.json
          retention-days: 90

      - name: Commit catalog
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add docs
          if git diff --staged --quiet; then
            echo "no changes"
          else
            ADDED=$(jq '.diff.added   // 0' out/report.json)
            DEAD=$(jq  '.diff.removed // 0' out/report.json)
            git commit -m "catalog: +${ADDED} added, ${DEAD} dead [skip ci]"
            git push
          fi
EOF_WORKFLOW

echo "wrote:"
echo "  .gitignore  package.json"
echo "  config/channels.json"
echo "  src/indexer.js  src/report.js"
echo "  .github/workflows/build-catalog.yml"
echo
echo "still to write (hand RESOLVER_SPEC.md to Claude Code):"
echo "  src/resolve/build-index.js  src/resolve/run.js  src/resolve/index.js"
echo "  src/publish.js  src/stremio.js"
