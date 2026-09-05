#!/usr/bin/env node
/**
 * probe.js — resolve a single title against the built index and show the work.
 *
 * The scoring weights in §4 are explicitly a starting point to be tuned, and
 * tuning them means being able to see why a given upload scored what it did.
 * This prints the whole candidate list with per-signal breakdowns.
 *
 * Usage:
 *   node src/resolve/probe.js "Nosferatu FULL MOVIE" --runtime 94
 *   node src/resolve/probe.js "Иван Грозный (1944)" --runtime 99 --desc "Eisenstein"
 */

import { buildIndex, resolveOne, generateCandidates, THRESHOLDS } from './index.js';
import { cleanTitle, extractYear } from '../transform/title.js';
import { normVariants } from './normalize.js';

function parseArgs(argv) {
  const a = { raw: '', runtime: 0, year: undefined, desc: '', cache: '.cache', top: 8 };
  const rest = [];
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--runtime') a.runtime = Number(argv[++i]);
    else if (k === '--year') a.year = Number(argv[++i]);
    else if (k === '--desc') a.desc = argv[++i];
    else if (k === '--cache') a.cache = argv[++i];
    else if (k === '--top') a.top = Number(argv[++i]);
    else rest.push(k);
  }
  a.raw = rest.join(' ');
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.raw) {
    console.error('usage: node src/resolve/probe.js "<raw youtube title>" [--runtime N] [--year N] [--desc "..."]');
    process.exit(1);
  }

  const index = await buildIndex({ cacheDir: args.cache });
  const name = cleanTitle(args.raw);
  const video = {
    ytId: 'probe',
    name,
    rawTitle: args.raw,
    year: args.year ?? extractYear(args.raw),
    runtimeMin: args.runtime,
    description: args.desc,
    channel: 'probe',
    group: 'probe',
  };

  console.log(`raw        ${args.raw}`);
  console.log(`cleaned    ${name}`);
  console.log(`normalized ${JSON.stringify(normVariants(name))}`);
  console.log(`year       ${video.year ?? '(none)'}    runtime ${args.runtime || '(none)'} min`);

  const { candidates, tier } = generateCandidates(video, index);
  console.log(`\ntier       ${tier} — ${candidates.length} candidate(s)\n`);

  const r = resolveOne(video, index);
  const rows = r.candidates?.length
    ? r.candidates
    : (r.imdbId ? [{ imdbId: r.imdbId, name: r.name, year: r.year,
                     runtimeMinutes: r.imdbRuntimeMin, score: r.confidence,
                     signals: r.signals }] : []);

  for (const c of rows.slice(0, args.top)) {
    const s = c.signals || {};
    console.log(
      `  ${String(c.score).padStart(5)}  ${c.imdbId.padEnd(11)} ` +
      `${String(c.year ?? '----').padEnd(5)} ${String(c.runtimeMinutes ?? '--').padStart(3)}m  ` +
      `[t${s.title ?? '-'} y${s.year ?? '-'} r${s.runtime ?? '-'} c${s.corroboration ?? '-'}]  ` +
      `${c.name}`);
  }

  console.log(`\n=> ${r.status.toUpperCase()}` +
    (r.imdbId ? `  ${r.imdbId}  confidence ${r.confidence}  margin ${r.margin}` : '') +
    (r.reason ? `  (${r.reason})` : ''));
  console.log(`   floor ${THRESHOLDS.accept} / margin ${THRESHOLDS.margin}`);
  index.close();
}

main().catch(e => { console.error(e); process.exit(1); });
