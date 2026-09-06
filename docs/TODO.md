# TODO

Ordered by value. Rationale is kept with each item because most of these exist
in response to something that actually broke, and that context is the reason to
do them in this order rather than a more obvious one.

Status as of 2026-09-05: 8,276 films indexed (Croatia), 2,102 published,
2,404 in review, 25.4% resolve rate, 33 tests passing.

---

## DONE — TV series (2026-09-06)

317 episodes across 15 public-domain shows, live alongside 2,285 films.
`src/transform/episode.js` parses the marker, `scoreTypeMatch` in
`src/resolve/index.js` rejects a type mismatch outright, and the marts carry a
`series` type with `tt<series>:<season>:<episode>` stream ids.

Two of the three follow-ups recorded here were diagnosed wrong, and probing
them turned up a larger defect. Both corrections are below.

- ~~**The fuzzy tier's early break is order-dependent**, and cost
  `Get Christie Love!` when the index grew by 377k series.~~ **Wrong.** The
  channel uploaded it as `Christie Love! (1974 Crime) Teresa Graves`, without
  the leading *Get*. No normalization of that string reaches `tt0071548`, and
  no candidate generator could have. Pinned in `config/overrides.json` to the
  1974 tvMovie rather than the same-named tvSeries `tt0070990`, on the upload's
  74-minute runtime. The early-break concern may still be real; this was not
  evidence of it.
- ~~**`Sapphire and Steel` may be an aka-coverage gap.**~~ **Wrong, and not
  worth fixing.** `normalize` turns every non-alphanumeric into a separator, so
  IMDb's `Sapphire & Steel` becomes `sapphire steel` while the upload's
  `Sapphire And Steel` keeps its conjunction. A real asymmetry — but mapping
  `&` to `and` was measured against all 3,720 `no-candidates` uploads and would
  reach **7** index titles, of which one (`tt0078682`) is plausible and six are
  unrelated modern films that would become candidates for the scorer to reject.
  One title does not justify a 15-minute index rebuild plus six new decoys.
  Separately, 12 of the 14 Sapphire and Steel uploads are
  `<Story> | Pt N | <Show> | FULL EPISODE`, a layout `parseEpisode` declines on
  purpose.
- **Series scoring is unmeasured.** The 20-point type signal was reasoned, not
  tuned. The review queue is the evidence for a first tuning pass. Still open.

## DONE — the title picked the star instead of the film (2026-09-06)

Probing the two items above surfaced the real defect. **93 uploads resolved to
nothing because `cleanTitle` returned an actor's name** — measured by matching
every `no-candidates` clean title against the index's `credits` table, where no
film is called *Rutger Hauer*. The true count is higher, since `credits` only
covers titles already in `KEEP_TYPES`.

The cause was tier 2 of `pickSegment`, which required a segment untouched by the
marketing strip. On the commonest layout there is —

    New World Disorder FULL MOVIE | Rutger Hauer | Action Movies | The Midnight Screening

— the marketing sits *on* the title, so the star's segment is the only clean one
and position lost to tidiness. Tier 2 now prefers the opening segment when
anything survives both the marketing strip and a genre vocabulary, which
separates `New World Disorder FULL MOVIE` from `Action Movies`.

Three narrower fixes were tried and **rejected on measurement**, each against
all 22,453 uploads scored by exact index hits:

| change | net hits | why rejected |
|---|---|---|
| relax tier 2 everywhere, not just at segment 0 | +49 | promoted genre tails (`Hemingway Fishing Drama`) over real titles ahead of them |
| treat a trailing name-shaped segment as a credit | −37 | `… \| Action Western Movie \| Michael Paré` and `… \| Free Movie \| Caged Birds` are the same shape; shape alone cannot tell a star from a title |
| stop treating bare `with` as a cast hint | −11 | it was accidentally vetoing hooks (`Trapped With A Killer Dog`) that `looksLikeHook` misses below its six-word floor |

The last one has since been taken — see below. The other two stand rejected.

## DONE — "with" separated into its three jobs (2026-09-06)

