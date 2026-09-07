# TODO

Ordered by value. Rationale is kept with each item because most of these exist
in response to something that actually broke, and that context is the reason to
do them in this order rather than a more obvious one.

Status as of 2026-09-07, after the entries below: 9,491 eligible uploads
(Croatia, down 115 with alefilmy dropped), **2,372 films** and 349 episodes
across 20 shows in the unrestricted tree, 2,994 in HR, **119 tests** passing.
The warehouse is fully re-resolved at resolver version 13 against the
2026-09-07 IMDb dataset and stands at **accept 5,403, review 2,466, reject
1,622** — so the gain the previous status line projected is banked, and the
next dispatch will not move those numbers again on its own.

The catalogue now carries **nine** groups and eleven catalogues rather than
eight and ten: Archive/China published its first film this session, having
scored zero out of 99 uploads until the separator entry below.

`docs/` has been republished from that warehouse and conformance is clean on
the unrestricted tree and all 20 regions. **The resolver change still needs a
`build-catalog` dispatch to reach viewers** — `deploy-site` fires only on
`src/dwh/publish.js`, `src/publish.js` and `src/report.js`, and a change to
`src/transform/title.js` is not on that list.

---

## DONE — the same licensing shape, on a channel that is half legitimate (2026-09-07)

CineMo is the second channel found this way and it could not be handled like
alefilmy, because dropping the group would have destroyed a real catalogue.
Its Filipino films — *A Mother's Story*, *Home Alone da Riber*, *Action Is Not
Missing* — are its own and stay. Alongside them it uploads Western studio and
direct-to-video action titles under a visibly different convention:

    its own          <Title> | FULL MOVIE | <cast> | CineMo
    the foreign ones <Star> in <TITLE> | Action | Full Movie HD in English

Of 17 accepted films, 14 were the foreign kind. None were ever served — checked
against the live `catalog.json`, 0 of 14 are in it — but all 14 were `accept`
in the warehouse and would have shipped on the next dispatch. Same as alefilmy:
the exposure is a dispatch, not a merge.

**Excluded by `ytIds`, not `imdbIds`, and that is the whole point of the
entry.** `tt3779300` (*War Pigs*) is **also on The Midnight Screening**, which
is a `currentReleases` rights holder and accepts it legitimately. A global
`imdbIds` exclusion would have removed that licensed copy as collateral.
`ytIds` names the individual upload, so it cannot reach another channel's copy
now or after any future re-resolve. Check for this before ever reaching for
`imdbIds`: the query is one join from `fct_resolution` back to `fct_upload`.

**The title pattern that found these is a search tool, not a verdict.** Run
over the channel it flagged 38 uploads, and three of them are wrong:

- `tt7415582` *Riding in Tandem* — a genuine Filipino CineMo film, caught only
  because its own title contains the word "in"
- `tt0050762` *Nine Lives* (1957) and `tt5162870` *Underworld* (2008) — these
  look like **wrong matches** rather than licensing problems: both are generic
  one-word titles matched `exact-primary`, and the *Nine Lives* upload lists a
  cast belonging to a different film entirely

None of the three is excluded. The last two are a resolver bug worth chasing
separately — a generic single-word title reaching `exact-primary` on the wrong
film is exactly the failure the margin gate exists for, and it is not firing
here.

**Extended to the review tier the same day: 14 accepted plus 14 in review, 28
in total.** Review entries are never served, so the second 14 were not exposure
today. They were taken out anyway because several sit at confidence 88-92 —
*above* the 85 floor, held only by the `recent-year` flag or a short margin —
and item 5 is explicitly about promoting things out of that queue. Left in
place they would have been published by the back door by the first §4 change
that worked. Only the `<Star> in <TITLE>` marker was used to pick them, never
the `| Action |` one that produced the false positives above.

Pipeline: eligible 9,491 -> 9,463, accept 5,403 -> 5,389, review 2,466 -> 2,452.

## DONE — 111 accepts and 0, separated by one character (2026-09-07)

