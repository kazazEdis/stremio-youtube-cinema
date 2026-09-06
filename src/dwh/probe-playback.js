#!/usr/bin/env node
/**
 * probe-playback.js — the part of "does it play" that only a real client knows.
 *
 * `verify-streams.js` asks the Data API and gets existence, privacy,
 * embeddability and region for the whole catalogue at 62 quota units. Four
 * things it cannot see, because the API does not carry them:
 *
 *   - age-gating, which makes a video unplayable in an embed while
 *     `status.embeddable` still says true
 *   - the real maximum resolution; the API grades only `hd` / `sd`
 *   - genuine subtitle tracks, as opposed to auto-captions
 *   - the video's actual duration, which is an *independent* check on the
 *     runtime we matched the film on
 *
 * That last one is the reason this is worth more than a spot check. Runtime
 * carries 20 of the 100 points in §4 and it is the signal that separates a
 * 1922 Nosferatu from a 1979 one. Everything else in the pipeline trusts the
 * duration landed at extract time; this is the only thing that re-measures it.
 *
 * yt-dlp costs about 3.6 seconds a video, so this samples rather than sweeps —
 * spread across channels and seeded, so two runs are comparable.
 *
 * Usage:
 *   node src/dwh/probe-playback.js --sample 40
 *   node src/dwh/probe-playback.js --ids b12gZKrL-k4,fH0IljKo9JI
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { publishedStreams } from './verify-streams.js';

const run = promisify(execFile);

function parseArgs(argv) {
  const a = { out: 'docs', warehouse: 'data/warehouse.sqlite', sample: 40, ids: null, concurrency: 3 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = argv[++i];
    else if (k === '--warehouse') a.warehouse = argv[++i];
    else if (k === '--sample') a.sample = Number(argv[++i]);
    else if (k === '--ids') a.ids = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--concurrency') a.concurrency = Number(argv[++i]);
  }
  return a;
}

/**
 * A stable hash, so `--sample 40` picks the same forty videos every run and two
 * probes are comparable. Math.random would make every result a fresh sample of
 * a different population, which is not a measurement.
 */
export function seededPick(rows, n, key = r => r.ytId) {
  const hash = s => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  // Spread across channels rather than taking the n smallest hashes overall:
  // PizzaFlix is 40% of the catalogue and would otherwise be 40% of the sample,
  // which tells you least about the channels most likely to be broken.
  const byGroup = new Map();
  for (const r of rows) {
    const g = r.grp ?? '';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(r);
  }
  for (const list of byGroup.values()) list.sort((a, b) => hash(key(a)) - hash(key(b)));

  const out = [];
  const groups = [...byGroup.values()];
  for (let i = 0; out.length < n && groups.some(g => g.length); i++) {
    for (const g of groups) {
      if (!g.length || out.length >= n) continue;
      out.push(g.shift());
    }
  }
  return out;
}

/** What yt-dlp knows and the Data API does not. */
export function summarise(info) {
  const heights = [...new Set((info.formats || []).map(f => f.height).filter(Boolean))]
    .sort((a, b) => b - a);
  return {
    ytId: info.id,
    durationSec: info.duration ?? null,
    ageLimit: info.age_limit ?? 0,
    availability: info.availability ?? null,
    liveStatus: info.live_status ?? null,
    maxHeight: heights[0] ?? null,
    subtitles: Object.keys(info.subtitles || {}),
    autoCaptions: Object.keys(info.automatic_captions || {}).length,
  };
}

/**
 * A verdict a viewer would recognise. `age-gated` is the one that matters: the
 * Data API reports such a video as embeddable, and it is not.
 */
export function verdict(s, expectedRuntimeMin) {
  if (s.ageLimit > 0) return 'age-gated';
  if (s.liveStatus && s.liveStatus !== 'not_live') return `live:${s.liveStatus}`;
  if (s.availability && s.availability !== 'public') return `availability:${s.availability}`;
  if (!s.maxHeight) return 'no-video-format';
  if (expectedRuntimeMin && s.durationSec) {
    // The duration we matched on came from the API at extract time. A drift of
    // more than two minutes means the upload was replaced or re-cut, and the
    // runtime evidence behind the match no longer describes this video.
    const drift = Math.abs(s.durationSec / 60 - expectedRuntimeMin);
    if (drift > 2) return 'duration-drift';
  }
  return 'ok';
}

/**
 * Always as a URL, never as a bare id. 79 of the 4,868 published ids begin with
 * a dash, and yt-dlp reads `-rg5GhmZ5zo` as the `-r` rate-limit flag and dies
 * with a usage error — so passing ids straight through reports 1.6% of the
 * catalogue as unreachable when nothing is wrong with it.
 */