`with` does three things on these channels: it introduces a credit ("All Tied
Up (1993) with Teri Hatcher"), it joins two noun phrases in an ordinary title
("Poker with Pistols", "Roll With It", "Go with God, Gringo"), and it hangs a
prepositional phrase off a clickbait clause ("Trapped With A Killer Dog",
"Husband's Secret Meetings with Mobsters"). Vetoing every one cost the titles;
vetoing none cost eleven hooks.

**Length separates them, and cleanly**: a title spends its words on the two
nouns and stays under five, while a hook has already said something before it
reaches `with`. All eleven hooks are five words or more; none of the titles
below five is a hook. **+5 exact index matches, zero losses.**

### The hook floor was the obvious fix, and it is wrong

Lowering `looksLikeHook`'s six-word floor to five is worth **+55** exact index
matches across all 22,453 uploads, and it must not be taken. A five-word
Title-Cased segment is the commonest shape a real film of this era has, and it
is indistinguishable from a hook — convicting it drops the pick through to
whatever follows, which on these channels is the star:

    The Last Man On Earth        ->  Vincent Price
    The Hunchback Of Notre Dame  ->  Lon Chaney
    Attack Of The Crab Monsters  ->  Roger Corman
    The Day Of The Triffids      ->  Thriller Action Movies

Seventy-five losses of that kind against 130 gains of mostly modern clickbait.
The count says take it; the catalogue says don't. Pinned in
`test/clean-title.test.js` so the next person does not rediscover it.

Deprioritising a lone name-shaped segment so the fallback stops landing on
actors was tried as a rescue and measured **−137**: `Warning Shot`,
`Caged Birds`, `Final Instinct`, `Moving Parts`, `Rear View` and `Ice Sharks`
are all name-shaped, so the rule hands their uploads to the hook instead. That
is the third independent confirmation that person-shape and title-shape cannot
be told apart here, after the trailing-credit rule (−37) and the two channel
layouts that are shape-identical.

### New evidence for the §4 weights

The three recovered titles resolve **correctly** and are all held in review
just under the 85 floor, which is item 5 below, not a title problem:

| title | match | year | runtime | score | margin |
|---|---|---|---|---|---|
| Poker with Pistols | `tt0062139` Un poker di pistole | 1967 | 86 vs 86 | 82 | 100 |
| Go with God, Gringo | `tt0136595` | 1966 | 83 vs 79 | 80 | 100 |
| Roll With It | `tt10622260` | 2023 | 97 vs 115 | 70 | held on `recent-year` |

The first two have an exact runtime, an exact or exact-aka title, and **no
competing candidate at all** (`margin` 100). They fail only on the yearless
neutral 8. That is the KNOWN ISSUE in `test/scoring.test.js` measured on real
films rather than a fixture.

## DONE — one override no longer re-resolves the warehouse (2026-09-06)

Found by pinning `Get Christie Love!` and watching the run: `overrides_hash` is
a hash of the whole file, and the work-list compared it row by row, so a single
new entry put **all 11,979 eligible uploads** back through the scorer — over two
hours on this host to correct one film. The predicate now narrows that to rows
the file actually pins, plus rows last resolved *by* an override so that
deleting an entry re-resolves it honestly. `pendingSql` is exported and pinned
in `test/pending.test.js`, because a checkpoint that silently does too much and
one that silently does too little look identical from outside.

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

## `fct_resolution.score` is never written

All 3,588 accepted rows have `score IS NULL`; `confidence` carries the number
instead. Harmless today, but it is the column the weight tuning in item 5 will
want to read, and a NULL there will look like "no data" rather than "wrong
column". Cheap to fix while the schema is still moving.

## DONE — the titles that never reached the scorer (2026-09-06)

`no-candidates` was the largest bucket in the warehouse — 3,632 uploads whose
title matched nothing at all, so the weights never saw them. Two channel habits
account for most of it, and both are query-side problems rather than scoring
ones.

**The print label.** Channels carrying several dubs of one film label the print
in the title: `The Shaolin Invincibles WIDESCREEN`, `Kung Fu King DUTCH`,
`New big Boss (English Dub)`, `Shaolin Vs Manchu (Subtítulos en Español)`. The
language of the print is not part of the film's name, and left in it goes into
the normalized key and matches nothing — 470 Wu Tang uploads for this reason
alone. Only a *trailing* run is stripped, and only a bracket holding nothing
else, so `The English Patient` and `Spanish Harlem` keep their languages.

**The name inside the brackets.** Cinema Mei Ah writes the Chinese title and
puts the English release title in parentheses; the westerns hang marketing off
the title the same way:

    笑傲江湖II東方不敗 (Swordsman II)｜李連杰、關之琳｜粵語中字｜美亞影院
    The Taste Of The Savage (Eye For An Eye) Western Movie in Full Length

So the text before the first bracket, and each parenthetical, are tried as
additional lookup keys — still query-side and still additive. They are labelled
`exact-derived` so a bad match from a bracket is visible in the review queue
instead of hiding among the ordinary exact hits: 321 accepted, 202 in review.

Reaching for a bracket only happens **after the title as written finds
nothing**. Offering both at once cost a film: `Ever After (Reloaded)` is its own
real title, and `Reloaded` pulled in a rival that closed the margin to 10.

Rejected on measurement: `<name> in <title>` (71 uploads, roughly half wrong —
`Shaolin Roar In The Woods` → *The Woods*, `He Fights the Yakuza in Brazil` →
*Brazil*); and dropping single-word parentheticals to save the film above,
which would have cost 37 correct alternate titles (`(Maternal)`, `(Ruslan)`,
`(Otryv)`) to save one.

    rejects       3,826 -> 3,000
    films         2,727 -> 2,923      +196 added, 0 removed
    Cinema Mei Ah     0 ->    82      0% -> 53.6%, from a channel that published nothing
    Cult Cinema     385 ->   462      32.5% -> 39.0%
    Wu Tang         275 ->   313      11.6% -> 13.2%

### The fuzzy tier was dead for a whole pipeline pass

Wrapping the lookup keys in `{v, derived}` objects left one line reading
`v.length` off the wrapper. It is `undefined` on an object, the length band
emptied, and `generateCandidates` returned early **for every upload in the
catalogue** — no error, no warning. Fourteen published films went to
`no-candidates`: *Cathy's Curse*, *Bulldog Drummond's Peril*, *Steamboat Bill,
Jr.*, *Robot Monster* and others, all of them channels that type titles by hand
and drop apostrophes, which is precisely the case only the fuzzy tier ever
caught.

The `-19 dead` line in the publish diff is the only thing that showed it. There
is now a test that resolves `cathys curse` against an indexed `cathy s curse`
and asserts the tier is `fuzzy`, because a tier that silently stops running
looks exactly like a tier that finds nothing.

## DONE — two more shapes of lookup key (2026-09-06)

Same method as the brackets, same gate: a rebuilt key is only tried once the
title as written has found nothing.

**Dash segments.** Cult Cinema Classics and Public Domain Movies file uploads
as `<year> - <title> - <tagline>`, and the martial-arts channels put the
English and Spanish titles either side of a dash. Every segment becomes a key
and the scorer decides which one is the film — `Roy Rogers - 1946 - My Pal
Trigger - ...` offers both the star and the picture, and runtime settles it at
79/79 minutes and confidence 100.

Two guards, both earned: a bare year is not a title (`1952 - Invasion, U.S.A.`
offered `1952`, which is a real film) and neither is one shouted word
(`Fist Of Shaolin - ENGLISH - RIP` offered `ENGLISH`, likewise real).

**A shouted cast credit.** `Jason Statham, Ben Foster in THE MECHANIC`. The
same rule matched case-insensitively was measured at roughly half wrong —
`Shaolin Roar In The Woods` to *The Woods*, `He Fights the Yakuza in Brazil` to
*Brazil* — because `in` is an ordinary preposition. Requiring the tail to carry
no lowercase at all took it to 27 for 27.

    rejects            3,000 -> 2,623
    films              2,923 -> 3,055     +132 added, 0 removed
    Cult Cinema          462 ->   611     51.5%
    derived tier         321 ->   576 accepted

## Wu Tang Collection: no further tuning (2026-09-06)

Decided by the owner. The channel is 2,372 features and resolves at 13.4%; the
888 uploads still at `no-candidates` are the largest single block left, and
they are titles like `Right Overcomes Might`, `My Blade my Life` and
`Black Belt The Roaming Hero` — English release names invented per-distributor
that IMDb does not carry under any aka. The channel stays in the catalogue for
the 319 films it does resolve; it is simply not the place to spend effort.

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
