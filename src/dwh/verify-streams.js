#!/usr/bin/env node
/**
 * verify-streams.js — ask YouTube whether the videos we are actually serving
 * are still there.
 *
 * Everything else in this pipeline verifies our own reasoning: that the title
 * resolved to the right film, that the mart holds what the catalogue promises.
 * None of it asks the only question a viewer cares about — does the stream
 * play. `src/dwh/extract.js` says so itself:
 *
 *   "a video deleted or newly geo-blocked since the last run is only noticed
 *    when it is re-hydrated"
 *
 * and the answer it offers is `--full`, which re-hydrates all 22,453 uploads at
 * 450 calls. This is the sharper question and the cheaper one: the published
 * catalogue is ~3,000 ytIds, videos.list takes 50 at a time, so the whole thing
 * costs about 62 quota units out of 10,000 a day.
 *
 * Reports, and does not act. A dead entry is a decision — quarantine it, drop
 * it, or re-resolve to a different upload of the same film — and that decision
 * wants the numbers in front of it first.
 *
 * Usage:
 *   node --env-file-if-exists=.env src/dwh/verify-streams.js --region HR
 *   node --env-file-if-exists=.env src/dwh/verify-streams.js --out docs/health.json
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { openLanding, startRun, finishRun, land } from './landing.js';

const API = 'https://www.googleapis.com/youtube/v3';
const KEY = process.env.YT_API_KEY;
const BATCH = 50;                       // videos.list takes 50 ids per call

function parseArgs(argv) {
  const a = { out: 'docs', region: 'HR', landing: 'data/landing.sqlite', limit: 0 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = argv[++i];
    else if (k === '--region') a.region = argv[++i];
    else if (k === '--landing') a.landing = argv[++i];
    else if (k === '--limit') a.limit = Number(argv[++i]);
  }
  return a;
}

const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * Every ytId the marts currently serve, with the entry it belongs to.
 *
 * Read from `docs/` rather than the warehouse on purpose: the warehouse holds
 * what we believe, the marts hold what we published, and it is the published
 * thing a viewer clicks. If those two ever disagree this is the tool that
 * should notice.
 */
export async function publishedStreams(outDir) {
  const out = [];
  // The root tree plus every region=xx variant beside it. Reading only the root
  // would quietly stop covering the uploads that exist *because* of a region —
  // which are exactly the ones a rights holder is most likely to gate or pull.
  const roots = [outDir];
  for (const name of await fsp.readdir(outDir, { withFileTypes: true }).catch(() => [])) {
    if (name.isDirectory() && name.name.startsWith('region=')) roots.push(path.join(outDir, name.name));
  }
  for (const root of roots) for (const type of ['movie', 'series']) {
    const dir = path.join(root, 'stream', type);
    let names;
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const text = await fsp.readFile(path.join(dir, name), 'utf8');
      // Every stream in the file, not just the first. A film can now offer
      // several copies, and reading only streams[0] meant the alternates were
      // never checked by anything — "100% coverage" covered the winners alone
      // while ~800 fallback streams went unmeasured, any of which could be
      // gated or dead and would still be offered to a viewer.
      for (const [rank, s] of (JSON.parse(text)?.streams ?? []).entries()) {
        if (s?.ytId) out.push({ id: name.replace(/\.json$/, ''), type, ytId: s.ytId, rank, root });
      }
    }
  }
  return out;
}

/**
 * Mirrors playableInRegion in publish.js, against live API data rather than
 * the copy landed whenever this video was last hydrated. The staleness between
 * those two is the whole point of this script.
 */
export function regionVerdict(restriction, region) {
  const blocked = restriction?.blocked ?? [];
  const allowed = restriction?.allowed ?? [];
  if (blocked.includes(region)) return 'blocked';
  if (allowed.length && !allowed.includes(region)) return 'not-allowed';
  return 'ok';
}