export const watchUrl = ytId => `https://www.youtube.com/watch?v=${encodeURIComponent(ytId)}`;

/**
 * yt-dlp does not return an `age_limit` for a gated video — it refuses to fetch
 * the metadata at all and exits non-zero, so the flag this script was written
 * to read never arrives. The message is the signal instead.
 *
 * Worth telling apart from a dead video, because they are different problems:
 * a gated upload still exists and could be replaced by another copy of the same
 * film, and it is the one case the Data API actively gets wrong — it reports
 * such a video as public and embeddable.
 */
export function verdictFromError(text) {
  const t = String(text || '');
  if (/confirm your age|age.?restricted|inappropriate for some users/i.test(t)) return 'age-gated';
  if (/private video/i.test(t)) return 'private';
  if (/members-only|join this channel/i.test(t)) return 'members-only';
  if (/not available in your country|blocked it in your country/i.test(t)) return 'region-blocked';
  return 'unreachable';
}

async function probe(ytId) {
  const { stdout } = await run('yt-dlp',
    ['-J', '--no-warnings', '--skip-download', '--socket-timeout', '20', '--', watchUrl(ytId)],
    { maxBuffer: 64 * 1024 * 1024, timeout: 90_000 });
  return summarise(JSON.parse(stdout));
}

async function main() {
  const args = parseArgs(process.argv);
  const wh = new DatabaseSync(args.warehouse, { readOnly: true });

  // The population is what the marts serve, not what the warehouse accepted.
  // Those differ by 1,783 rows — the HR region filter and duplicate settling
  // both run at publish time — and sampling the wider set means probing videos
  // this addon never offers. It reported two of them as unreachable, which was
  // true and irrelevant: both are geo-blocked outside their allowed regions,
  // which is exactly why publish had already dropped them.
  const served = await publishedStreams(args.out);
  const meta = new Map(wh.prepare(`
    SELECT r.ytId, r.imdb_id, r.match_name, u.runtime_min, u.grp, u.channel_name
    FROM fct_resolution r JOIN fct_upload u ON u.ytId = r.ytId
    WHERE r.status = 0`).all().map(r => [r.ytId, r]));
  const published = served.map(s => ({ ytId: s.ytId, ...(meta.get(s.ytId) ?? {}) }));

  const chosen = args.ids
    ? published.filter(r => args.ids.includes(r.ytId))
    : seededPick(published, args.sample);

  console.log(`[probe]    ${chosen.length} of ${published.length.toLocaleString()} published videos, ` +
              `${args.concurrency} at a time`);

  const results = [];
  const queue = [...chosen];
  await Promise.all(Array.from({ length: args.concurrency }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        const s = await probe(row.ytId);
        results.push({ ...s, imdbId: row.imdb_id, name: row.match_name,
                       channel: row.channel_name, expectedMin: row.runtime_min,
                       verdict: verdict(s, row.runtime_min) });
      } catch (err) {
        // yt-dlp exits non-zero for a video it cannot reach at all, which is
        // itself the answer, not an error in this script.
        const text = String(err.stderr || err.message);
        results.push({ ytId: row.ytId, imdbId: row.imdb_id, name: row.match_name,
                       channel: row.channel_name, expectedMin: row.runtime_min,
                       verdict: verdictFromError(text),
                       error: text.replace(/\s+/g, ' ').slice(0, 160) });
      }
    }
  }));
  wh.close();

  results.sort((a, b) => String(a.imdbId).localeCompare(String(b.imdbId)));
  const tally = k => results.reduce((m, r) => m.set(r[k], (m.get(r[k]) ?? 0) + 1), new Map());
  const verdicts = Object.fromEntries([...tally('verdict')].sort((a, b) => b[1] - a[1]));
  const heights = Object.fromEntries([...tally('maxHeight')].sort((a, b) => (b[0] ?? 0) - (a[0] ?? 0)));
  const withSubs = results.filter(r => r.subtitles?.length).length;

  const report = {
    probedAt: new Date().toISOString(),
    sampled: results.length,
    population: published.length,
    verdicts,
    maxHeight: heights,
    realSubtitles: withSubs,
    results,
  };
  const file = path.join(args.out, 'playback.json');
  await fsp.writeFile(file, JSON.stringify(report, null, 2));

  const ok = verdicts.ok ?? 0;
  console.log(`[probe]    ${ok} of ${results.length} play as published ` +
              `(${((100 * ok) / results.length).toFixed(1)}%) -> ${file}`);
  for (const [v, n] of Object.entries(verdicts)) if (v !== 'ok') console.log(`   ${v.padEnd(22)} ${n}`);
  console.log(`   max height          ${JSON.stringify(heights)}`);
  console.log(`   real subtitle tracks ${withSubs} of ${results.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