Two Hong Kong channels carry the same catalogue and got opposite outcomes, and
the cause is not licensing, quality or the resolver. It is which pipe they type.

| | separator | what `cleanTitle` keeps | accepts |
|---|---|---|---|
| Cinema Mei Ah | fullwidth `｜` U+FF5C — **not** in `BOUNDARY` | the whole string, English title intact inside it | **111** |
| 經典華語老電影 | ASCII `\|` — **is** a boundary | the leading Han segment only | **0** |

Mei Ah's 111 are `exact-derived`: the string survives whole, so §3's bracket
rule finds `(God Of Gamblers)` — an IMDb *primary* title, 50 points.
經典華語老電影 gets split, the English segment in position 2 is discarded, and
what is left matches only a Han `aka` row at 44. The ceiling is then
arithmetic: `44 + 20 year + 20 runtime + 0 corroboration = 84`, against a floor
of 85, on all 74 uploads that matched at all. Corroboration is 0 on every one
because the descriptions list cast in Han characters while the index's
`credits` holds romanized names. **Zero accepts out of 99, one point short.**

**The fix appends rather than replaces.** `clean_title` becomes
`九龍冰室 (Goodbye Mr. Cool)` — Mei Ah's own layout, reproduced deliberately.
`derive()` then offers both keys and the resolver already keeps the stronger
source per tconst, so the aka's 44 is promoted to a primary's 50 for free. No
resolver change at all.

Substituting instead of appending was measured and is wrong. It throws the aka
anchor away, and an English title that then misses exactly drops to the fuzzy
tier onto a sibling film: `古惑仔Ⅲ之隻手遮天` reached *Young and Dangerous 2* at
confidence 87.4 that way. Same accept count, one wrong id — the trap CLAUDE.md
describes, and the reason
[`test/fixtures/labelled.json`](../test/fixtures/labelled.json) pins both
roman-numeral sequels.

Measured at four levels, because **the obvious harness rejects this change**:
counting exact `title_norm` hits on `clean_title` alone reports `gained 0, lost
70`, since `九龍冰室 goodbye mr cool` is in no index row. The entire gain lives
in `derive()`, which a clean-title harness does not model. Levels that do:

    L1  clean_title identity   93 of 9,491 changed, all one channel
                               Mei Ah 0/185, other channels 0/9,207
    L2  candidate strength     aka->primary 56, none->primary 18, none->aka 2
                               0 uploads lost all exact candidates
    L3  resolveOne             accept 0 -> 46   GAINED 46  LOST 0
                               conf max 84 -> 90, mean 78.8 -> 83.1
    L4  labelled set           17/41 -> 20/41 accepted, wrong 0

Through the pipeline: **accept 5,357 -> 5,403**, review 2,492 -> 2,466, reject
1,642 -> 1,622. Exactly 93 rows re-resolved.

It also fixes a wrong id that was already there: `最佳損友2` resolved through
the fuzzy tier to tt0096512, the *base* film. It now resolves `exact-derived`
to tt0098718, the sequel. Still in review at 84 — but right rather than wrong.

**The cost, recorded rather than mitigated.** Three uploads lose a promotable
right id from the review queue to `too-many-candidates`, because their English
titles are generic: *Lost and Found* (53 candidates) twice and *True Love* (33)
once. No accept was lost and nothing crossed into accept wrongly; `MAX_CANDIDATES`
is doing the job it was written for. The only way to avoid it inside
`title.js` is not to append, which costs all 46.

Guard rail for whoever tunes this next: do **not** relax the
`!LATIN_SCRIPT.test(body(picked))` predicate to "no Latin *word*". That variant
was measured, scores the same accept count, and produces the Young-and-Dangerous-2
wrong id. `body()` is what makes `1080P` not count as Latin, via `MARKETING`.

## DONE — the third systematic gate: one unhandled bracket (2026-09-07)

Item 3 asked for a third gate before anything was promoted by hand. This is it,
and like the first two it was found by characterising a bucket on a signal the
gate does not test — here, `no-candidates` by channel rather than by score:

    經典華語老電影   92 of  99 uploads  (93%)   <- the whole channel, dark
    CineMo          194 of 336 uploads  (58%)
    Mosfilm         129 of 282 uploads  (46%)
    PizzaFlix        38 of 1417 uploads  (3%)

