# Does it actually play?

Everything else in this pipeline verifies our own reasoning. These two tools ask
whether a viewer gets a video, and they disagree with each other in ways that
matter.

## The Data API — cheap, whole-catalogue, and wrong about one thing

`verify-streams` asks `videos.list` about every published ytId: 50 per call,
about **62 quota units** against 10,000 a day. It catches deleted, private,
un-embeddable and geo-blocked.

It cannot see **age-gating**, and reports such a video as `public` and
`embeddable: true`. It is also possible for the API to report a video as fine
that no client can play at all — the metadata record outlives the video. Three
published films were in exactly that state.

## yt-dlp — expensive, sampled, and knows what a client knows

`probe-playback` gets age-gating, the true maximum resolution (the API grades
only `hd`/`sd`), genuine subtitle tracks, and the video's real duration — which
is an independent check on the runtime the match was scored on.

Whole catalogue, measured: **3,857 play, 31 age-gated, 3 dead.** Not one stored
runtime had drifted, which is worth knowing given runtime carries 20 of the 100
points.

Four things this cost to get right:

- **Pass ids as watch URLs.** 79 of 4,868 published ids start with a dash, and
  yt-dlp reads `-rg5GhmZ5zo` as the `-r` rate-limit flag.
- **Age-gating arrives as an error, not a flag.** yt-dlp refuses to fetch the
  metadata, so `age_limit` never arrives; the message is the only signal.
- **Throttling is not a fact about the video.** "Sign in to confirm you're not a
  bot" recorded as a verdict marks a healthy film permanently unreachable, and
  an unprobed-first sampler never revisits it. Classify it apart and **do not
  write it** — a probe that learned nothing must not count as coverage.
- **Sample from what is *published*, not what was accepted.** Those differ by
  the region filter and duplicate settling, and probing the wider set means
  probing videos the addon never offers.

## Acting on it

Different failures deserve different treatment, and collapsing them is the
mistake:

- **age-gated** — a signed-in viewer can still play it. Keep it, rank it last,
  label it, and only remove it when another copy exists to swap in.
- **private / members-only / unreachable** — nobody can play it. Remove the
  upload; if that empties the film, it leaves the catalogue.
- **unreachable needs seeing twice.** yt-dlp reports a throttled request and a
  deleted video in much the same breath, and one bad minute must not delete a
  film.
- **region-blocked never votes.** It reflects wherever the probe ran, which in
  CI is a US datacenter.

## What none of it proves, and how that was closed

Every check above is a probe: the Data API's opinion, and yt-dlp's. Neither is
a viewer. The chain a viewer actually walks — catalogue row -> IMDb id ->
Cinemeta's metadata -> our stream file -> Stremio's own player -> picture on
screen — went unverified for the whole life of the project, because it ends in
tapping something in an app.

Confirmed end to end on 2026-09-06, on an Android phone, HR variant:

    catalogue    Operation 'Y' & Other Shurik's Adventures, tt0059550
    detail page  Cinemeta supplied art, synopsis, director, cast, IMDb 8.4
    stream tab   "YouTube Cinema — Mosfilm • 95 min • match 86", one stream
    playback     Mosfilm logo, then the opening credits

The detail page is the part worth dwelling on. Nothing in it comes from us —
every frame of that metadata arrived because the tconst was right. It is the
clearest statement of why a wrong id is the worst failure available here: the
same mechanism that fills the page correctly would have filled it with a
different film, confidently, and the stream would still have played.

`match 86` is also visible to the viewer, which is deliberate — see
[[resolver-scoring]] for what that number is and why 85 is the floor.
