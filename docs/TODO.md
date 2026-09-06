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
- ~~**Series scoring is unmeasured.**~~ Measured, see below.

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

## DONE — the diagnostic columns hold something (2026-09-06)

`score` was NULL on every accepted row and `candidate_count` on all but one
rejection path: two columns that existed for tuning and never held anything.

Rather than fill `score` with a copy of `confidence`, they now answer different
questions. `confidence` is what the floor judged; `score` is what §4 alone
produced, **before** the yearless lift; `candidate_count` is how much
competition there was. The first query paid for it:

    accepted rows the lift carried over the floor    1,016
      of which §4 had scored exactly 84                936
      of which §4 had scored 82                         80

    accepted rows with no rival candidate at all     3,303 of 4,868
    2-3 candidates                                     908
    4-10                                               515
    11+                                                141

That 936 is the cliff, as a number you can query rather than a shape in a
histogram.

A re-resolve with scoring untouched proved the change is diagnostic-only:
**manifest, every catalog page and all 3,085 stream files came out byte
identical.** Only `docs/catalog.json` — the internal dump `src/stremio.js`
reads, not a protocol endpoint — gained the `candidateCount` field.

Still NULL where nothing was scored, which is correct: 1 override (it never
reached the scorer) and 182 `too-many-candidates` rejections (the cap fires
before scoring).

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

## DONE — Wu Tang Collection dropped (2026-09-06)

The owner's call. The channel was 2,372 features resolving at 13.4%, and its
888 remaining `no-candidates` were the largest single block left in the
warehouse — titles like `Right Overcomes Might`, `My Blade my Life` and
`Black Belt The Roaming Hero`, English release names invented per-distributor
that IMDb carries under no aka. Nothing built today reached them and nothing
was going to.

Dropped through `config/exclude.json` (`groups: ["MartialArts"]`, whose only
channel it is) rather than by deleting anything: the uploads keep their landing
rows, transform gives them a `drop_reason`, and `fct_resolution` sheds their
2,383 rows on the next run. Reversible by removing one line.

    films        3,055 -> 2,736     -319
    resolve rate  36.7% ->  44.8%   the denominator lost 2,383 hard uploads

The run warns `silent channels: Wu Tang Collection` exactly once, which is
correct — a channel that was publishing 319 and now publishes none is worth
saying out loud. `findSilentChannels` compares against the previous report, so
the following run has no row to compare and stays quiet.

## DONE — a publish can no longer lie about what it wrote (2026-09-06)

A publish left `docs/stream/movie/tt0317268.json` at **zero bytes**. The host VM
was killed mid-run, and a kill here is power loss — the page cache went with it.
The catalogue still listed the film, so Stremio would have shown it and then
offered no stream at all, and **nothing in the pipeline would ever have said
so**. It surfaced only because a determinism check happened to diff two
consecutive publishes.

`verifyMarts` now reads back every stream file the catalogue promises and
checks it parses and carries the ytId just written, failing the build
otherwise. Three thousand small reads cost under a second. Pinned in
`test/verify-marts.test.js` against an empty file, a missing file, a stale
ytId, and an episode's composite id.

## DONE — the same cliff, on the series side (2026-09-06)

The yearless lift reads the runtime to decide whether the era is pinned, and
`scoreCandidate` zeroes the runtime for episodes **on purpose** — IMDb's series
runtime is a nominal slot length, not what an episode runs. So episodes were
structurally shut out of the fix and the identical cliff formed again:

    t50 y8 runtime0 c0  =  78   ->  170 episodes
    t50 y8 runtime0 c6  =  84   ->   90 episodes    one point under the floor

For an episode the type agreement *is* the corroboration: the candidate is a
`tvSeries` carrying that exact title, which is what the marker claimed. A year
would not have helped in any case, because IMDb's `startYear` is when the show
began while the upload carries the episode's own date — comparing them is a
category error, and it is why 37 episodes scored `y6` for being two years
"off".

    episodes   317 -> 349      shows 15 -> 20
    films      2,736 unchanged, 0 removed

All twenty published shows were checked against the index: every one is a
`tvSeries` with the right start year. Two shows the queue was holding are
**wrong and stayed held** — `TV!` (`cleanTitle` made that out of a
`|TV-1966|` marker on a Lucy Show upload) and `Soul`, which reached a 2009
series rather than the 1968 one. The floor caught both, which is the floor
working.

Joe 90 resolves correctly for 30 episodes and publishes none of them: the
uploads are `allowed_regions` US/Canada, so the Croatian filter drops them.
That is the gap between the 62 the simulation predicted and the 32 that shipped.

Still held: 170 episodes with no corroboration at all, at 82. Two signals do
not carry an episode any more than they carry a film.

## DONE — the streams are actually checked now (2026-09-06)

