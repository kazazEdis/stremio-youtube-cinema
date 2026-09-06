# Memory

What this project learned the hard way. One page per subject; each is written to
be useful to someone who has never seen the code, and every claim in them is
something that was measured or that broke in production.

The `docs/` specs say what the system does. These say **why it is shaped like
that**, which is the part a fork cannot recover by reading the source.

| page | what it saves you |
|---|---|
| [host-and-resumability](memory/host-and-resumability.md) | why every long step checkpoints, and what "the process will be killed" does to a design |
| [imdb-datasets](memory/imdb-datasets.md) | 1.8 GB of third-party data, a daily republish, and the resume bug that spliced four archives |
| [resolver-scoring](memory/resolver-scoring.md) | the §4 weights, the cliff at 84, and why a wrong match is worse than no match |
| [title-extraction](memory/title-extraction.md) | how channels name uploads, and the rules that survived measurement |
| [stremio-protocol](memory/stremio-protocol.md) | what a client actually requests, and the four ways a static addon breaks |
| [regions](memory/regions.md) | the unrestricted/per-region split and why combinations cannot be pre-generated |
| [playback-verification](memory/playback-verification.md) | the API lies about age-gating; how the catalogue is checked against reality |
| [build-and-deploy](memory/build-and-deploy.md) | why a code change ships on push and a data change does not |

## The shortest version

- **A wrong IMDb id is the worst failure this project has.** Everything else is
  a tuning question.
- **Count-positive is not the same as right.** Three separate changes improved
  the exact-match count and were rejected for what they broke.
- **The failures that hurt were invisible from inside.** A dead fuzzy tier, a
  zero-byte mart file, a `genre` chip that 404s — all of them left every
  internal number looking correct.
- **The host will kill you.** Design for it.
- **Green is not deployed.** `deploy-site` re-renders the warehouse it is given;
  a feature that needs new *data* ships only when `build-catalog` runs.
