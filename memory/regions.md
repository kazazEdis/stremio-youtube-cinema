# Regions

A YouTube upload can be allowed in some countries and not others, and the
warehouse keeps `blocked_regions` / `allowed_regions` on every one. Two-thirds
of the catalogue carries no restriction at all; the other third is where this
gets interesting.

    films total                    3,963
    playable anywhere              2,551   64.4%
    need a region to decide        1,412

    US unlocks +1,200    CA +1,023    GB +623    DE +354

## Why combinations cannot be pre-generated

Twenty regions is 2²⁰ selections, and the catalogues do **not** collapse — all
twenty are distinct. On a static host every config value has to be a real
directory, so arbitrary combinations are out.

Stremio solves it instead: it merges catalogues and streams across installed
addons. Tick two countries, install both, get the exact union with every copy of
a film offered together. That requires a distinct manifest id per region, and it
is why the addon **name** is identical everywhere — they are all the same addon,
and what differs is the catalogue, so the country belongs on the catalogue rows.

## `FREE` is not "playable where I am"

The unrestricted root exists so a viewer anywhere can install one URL and have
every stream work. An upload allowed only in the US passes `playableIn('US')`
and must **not** pass this. That distinction is the whole split.

## Two rules with the same reason

Region is filtered **before** duplicate settling, and so is the age-gate
quarantine. A geo-blocked or unplayable upload that wins a duplicate contest and
is then filtered out takes the whole film with it.

## Cost

Each region is a complete tree — Stremio resolves every path against the
manifest's own base and never falls back to a parent. Twenty of them is ~66,000
files and 280 MB, ~85% identical to the root. They are gitignored and deployed
as a Pages artifact; only the unrestricted tree is committed, so the weekly
commit stays readable.

The configure page is generated from the trees that were actually built. A
region offered there that does not exist is a 404 a viewer reads as a broken
addon.