93% is not a matching problem, it is a parsing problem. That channel stamps
every upload with a bracketed language label — `【粵語】` (Cantonese),
`【國語/ENG】` (Mandarin). `cleanTitle`'s bracket rule knew the ASCII and
fullwidth pairs but not the CJK pair, so the `【` was later stripped as leading
junk while the `】` survived mid-string: `九龍冰室` came out as `粵語】九龍冰室`
and matched nothing. Exactly 95 clean titles in the warehouse still carried an
orphaned `】`, against 99 uploads on the channel.

Removing the label is the entire fix — IMDb carries these films under the plain
Chinese title in `title.akas` (`九龍冰室` -> tt0304098, `賭神` -> tt0097244), so
there was no need to prefer the English segment instead. Measured old vs new
over all 9,606 kept uploads, counting exact index hits:

    old-hit 7,036   new-hit 7,104   delta +68   gained 68   lost 0

All 68 on that one channel, nothing lost anywhere. The pattern is bounded to 12
characters so it stays a label and cannot eat a bracketed title.

**It published nothing, and that is the honest number.** Through the pipeline
the 68 moved from `reject/no-candidates` to `review/low-score`, not to accept:

    accept  5,372 -> 5,357     review 2,521 -> 2,492     reject 1,713 -> 1,642

and every one of those movements is the alefilmy drop (-15 accept, -96 review,
-4 reject) plus 68 rejects becoming reviews. A count of index hits is not a
count of films; this is the same trap as the changes that scored well and were
rejected anyway.

What it bought is that the channel is now *visible* — 92 uploads that could not
be scored at all can now be worked. Sampled 14 of them by hand and every id is
right (`九龍冰室` -> tt0304098, `南海十三郎` -> tt0134836, `絕代雙驕` -> tt0104572),
with runtimes 1-2 minutes under IMDb because IMDb counts the credits.

And they all sit at **confidence 84**, one point under the floor, which is the
cliff this project keeps rediscovering. The shape is `44 + 20 + 20 + 0`: the
title matched an *aka* rather than a primary, and `exact-aka` scores 44 where
`exact-primary` scores 50. For a film whose only English-language identity is
an aka, that 6-point discount is the whole difference. That is a real question
for item 5, and unlike the yearless shape it has nothing to do with a missing
year — the year is right there in the title and scoring a full 20.

No `RESOLVER_VERSION` bump: `inputHash` already covers `name`, which is
`clean_title`, so precisely the 68 changed rows re-resolve and the other 9,538
keep their checkpoint. Scoring is untouched — 13 still describes the scorer.

## DONE — a channel whose matches were right and should not have been published (2026-09-07)

Found while working the `low-score` bucket for the gate above, and it inverts
what item 3 assumed. `low-score` by channel:

    alefilmy        89 of 115 uploads  (77%)   <- outlier
    Grjngo         266 of 1009 (26%)
    PizzaFlix       97 of 3000  (3%)

The 89 are a single uniform shape — exact-aka title, PAL-band runtime, a cast
hit, `44+12+17+10` — and every sampled one is a *correct* match. That is the
problem. They are modern commercial features with Polish lektor voiceover, and
14 of the 15 that cleared the floor are from 2000 or later, spanning Newmarket,
Warner, StudioCanal, DreamWorks, Focus and Screen Gems. No single licensor holds
that spread.

**None of them were ever served, and the first draft of this entry said
otherwise.** Checked against the live `catalog.json`: 0 of the 15 are in it.
They were `accept` in the warehouse but the deployed tree predates the v13
re-resolve, so they were among the gains the **next dispatch** would have
introduced. The exclusion stopped that. The distinction matters for how this
reads later — the exposure is a `build-catalog` dispatch, not a merge.

