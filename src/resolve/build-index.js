#!/usr/bin/env node
/**
 * build-index.js — turn the IMDb dumps into a queryable SQLite index.
 *
 * Everything is streamed through gunzip + readline; nothing is ever held whole
 * in memory except the tconst set (~1.1M strings, per spec §1) and the nconst
 * set needed to attach credits.
 *
 * Usage:
 *   node src/resolve/build-index.js --cache .cache [--no-principals] [--force]
 *
 * The datasets are ~2GB of third-party data under IMDb's non-commercial
 * licence. They live in --cache, which .gitignore excludes.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';

import { normalize, normVariants } from './normalize.js';

const BASE = 'https://datasets.imdbws.com';

// §1: features only, and a runtime is mandatory — runtime is the discriminator
// the whole scorer leans on, so a row without one is not a usable candidate.
const KEEP_TYPES = new Set(['movie', 'tvMovie', 'video']);

export const DATASETS = {
  basics: 'title.basics.tsv.gz',
  akas: 'title.akas.tsv.gz',
  principals: 'title.principals.tsv.gz',
  names: 'name.basics.tsv.gz',
};

// #region ---------------------------------------------------------- download
const mb = n => `${(n / 1e6).toFixed(0)} MB`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** HEAD the dataset — backs both the freshness stamp and the size check. */
async function headers(file) {
  const res = await fetch(`${BASE}/${file}`, { method: 'HEAD' });
  if (!res.ok) throw new Error(`HEAD ${file}: ${res.status}`);
  return res.headers;
}

async function remoteStamp(file) {
  return (await headers(file)).get('last-modified') || '';
}

/**
 * Download unless a complete local copy already exists.
 *
 * Resumable and size-verified, because on a phone neither is optional. A
 * dropped socket ends a fetch() body *cleanly*: the old one-shot version wrote
 * the short read to .partial, renamed it, and produced a file that was
 * indistinguishable from a good one until gunzip choked on it 700 MB into the
 * indexing pass. We keep .partial across attempts, ask for the remainder with
 * a Range header, and promote it only once the byte count matches the server.
 */
