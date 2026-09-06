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
  let text;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  // A zero-byte file is what a kill mid-write leaves behind on this box, and
  // it carries no information — treat it as absent rather than crashing a run
  // that could otherwise complete.
  if (!text.trim()) return fallback;
  return JSON.parse(text);
}
// #endregion

// #region ---------------------------------------------------------- diff
/**
 * Diff on imdbId — the identity users and other addons see. A film whose
 * ytId changed is not added+removed; it is the same entry with a new source.
 */
export function diffCatalogs(previous, current) {
  // Keyed on the published id, which for an episode is tconst:season:episode.
  // Keying on imdbId alone would fold a show's episodes into a single entry and
  // report ninety of them as removed the moment a second one appeared.
  const key = m => m.id ?? m.imdbId;
  const prev = new Map((previous || []).map(m => [key(m), m]));
  const curr = new Map(current.map(m => [key(m), m]));

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

  const label = m => {
    const base = m.year ? `${m.name} (${m.year})` : m.name;
    return m.season != null ? `${base} S${m.season}E${m.episode}` : base;
  };
  return {
    added: added.length,
    removed: removed.length,
    resourceChanged: resourceChanged.length,
    unchanged,
    addedTitles: added.map(label).sort(),
    removedTitles: removed.map(m => `${label(m)} [${key(m)}]`).sort(),
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
