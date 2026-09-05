# IMDb Resolver — implementation brief

Repo: `stremio-youtube-cinema`
Module: `src/resolve/` — build this before anything else depends on it.

## Purpose

Map a YouTube upload to an IMDb `tconst`, with a confidence score. Everything
downstream needs this:

- Stremio stream handler keys on `tt…` ids, not `yt:…`
- Titlovi / OpenSubtitles addons only fire on `tt…`
- Cinemeta supplies posters, cast and ratings for free once ids are real
- Runtime validation is a by-product of the same matching work

**A wrong match is worse than no match.** A bad `tconst` makes every other addon
in the user's stack confidently serve the wrong thing — subtitles for a
different film, the wrong synopsis, the wrong poster. Publish nothing below the
confidence floor.

---

## 1. Reference data

Source: `https://datasets.imdbws.com/` — gzipped TSV, refreshed daily,
IMDb non-commercial licence (fine for personal use; revisit if this is ever
hosted as a public service).

| file | size (uncompressed) | needed for |
|---|---|---|
| `title.basics.tsv.gz` | ~676 MB | primaryTitle, originalTitle, startYear, runtimeMinutes, genres |
| `title.akas.tsv.gz` | ~1.4 GB | localized titles — **mandatory**, not optional |

`title.akas` is what makes Mosfilm, Korean Film Archive and the HK channels
resolvable at all. Without it, anything not posted under its English release
title fails.

### Ingestion

Stream both through `zlib.createGunzip()` + `readline`. Do not load either into
memory whole, and do not commit them to the repo.

1. Pass 1 — `title.basics`: keep rows where
   `titleType ∈ {movie, tvMovie, video}` **and** `runtimeMinutes != '\N'`.
   Expect ~1.1M rows. Insert into SQLite. Hold the `tconst` set in memory
   (~1.1M strings, acceptable).
2. Pass 2 — `title.akas`: keep rows whose `titleId` is in that set.
   Store `title`, `region`, `language`.
3. Index on a `norm_title` column (see §2), not on the raw title.

Cache the built SQLite file between Actions runs with `actions/cache`, keyed on
the dataset's `last-modified`. Rebuilding from scratch every week is ~10 min of
CI time for data that barely changes.

---

## 2. Normalization

Applied to both sides before comparison. One function, used everywhere —
asymmetric normalization is the classic source of silent misses.

```
normalize(s):
  NFD decompose, strip combining marks   // "Ivan Grozný" -> "Ivan Grozny"
  lowercase
  strip punctuation -> space
  collapse whitespace
  strip leading article: the|a|an|le|la|les|el|los|der|die|das|il|lo
```

Keep the article-stripped and unstripped forms both indexed; match against
either. Do not strip trailing roman numerals — `Rocky II` is not `Rocky`.

The YouTube side additionally runs the existing `cleanTitle()` from `indexer.js`
first. Keep `rawTitle` on every record so failures are debuggable.

---

## 3. Candidate generation

In order, stopping when a tier yields hits:

1. Exact `norm_title` match on `primaryTitle` or `originalTitle`
2. Exact `norm_title` match on any `akas` row
3. Trigram / Levenshtein ≥ 0.85 against titles filtered to
   `startYear ∈ [extractedYear ± 1]` — only attempt this when a year was
   extracted, or the candidate set is unbounded

Cap at 25 candidates. More than that means the title is too generic to resolve
safely — route to review.

---

## 4. Scoring

Score each candidate 0–100. Weights are a starting point; tune against a hand-
labelled set (see §7).

| signal | max | rule |
|---|---|---|
| title | 50 | exact primary/original = 50; exact aka = 44; fuzzy = 50 × ratio |
| year | 20 | exact = 20; ±1 = 14; ±2 = 6; absent from YT title = 8 (neutral, not 0) |
| runtime | 20 | see below |
| corroboration | 10 | director or top-3 cast surname found in YT description = 10 |