Everything else in this pipeline verifies our own reasoning: that a title
resolved to the right film, that the mart holds what the catalogue promises.
None of it asked the only question a viewer has — *does it play*. `extract.js`
names the risk in its own comments:

> a video deleted or newly geo-blocked since the last run is only noticed when
> it is re-hydrated

and offers `--full`, which re-hydrates all 22,453 uploads at 450 calls.
`npm run verify-streams` asks the sharper question for a fraction of that: the
published catalogue is ~3,000 ytIds, `videos.list` takes 50 at a time, so the
whole thing is **62 quota units out of 10,000 a day**.

First run, 2026-09-06: **3,085 of 3,085 playable.** Nothing deleted, nothing
private, nothing un-embeddable, nothing geo-blocked for HR. Written to
`docs/health.json`, and the 62 API responses are landed like every other call
so the result stays explainable later.

It reads the ytIds out of `docs/stream/**` rather than the warehouse on
purpose. The warehouse holds what we believe; the marts hold what we published,
and it is the published thing a viewer clicks. If those two ever disagree this
is the tool that notices.

It reports and does not act. A dead entry is a decision — quarantine it, drop
it, or re-resolve to a different upload of the same film — and that decision
wants numbers in front of it.

Wired into `build-catalog.yml` after publish, so `docs/health.json` is rebuilt
and committed with every weekly catalogue. `probe-playback` runs there too, at
150 a week — enough to cover anything new immediately and refresh all 3,893
streams roughly every six months. The publish is repeated after it, so a
quarantine or a dead upload takes effect the same run rather than a week later.

A runner is a datacenter IP and YouTube bot-checks those far more often than a
home connection. That is survivable rather than fatal: a throttled probe is
classified apart and never written, so a blocked run learns nothing instead of
recording a healthy film as dead. The step is `continue-on-error`
**on purpose**: it is diagnostic, and a quota error or a network blip must not
throw away a catalogue that published cleanly. Problems surface as a
`::warning::` in the Actions summary, the same way a silent channel does.

## DONE — the catalogue measured by a real client (2026-09-06)

**Complete: 3,893 of 3,893 streams**, every copy of every film, probed with
yt-dlp rather than sampled.

    3,857 play        33 age-gated       3 dead

The first attempt claimed this at 3,085, which was only the primaries:
`publishedStreams` read `streams[0]` of each file, so once a film could offer
several copies the alternates were invisible to it. 805 streams had never been
probed by anything, and one of the gated uploads found afterwards was a
fallback — the exact case that read could not reach.

The invariant that matters holds: **no gated stream leads a film that has a
working alternative** (0 of 33). The 27 that lead are the only copy of their
film, labelled `sign-in required`; the other 6 sit behind a stream that plays.

The primary streams alone, for comparison with what the API reported:

    3,054 play        31 age-gated      3 dead

    1080p  1,441  46.7%      480p        762  24.7%
    720p     330  10.7%      below 480p  390  12.6%
    4K       131   4.2%      no format    34   1.1%

    real subtitle tracks, not auto-captions: 912 of 3,088

**Three published films do not play and the Data API says they are fine.**
`The Little Princess` (tt0031580), `The Brave One` (tt0049030) and
`Gulliver's Travels` (tt0031397) all return "This video is not available"
reproducibly, while `videos.list` reports them public, embeddable and
unrestricted. None has a second copy, so nothing can be swapped in. The API's
metadata record simply outlives the video, which is the whole reason this probe
exists alongside `verify-streams`.

**Dropped, on the owner's call (2026-09-06).** `unreachable`, `private` and
`members-only` now remove the upload outright, because unlike a gated one there
is no viewer who can play it — an entry that always fails costs the click and
the trust, which is worse than no entry.

`unreachable` needs seeing **twice**: yt-dlp reports a throttled request and a
deleted video in much the same breath, and one bad minute must not delete a
film. `private` and `members-only` are unambiguous from a single probe. A single
success clears the count and the film returns.

Two films left the catalogue and one was rescued: *The Little Princess* had a
second copy, so the dead upload went and the film stayed on a 360p print.

    2,736 -> 2,734 films      -2 dead, 0 added

### Throttling is not a verdict

"Sign in to confirm you're not a bot" arrived on *The Little Princess* and was
recorded as `unreachable` — a permanent false verdict on a healthy film from
one busy minute, which the unprobed-first sampler would then never revisit.
Throttled probes are now classified apart and **not written at all**: a probe
that learned nothing must not count as coverage. The next probe of that video
returned the real answer, which happened to be that it is dead anyway.

## DONE — the runtime evidence audited against the videos (2026-09-06)

`duration-drift` was built to catch a video re-cut since we matched its runtime,
and it never fired. With all 3,857 playable streams measured, that is now a
result rather than an absence:

