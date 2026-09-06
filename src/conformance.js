#!/usr/bin/env node
/**
 * conformance.js — walk the published addon the way Stremio does, and fail on
 * anything a client would trip over.
 *
 * Every other check in this repo verifies our own reasoning: that a title
 * resolved to the right film, that a stream file holds what the catalogue
 * promises, that the video still plays. None of them asks whether the *addon
 * protocol* is satisfied — whether a manifest declares a catalogue that does
 * not resolve, whether page two of a catalogue exists, whether a listed film
 * has a stream at the id Stremio will actually request.
 *
 * Those are the failures a viewer sees as "the addon is broken", and they are
 * invisible from inside: the marts can be internally perfect and still be
 * unusable if the ids do not line up.
 *
 * Usage:
 *   node src/conformance.js                       # the local docs/ tree
 *   node src/conformance.js --base https://…      # the deployed site
 *   node src/conformance.js --regions hr,us       # and the regional variants
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const a = { base: 'docs', regions: [], sample: 25 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--base') a.base = argv[++i];
    else if (k === '--regions') a.regions = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--sample') a.sample = Number(argv[++i]);
  }
  return a;
}

const isHttp = base => /^https?:/.test(base);

/** Fetch a resource the way a client would, local or remote. */
async function get(base, rel) {
  if (isHttp(base)) {
    const res = await fetch(`${base}/${rel}`);
    if (!res.ok) return { ok: false, status: res.status };
    try { return { ok: true, body: await res.json() }; }
    catch (e) { return { ok: false, status: `invalid JSON: ${e.message}` }; }
  }
  try { return { ok: true, body: JSON.parse(await fsp.readFile(path.join(base, rel), 'utf8')) }; }
  catch (e) { return { ok: false, status: e.code ?? e.message }; }
}

/** Deterministic spread so two runs check the same entries. */
const spread = (xs, n) => {
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step)]);
};

export async function checkAddon(base, { sample = 25, label = '' } = {}) {
  const fails = [];
  const fail = (what, why) => fails.push(`${label}${what}: ${why}`);

  const man = await get(base, 'manifest.json');
  if (!man.ok) { fail('manifest.json', `unreachable (${man.status})`); return { fails, stats: {} }; }
  const m = man.body;

  // §1 the manifest itself
  for (const k of ['id', 'version', 'name', 'resources', 'types', 'catalogs']) {
    if (m[k] === undefined) fail('manifest', `missing ${k}`);
  }
  if (!Array.isArray(m.idPrefixes) || !m.idPrefixes.includes('tt')) {
    fail('manifest', 'idPrefixes must include "tt" or Stremio asks us about every id in every catalogue');
  }
  if (!m.resources?.includes('stream')) fail('manifest', 'does not declare the stream resource');

  // §2 every declared catalogue resolves, and pages past the first exist
  const ids = { movie: [], series: [] };
  let pagesChecked = 0;
  for (const c of m.catalogs ?? []) {
    const first = await get(base, `catalog/${c.type}/${c.id}.json`);
    if (!first.ok) { fail(`catalog/${c.type}/${c.id}`, `declared but unreachable (${first.status})`); continue; }
    if (!Array.isArray(first.body?.metas)) { fail(`catalog/${c.type}/${c.id}`, 'no metas array'); continue; }
    pagesChecked++;

    for (const meta of first.body.metas) {
      if (!meta.id) fail(`catalog/${c.type}/${c.id}`, 'a meta has no id');
      else if (!meta.id.startsWith('tt')) fail(`catalog/${c.type}/${c.id}`, `meta id ${meta.id} is not a tconst`);
      if (!meta.type) fail(`catalog/${c.type}/${c.id}`, `${meta.id} has no type`);
      if (!meta.name) fail(`catalog/${c.type}/${c.id}`, `${meta.id} has no name`);
      ids[c.type]?.push(meta.id);
    }

    // A full first page means Stremio will ask for skip=100. If that 404s the
    // viewer sees a catalogue that stops dead at a hundred entries.
    if (first.body.metas.length === 100) {
      const next = await get(base, `catalog/${c.type}/${c.id}/skip=100.json`);
      if (!next.ok) fail(`catalog/${c.type}/${c.id}`, `first page is full but skip=100 is missing (${next.status})`);
      else pagesChecked++;
    }
  }

  // §3 a listed film must have a stream at the id Stremio will request
  let streamsChecked = 0;
  for (const id of spread([...new Set(ids.movie)], sample)) {
    const s = await get(base, `stream/movie/${id}.json`);
    if (!s.ok) { fail(`stream/movie/${id}`, `listed in a catalogue but unreachable (${s.status})`); continue; }
    const streams = s.body?.streams;
    if (!Array.isArray(streams) || !streams.length) { fail(`stream/movie/${id}`, 'no streams'); continue; }
    for (const st of streams) {
      if (!st.ytId && !st.url && !st.externalUrl) fail(`stream/movie/${id}`, 'a stream carries nothing playable');
    }
    streamsChecked++;
  }

  // §4 a series row points at a show, and Stremio then asks for
  // tconst:season:episode. Guessing those numbers is wrong — episodes are
  // whatever the channel happened to upload, and a first pass that probed
  // S1-3/E1-3 reported Man with a Camera as broken when its two episodes are
  // S1E6 and S1E12. catalog.json lists every published id exactly, so use it.
  const index = await get(base, 'episodes.json');
  if (!index.ok) fail('episodes.json', `unreachable (${index.status})`);
  else {
    const byShow = index.body ?? {};
    for (const id of [...new Set(ids.series)]) {
      if (!byShow[id]?.length) fail(`stream/series/${id}`, 'listed as a show but publishes no episode');
    }
    for (const epId of spread(Object.values(byShow).flat(), Math.min(sample, 12))) {
      const r = await get(base, `stream/series/${epId}.json`);
      if (!r.ok || !r.body?.streams?.length) fail(`stream/series/${epId}`, `published but unreachable (${r.status ?? 'no streams'})`);
      else streamsChecked++;
    }
  }

  return {
    fails,
    stats: { name: m.name, id: m.id, catalogs: m.catalogs?.length ?? 0,
             pagesChecked, movies: new Set(ids.movie).size,
             shows: new Set(ids.series).size, streamsChecked },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const targets = [['', args.base]];
  for (const r of args.regions) {
    targets.push([r.toUpperCase(), isHttp(args.base) ? `${args.base}/region=${r.toLowerCase()}`
                                                     : path.join(args.base, `region=${r.toLowerCase()}`)]);
  }

  let bad = 0;
  const seen = new Map();
  for (const [label, base] of targets) {
    const { fails, stats } = await checkAddon(base, { sample: args.sample, label: label ? `${label} ` : '' });
    const tag = label || 'free';
    console.log(`${tag.padEnd(6)} ${String(stats.name ?? '?').padEnd(16)} ${String(stats.id ?? '?').padEnd(34)} ` +
                `${String(stats.catalogs ?? 0).padStart(2)} catalogues  ` +
                `${String(stats.movies ?? 0).padStart(4)} films  ${String(stats.shows ?? 0).padStart(3)} shows  ` +
                `${stats.streamsChecked ?? 0} streams checked`);
    fails.forEach(f => console.log(`   FAIL ${f}`));
    bad += fails.length;
    if (stats.id) {
      if (seen.has(stats.id)) console.log(`   FAIL duplicate manifest id shared with ${seen.get(stats.id)} — installing one replaces the other`), bad++;
      seen.set(stats.id, tag);
    }
  }
  console.log(bad ? `\n${bad} problem(s)` : '\nno problems');
  process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