Absent year scores neutral rather than zero — plenty of legitimate uploads omit
it, and penalising absence just pushes good matches under the floor.

### Runtime scoring

`delta = (ytRuntimeMin - imdbRuntimeMin) / imdbRuntimeMin`

| delta | points | why |
|---|---|---|
| −2% … +3% | 20 | direct match, allowing for a channel intro/outro |
| −6% … −2% | 17 | PAL speedup — 24fps film on 25fps runs ~4% **short**. Normal, not suspicious. |
| +3% … +12% | 12 | restored or director's cut |
| −20% … −6% | 6 | TV edit, or a cut print |
| < −45% | **reject candidate** | this is part 1 of a split upload, not the film |
| > +60% | **reject candidate** | double feature or a compilation upload |

Runtime is most valuable as a **discriminator**, not a validator. Three
`tconst`s match "Nosferatu"; runtime picks which one. Weight it accordingly in
tie-breaks.

---

## 5. Decision

```
best   = highest scoring candidate
margin = best.score - secondBest.score   // 100 if only one candidate

accept        if best.score >= 85 and margin >= 12
needs-review  if best.score >= 60
reject        otherwise
```

The margin gate matters as much as the floor. Two candidates at 88 and 86 is
a coin flip dressed up as confidence — send it to review.

### Hard flags — override the score, always route to review

- `imdb.startYear >= currentYear - 5` — a recent theatrical title on a free
  channel is almost always an unlicensed upload, whatever the match quality
- `imdb.isAdult == 1`
- the same `tconst` resolved from two different videos — keep the higher score,
  flag the loser as a duplicate
- `titleType == 'video'` **and** score < 90 — that type is noisy

---

## 6. Output

Two files. Only the first is published.

`out/resolved.json`
```json
{
  "ytId": "m3BKVSpP80s",
  "imdbId": "tt0031051",
  "confidence": 93,
  "margin": 41,
  "signals": { "title": 50, "year": 20, "runtime": 17, "corroboration": 6 },
  "ytRuntimeMin": 78,
  "imdbRuntimeMin": 81,
  "channel": "PizzaFlix",
  "group": "PublicDomain",
  "firstSeen": "2026-09-05",
  "lastVerified": "2026-09-05"
}
```

`out/needs-review.json` — same shape plus `candidates[]` (top 5 with scores)
and `reason` (`low-score` | `narrow-margin` | `recent-year` | `adult` |
`duplicate` | `too-many-candidates`).

Review entries are never served. A human promotes them by adding the `ytId` →
`imdbId` pair to `config/overrides.json`, which the resolver consults **before**
scoring and treats as confidence 100. That file is the escape hatch for
everything the heuristics get wrong, and it should be PR-able.

---

## 7. Tests

Build the labelled fixture set first — this is what lets you tune weights
without guessing.

- 40 hand-verified `(rawTitle, channel, runtimeMin) -> tconst` pairs, spread
  across PizzaFlix, Mosfilm, Korean Classic Film, Goldmines and Movie Central.
  The non-English ones are the whole point; don't stack the set with easy
  English cases.
- Assert precision on the accept tier ≥ 0.98. Recall is secondary — a film
  sitting in review costs nothing, a wrong `tt` costs a user's subtitle track.
- Unit-test `normalize()` against diacritics, articles, and roman numerals.
- Unit-test the runtime bands at each boundary, including the PAL case.
- One golden test: a title with three real IMDb collisions (`Nosferatu`,
  `Django`, `The Killers`) must pick correctly on runtime alone.

---

## 8. Interface

```js
// src/resolve/index.js
export async function buildIndex({ cacheDir })        // -> IMDbIndex
export function resolveOne(video, index, opts)         // -> Resolution
export async function resolveAll(catalog, index, opts) // -> { resolved, review }
```

Keep the scoring functions pure and separately exported — `scoreTitle`,
`scoreYear`, `scoreRuntime`, `scoreCorroboration`. They need to be testable
without an index, and tuning weights means calling them in isolation.