**Not one stored runtime has drifted.** Every duration landed at extract time
still describes the video to within two minutes. The signal carrying 20 of the
100 points in §4 is being scored on accurate input, which nothing had checked
before.

Against IMDb's runtime for the matched film:

    within 3%    2,688   69.7%
    within 10%     850   22.0%
    within 25%     317    8.2%
    beyond 25%       2    0.1%

That second table is **partly circular** and should not be read as a precision
measurement: runtime is a scoring input, so films that matched well on runtime
are over-represented among published ones by construction. What it does say is
that nothing in the catalogue is wildly off — two entries beyond 25%, and both
are *Rocky Jones, Space Ranger*, which was serialised in three-part chapters and
whose uploads carry a whole story under its first episode's number. A viewer
clicking E19 gets E19 and then some, which is not a wrong match.

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

## DONE — the part of playability only a real client sees (2026-09-06)

`verify-streams` covers existence, privacy, embeddability and region for the
whole catalogue at 62 quota units. `npm run probe-playback` covers what the
Data API does not carry, on a seeded sample spread across channels — at ~3.6s a
video, sampling is the only honest option.

**First run, 40 of 3,085: 39 play as published (97.5%).**

The one failure is the case this exists for. *Ivan's Childhood* (Mosfilm) is
**age-gated** — "Sign in to confirm your age" — and the Data API reports it as
`public` and `embeddable: true`, so `verify-streams` passes it and a viewer
still gets nothing. One in forty puts roughly 77 films in that state across the
catalogue, which is worth knowing and is a separate decision to act on.

Resolution, which the API grades only as `hd`/`sd`:

    2160   5      1080  23      752  1      480  7      ≤360  3

    PizzaFlix              480, 480, 480          (1,106 films, all SD)
    Mosfilm                2160 ×3, 1080 ×3, 480
    Grjngo                 2160, 1080 ×6, 342
    Cinema Mei Ah          1080 ×4, 480 ×3

Real subtitle tracks, as opposed to auto-captions: **10 of 40**.

### Two bugs it found in itself first

**A bare ytId is not safe to pass to yt-dlp.** 79 of the 4,868 published ids
begin with a dash, and yt-dlp reads `-rg5GhmZ5zo` as the `-r` rate-limit flag
and dies with a usage error — recorded as "unreachable". Ids go as watch URLs
now.

**The population was wrong.** The probe sampled the 4,868 *accepted*
resolutions when only 3,085 are *served*; the HR region filter and duplicate
settling both run at publish time. It duly reported two geo-blocked videos as
unreachable, which was true and irrelevant — publish had already dropped them.
It reads `docs/stream/**` now, which is the rule `verify-streams` states in its
own docstring and this script broke in the very next file.

### DONE — an age-gated film is re-resolved to another upload

The owner's call. `fct_playback` records what a real client found; publish reads
it back and drops a quarantined upload **before** duplicate settling, so another
copy of the same film wins the contest instead. That is the same placement, and
the same reason, as the region filter one line above it.

*Ivan's Childhood* moved from the gated Mosfilm upload to `_TAvXRF5ZHc` — the
same 95 minutes from the same channel, second on confidence. `+0 added, -0
dead, ~1 re-uploaded`: the film stayed, the dead click went.

Only three verdicts quarantine, and the two that do not are the point:

- `region-blocked` reflects wherever the probe ran. CI is in the US and the dev
  box is not, so it says nothing about HR.
- `unreachable` can be a dropped connection as easily as a dead video, and
  `verify-streams` already asks the API that question for the whole catalogue
  rather than a sample.

What is left is a stable property of the upload. A later probe overwrites an
earlier verdict, so a quarantine lifts by itself when a video is ungated —
otherwise a film would be stranded on a worse copy for good.

**A quarantine only fires when there is something to swap to.** Dropping the
sole copy of a film deletes it from the catalogue, and "re-resolve to another
upload" is not "delete when there is no other upload" — three of the first four
gated films found had no spare at all. Those keep their stream and are marked
`notWebReady: true` with "sign-in required" in the title, which is the truth
about them: a signed-in viewer can play them on YouTube, and the embedded
player is exactly where gating bites.

    Ivan's Childhood     swapped to _TAvXRF5ZHc, notWebReady false
    No Place Like Home   kept, no spare, sign-in required
    Legend of the Muse   kept, no spare, sign-in required
    What We've Become    kept, no spare, sign-in required

**Coverage is the limit, not the mechanism.** 16.4% of published films have a
spare upload to fall back on, and the probe only knows about what it has
sampled. The seed now defaults to the ISO week, so each run probes a different
40 and `fct_playback` accumulates: 40 a week is the catalogue in ~77 weeks,
200 a week in ~15. Raising `--sample` in CI is the lever; at 3.6s a video with
concurrency 3, 200 is about four minutes.

`duration-drift` — a video re-cut since we matched its runtime — has a detector
and has still never fired.


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