`channels.json` already states the test this fails: `currentReleases` marks the
four channels that are the rights holder, and on an unmarked channel a modern
match is anomalous. alefilmy carries no marker. Dropped via `config/exclude.json`
`groups`, the Wu Tang precedent, since it is the only channel in group `Polish`.

Two things worth keeping from this:

- **`fct_upload.licensed` means nothing here.** It reads 1 on all of them. It
  is YouTube's `contentDetails.licensedContent`, which says a Content ID owner
  claimed the video — not that the uploader has rights. For pirated uploads it
  is *more* likely to be 1, so the field's name is actively misleading.
- **The score floor was the only thing holding the other 89 back.** Any
  loosening of §4 aimed at the yearless-neutral shape would have published
  them. That is now a reason the floor stays where it is, and it is not a
  reason §4 was originally written for. See item 5.

Grjngo and Cult Cinema Classics were checked the same way and are clean: their
modern titles are genuine low-budget indie westerns and thrillers, no
major-studio releases.

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

## DONE — unrestricted root, twenty regional addons (2026-09-06)

Torrentio's convention, adapted to a static host: configuration rides in a path
segment before `manifest.json`. Torrentio parses that per request because it is
a live server; on Pages each value has to be a real directory, which is only
affordable because the config here is one key with twenty values rather than
providers × qualities × debrid keys.

    /manifest.json              2,202 films + 349 episodes, no restrictions
    /region=us/manifest.json    3,372
    /region=hr/manifest.json    2,736
    /configure/                 pick a country, get the link

**The root is the unrestricted set**, and that is a decision about honesty. Its
films carry no country restriction at all, so a viewer anywhere can install one
URL and have every stream work. `FREE` is not "playable where I am" — an upload
allowed only in the US passes `playableIn('US')` and must not pass this.

Two-thirds of the catalogue turned out to be region-free; only 1,412 films
needed a region to decide. The US unlocks 1,170 of them that the root cannot
offer — mostly licensed uploads gated to North America, which is why *Joe 90*
resolved 30 episodes correctly and published none while the catalogue was
Croatia-only. It publishes now, under `region=us`.

The configure page is generated from the trees that were actually built. A
region offered there that does not exist is a 404 a viewer reads as a broken
addon.

**Deployment changed with it.** Twenty regional trees are 66,000 files and
280 MB, ~85% identical to the root, so committing them weekly would bury the one
commit that matters. `docs/region=*/` is gitignored and the site deploys as a
Pages artifact (`build_type` switched from `legacy` to `workflow`); the repo
keeps the unrestricted tree, which stays diffable. Job timeout 45 → 90 minutes.

`publishedStreams` walks every tree now — reading only the root would have
quietly stopped covering the uploads that exist *because* of a region, which are
the ones a rights holder is most likely to gate or pull.

## DONE — several countries at once, and a name that stops shouting (2026-09-06)

Twenty regions is 2^20 selections and the catalogues do not collapse — all
twenty are distinct — so pre-generating combinations is out on a static host.
Stremio already solves it: it merges catalogues and streams across installed
addons. Tick HR and US, install both, get `unrestricted ∪ HR ∪ US` with every
copy of a film offered together. Exact, no supersets, nothing to guess.

That only works if they can coexist, and Stremio keys an installed addon on its
manifest **id** — share one and the second install replaces the first. So:

    id     org.stremio.youtube-cinema.hr     distinct per region
    name   YouTube Cinema                    the same everywhere
    rows   YouTube Cinema — HR               the country lives here

The configure page is checkboxes and hands back one install button per country
picked, rather than a single URL that could only ever mean one of them.

### The addon is now checked as a client sees it

`npm run conformance` walks the published tree the way Stremio does: every
declared catalogue resolves, page two exists where page one is full, a listed
title has a stream at the id a client will actually request, and no two addons
share an id. It runs after publish in both workflows.

Everything else in this repo verifies our own reasoning. This is the first check
that asks whether the *protocol* holds — the failure a viewer calls "the addon
is broken", and the one that is invisible from inside, because the marts can be
internally perfect and still unusable if the ids do not line up.

