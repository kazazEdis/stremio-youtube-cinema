# IMDb datasets

Five files, ~1.8 GB, under a non-commercial licence. Never committed; rebuilt
into `.cache/imdb.sqlite`, which is ~1.6 GB and also never committed.

| file | size | what it is for |
|---|---|---|
| `title.basics` | 226 MB | the titles themselves; filtered to `KEEP_TYPES` |
| `title.akas` | 513 MB | alternate titles — the single biggest source of matches |
| `title.principals` | 782 MB | director and cast, for corroboration |
| `name.basics` | 309 MB | resolves those credits to names |
| `title.ratings` | 9 MB | the only quality signal IMDb gives away |

`title.akas` earns its size: without it the non-English channels resolve almost
nothing. `title.ratings` is trivially small and was simply never fetched until
sorting needed it.

## IMDb republishes daily, and that is a hazard

The index records the dataset stamp it was built from, and a build that sees a
new stamp resets — otherwise the index and the data disagree in ways that are
invisible until a match is wrong.

The dangerous interaction is with **resumed downloads**:

> A resume that only checks content-length will splice the tail of a new dump
> onto the head of an old one. The file is exactly the right length and is not
> a valid gzip.

That happened to **four of five datasets at once**. It surfaced as
`incorrect header check` thrown from inside a pass, minutes later, with no
filename attached.

Two fixes, and the order matters:

1. **`If-Range` with the validator of the bytes you already have.** Record the
   ETag beside the partial when the transfer starts and send *that*. Sending the
   server's *current* ETag looks like a fix and is not — it matches by
   construction, so every range is honoured. A partial with no recorded
   validator is not resumed at all.
2. **Decompress the whole archive before trusting it.** A header-only check is
   worthless here: all four corrupt files passed one. The splice is
   mid-stream. It costs one decompress per transfer, never on a cache hit, and
   turns an opaque failure deep in a pass into a named one at the point the
   bytes arrived.

## Passes are checkpointed individually

`basics → akas → ratings → principals → names → indexes → done`, each marked in
`meta`. A new pass added later runs on its own against an existing index rather
than forcing a rebuild — which is how ratings were added without re-fetching
1.8 GB.

`CREATE TABLE IF NOT EXISTS` everywhere, and the schema is re-executed on every
open, so a new table reaches an old index for free. That does **not** apply to
new *columns*: `IF NOT EXISTS` adds none, and forgetting that produced
`NOT NULL constraint failed: dim_channel.channel_ref` a full run after the
damage was done.

## Normalisation is the quiet one

One `normalize()` used on both sides of every comparison. Asymmetry is the
classic silent miss:

- NFD decomposes Hangul into Jamo, and Jamo are letters rather than combining
  marks, so `\p{M}` does not strip them. Without a closing `.normalize('NFC')`
  every Korean title is stored decomposed and matches nothing.
- Non-alphanumerics become spaces, so `&` disappears while `and` survives.
  Measured: fixing it would reach 7 index titles, 1 plausible. Not worth a
  rebuild — but know it is there.
