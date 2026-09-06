/**
 * episode.js — pull season and episode numbers out of an upload title.
 *
 * Kept separate from title.js on purpose. cleanTitle is 46 tests deep and does
 * one job well; this is a different question asked of the same string, and the
 * two compose rather than merge — parseEpisode finds the marker and hands the
 * text before it to cleanTitle.
 *
 * Every format below is taken from real uploads in the catalogue:
 *
 *   One Step Beyond   S2E17   EARTHQUAKE            -> s2  e17
 *   The Beverly Hillbillies (1962)  S01E23  ...     -> s1  e23
 *   Sapphire And Steel: Season 1 Episode 1 - ...    -> s1  e1
 *   Funny Ka, Pare Ko | Season 4 | Full Episode 1   -> s4  e1
 *   Sherlock Holmes (TV-1954) HARRY CROCKER (S1E9)  -> s1  e9
 *   Tate (TV-1960) MARY HARDIN (Episode 4)          -> s1  e4   season defaulted
 *
 * "Part N" is deliberately NOT a marker. Those are split uploads of single
 * films, and scoreRuntime's sub-45% reject band already handles them; treating
 * them as episodes would invent series that do not exist.
 */

// Ordered: the most specific pattern must win. "Season 1 Episode 2" has to be
// tried before the bare "Episode 2" rule, or the season is silently lost.
const PATTERNS = [
  // S01E23, S1E9, S2 E17
  { re: /\bs\s?(\d{1,2})\s*[.\-_ ]?\s*e\s?(\d{1,3})\b/i, season: 1, episode: 2 },
  // Season 1 Episode 2, Season 4 | Full Episode 1, Season 1 - Ep 3
  // The gap may hold a separator: "Season 4 | Full Episode 1" is one marker
  // split across two pipes, not two unrelated segments.
  { re: /\bseason\s*(\d{1,2})\b[^)\]]{0,24}?\bep(?:isode)?\.?\s*(\d{1,3})\b/i,
    season: 1, episode: 2 },
  // 1x05
  { re: /\b(\d{1,2})x(\d{2,3})\b/, season: 1, episode: 2 },
  // Episode 4 / Ep. 12 with no season stated
  { re: /\bep(?:isode)?\.?\s*(\d{1,3})\b/i, season: null, episode: 1 },
];

/**
 * Where the show name ends. The marker itself and everything after it is
 * episode-specific: the episode's own title, the channel's tag line, the cast.
 */
function headOf(raw, matchIndex) {
  return raw.slice(0, matchIndex)
    // A trailing separator left dangling by the cut.
    .replace(/[\s|(\[\-–—:,]+$/, '')
    .trim();
}

/**
 * `{ season, episode, showTitle, marker }` or null when the title carries no
 * episode marker at all.
 *
 * A missing season becomes 1. These are mostly 1950s anthology and western
 * series whose uploads are not season-scoped, and a wrong guess costs nothing
 * visible: Cinemeta will not list the episode, so the stream is never offered.
 */
export function parseEpisode(rawTitle) {
  if (!rawTitle) return null;
  for (const { re, season, episode } of PATTERNS) {
    const m = re.exec(rawTitle);
    if (!m) continue;

    const ep = Number(m[episode]);
    const se = season === null ? 1 : Number(m[season]);
    // Guard against matching a year or a stray number: episode 0 does not
    // exist, and a three-digit season is a false positive.
    if (!Number.isFinite(ep) || ep < 1 || ep > 999) continue;
    if (!Number.isFinite(se) || se < 1 || se > 99) continue;

    const showTitle = headOf(rawTitle, m.index);
    // Without a show name in front of it the marker is unusable -- there is
    // nothing to resolve against.
    if (showTitle.length < 2) continue;

    return { season: se, episode: ep, showTitle, marker: m[0].trim() };
  }
  return null;
}

/** Cheap test for the transform's duration window, without building the rest. */
export const hasEpisodeMarker = raw => parseEpisode(raw) !== null;

/** The composite id Stremio uses for a series stream: tt1234567:1:5 */
export const episodeId = (tconst, season, episode) => `${tconst}:${season}:${episode}`;
