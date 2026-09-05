# Data pipeline

Four layers, each rebuildable from the one before it. The rule that matters:
**a layer never applies a business rule that the layer below cannot reproduce.**

```
  SOURCES              LANDING              STAGING            CORE              MARTS
  ───────              ───────              ───────            ────              ─────
  YouTube API   ──►  landing.sqlite  ──►  stg_upload    ──► dim_channel   ──►  docs/
  IMDb TSV           raw payloads         stg_title          dim_title          catalogs
  config/*.json      append-only          stg_aka            fct_upload         streams
                     never rewritten      typed, 1:1         fct_resolution     manifest

  extract              stage               transform          publish
```

## Why this exists

The pipeline previously filtered at ingest. `indexer.js` dropped any video
blocked in Croatia, so 2,779 films were discarded at the moment of collection
and could only be recovered by re-fetching from the API. Region is a *serving*
concern; discarding at ingest made a cheap decision permanent.

The same mistake in a second place: `cleanTitle` ran during extraction, so
`raw.json` stored an interpretation. Improving the heuristic meant re-cleaning
the whole catalog — done three times in one session.

Both are the same error. Layers fix it structurally rather than by discipline.

---

## 1. Landing — what the source said

`data/landing.sqlite`. **Append-only. Never updated, never deleted by the
pipeline.** One row per API response, stored as received.

    api_response(run_id, fetched_at, endpoint, params_hash, http_status, body)
    imdb_file(run_id, fetched_at, filename, last_modified, bytes, sha256)

No parsing, no filtering, no cleaning. If a downstream layer is wrong, it is
rebuilt from here without touching the network. This is the only layer whose
loss costs quota and wall-clock.

**Incremental extract.** `playlistItems` returns uploads newest-first, so
paging stops once it reaches a video already landed for that channel, plus a
small overlap for safety. The watermark is per channel:

    extract_watermark(channel_ref, last_ytid, last_published, last_run_id)

Today every run re-fetches up to 3,000 videos per channel regardless of whether
anything changed. Weekly, almost nothing does.

## 2. Staging — typed, one row per source record

Rebuilt from landing on every run. Parsing and typing only; still shaped like
the source. No business logic, no derived columns.

    stg_upload(ytId, channel_ref, raw_title, duration_s, published_at,
               view_count, embeddable, licensed, blocked_regions,
               allowed_regions, description, run_id)

`blocked_regions` and `allowed_regions` are *recorded*, never applied. That is
what makes serving other regions a mart change rather than a re-extract.

## 3. Core — conformed, business rules applied

    dim_channel(channel_key, ref, name, yt_channel_id, grp, valid_from, valid_to)
    dim_title(imdb_id, primary_title, original_title, start_year, runtime, ...)
    fct_upload(ytId, channel_key, clean_title, extracted_year, runtime_min, ...)
    fct_resolution(ytId, run_id, status, imdb_id, confidence, margin, signals...)

`clean_title` is computed **here**, not at extract. A heuristic change replays
transform over staging: minutes, no network, no quota.

`dim_channel` is slowly-changing because channels get renamed and terminated —
`report.js` already alarms on channels that produced last week and nothing now.

`fct_resolution` keeps `run_id`, so scoring changes are measurable against
history rather than only against the current state.

## 4. Marts — shaped for one consumer

`docs/`, the Stremio addon: manifest, catalogs, streams. Region filtering
applies here, reading `blocked_regions` from core. Adding a region becomes a
publish-time loop, not a re-collection.

---

## Cross-cutting

**Runs.** Every stage writes to `run(run_id, stage, started_at, finished_at,
status, rows_in, rows_out, notes)`. Lineage, timing, and a place for the
quality gates to record their verdict.

**Idempotence.** Every stage is safe to re-run and safe to kill. This host
terminates long processes routinely — roughly nine times in one session — so
restartability is a correctness requirement, not an optimisation.

**Quality gates**, run between core and marts and recorded on the run:
- catalog shrank more than 30% vs the last published mart -> fail
- a channel that produced last run produced nothing -> warn
- an accepted resolution below the confidence floor -> fail (should be impossible)
- duplicate imdb_id among accepted rows -> fail (should be impossible)

**What is deliberately not here:** separate physical databases per layer beyond
landing/warehouse, surrogate-key servers, and multi-fact conformed dimensions.
There is one fact of interest. Structure that does not earn its keep is cost.
