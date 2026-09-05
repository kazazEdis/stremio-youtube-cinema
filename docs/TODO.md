# TODO

Ordered by value. Rationale is kept with each item because most of these exist
in response to something that actually broke, and that context is the reason to
do them in this order rather than a more obvious one.

Status as of 2026-09-05: 8,276 films indexed (Croatia), 2,102 published,
2,404 in review, 25.4% resolve rate, 33 tests passing.

---

## DONE 2026-09-05 — items 1 and 2

`cleanTitle` now runs in `src/dwh/transform.js`, not during the fetch, and the
warehouse (`data/warehouse.sqlite`) replaces the JSON intermediates. The
resolver checkpoint is `fct_resolution` itself — `.cache/resolve-progress.json`
is retired.

Parallel-run verification against the old path: **576 films common, zero field
differences across 12 fields including `firstSeen`**; 1,504 absent only because
the parity extract used 500 uploads/channel against the old run's 3,000; 22
published under a different `ytId` because region now filters before duplicate
settling. Zero unexplained.

**Not yet cut over.** The live addon still serves the old path. Cutover needs a
full extract at `--max-per-channel 3000` first, or the catalog shrinks from
2,102 to 682 purely from universe size.

## ~~1. Move `cleanTitle` from index time to resolve time~~ (done)

`src/indexer.js` cleans titles as it fetches, so `out/raw.json` stores an
*interpretation* rather than a fact. Every heuristic fix therefore forced a
re-clean pass over the whole catalog — three times in one session.

Store only `rawTitle`; derive the name inside the resolver. Title fixes then
cost a re-resolve (~7 min, no network) and never a re-index.

This is first because it removes the last reason to ever re-run the indexer for
a non-YouTube reason.

## ~~2. Move `out/` from JSON to SQLite~~ (done)

One `out/catalog.sqlite` replacing `raw.json`, `resolved.json`,
`needs-review.json` and `resolve-progress.json`. `node:sqlite` is built in, so
this costs no dependency — the original argument for JSON here was wrong, see
`docs/FORMATS.md`.

- checkpointing becomes incremental instead of rewriting 5.4 MB nine times a run
- WAL makes it survive a kill mid-write, which the host does routinely
- diagnostics become queries instead of bespoke scripts
- `report.js`'s catalog diff becomes a JOIN

`docs/` stays JSON — that is the addon protocol, not a choice.

## 3. Work the review queue

2,404 entries, and the sampled ones are mostly *correct* matches sitting under
the 85 floor — "The Swan (1930)" resolved to `One Romantic Night` at 84.

- promote confirmed pairs into `config/overrides.json` (confidence 100, PR-able)
- the `src/resolve/probe.js` tool exists for exactly this: it prints the full
  candidate list with per-signal breakdowns

This is the catalog's largest untapped asset. It is ahead of weight tuning
because promoted entries are also the labelled set that tuning needs.

## 4. Build the §7 labelled fixture set (40 pairs)

Hand-verified `(rawTitle, channel, runtimeMin) -> tconst`, weighted toward the
non-English channels — Mosfilm, Korean Classic Film, Cinema Mei Ah — since those
are the cases the resolver is least able to self-check.

Must be hand-verified. Generating it from the resolver's own output would
measure the resolver against itself.

## 5. Tune the §4 weights

**Only after the items above.** Today's evidence: `no-candidates` was ~98% of all
rejections, meaning titles never reached the scorer at all. Tuning a scorer
that is not being called teaches the wrong lesson.

The known defect, pinned in `test/scoring.test.js` as `KNOWN ISSUE`: an exact
title with a *perfect* runtime scores 50 + 8 + 20 = 78, under the 85 floor. So
a yearless upload can never be published however good the match. §4 justifies
the neutral 8 by saying absence should not push good matches under the floor —
at 8 points it does exactly that.

## 6. yt-dlp verification of the weekly diff

`report.js` already computes added/changed entries — tens per week. At ~4.7s per
video that is minutes, and buys what the API cannot supply:

- real playability (regionRestriction is declarative; it misses age-gating and
  videos pulled since the last crawl)
- true max resolution (the API gives only `hd`/`sd`)
- subtitle tracks (the API gives only a caption boolean)

Verify the diff, never the catalog. Discovery stays on the API.

## 7. Deploy to GitHub Pages

`docs/` is 11 MB over 2,152 files, largest 1.17 MB — far under the 100 MB
per-file limit. Push, add `YT_API_KEY` as a repo secret, enable Pages on
`/docs`. The workflow in `.github/workflows/build-catalog.yml` already handles
the weekly rebuild.

An addon must answer whenever Stremio opens, and the dev VM cannot do that —
it was killed roughly nine times during one session.

## ~~8. Fix the Actions cache key~~ (done 2026-09-05)

Removed rather than fixed. The key was correct — it missed weekly because IMDb
republishes daily and the job runs weekly — but that meant writing a 1.6 GB
cache entry that expired unread. Rebuilding is free CI time and guarantees the
index matches the dataset stamp `fct_resolution.dataset` checks against.

`data/` (landing + warehouse) *is* cached now, on a rolling key, because losing
the extract watermarks costs roughly 60x in quota.

## ~~8. Fix the Actions cache key~~ — original note

`.github/workflows/build-catalog.yml` keys the IMDb cache on an md5 of the
dataset's `last-modified`. IMDb republishes **daily**, so a weekly cron never
hits it and rebuilds the index every run. It is free but ~13 minutes.

Either accept it and drop the cache step, or key on something coarser and accept
an index a few days stale. Right now the step is neither.

---

## Deferred, deliberately

**Multi-region.** Currently region is filtered at *index* time, so blocked films
are discarded rather than recorded — 2,779 of them. Serving other regions means
recording `blocked[]`/`allowed[]` and filtering at serve time, plus per-region
catalogs. Scope is Croatia until that changes.

**A different serialization format.** See `docs/FORMATS.md`.

**Devanagari-titled Hindi catalogs.** Removed 2026-09-05: 28% of indexed
uploads for 6% of published films. `config/exclude.json` now drops them by
script on any channel.
