#!/usr/bin/env node
/**
 * compare.js — run the resolver twice over the whole corpus and read the
 * difference by name.
 *
 * CLAUDE.md calls this "a harness pattern used throughout": run the old and new
 * code over every upload, count what changed, and read the gained and lost
 * lists rather than the totals. Nothing implemented it. Every session rebuilt
 * it in a scratch directory and threw it away, three times in one session, and
 * a harness nobody keeps is a harness nobody can be asked to run.
 *
 * The lists matter more than the count, and that is the whole reason this
 * exists: lowering looksLikeHook's six-word floor scores +55 and is still
 * wrong, because it costs The Last Man On Earth to "Vincent Price". A total
 * cannot show that. A named lost list can.
 *
 * Usage:
 *   node src/resolve/compare.js --variant full-description
 *   node src/resolve/compare.js --variant title-corroboration --channel CineMo
 *   node src/resolve/compare.js --variant full-description --limit 500
 */

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildIndex, resolveOne } from './index.js';
import { openLanding, readLanded } from '../dwh/landing.js';

/** fct_resolution.status is an integer; core.js owns the mapping. */
const STATUS_NAME = ['accept', 'review', 'reject'];

// #region ---------------------------------------------------------- variants
/**
 * A variant is a pure transform of the resolver's input. Both questions this
 * was built for are input questions, so neither needs the scorer edited to be
 * measured -- scoreCorroboration reads `description`, so concatenating the raw
 * title onto it simulates reading the title exactly.
 */
const VARIANTS = {
  /**
   * stage.js truncates every description to 900 characters, which is a hard
   * cliff for the long-description channels -- 2,046 of 2,428 Movie Central
   * blurbs are stored at exactly 900. This swaps in the untruncated text that
   * is still sitting in landing, so no quota is spent.
   */
  'full-description': (v, ctx) => ({ ...v, description: ctx.full.get(v.ytId) ?? v.description }),

  /**
   * The same, but bounded. Every accept lost to the untruncated variant was a
   * long description -- 1,206 to 4,963 characters -- where the extra text named
   * someone who is also in a RIVAL's credits, so both gained corroboration and
   * the margin closed. A cap keeps most of the gain and less of that.
   */
  'full-description-2000': (v, ctx) =>
    ({ ...v, description: (ctx.full.get(v.ytId) ?? v.description).slice(0, 2000) }),

  /** Cast in the title rather than the blurb -- the CineMo shape. */
  'title-corroboration': v => ({ ...v, description: `${v.description} ${v.rawTitle}` }),
};
// #endregion

function parseArgs(argv) {
  const a = { variant: null, baseline: null, warehouse: 'data/warehouse.sqlite',
              landing: 'data/landing.sqlite',
              cache: '.cache', limit: 0, channel: null, show: 40 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--variant') a.variant = argv[++i];
    else if (k === '--baseline') a.baseline = argv[++i];
    else if (k === '--limit') a.limit = Number(argv[++i]);
    else if (k === '--channel') a.channel = argv[++i];
    else if (k === '--show') a.show = Number(argv[++i]);
    else if (k === '--cache') a.cache = argv[++i];
  }
  return a;
}

