/**
 * parseEpisode against the formats actually present in the catalogue.
 *
 * Every case is a real upload title. The parser composes with cleanTitle rather
 * than duplicating it: parseEpisode finds the marker and hands the text before
 * it over, so the channel-brand strip and cast-run rules still apply.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseEpisode, episodeId } from '../src/transform/episode.js';
import { cleanTitle } from '../src/transform/title.js';

const show = raw => {
  const ep = parseEpisode(raw);
  return ep && cleanTitle(ep.showTitle, 'Public Domain Movies');
};

test('SxxExx in its various spacings', () => {
  assert.deepEqual(
    { ...parseEpisode('One Step Beyond   S2E17   EARTHQUAKE || Tv-Series'), showTitle: undefined, marker: undefined },
    { season: 2, episode: 17, showTitle: undefined, marker: undefined });
  assert.equal(parseEpisode('The Beverly Hillbillies (1962)  S01E23  Jed Buys the Freeway').episode, 23);
  assert.equal(parseEpisode('Sherlock Holmes (TV-1954) HARRY CROCKER (S1E9)').episode, 9);
});

test('Season N ... Episode N, even split across separators', () => {
  assert.equal(parseEpisode('Sapphire And Steel: Season 1 Episode 1 - Escape').season, 1);
  // "Season 4 | Full Episode 1" is one marker split across two pipes, not two
  // unrelated segments -- excluding the pipe lost the season entirely.
  const f = parseEpisode('Funny Ka, Pare Ko | Season 4 | Full Episode 1 | CineMo');
  assert.equal(f.season, 4);
  assert.equal(f.episode, 1);
});

test('a bare episode number defaults to season 1', () => {
  // Mostly 1950s anthology and western series whose uploads are not
  // season-scoped. A wrong guess is invisible: Cinemeta never lists the
  // episode, so the stream is never offered.
  const t = parseEpisode('Tate (TV-1960) MARY HARDIN (Episode 4) TV Western');
  assert.equal(t.season, 1);
  assert.equal(t.episode, 4);
});

test('the show name survives the marker and the channel branding', () => {
  assert.equal(show('One Step Beyond   S2E17   EARTHQUAKE || Tv-Series'), 'One Step Beyond');
  assert.equal(show('The Beverly Hillbillies (1962)  S01E23  Jed Buys the Freeway'), 'The Beverly Hillbillies');
  assert.equal(show('Sherlock Holmes (TV-1954) HARRY CROCKER (S1E9)'), 'Sherlock Holmes');
  assert.equal(show('Medic (TV-1955) FLASH OF DARKNESS (S1E14)'), 'Medic');
  assert.equal(show('Rocky Jones, Space Ranger (1954)🎬 S1E5 Bobby s Comet'), 'Rocky Jones, Space Ranger');
});

test('films are never mistaken for episodes', () => {
  for (const notAnEpisode of [
    'Cavalry Command (1963) Full HD Movie | John Agar',
    'The Sea Wolf (1941)',
    'Django 1966 FULL WESTERN',
    // "Part N" is deliberately not a marker: these are split uploads of one
    // film, already handled by scoreRuntime's reject band. Treating them as
    // episodes would invent series that do not exist.
    'Wu Tang Collection - Part 2',
    'The Great Escape Part 1 of 2',
  ]) {
    assert.equal(parseEpisode(notAnEpisode), null, notAnEpisode);
  }
});

test('implausible numbers are rejected rather than guessed', () => {
  assert.equal(parseEpisode('Episode 0 of nothing'), null);
  // A marker with no show name in front of it has nothing to resolve against.
  assert.equal(parseEpisode('S01E05'), null);
});

test('episodeId builds the id Stremio asks for', () => {
  assert.equal(episodeId('tt0052514', 2, 17), 'tt0052514:2:17');
});