async function ensureLocal(file, cacheDir, { force = false, attempts = 8 } = {}) {
  const dest = path.join(cacheDir, file);
  const tmp = `${dest}.partial`;
  const size = Number((await headers(file)).get('content-length') || 0);

  if (force) {
    await fsp.rm(dest, { force: true });
    await fsp.rm(tmp, { force: true });
  } else {
    const st = await fsp.stat(dest).catch(() => null);
    if (st && size && st.size === size) {
      console.log(`[cached] ${file} (${mb(st.size)})`);
      return dest;
    }
    if (st && size && st.size < size) {
      // A short file under the final name is a truncated download from before
      // this verification existed. The bytes are still good — resume onto them
      // rather than paying for the whole transfer again.
      console.log(`[salvage] ${file} keeping ${mb(st.size)} of ${mb(size)}`);
      await fsp.rm(tmp, { force: true });
      await fsp.rename(dest, tmp);
    } else if (st) {
      await fsp.rm(dest, { force: true });
    }
  }

  if (!size) {
    // No content-length means nothing to verify against; one shot and a warning
    // beats silently trusting a stream that may end early.
    console.warn(`[warn]   ${file}: server sent no content-length, cannot verify`);
    const res = await fetch(`${BASE}/${file}`);
    if (!res.ok) throw new Error(`GET ${file}: ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    await fsp.rename(tmp, dest);
    return dest;
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let have = (await fsp.stat(tmp).catch(() => null))?.size ?? 0;
    if (have > size) { await fsp.rm(tmp, { force: true }); have = 0; }
    if (have === size) break;

    const where = have ? `resume from ${mb(have)} of ${mb(size)}` : mb(size);
    const tries = attempt > 1 ? `  [attempt ${attempt}/${attempts}]` : '';
    console.log(`[fetch]  ${file} (${where})${tries}`);

    try {
      const res = await fetch(`${BASE}/${file}`, {
        headers: have ? { Range: `bytes=${have}-` } : {},
      });
      // 206 means the range was honoured. A plain 200 to a ranged request means
      // the server ignored it and is resending the whole file from byte zero.
      let append = false;
      if (have && res.status === 206) append = true;
      else if (have && res.status === 200) await fsp.rm(tmp, { force: true });
      else if (!res.ok) throw new Error(`GET ${file}: ${res.status}`);

      await pipeline(
        Readable.fromWeb(res.body),
        fs.createWriteStream(tmp, append ? { flags: 'a' } : {}),
      );
    } catch (err) {
      console.warn(`[warn]   ${file}: ${err.message}`);
    }

    const now = (await fsp.stat(tmp).catch(() => null))?.size ?? 0;
    if (now === size) break;
    if (attempt === attempts) {
      throw new Error(`${file}: stalled at ${mb(now)} of ${mb(size)} after ${attempts} attempts`);
    }
    await sleep(Math.min(30_000, 2 ** attempt * 500));
  }

  await fsp.rename(tmp, dest);
  console.log(`[ok]     ${file} (${mb(size)})`);
  return dest;
}

/** Line reader over a gzipped TSV, header row already consumed. */
async function* tsvRows(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    if (line) yield line.split('\t');
  }
}
// #endregion

// #region ---------------------------------------------------------- schema
const SCHEMA = `
-- WAL rather than the usual bulk-load journal_mode=OFF. OFF is faster, but it
-- also means any interruption leaves a corrupt file — and on this host the
-- process is killed routinely, which would make the pass checkpoints below
-- worthless. WAL + NORMAL keeps commits atomic across a kill.
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
-- Bound SQLite's own memory (32 MB) and keep big sorts on disk. The window
-- function in passNames sorts millions of rows; it must not do that in RAM.
PRAGMA cache_size = -32000;
PRAGMA temp_store = FILE;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS titles (
  tconst         TEXT PRIMARY KEY,
  titleType      TEXT NOT NULL,
  primaryTitle   TEXT NOT NULL,
  originalTitle  TEXT,
  isAdult        INTEGER NOT NULL DEFAULT 0,
  startYear      INTEGER,
  runtimeMinutes INTEGER NOT NULL,
  genres         TEXT
);

-- One row per (title, normalized form, source). Both the article-stripped and
-- unstripped forms are present, per §2 — matching hits either.
CREATE TABLE IF NOT EXISTS title_norm (
  norm     TEXT NOT NULL,
  tconst   TEXT NOT NULL,
  source   TEXT NOT NULL,          -- primary | original | aka
  region   TEXT,
  language TEXT
);

-- Director + top-3 cast, flattened to what corroboration actually needs.
CREATE TABLE IF NOT EXISTS credits (
  tconst   TEXT NOT NULL,
  category TEXT NOT NULL,          -- director | cast
  name     TEXT NOT NULL,          -- normalized full name
  tokens   TEXT NOT NULL           -- space-joined tokens of length >= 4
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_norm        ON title_norm(norm);
CREATE INDEX IF NOT EXISTS idx_norm_tconst ON title_norm(tconst);
CREATE INDEX IF NOT EXISTS idx_year        ON titles(startYear);
CREATE INDEX IF NOT EXISTS idx_credits     ON credits(tconst);
`;
// #endregion

// #region ---------------------------------------------------------- passes
const nz = v => (v === '\\N' || v === '' || v == null ? null : v);

// Each pass records itself here on completion. The host kills this process
// often enough that restarting a 20-minute build from zero is the expensive
// choice; resuming costs at most the pass that was in flight.
//
// A set rather than an ordered position, because --no-principals must not
// leave a marker that makes a later full build believe the credits passes
// already ran.
function completedPasses(db) {
  const v = db.prepare('SELECT value FROM meta WHERE key = ?').get('passes')?.value;
  return new Set(v ? v.split(',').filter(Boolean) : []);
}

function markPass(db, name) {
  const done = completedPasses(db);
  done.add(name);
  db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)')
    .run('passes', [...done].join(','));
}

const passDone = (db, name) => completedPasses(db).has(name);

/** Rebuild the kept-tconst set from the DB when resuming past passBasics. */
function loadKeep(db) {
  const keep = new Set();
  for (const row of db.prepare('SELECT tconst FROM titles').iterate()) keep.add(row.tconst);
  return keep;
}

function insertNormRows(stmt, tconst, title, source, region, language) {
  for (const v of normVariants(title)) {
    stmt.run(v, tconst, source, region, language);
  }
}

async function passBasics(db, file) {
  const ins = db.prepare(
    `INSERT OR REPLACE INTO titles
     (tconst,titleType,primaryTitle,originalTitle,isAdult,startYear,runtimeMinutes,genres)
     VALUES (?,?,?,?,?,?,?,?)`);
  const insNorm = db.prepare(
    `INSERT INTO title_norm (norm,tconst,source,region,language) VALUES (?,?,?,?,?)`);

  const keep = new Set();
  let seen = 0;
  db.exec('BEGIN');
  for await (const [tconst, titleType, primaryTitle, originalTitle,
                    isAdult, startYear, , runtimeMinutes, genres] of tsvRows(file)) {
    seen++;
    if (!KEEP_TYPES.has(titleType)) continue;
    if (runtimeMinutes === '\\N' || !runtimeMinutes) continue;

    ins.run(tconst, titleType, primaryTitle, nz(originalTitle),
            isAdult === '1' ? 1 : 0, nz(startYear) ? Number(startYear) : null,
            Number(runtimeMinutes), nz(genres));

    insertNormRows(insNorm, tconst, primaryTitle, 'primary', null, null);
    if (originalTitle && originalTitle !== primaryTitle) {
      insertNormRows(insNorm, tconst, originalTitle, 'original', null, null);
    }
    keep.add(tconst);
    if (keep.size % 200000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); }
  }
  db.exec('COMMIT');
  console.log(`[basics] ${seen.toLocaleString()} rows -> ${keep.size.toLocaleString()} features`);
  markPass(db, 'basics');
  return keep;
}

async function passAkas(db, file, keep) {
  const insNorm = db.prepare(
    `INSERT INTO title_norm (norm,tconst,source,region,language) VALUES (?,?,?,?,?)`);
  let seen = 0, kept = 0;
  db.exec('BEGIN');
  for await (const [titleId, , title, region, language] of tsvRows(file)) {
    seen++;
    if (!keep.has(titleId) || !title || title === '\\N') continue;
    insertNormRows(insNorm, titleId, title, 'aka', nz(region), nz(language));
    if (++kept % 500000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); }
  }
  db.exec('COMMIT');
  console.log(`[akas]   ${seen.toLocaleString()} rows -> ${kept.toLocaleString()} localized titles`);
  markPass(db, 'akas');
}

/**
 * Stage every director and billed-cast row for a kept title.
 *
 * This used to accumulate a Map of ~800k titles plus a Set of ~2M name ids in
 * the JS heap — roughly a gigabyte. On a 4 GB VM with no virtio-balloon device
 * that memory is never returned to the host, and the host responds by killing
 * the whole guest. Staging into SQLite instead keeps the heap flat.
 *
 * Trimming to the top three billed happens later in SQL, using IMDb's own
 * `ordering` column, so the result no longer depends on rows arriving in
 * tconst order the way the previous in-memory version quietly assumed.
 */
async function passPrincipals(db, file, keep) {
  db.exec(`CREATE TABLE IF NOT EXISTS staged_credits (
             tconst TEXT NOT NULL, ordering INTEGER,
             nconst TEXT NOT NULL, category TEXT NOT NULL)`);

  // This is the longest pass and the one the host most often kills. Restarting
  // it from zero each time means it can never finish on a machine that dies
  // every few minutes, so it resumes from the last committed tconst instead.
  // principals is sorted by tconst, so "already past it" is a valid skip.
  const resumeAt = db.prepare('SELECT value FROM meta WHERE key = ?')
                     .get('principals_at')?.value ?? null;
  if (resumeAt) console.log(`[princ]  resuming after ${resumeAt}`);
  else db.exec('DELETE FROM staged_credits');

  const ins = db.prepare(
    'INSERT INTO staged_credits (tconst,ordering,nconst,category) VALUES (?,?,?,?)');
  const mark = db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)');

  let seen = 0, kept = 0, skipping = Boolean(resumeAt), last = null;
  db.exec('BEGIN');
  for await (const [tconst, ordering, nconst, category] of tsvRows(file)) {
    seen++;
    // Decompressing and discarding is far cheaper than re-inserting, and gzip
    // cannot be seeked, so catching up means reading from the top.
    if (skipping) {
      if (tconst <= resumeAt) continue;
      skipping = false;
    }
    if (!keep.has(tconst)) continue;
    if (category !== 'director' && category !== 'actor' && category !== 'actress') continue;
    ins.run(tconst, Number(ordering) || 0, nconst,
            category === 'director' ? 'director' : 'cast');
    last = tconst;
    if (++kept % 500000 === 0) {
      // Commit the checkpoint with the rows it describes, so a kill between
      // the two cannot leave the marker ahead of the data.
      mark.run('principals_at', last);
      db.exec('COMMIT'); db.exec('BEGIN');
    }
  }
  db.exec('COMMIT');
  console.log(`[princ]  ${seen.toLocaleString()} rows -> ${kept.toLocaleString()} credits staged`);
  markPass(db, 'principals');
}

/**
 * Attach names to the staged credits. Streams all of name.basics into SQLite
 * rather than building a JS Map of it, for the same reason as above.
 */
async function passNames(db, file) {
  db.exec(`CREATE TABLE IF NOT EXISTS staged_names (
             nconst TEXT PRIMARY KEY, primaryName TEXT NOT NULL)`);

  // Staging and joining are checkpointed separately: the join is the part that
  // usually gets killed, and re-streaming 15M names to redo it is 90 seconds
  // of work this machine cannot reliably spare.
  if (passDone(db, 'names_staged')) {
    const n = db.prepare('SELECT COUNT(*) c FROM staged_names').get().c;
    console.log(`[resume] ${n.toLocaleString()} people already staged`);
  } else {
    db.exec('DELETE FROM staged_names');
    const ins = db.prepare(
      'INSERT OR IGNORE INTO staged_names (nconst,primaryName) VALUES (?,?)');
    let people = 0;
    db.exec('BEGIN');
    for await (const [nconst, primaryName] of tsvRows(file)) {
      if (!primaryName || primaryName === '\\N') continue;
      ins.run(nconst, primaryName);
      if (++people % 500000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); }
    }
    db.exec('COMMIT');
    markPass(db, 'names_staged');
    console.log(`[names]  ${people.toLocaleString()} people staged`);
  }

  db.exec('DROP TABLE IF EXISTS staged_top');
  db.exec(`CREATE TABLE staged_top AS
             SELECT tconst, nconst, category FROM (
               SELECT tconst, nconst, category,
                      ROW_NUMBER() OVER (PARTITION BY tconst, category
                                         ORDER BY ordering) AS rn
               FROM staged_credits)
             WHERE category = 'director' OR rn <= 3`);

  // A join that was killed halfway leaves partial credits behind; it is a
  // derived table, so clearing it is cheaper than trying to resume into it.
  db.exec('DELETE FROM credits');

  const insCredit = db.prepare(
    'INSERT INTO credits (tconst,category,name,tokens) VALUES (?,?,?,?)');
  const join = db.prepare(`SELECT t.tconst, t.category, n.primaryName
                           FROM staged_top t JOIN staged_names n ON n.nconst = t.nconst`);

  let rows = 0;
  db.exec('BEGIN');
  for (const row of join.iterate()) {
    const norm = normalize(row.primaryName);
    if (!norm) continue;
    // Short tokens ("de", "van", "kim") match too much ordinary prose to be
    // evidence that a description is talking about this particular person.
    const tokens = norm.split(' ').filter(t => t.length >= 4);
    insCredit.run(row.tconst, row.category, norm, tokens.join(' '));
    rows++;
  }
  db.exec('COMMIT');

  for (const t of ['staged_top', 'staged_names', 'staged_credits']) {
    db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  console.log(`[names]  ${rows.toLocaleString()} credits attached`);
  markPass(db, 'names');
}
// #endregion

// #region ---------------------------------------------------------- main
/** The dataset stamp a partial build was started against, if there is one. */
async function priorStamp(dbPath) {
  if (!(await fsp.stat(dbPath).catch(() => null))) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const v = db.prepare('SELECT value FROM meta WHERE key = ?').get('dataset')?.value ?? null;
    db.close();
    return v;
  } catch {
    return null;   // unreadable or half-written — treat as no prior build
  }
}

export async function buildIndexFile({ cacheDir = '.cache', principals = true, force = false, fetchOnly = false } = {}) {
  await fsp.mkdir(cacheDir, { recursive: true });
  const dbPath = path.join(cacheDir, 'imdb.sqlite');

  const stamp = await remoteStamp(DATASETS.basics);
  const files = {};
  for (const key of principals ? Object.keys(DATASETS) : ['basics', 'akas']) {
    files[key] = await ensureLocal(DATASETS[key], cacheDir, { force });
  }

  // Downloading is the step that fails on a flaky link; indexing is the step
  // that needs headroom. Splitting them lets each be retried on its own.
  if (fetchOnly) {
    console.log('[done]   datasets present, --fetch-only so stopping here');
    return null;
  }

  if (force) {
    await fsp.rm(dbPath, { force: true });
  } else {
    const prior = await priorStamp(dbPath);
    if (prior && prior !== stamp) {
      console.log('[reset]  IMDb published a new dump since this build started');
      await fsp.rm(dbPath, { force: true });
    }
  }

  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run('dataset', stamp);

  const t0 = Date.now();
  let keep;
  if (passDone(db, 'basics')) {
    keep = loadKeep(db);
    console.log(`[resume] basics done — ${keep.size.toLocaleString()} features already indexed`);
  } else {
    keep = await passBasics(db, files.basics);
  }

  if (passDone(db, 'akas')) console.log('[resume] akas done');
  else await passAkas(db, files.akas, keep);

  if (principals) {
    if (passDone(db, 'principals')) console.log('[resume] principals done');
    else await passPrincipals(db, files.principals, keep);

    if (passDone(db, 'names')) console.log('[resume] names done');
    else await passNames(db, files.names);
  }
  keep = null;   // ~800k strings; let it go before the index build allocates

  // Always run: every statement is IF NOT EXISTS, so this is a cheap no-op
  // when they exist, and it must not be skipped when a later run adds credits.
  console.log('[index]  building indexes…');
  db.exec(INDEXES);

  const put = db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)');
  put.run('built', new Date().toISOString());
  put.run('titles', String(db.prepare('SELECT COUNT(*) c FROM titles').get().c));
  markPass(db, 'done');

  // VACUUM last and unguarded by a transaction: it rewrites the whole file, so
  // it is the one step worth losing to a kill rather than repeating cheaply.
  db.exec('VACUUM');
  db.close();

  const st = await fsp.stat(dbPath);
  console.log(`[done]   ${dbPath} ${(st.size / 1e6).toFixed(0)} MB in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
  return dbPath;
}

function parseArgs(argv) {
  const a = { cacheDir: '.cache', principals: true, force: false, fetchOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--cache') a.cacheDir = argv[++i];
    else if (k === '--no-principals') a.principals = false;
    else if (k === '--force') a.force = true;
    else if (k === '--fetch-only') a.fetchOnly = true;
  }
  return a;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildIndexFile(parseArgs(process.argv)).catch(e => { console.error(e); process.exit(1); });
}
// #endregion
