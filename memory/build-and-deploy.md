# Build and deploy

Two workflows, and the split is the thing to understand before changing either.

| | owns | costs |
|---|---|---|
| `build-catalog` | the **warehouse** — extract, stage, transform, publish, probe | YouTube quota, ~40–90 min, weekly cron |
| `deploy-site` | **re-rendering** what the warehouse already holds | ~2–9 min, on push |

`deploy-site` exists because the site stopped updating on push. The twenty
regional trees are 66,000 files and are not committed, so only a run can produce
them — and going through `build-catalog` to change a line of HTML on the
configure page means spending quota and thirteen minutes on an index rebuild.

Both declare `concurrency: group: pages`. Two Pages deployments at once is one of
them losing, and the loser is whichever finished second regardless of which is
newer.

## The rule that is easy to break

**`deploy-site` restores the cache and must never write it.** Its cache step is
`actions/cache/restore@v4`, not `cache@v4`, deliberately: a deploy run that saved
its own copy would overwrite the warehouse `build-catalog` spent its quota on.

## The trap that follows from that rule

`deploy-site` can only render what is already **in** the warehouse. So a change
to *code* ships on push, and a change to *data* does not — and the two look
identical from the local tree, where both are already correct.

The Rating sort is the worked example. Sorting by IMDb rating needed
`title.ratings.tsv.gz` in the index and a `syncRatings` pass in transform.
Locally that produced ratings on 5,765 of 5,841 matched titles and a working
`genre=Rating` chip. The commit pushed, `deploy-site` ran green, Pages deployed
— and the live manifest offered:

    ["Popular", "Year"]

with `catalog/movie/ytc-all/genre=Rating.json` returning the 404 page. Nothing
failed. `deploy-site` had restored the warehouse `build-catalog` last wrote,
which had no `dim_rating` rows, and `writeTree` did exactly what it should:

```js
// Only offer Rating where there is something to rank on. A chip that
// silently sorts by nothing reads as a broken addon.
const sorts = SORTS.filter(n => n !== 'Rating' || movies.some(m => m.rating != null));
```

The guard was right and the deploy was still wrong. **A data-shaped feature is
not shipped until `build-catalog` has run**, whatever the local tree says.
`workflow_dispatch` is on it for exactly this.

## Verify against the deployed URL, not the local tree

`npm run conformance` walks `docs/`, which is the thing you just built. The
above passed it 21 times over. `--base https://…` walks what viewers actually
get, and is the only check that would have caught it:

    node src/conformance.js --base https://kazazedis.github.io/stremio-youtube-cinema

See [[stremio-protocol]] for what conformance checks, and
[[host-and-resumability]] for why the local half of this is checkpointed.