It found its own bug before the addon's: probing S1-3/E1-3 for a show's episodes
called *Man with a Camera* broken, when its two episodes are S1E6 and S1E12.
Episodes are whatever a channel uploaded; guessing was never going to hold. Each
tree publishes `episodes.json` now, so the check reads the truth. That also
fixed a real gap — `catalog.json` exists only in the root, so nothing could
verify a regional variant remotely.

**All 21 live addons pass**, and the chain was walked to the end: catalogue →
stream → a YouTube video that actually plays, for films and for an episode.

## DONE — in-repo memory wiki (2026-09-06)

Everything this project learned the hard way lives outside the repository — in
the agent's own memory directory — so a fork inherits the code and none of the
reasoning. A tracked `CLAUDE.md` at the root should be the entry point, pointing
at `MEMORY.md`, which indexes a `memory/` wiki.

Its job is the knowledge that is *not* derivable from reading the code: why the
runtime signal is worth 20 points, why `genre` carries sort orders but never
group names, why a resumed download needs `If-Range`, why every long step is
checkpointed. The specs already describe what the code does; this should say
what it cost to find out.

`CLAUDE.md` is the entry point, `MEMORY.md` indexes seven pages under
`memory/`: the host and why everything is resumable, the IMDb datasets and the
resume bug that spliced four archives, the resolver weights and the cliff at 84,
title extraction and the three rules that measured well and were rejected
anyway, what Stremio actually requests, the region split, and how playback is
checked against reality.

Written for someone who has never seen the code. Every claim in them is
something that was measured or that broke in production — the specs already say
what the code does.

## DONE — 170 of the review queue, by measurement not by hand (2026-09-06)

The queue's largest single shape turned out to be one missing band, not a
thousand judgement calls.

`relaxYearless` gives a yearless upload a relaxed year neutral (8 -> 12, +4)
when the runtime pins the era, and it demanded the **top** band, 20. The queue
was full of exact-title matches with margin 100 that missed by three points:
*Chicago Overcoat* [91m] -> (2009, 94m) at 81.

**The first reading was wrong and measurement caught it.** Those samples all
showed the YouTube duration a few percent under IMDb's, which looked like the
bands being miscentred. They are not: across the 2,617 accepted matches whose
year agreed exactly — confirmed by a signal other than runtime — the median
delta is **0.00%**. The apparent shortfall came from filtering on
`sig_runtime>=17` and then reading rows out of the 17 band, which is *defined*
as -6%..-2%. A filter cannot be used as evidence for itself.

The same measurement gave the real answer — band occupancy on that known-good
population:

    20   1,590   60.8%
    17     484   18.5%
    12     180    6.9%
     6     362   13.8%

Band 17 is the PAL speedup: a mechanical artifact of the transfer, the same cut
of the film, and where nearly a fifth of demonstrably correct matches sit. Band
6 is a print that has actually been cut, and stays out. Whole corpus, old
against new: **gained 170, lost 0, ids changed 0** — the shape the change
predicts, since the lift moves the winner alone after the ranking and margin are
settled.

    accept 4,868 -> 5,038      resolved 47.9% -> 48.7%
    films  2,202 -> 2,241      US 3,370 -> 3,513   HR 2,734 -> 2,794

Gained list read rather than counted: 156 of 170 exact titles, the other 14
akas doing their job (*A Certain Justice* -> **Puncture Wounds**, *Hot Enough
For June* -> **Agent 8 3/4**). Of the 29 with a real competitor, runtime is what
discriminates — *Bye Bye Birdie* at 131m takes the 1995 version over the 1963.

## DONE — recent-year was testing the wrong thing (2026-09-07)

The second systematic gate, found the same way as the first. §5 justifies the
flag as *"a recent theatrical title on a **free channel** is almost always an
unlicensed upload"*. The premise is about the channel, and the code only ever
looked at the year.

`config/channels.json` is a hand-curated whitelist, and four of the channels in
it **are the rights holder** — Movie Central, Shout! Studios, GEM: Film Library,
The Midnight Screening. Current releases are their catalogue, so on those
channels the year carries no information about whether an upload is licensed.
**500 of the 526 flagged uploads were theirs.**

