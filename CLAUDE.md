# Working on this repository

A Stremio addon that surfaces feature films and TV legally on YouTube, resolved
to IMDb ids so Stremio brings its own artwork, cast and subtitles. It is a
**static** addon: every response is a JSON file on GitHub Pages, and there is no
server anywhere in it.

    npm test              # 111 tests, no network, no fixtures to download
    npm run pipeline      # extract → stage → transform → publish
    npm run conformance   # walk the built addon the way Stremio does

## Where the knowledge is

| | |
|---|---|
| [`MEMORY.md`](MEMORY.md) | index of the `memory/` wiki — **read this first** |
| [`docs/RESOLVER_SPEC.md`](docs/RESOLVER_SPEC.md) | the matching contract: signals, weights, thresholds |
| [`docs/PIPELINE.md`](docs/PIPELINE.md) | the warehouse layers and what each stage owns |
| [`docs/FORMATS.md`](docs/FORMATS.md) | why SQLite for the warehouse and JSON for the marts |
| [`docs/TODO.md`](docs/TODO.md) | the running log — what was done, what was tried and rejected, and why |

The specs describe what the code does. The `memory/` wiki describes **what it
cost to find out** — the failures that shaped the design, most of which are not
recoverable by reading the source.

## The rules that matter most

**Never publish a wrong IMDb id.** A wrong tconst makes every other addon in the
stack serve the wrong thing — Cinemeta's synopsis, the subtitle addon's tracks,
the viewer's watch history. Rejecting a match costs one film; a wrong match
corrupts a viewer's library. Every threshold in the resolver leans that way, and
`docs/TODO.md` is full of changes that were measured, found net-positive by
count, and rejected anyway because of what kind of thing they got wrong.

**Measure before and after, on the whole corpus.** Nearly every improvement here
looked obvious and several were backwards. There is a harness pattern used
throughout: run the old and new code over all 22,453 uploads, count exact index
hits, and read the gained/lost lists rather than the totals. Lowering
`looksLikeHook`'s six-word floor scores **+55** and is still wrong — it costs
*The Last Man On Earth* to "Vincent Price".

**Anything long must be resumable.** The reference host kills the process
routinely; see [`memory/host-and-resumability.md`](memory/host-and-resumability.md).
Every long stage checkpoints mid-pass, not just between passes.

**Verify what you wrote, not what you meant to write.** A publish once left a
zero-byte stream file and every count still added up. `verifyMarts` reads back
every file the catalogue promises; `conformance.js` then walks the result as a
client would.

## Conventions

- **Node 24+**, zero runtime dependencies. `node:sqlite` is built in — that is
  why the warehouse is SQLite and why the `engines` floor is 24.
- **Comments explain *why*, and cite the failure.** A comment that restates the
  code is noise; one that says "this shape reported *Man with a Camera* as
  broken because its episodes are S1E6 and S1E12" stops the next person redoing
  it. That style is deliberate throughout — match it.
- **`docs/` is generated.** Only the unrestricted tree is committed;
  `docs/region=*/` is built in CI and deployed as a Pages artifact.
- Commit messages carry the reasoning and the numbers, not just the change.
