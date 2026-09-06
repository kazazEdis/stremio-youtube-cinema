# Resolving a YouTube upload to an IMDb id

The whole project turns on one judgement: is *this upload* *that film*? Get it
wrong and every other addon in the stack serves the wrong thing.

## The weights, and what each is worth

100 points. Accept at **85** with a **12**-point margin over the runner-up.

| signal | max | notes |
|---|---|---|
| title | 50 | exact primary 50, exact aka 44, fuzzy 50×ratio |
| year | 20 | exact 20, ±1 14, ±2 6, absent 8 — or 12, see below |
| runtime | 20 | banded; two bands **reject the candidate outright** |
| corroboration | 10 | director 10, cast 6 — from the YouTube description |
| type match | 20 | episodes only, replacing runtime |

**Runtime rejects.** Below −45% is part one of a split upload; above +60% is a
double feature. Those return `null` rather than a low score, because a
compilation that happens to share a title is not a weak match, it is a different
thing.

**The PAL band looks like a bug and is not.** 24fps film transferred at 25fps
runs about 4% *short*, so a systematic −4% delta is the signature of a normal
European master, not a cut print.

**Episodes score type agreement instead of runtime.** IMDb's `runtimeMinutes`
for a series is a nominal slot length — 30 for a show whose episodes run 22 —
and the feature bands are calibrated for 90-minute films, so at 22 minutes ±1
minute is ±4.5% and the top band is unreachable.

## The cliff at 84

The most instructive bug in the project. A flat neutral of 8 for a missing year
produced this:

    confidence 84  ->  1,194 reviewed uploads    98% of them yearless
    confidence 82  ->    249
    confidence 81  ->    239

A five-fold spike one point under the floor, and arithmetic rather than
coincidence: `50 title + 8 year + 20 runtime + 6 corroboration = 84` is the
commonest shape a **correct** match takes. The signal meant to stop absence
pushing good matches under the floor was doing exactly that.

The fix is not "lower the floor". The year's job is separating same-titled films
of different eras; when the title matched exactly and the runtime is top-band,
the era is already pinned, so absence stops being evidence against and the
neutral becomes 12. A fuzzy title or a loose runtime keeps the strict 8.

Two things that made it trustworthy:

- **An independent check.** The year written in the YouTube *description* — a
  signal the scorer never reads. Promoted uploads agreed 92.3% of the time
  against 94.0% for what was already published: the same bar, applied
  consistently, not a lower one.
- **The lift lands on the winner after ranking and margin are settled.** Putting
  it inside the per-candidate scorer reads *that candidate's* runtime, so a
  rival with a better runtime collects points the winner does not — runtime
  silently re-weighted from 20 to 24. It cost four already-published films their
  margin before the publish diff caught it.

## Candidate generation

Three tiers: exact primary/original, exact aka, then fuzzy — bounded to ±1 year
and a plausible length band. **The fuzzy tier is unavailable to yearless
uploads**, because without a year there is no window to scan and scanning 1.19M
titles per upload is not viable. That is a real, known limit, not an oversight.

Two things live here that are easy to get wrong:

- **Filter type-incompatible candidates *before* the cap.** Adding 377k series
  pushed generic titles like `Choices` and `Flight` past 25 candidates and into
  review, even though every extra candidate was a series a film could never
  match. Cost 15 films.
- **A rebuilt lookup key is a last resort.** Deriving keys from brackets and
  dashes recovers ~840 uploads, but only when the title *as written* found
  nothing. Offering both at once cost a film: `Ever After (Reloaded)` is its own
  real title, and also offering `Reloaded` pulled in a rival that closed the
  margin.

## Diagnostics worth keeping

`fct_resolution.score` is what §4 alone produced; `confidence` is what the floor
judged; `candidate_count` is how much competition there was. All three were NULL
for months — two columns that existed for tuning and never held anything, which
is worse than not having them, because a NULL reads as "no data" rather than
"wrong column".
