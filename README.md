# stremio-youtube-cinema

A Stremio addon that surfaces feature films and TV legally on YouTube, resolved
to IMDb ids so Stremio brings its own artwork, cast and subtitles. It is a
**static** addon: every response is a JSON file on GitHub Pages, and there is no
server anywhere in it.

Live: <https://kazazedis.github.io/stremio-youtube-cinema/manifest.json>

    npm test              # no network, no fixtures to download
    npm run pipeline      # extract → stage → transform → publish
    npm run conformance   # walk the built addon the way Stremio does

Read [`CLAUDE.md`](CLAUDE.md) for the rules that govern changes here, and
[`docs/TODO.md`](docs/TODO.md) for what is done, what was tried and rejected,
and why.

---

## Setting up on a new machine

Node 24+ and git are the whole toolchain. **There are no dependencies** —
`package.json` has no `dependencies` or `devDependencies` at all, because the
warehouse uses `node:sqlite`, which is built in. That is also why the `engines`
floor is 24. Do not run `npm install`; there is nothing to install.

### 1. Clone

    git clone https://github.com/kazazEdis/stremio-youtube-cinema
    cd stremio-youtube-cinema
    node --version        # must be >= 24
    npm test              # should pass with no network

On **WSL**, keep the clone on the Linux filesystem (`~/stremio-youtube-cinema`),
**not** under `/mnt/c/`. The warehouse is SQLite and the index is a ~2 GB
database; both are punishingly slow over the Windows drive mount, and SQLite's
locking is unreliable there.

### 2. The three things git does not carry

The repo holds code plus the unrestricted `docs/` tree. Everything expensive is
gitignored, and each piece has a different recovery path:

| | size | how to get it | needed for |
|---|---|---|---|
| `.cache/imdb.sqlite` | ~2 GB | **rebuild** — `npm run build-index` | resolving, any scoring work |
| `data/warehouse.sqlite` | ~37 MB | **download from CI** (below) | everything downstream of resolve |
| `data/landing.sqlite` | ~17 MB | **copy it** — or re-extract, which costs YouTube quota | `extract`, `stage`, `transform` |

**The IMDb index — rebuild, do not copy.** It downloads ~1.8 GB of IMDb TSVs
and builds for roughly fifteen minutes:

    npm run build-index

It is checkpointed per pass *and* mid-pass, so a kill resumes rather than
restarts. `ensureLocal` reuses a downloaded file whose size matches the
server's, so a re-run does not re-fetch. **Never pass `--force`** unless you
actually intend to re-download all 1.8 GB.

**The warehouse — take it from CI.** Every `build-catalog` run uploads it as an
artifact with 30-day retention, so the freshest one is usually better than
anything on the old machine:

    gh run list --workflow build-catalog --limit 5
    gh run download <run-id> -R kazazEdis/stremio-youtube-cinema -n warehouse -D data/

**The landing database — copy it.** CI keeps it only in the Actions cache, which
cannot be downloaded, and rebuilding it means a full `extract` against the
YouTube Data API. It is 17 MB; move it by hand.

### 3. The API key

`extract` and `verify-streams` need a YouTube Data API key:

    echo 'YT_API_KEY=<your key>' > .env

Both scripts load it with `--env-file-if-exists=.env`, so everything else runs
without one. The same key lives in the repo's `YT_API_KEY` Actions secret;
GitHub cannot show it back to you, so keep your own copy.

### 4. Check the move worked

    npm test
    node -e "const{DatabaseSync}=require('node:sqlite');
      const d=new DatabaseSync('data/warehouse.sqlite',{readOnly:true});
      console.log(d.prepare('SELECT resolver_version v,COUNT(*) c FROM fct_resolution GROUP BY v').all())"
    npm run conformance

Conformance walks the committed `docs/` tree. To check what viewers actually
get, point it at the deployed site instead — a green local run has passed while
the live site was stale:

    node src/conformance.js --base https://kazazedis.github.io/stremio-youtube-cinema

## Building and deploying

`build-catalog` is **schedule-and-dispatch only** — it does *not* run on push,
and it is the only workflow that re-resolves. A resolver change ships when you
dispatch it:

    gh workflow run build-catalog --ref main

`deploy-site` runs on push, but only for `src/dwh/publish.js`, `src/publish.js`
and `src/report.js`, and it only republishes marts from the cached warehouse —
it never re-resolves. See [`memory/build-and-deploy.md`](memory/build-and-deploy.md)
for why that split exists and the trap it sets.

## A note on the old dev box

Much of the code is defensive about being killed mid-run — checkpoints
everywhere, resumable downloads, `--max-old-space-size=1024` on the heavy
scripts. That is because it was written on an Android Linux Terminal VM with
4 GB and no memory balloon, where long jobs died several times a day.

On WSL you will not hit that, and the heap caps can be raised if a stage is
slow. **Leave the resumability alone.** WSL still goes away — `wsl --shutdown`,
a host sleep, a Windows update — and the checkpointing is what makes a
forty-minute stage survive it.