Confirmed on a signal the year flag knows nothing about — runtime against IMDb,
over the 333 that also cleared the floor and the margin:

    median delta   0.00%        within +/-3%   291 of 333

**The flag is kept everywhere else, and the data says exactly why.** All five
genuinely wrong matches in the bucket were *archive* channels reaching a modern
film of the same name — *Spider Island (1962)* -> a 2026 `Spider Island`,
*Goodbye Love (1933)* -> a 2025 one, *The King of the Mountains (1962)* -> 2025.
On a channel whose median film is from 1943 the recency **is** the evidence.
That is why the exemption is per-channel and hand-declared rather than a global
relaxation of the five-year window:

    Movie Central      median 2017   21.5% >=2021      PizzaFlix     median 1943   0.1%
    Midnight Screening median 2013   14.7%             Public Domain median 1954   0.0%
    GEM: Film Library  median 1997    7.5%             Grjngo        median 1968   0.5%
    Shout! Studios     median 1995    6.4%             Cult Cinema   median 1961   0.4%

Whole corpus, old against new: **gained 324, lost 0, ids displaced 0.**

    accept  5,038 -> 5,370        review/recent-year  526 -> 26
    of the 500 flagged: 332 accept, 128 low-score, 35 narrow-margin, 4 reject

The 332 accepts net to 324 films because eight were re-uploads of titles already
published — `settleDuplicates` settled them, which is why the harness runs it
over *both* corpora. A per-row diff would have called those a gain.

**The "before" was checked rather than assumed.** The warehouse is uniformly at
resolver version 12 under one overrides hash, so its stored rows are the before
for every upload — but only if they still reproduce against the rebuilt index.
400 unflagged rows on the same four channels were re-resolved as a control:
**0 drifted**. Without that the comparison would have been against rows written
by a different index.

Gained list read rather than counted. The five lowest-confidence entries all
matched a title unlike the upload's, and all five are legitimate:

| upload | match | via |
|---|---|---|
| Crocodile Vengeance | `tt14045614` **Croc!** | that *is* its `originalTitle` |
| ASSAULT ON STATION 33 | `tt12064810` **Assault on VA-33** | `aka GB` |
| The Last Day of the Rest of My Life | `tt11061084` **The Mass Shooting Monologues** | `aka XWW` |
| The Demon's Child | `tt14242974` **The Solemn Vow** | `aka XWW`; runner-up a 1954 film at 69 |

Notes on the shape of the fix, for whoever touches it next:

- It rides `opts`, like `overrides`, and is **not** a `dim_channel` column.
  It is resolver *policy* read from config; freezing a policy call into
  warehouse rows means the next re-resolve has to undo it.
- It defaults **off**. A caller that knows nothing about `config/channels.json`
  — `probe.js`, a test — gets the strict §5 behaviour.
- It is scoped to `recent-year` alone. `adult` and `video-type` still fire on an
  exempt channel, pinned in `test/scoring.test.js`, or the set would quietly
  become a blanket §5 bypass.
- `ScreamFactoryTV` and `FilmRise` are the same kind of distributor but are
  **not** marked: every one of their uploads is dropped on duration, so there is
  no evidence either way and marking them would be a guess wearing a
  measurement's clothes.

## 3. Work the rest of the review queue

**2,517 entries left**, after the recent-year work above:

    low-score  1,700     narrow-margin  460     too-many-candidates  182
    video-type   134     recent-year     26     adult                 15

The sampled ones are still mostly *correct* matches sitting under the 85 floor —
"The Swan (1930)" resolved to `One Romantic Night` at 84.

**A third gate has now been found and the method still holds — keep using it
before promoting anything by hand.** The three so far, each worth more than any
batch of hand promotions: the PAL runtime band (+170), the channel premise
behind `recent-year` (+324), and the CJK bracket in `cleanTitle` (+68 index
hits, nothing lost — though it published nothing, see the entry at the top). The third came out of the
`no-candidates` bucket rather than `low-score`, which is worth remembering:
this item points at `low-score` because it is the biggest, but the bucket that
paid was the one where titles never reached the scorer at all.