/** Untruncated descriptions, keyed by ytId. Later responses win a re-fetch. */
function fullDescriptions(landingFile) {
  const db = openLanding(landingFile);
  const out = new Map();
  for (const { body } of readLanded(db, 'videos')) {
    for (const item of body?.items ?? []) {
      const d = item?.snippet?.description;
      if (item?.id && typeof d === 'string') out.set(item.id, d);
    }
  }
  db.close();
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  // Two modes. `--variant` compares two INPUTS under the same code, which is
  // what an input question needs. `--baseline warehouse` compares the CURRENT
  // code against what the warehouse already stored, which is the only way to
  // measure a change to the SCORER -- with a variant, both arms would run the
  // new code and the diff would be empty.
  const warehouseBaseline = args.baseline === 'warehouse';
  const variant = warehouseBaseline ? (v => v) : VARIANTS[args.variant];
  if (!variant) {
    console.error(`--variant is required, one of: ${Object.keys(VARIANTS).join(', ')}` +
                  `\n   (or --baseline warehouse to diff the current code against stored resolutions)`);
    process.exit(1);
  }

  const wh = new DatabaseSync(args.warehouse, { readOnly: true });
  const rows = wh.prepare(`
    SELECT u.ytId, u.clean_title, u.raw_title, u.extracted_year, u.runtime_min,
           u.channel_name, u.channel_ref, u.grp, u.season, u.episode,
           COALESCE(b.text, '') AS description,
           f.status AS was_status, f.imdb_id AS was_id,
           f.confidence AS was_conf, f.margin AS was_margin
      FROM fct_upload u LEFT JOIN stg_blurb b ON b.ytId = u.ytId
      JOIN fct_resolution f ON f.ytId = u.ytId
     WHERE u.drop_reason IS NULL ${args.channel ? 'AND u.channel_name = ?' : ''}
     ORDER BY u.ytId ${args.limit ? 'LIMIT ' + args.limit : ''}`)
    .all(...(args.channel ? [args.channel] : []));

  const wantsFull = !warehouseBaseline && args.variant.startsWith('full-description');
  const ctx = { full: wantsFull ? fullDescriptions(args.landing) : new Map() };
  if (wantsFull) {
    console.log(`[compare]  ${ctx.full.size.toLocaleString()} untruncated descriptions recovered from landing`);
  }

  // The same opts transform.js:351 passes. Omitting them is not a small
  // inaccuracy: without `currentReleaseChannels` the four rights-holder
  // channels get §5's recent-year hard flag applied when the config exempts
  // them, and Movie Central and GEM are exactly where the gains land. A run
  // without this undercounted new accepts by 16.
  const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
  const overridesDoc = readJson('config/overrides.json', {});
  const cfg = readJson('config/channels.json', { channels: [] });
  const opts = {
    overrides: Object.fromEntries(Object.entries(overridesDoc?.overrides ?? {})
      .filter(([k]) => !k.startsWith('_'))),
    currentReleaseChannels: new Set(
      (cfg.channels ?? []).filter(c => c.currentReleases).map(c => c.ref)),
  };
  console.log(`[compare]  ${Object.keys(opts.overrides).length} overrides, ` +
              `${opts.currentReleaseChannels.size} currentReleases channels`);

  const index = await buildIndex({ cacheDir: args.cache });
  const base = v => ({
    ytId: v.ytId, name: v.clean_title, rawTitle: v.raw_title, year: v.extracted_year,
    runtimeMin: v.runtime_min, description: v.description, channel: v.channel_name,
    channelRef: v.channel_ref, group: v.grp, season: v.season, episode: v.episode,
  });

  const matrix = new Map();
  const gained = [], lost = [], flipped = [], narrowed = [];
  let unchanged = 0, done = 0;
  const started = Date.now();
  for (const r of rows) {
    const v = base(r);
    const w = variant(v, ctx);
    // A variant that changes nothing cannot change the answer, and resolving
    // such a row twice is pure cost: 5,070 of 9,458 uploads have no truncated
    // description at all, so the first run of this spent 54% of half an hour
    // proving that identical inputs give identical outputs.
    if (!warehouseBaseline && w.description === v.description && w.rawTitle === v.rawTitle) {
      unchanged++; continue;
    }

    const episode = r.season != null && r.episode != null
      ? { season: r.season, episode: r.episode } : null;
    // In warehouse mode the "before" is the stored row, not a second resolve --
    // which also halves the work.
    const a = warehouseBaseline
      ? { status: STATUS_NAME[r.was_status], imdbId: r.was_id,
          confidence: r.was_conf ?? 0, margin: r.was_margin ?? 0 }
      : resolveOne(v, index, { ...opts, episode });
    const b = resolveOne(w, index, { ...opts, episode });
    if (++done % 500 === 0) {
      const rate = done / ((Date.now() - started) / 1000);
      console.log(`  … ${done} compared (${rate.toFixed(1)}/s)`);
    }

    const key = `${a.status} -> ${b.status}`;
    matrix.set(key, (matrix.get(key) ?? 0) + 1);

    const row = { ch: r.channel_name, title: r.clean_title,
                  from: a.imdbId ?? '-', to: b.imdbId ?? '-',
                  ca: a.confidence ?? 0, cb: b.confidence ?? 0,
                  ma: a.margin ?? 0, mb: b.margin ?? 0 };
    if (a.status !== 'accept' && b.status === 'accept') gained.push(row);
    else if (a.status === 'accept' && b.status !== 'accept') lost.push({ ...row, why: b.reason });
    if (a.imdbId && b.imdbId && a.imdbId !== b.imdbId) flipped.push(row);
    if (a.status === 'accept' && b.status === 'accept' && b.margin < a.margin) narrowed.push(row);
  }
  index.close();

  const p = (n, w = 5) => String(n).padStart(w);
  const label = warehouseBaseline ? 'current code vs stored resolutions' : `variant ${args.variant}`;
  console.log(`\n[compare]  ${label}   ${rows.length.toLocaleString()} uploads\n`);
  for (const [k, n] of [...matrix].sort((x, y) => y[1] - x[1])) console.log(`  ${p(n)}  ${k}`);

  const show = (label, list) => {
    console.log(`\n  ${label}: ${list.length}`);
    for (const r of list.slice(0, args.show)) {
      console.log(`    ${r.from} -> ${r.to}  conf ${p(r.ca, 3)}->${p(r.cb, 3)}  ` +
                  `margin ${p(r.ma, 3)}->${p(r.mb, 3)}  ${r.ch.slice(0, 18).padEnd(18)} ${r.title.slice(0, 34)}`);
    }
    if (list.length > args.show) console.log(`    … ${list.length - args.show} more`);
  };
  // LOST first, deliberately. It is the list that decides, and putting it last
  // is how a change gets shipped on the strength of its gained count.
  show('LOST accepts', lost);
  show('CHANGED tconst', flipped);
  show('GAINED accepts', gained);
  // Deliberately NOT "how many fell under the 12 gate": a row that is still an
  // accept has margin >= 12 by definition, so that filter can never be
  // non-zero. It read as a safety check and was a tautology. The rows that
  // crossed the gate ARE the LOST list above -- that is the only place they
  // can appear.
  const worst = narrowed.reduce((m, r) => Math.min(m, r.mb - r.ma), 0);
  console.log(`\n  unchanged by this variant, not compared: ${unchanged.toLocaleString()}`);
  console.log(`  surviving accepts whose margin shrank: ${narrowed.length}` +
              `  (largest drop ${worst})`);
  console.log(`  accepts that crossed the margin gate: ${lost.length} -- listed above, not counted here`);
}

main().catch(e => { console.error(e); process.exit(1); });