/** Classify one videos.list item, or its absence. */
export function classify(item, region) {
  if (!item) return 'gone';                       // deleted, private, or terminated
  const status = item.status ?? {};
  if (status.privacyStatus && status.privacyStatus !== 'public') return 'not-public';
  if (status.uploadStatus && status.uploadStatus !== 'processed') return `upload:${status.uploadStatus}`;
  if (status.embeddable === false) return 'not-embeddable';
  const verdict = regionVerdict(item.contentDetails?.regionRestriction, region);
  if (verdict !== 'ok') return `region:${verdict}`;
  return 'ok';
}

async function main() {
  const args = parseArgs(process.argv);
  if (!KEY) {
    console.error('YT_API_KEY is not set — run with --env-file-if-exists=.env');
    process.exit(1);
  }

  const streams = await publishedStreams(args.out);
  if (!streams.length) {
    console.error(`no stream files under ${args.out} — run publish first`);
    process.exit(1);
  }
  const byYtId = new Map();
  for (const s of streams) {
    if (!byYtId.has(s.ytId)) byYtId.set(s.ytId, []);
    byYtId.get(s.ytId).push(s);
  }
  const ids = [...byYtId.keys()];
  const todo = args.limit ? ids.slice(0, args.limit) : ids;
  console.log(`[verify]   ${streams.length.toLocaleString()} stream files, ` +
              `${ids.length.toLocaleString()} distinct videos, ` +
              `${Math.ceil(todo.length / BATCH)} API calls`);

  const landing = openLanding(args.landing);
  const runId = startRun(landing, 'verify-streams');

  const seen = new Map();
  let calls = 0;
  try {
    for (const batch of chunk(todo, BATCH)) {
      const params = { part: 'status,contentDetails', id: batch.join(',') };
      const url = new URL(`${API}/videos`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      url.searchParams.set('key', KEY);

      const res = await fetch(url);
      const text = await res.text();
      land(landing, runId, 'videos', params, res.status, text);
      calls++;
      if (!res.ok) throw new Error(`videos ${res.status}: ${text.slice(0, 200)}`);
      for (const item of JSON.parse(text).items || []) seen.set(item.id, item);
    }
  } catch (err) {
    finishRun(landing, runId, { status: 'error', notes: String(err).slice(0, 200) });
    landing.close();
    throw err;
  }

  const byVerdict = new Map();
  const problems = [];
  for (const ytId of todo) {
    const verdict = classify(seen.get(ytId), args.region);
    byVerdict.set(verdict, (byVerdict.get(verdict) ?? 0) + 1);
    if (verdict !== 'ok') {
      for (const s of byYtId.get(ytId)) problems.push({ ...s, verdict });
    }
  }

  const health = {
    checkedAt: new Date().toISOString(),
    region: args.region,
    videos: todo.length,
    entries: streams.length,
    apiCalls: calls,
    verdicts: Object.fromEntries([...byVerdict].sort((a, b) => b[1] - a[1])),
    problems: problems.sort((a, b) => a.id.localeCompare(b.id)),
  };
  const file = path.join(args.out, 'health.json');
  await fsp.writeFile(file, JSON.stringify(health, null, 2));

  const ok = byVerdict.get('ok') ?? 0;
  console.log(`[verify]   ${ok.toLocaleString()} of ${todo.length.toLocaleString()} playable ` +
              `(${((100 * ok) / todo.length).toFixed(1)}%) -> ${file}`);
  for (const [verdict, n] of Object.entries(health.verdicts)) {
    if (verdict !== 'ok') console.log(`   ${verdict.padEnd(22)} ${n}`);
  }
  // Surfaced the way publish surfaces a silent channel, so a catalogue that has
  // started serving dead links is visible in the Actions summary rather than
  // only in a file nobody opens.
  if (problems.length) {
    const summary = Object.entries(health.verdicts)
      .filter(([v]) => v !== 'ok').map(([v, n]) => `${v} ${n}`).join(', ');
    console.log(`::warning::${problems.length} published entries are not playable in ` +
                `${args.region}: ${summary}`);
  }

  finishRun(landing, runId, { status: 'ok', rowsIn: todo.length, rowsOut: ok });
  landing.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