The same pass turned up something this item did not anticipate — a channel
whose matches are *correct* and should not be published at all. That is the
alefilmy entry above, and it is the reason `low-score` is now 2,517 minus its
89. Working this queue is not only about promoting; twice now the right answer
was to drop something.

The method each time was the same, and it is the part worth copying:

1. Take a bucket and characterise it on a signal **other than the one the gate
   tests** — runtime, when the gate is about years.
2. Read the gained *and* lost lists, never the totals.
3. Check that the "before" you are diffing against still reproduces.
4. Hand-verify the low-confidence tail, which is where a wrong id would be.

`low-score` at 1,700 is still the biggest bucket, but read item 5 before
attacking the shape inside it: the 82-point yearless-neutral matches are
genuinely correct *and* promoting them on two signals would also have published
the 89 alefilmy uploads. The remaining `no-candidates` on the CJK channels are
the cleaner target — the bracket fix took 68 of the 92 on 經典華語老電影 and the
rest are **not** one gate. Corpus-wide only **3** clean titles carry a fullwidth
roman numeral (U+2160-217F) and **zero** carry a fullwidth digit, so the earlier
note here calling that "a bounded, measurable next gate" was wrong — it is a
two-film gate. Looked up individually, the 25 break down as:

    14  IMDb carries no Han aka at all, or Simplified only where the upload
        is Traditional  — a data gap, not fixable in the cleaner
     6  near-miss aka variants (a dropped subtitle, one homophone character)
     2  fullwidth roman numerals
     1  a leading `MULTI SUB ` the cleaner does not strip
     2  IMDb's Chinese aka is a genuinely different Chinese title

The real gate on that channel is not in this bucket at all — see the separator
entry above.

- promote confirmed pairs into `config/overrides.json` (confidence 100, PR-able)
- the `src/resolve/probe.js` tool exists for exactly this: it prints the full
  candidate list with per-signal breakdowns

This is the catalog's largest untapped asset. It is ahead of weight tuning
because promoted entries are also the labelled set that tuning needs.

## DONE — the §7 labelled fixture set (2026-09-07)

`test/fixtures/labelled.json`, 41 pairs, 25 of them (61%) from the non-English
channels. Korean Classic Film and Goldmines are named in §7 but no longer exist
in `channels.json` — Goldmines went with the Devanagari exclusion — so the
weight went to Mosfilm (12), Cinema Mei Ah (6) and 經典華語老電影 (7).

Verified by looking each film up in the IMDb datasets **directly** and
confirming year and runtime, never by accepting what the resolver returned.
`test/labelled.test.js` asserts §7's precision >= 0.98 on the accept tier and
skips when `.cache/imdb.sqlite` is absent, so a fresh clone can still run
`npm test` with no network.

**Current result: 17 accepted, precision 1.000, zero wrong ids.** The other 24
are not failures — §7 makes recall secondary on purpose — but they are the best
evidence item 5 has, so see below.

