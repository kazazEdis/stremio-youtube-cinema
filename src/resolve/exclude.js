/**
 * exclude.js — declarative catalog exclusions, enforced in one place.
 *
 * Why this exists rather than a language filter on the IMDb side: the public
 * IMDb datasets carry no language or country field. `title.akas.language`
 * describes an individual alternate title, not the film, and every film with an
 * Indian release picks up an `IN` row — measured, a Hindi feature had 3 such
 * rows and a German silent had 1, which is not a separation you can threshold.
 *
 * The reliable signal is on the YouTube side: the script the channel actually
 * titled the upload in. That is observed data rather than inference, it catches
 * the content on any channel rather than only dedicated ones, and it is
 * legible — someone reading config/exclude.json can see exactly what is
 * dropped and why.
 */

// Unicode blocks. Devanagari covers Hindi (and Marathi/Nepali); the others are
// here so extending the list is a config change rather than a code change.
const SCRIPTS = {
  devanagari: /[ऀ-ॿ]/,
  tamil: /[஀-௿]/,
  telugu: /[ఀ-౿]/,
  bengali: /[ঀ-৿]/,
  arabic: /[؀-ۿ]/,
  thai: /[฀-๿]/,
};

export function loadExclusions(doc) {
  const d = doc || {};
  const unknown = (d.scripts || []).filter(s => !(s in SCRIPTS));
  if (unknown.length) {
    console.warn(`[warn]   exclude: unknown script(s) ${unknown.join(', ')} — ignored`);
  }
  return {
    scripts: (d.scripts || []).filter(s => s in SCRIPTS).map(s => [s, SCRIPTS[s]]),
    groups: new Set(d.groups || []),
    imdbIds: new Set(d.imdbIds || []),
    ytIds: new Set(d.ytIds || []),
  };
}

/**
 * Reason this video is excluded, or null to keep it.
 *
 * Tested against rawTitle, not the cleaned name: cleaning strips marketing and
 * can remove the very characters the script test looks for.
 */
export function excludeReason(video, rules) {
  if (rules.ytIds.has(video.ytId)) return 'ytId';
  if (rules.groups.has(video.group)) return `group:${video.group}`;
  for (const [name, re] of rules.scripts) {
    if (re.test(video.rawTitle || '')) return `script:${name}`;
  }
  return null;
}

/** Post-resolution exclusion, once a tconst is known. */
export const excludedByImdb = (imdbId, rules) => rules.imdbIds.has(imdbId);
