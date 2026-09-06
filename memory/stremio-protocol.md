# What Stremio actually asks for

A static addon is a set of files at fixed paths. Everything below is a way that
arrangement breaks while every internal number still looks correct.

    /manifest.json
    /catalog/{type}/{id}.json
    /catalog/{type}/{id}/{extraArgs}.json      extraArgs = "genre=Year&skip=100"
    /stream/{type}/{id}.json                   id = tt123  or  tt123:1:5
    /configure                                 if behaviorHints.configurable

`extraArgs` is a stringified query object, URL-encoded, as one path segment.
**The key order is the client's to choose**, so paginated pages are written both
ways — one duplicated small file beats a catalogue that stops dead at a hundred
entries.

## This addon declares only `catalog` and `stream`

Never `meta`. Cinemeta owns the detail page, the synopsis, the cast, the
ratings — and, for a series, **the episode list**. That is why
`title.episode.tsv.gz` is not among the datasets: answering
`stream/series/tt123:1:5.json` needs the series tconst and two integers parsed
from the upload's own title, and IMDb's 9.9M-row episode table buys nothing.

It also means a catalogue row carries only what Stremio needs to *draw the row*:
id, type, name, poster, year. Anything else duplicates Cinemeta at best and
contradicts it at worst.

## Four ways this breaks silently

**A `genre` option that no file answers.** The chip 404s, the catalogue looks
empty, and the viewer blames the addon. Group names must never be genre options:
`Archive/Soviet` contains a slash, and Stremio hands the value back as a path
segment, which any server reads as a directory separator. Sort names are safe.

**Page two missing.** A full first page means the client will ask for
`skip=100`. If that 404s the catalogue simply ends.

**A listed title with no stream at the id the client requests.** The marts can
be internally consistent and still unusable if the ids do not line up.

**`configurable: true` with no `/configure`.** The gear appears and 404s. For an
addon served under a config path segment, the gear resolves to
`<base>/configure` — *inside* that segment — so every variant needs the page, or
a redirect to the canonical one.

`src/conformance.js` walks all of this the way a client would and runs after
publish in CI. It found its own first bug before it found the addon's: probing
S1–3/E1–3 for a show's episodes called *Man with a Camera* broken, when its two
episodes are S1E6 and S1E12. Episodes are whatever a channel uploaded; guessing
their numbers was never going to hold, which is why each tree publishes an
`episodes.json` index for the check to read.

## Streams

`ytId` is the field that matters — Stremio has a native YouTube player, so
handing it the id plays in-app instead of bouncing to a browser. `externalUrl`
is the fallback.

The `streams` array holds **every playable copy of the film**, best first. It
held one for months, which quietly threw away a second working upload for 579
films. `behaviorHints.notWebReady` must be honest: an age-gated video is exactly
the case where the embedded player fails, so claiming otherwise is a lie that
costs the viewer a click.

## Installing several at once

Stremio keys an installed addon on its **manifest id**. Share one id and the
second install replaces the first; give each variant its own and they coexist,
with catalogues and streams merged across them. That is the whole mechanism
behind multi-region — see [regions](regions.md).