Hand-verification earned its keep by *rejecting* six candidates rather than
guessing: *Prehistoric Women* (upload 73m sits between the 1950 film at 74m and
the cut release of the 1967 Hammer film at 91m), *Her Sister from Paris*
(99m against IMDb's 70m — silent-era framerate, not a match error), *War and
Peace Part One* (147m against 373m for the complete cut, which trips the
split-upload reject by design), the 2004 HK *Blood Brothers* (no aka), and
*Operation Y* / *The Irony of Fate* (no exact index hit at all).

One pair was wrong in the first draft and is worth recording: a `LIKE` on the
English title matched the *sequel* upload while it carried the base film's
tconst. Both are in the set now — *The Crazy Companies* 97m against tt0096512's
99m, and *The Crazy Companies 2* 97m against tt0098718's 98m, same year, one
minute apart. That is the case §2 keeps trailing roman numerals for, and it now
fails here rather than in the catalogue.

## 5. Tune the §4 weights — still last, and now for a better reason

**The `KNOWN ISSUE` this item was pinned to is gone.** `test/scoring.test.js`
now reads *"Was* KNOWN ISSUE": `relaxYearless` lifts the neutral to 12 when the
runtime corroborates, so the shape scores 82 rather than 78, and a weak third
signal such as a cast mention reaches 88 where it used to reach 84 and fail.
The original text below is kept because the reasoning still holds.

**The ordering argument survives, re-measured.** `no-candidates` is 1,571 of
1,713 rejections — 92%, not the ~98% quoted below, but the point is unchanged:
most failures never reach the scorer, so tuning it teaches the wrong lesson.
The bracket gate above is exactly that kind of fix and was worth +68 on its own.

**The licensing blocker, measured after both exclusions.** The 82 band holds
467 uploads, 234 of them from 2000 or later. Split by whether the channel is a
declared rights holder:

    rights holder (safe)      175   Movie Central 103, Shout! 57, Midnight 8, GEM 7
    NO currentReleases         59   CineMo 52, and 7 across four other channels

So the risk is not spread — it is **CineMo's residual 52**. The 28 uploads
excluded above were selected on the reliable `<Star> in <TITLE>` marker; these
52 use the channel's other convention, plain `<TITLE> | Action | Full Movie HD
in English`, which cannot be used as a selector because it also matches genuine
Filipino films and two probable wrong matches (see the CineMo entry).

**That is the blocker, and it is a bounded one.** Resolve those 52 — by hand,
or by finding a signal that separates them the way the star prefix does — and
§4 tuning stops being a licensing question. Until then a blanket +3 publishes
them, which is precisely the alefilmy mistake with a different channel's name
on it.

**What the labelled set says.** Of its 24 non-accepts, 13 are RIGHT-ID sitting
at confidence 82 with the identical shape `50 + 12 + 20 + 0` — exact primary
title, perfect runtime, no cast mention — three points under the floor. Named,
they are *Gentlemen of Fortune*, *Come and See*, *Moscow Does Not Believe in
Tears*, *Solaris*, *Dersu Uzala*, *Office Romance*, *They Fought for Their
Country*, *God of Gamblers*, *Black Eagle*, *Garden of Evil*, *Mimino* (79),
*The Tricky Master* (84) and *White Tiger* (70). Six of the seven remaining are
`no-candidates` on CJK titles, and two are `too-many-candidates` on *Stalker*
and *The Mirror*, which collide 7 ways each.

So the tempting change is +3 somewhere in that shape. **Do not make it without
reading the alefilmy entry above.** Those 89 uploads sit at `44+12+17+10` and
are correct matches to films that should not be in a catalogue of films legally
on YouTube; the floor was the only thing holding them back. A change that
promotes the 13 above on two signals promotes those too. If this is attempted,
the third signal has to be something that separates them — the labelled set is
now the place to prove it, and it will show the gain as named films.

### The original note, kept

Today's evidence: `no-candidates` was ~98% of all rejections, meaning titles
never reached the scorer at all. Tuning a scorer that is not being called
teaches the wrong lesson.

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

## DONE — deploy to GitHub Pages (closed 2026-09-07)

Live and serving: `manifest.json` returns 200, the Pages API reports
`status: built` with `build_type: workflow`, and `deploy-site` has been green
on push for weeks. The item sat open only because nobody closed it.

The original rationale still explains the shape of the thing: an addon must
answer whenever Stremio opens, and the dev VM could not do that — it was
killed roughly nine times during one session.

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

**~~Multi-region.~~ Done 2026-09-06.** The note above described the pre-DWH
path, where region was filtered at *index* time and blocked films were thrown
away. The warehouse has kept `blocked_regions`/`allowed_regions` on every upload
since the cutover, so this turned out to be a publish-time loop rather than a
re-architecture, and nobody had updated the note.

**A different serialization format.** See `docs/FORMATS.md`.

**Devanagari-titled Hindi catalogs.** Removed 2026-09-05: 28% of indexed
uploads for 6% of published films. `config/exclude.json` now drops them by
script on any channel.
