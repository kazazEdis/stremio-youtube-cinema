# Serialization formats — review

Four places store data, and only two of them were an actual choice. Reviewed
2026-09-05 with measurements rather than intuition.

| Where | Format | Chosen or forced? | Verdict |
|---|---|---|---|
| `docs/` (served to Stremio) | JSON | **forced** by the addon protocol | keep |
| `out/*.json` (intermediates) | JSON | chosen | **move to SQLite** |
| `config/*.json` (hand-edited) | JSON | chosen | keep, with a caveat |
| `.cache/imdb.sqlite` | SQLite | chosen | keep |

---

## `docs/` — not a choice

The Stremio addon protocol is JSON over HTTP at fixed paths. Serving anything
else means the client cannot read it. There is no decision here.

Compression is already handled twice over and needs no work: measured 90-91%
on our own output, applied transparently by any HTTP server, and `publish.js`
already writes minified (no indent). 11 MB across 2,152 files, largest 1.17 MB.

## `out/*.json` — should be SQLite; two arguments below were wrong

**Corrected 2026-09-05.** The original entry defended JSON here on grounds that
do not hold up:

- *"Zero dependencies."* `node:sqlite` is built into Node 24. SQLite costs
  nothing extra. This was the main argument and it was simply false.
- *"Readable, which is how the bugs were found."* Weaker than claimed.
  `SELECT rawTitle, name FROM films WHERE status='reject' LIMIT 20` is more
  inspectable than the bespoke script it replaces, not less. Every diagnosis in
  this project — reject reasons by channel, sampled titles, residual script
  matches, duplicate counts — was hand-written JS that should have been a query.

What survives: for a write-once/read-once handoff, SQLite adds nothing.
`publish.js` reads `resolved.json` sequentially and emits `docs/`.

Where it clearly wins:

| | JSON today | SQLite |
|---|---|---|
| resolver checkpoint | 5.4 MB rewritten 9x per run | incremental inserts, WAL-safe |
| diagnostics | a bespoke script each time | one query |
| `report.js` diff | Maps assembled in JS | a JOIN |

The checkpoint matters most: it is exactly the artifact the host keeps killing,
and WAL is what kept the IMDb index intact through three kills where
`journal_mode=OFF` would have corrupted it.

**Not DuckDB**, even granting the dependency. Its edge is columnar analytics and
Parquet; this workload is point lookups and small scans. SQLite is better matched
*and* built in, so DuckDB would cost a ~50 MB ARM native binary to be worse here.
The dependency is not the reason to decline it.

See TODO #2.

## Original note: the memory argument against JSON was also wrong

An earlier version of this reasoning claimed loading `raw.json` whole was a
memory risk worth switching to NDJSON for. Measured, that is false:

```
out/raw.json      10.3 MB on disk -> 38 MB RSS to parse (3.7x), 8,276 films
as NDJSON          9.1 MB, 2.5 MB gzipped
```

38 MB against a 1 GB heap is not a problem. The OOM that did occur during
development came from `qYearWindow.all()` materialising millions of SQLite rows
in the fuzzy tier — NDJSON would not have prevented it, and the fix was to
stream that query and push its length filter into SQL.

So NDJSON would buy 1.2 MB and cost streaming complexity, for no measured
benefit. What plain JSON does buy is decisive here: **it can be read.** Most of
the bugs found in this project were found by eyeballing intermediate output —
titles resolving to cast lists, channel names left in keys, marketing text
swallowing the film name. A binary format would have hidden every one of them.

## `config/*.json` — keep, but `_comment` is a real wart

These files are hand-edited and PR-able, which is exactly where comments matter
most, and JSON has none. Hence the `_comment` key in `channels.json`,
`exclude.json` and `overrides.json`.

JSON5, JSONC or YAML would all be more pleasant. None ship with Node, so each
costs a dependency — and zero dependencies is why this project ran first try on
an ARM Android VM with 4 GB of RAM. A hand-rolled comment stripper would work
but invents a private dialect that editors and linters do not know.

`_comment` is ugly, valid everywhere, and costs no code. Keeping it.

## `.cache/imdb.sqlite` — keep; Parquet is the wrong shape

Parquet was considered seriously. The data is close to ideal for it:

```
title_norm   6,843,665 rows
  tconst       809,556 distinct  (8.5x repetition -> dictionary encoding)
  source             3 distinct  (-> RLE, essentially free)
  region/language  244 / 101     (-> dictionary)
```

Row-oriented gzip already reaches 60% on the file; columnar encoding would
plausibly reach 85-90%, taking 1.6 GB to roughly 250 MB.

It is still the wrong tool, for three reasons:

1. **Access pattern.** The resolver performs ~30,000 point lookups per run
   (`WHERE norm = ?`, once per title variant per film). SQLite answers each from
   a B-tree in microseconds. Parquet is columnar with no index; even with
   row-group statistics, `norm` is unsorted, so each lookup degrades toward a
   scan of 6.8M rows. Parquet wins at scan-and-aggregate; this workload seeks.
2. **Dependencies.** Node has no Parquet reader. DuckDB is a ~50 MB native
   binary needing an ARM build; `parquetjs` is thinly maintained. `node:sqlite`
   is built in.
3. **It optimises nothing.** The file never ships to users, the dev box has
   139 GB free, and it sits inside the Actions cache's 10 GB limit. The cache
   key is an md5 of IMDb's `last-modified`, which changes daily, so on a weekly
   cron it never hits and the index is rebuilt regardless — see TODO #7.

**Where the instinct is right:** if rebuilding the index weekly becomes the
annoyance, ship a prebuilt one as a **GitHub Release asset** (2 GB per-file
limit, versus 100 MB for a committed file) compressed with `zstd -19` — roughly
70-75%, so ~400 MB. Same benefit, no format change, no dependency, no
query-speed regression.

---

## The rule this all follows

Change *what* is stored before changing *how* it is encoded. Every size problem
encountered here was better solved by storing less (streaming the year window,
pushing the length filter into SQL, dropping 3,243 films that yielded 145) than
by re-encoding the same data more densely.
