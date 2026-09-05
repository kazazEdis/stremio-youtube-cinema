/**
 * cleanTitle against real channel formats.
 *
 * Every case here is an actual YouTube title from the catalog, because the
 * failures this function has are not the ones you invent at a desk — the naive
 * "first segment without marketing words" rule looked obviously right and
 * silently returned cast lists for a third of the catalog.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanTitle, extractYear } from '../src/transform/title.js';

test('the year parenthetical anchors the title', () => {
  // Marketing wraps the title on both sides with no pipe to split on.
  assert.equal(
    cleanTitle('NEW HD RESTORATION🍕 The Crawling Hand (1963) Sci-Fi Horror Classic, FULL HD MOVIE', 'PizzaFlix'),
    'The Crawling Hand');
  assert.equal(
    cleanTitle('🍕The Florodora Girl (MGM,1930) Full HD Movie, Marion Davies', 'PizzaFlix'),
    'The Florodora Girl');
  assert.equal(
    cleanTitle('A Killer on the Run! Clearing the Way with Bullets (1962) Pulp Crime Noir', 'Cult Cinema Classics'),
    'Clearing the Way with Bullets');
  assert.equal(
    cleanTitle('THE LATIN QUARTER CLAN! 💥 Without Warning (1973) [French Audio]', 'Cult Cinema Classics'),
    'Without Warning');
});

test('the channel brand is stripped from its own uploads', () => {
  // Left in place it is carried into the normalized key and matches nothing,
  // which silently rejected this channel's entire 2,204-film catalog.
  assert.equal(cleanTitle('Wu Tang Collection - The Eight Immortals', 'Wu Tang Collection'),
               'The Eight Immortals');
  assert.equal(cleanTitle('Wu Tang Collection - THE IRON MONKEY - (ENGLISH Subtitled)- CHEN KUAN TAI',
                          'Wu Tang Collection'),
               'THE IRON MONKEY');
});

test('a cast list never wins over the title', () => {
  assert.equal(cleanTitle('Bagheera Full Movie (HD) |  Prabhu Deva, Amyra Dastur', 'Shemaroo Movies'),
               'Bagheera');
  assert.equal(cleanTitle('Bollywood COMEDY Movie | Fool N Final | FULL MOVIE (HD) | Sunny Deol, Shahid Kapoor',
                          'Shemaroo Movies'),
               'Fool N Final');
});

test('titles that merely look like cast lists or marketing survive', () => {
  // One comma joining a lowercase continuation is a title, not a cast list.
  assert.equal(cleanTitle('The Good, the Bad and the Ugly | Western', 'Grjngo'),
               'The Good, the Bad and the Ugly');
  // A dash with no space on either side is part of the word.
  assert.equal(cleanTitle('Spider-Man', 'X'), 'Spider-Man');
  // A dash segment with lowercase is a subtitle, not a shouted performer name.
  assert.equal(cleanTitle('Ace Ventura - Pet Detective', 'X'), 'Ace Ventura - Pet Detective');
});

test('the spec §2 example still holds', () => {
  assert.equal(cleanTitle('FULL MOVIE | The Sea Wolf (1941) | Free Drama 4K', 'Movie Central'),
               'The Sea Wolf');
});

test('extractYear reads the raw title, not the cleaned one', () => {
  // cleanTitle drops the year now, so the year must come off the raw string.
  const raw = '🍕Cavalry Command (1963) Full HD Movie | John Agar';
  assert.equal(cleanTitle(raw, 'PizzaFlix'), 'Cavalry Command');
  assert.equal(extractYear(raw), 1963);
});

test('a title with no usable content falls back rather than returning empty', () => {
  assert.equal(cleanTitle('FULL MOVIE', 'X'), 'FULL MOVIE');
  assert.ok(cleanTitle('🍕🍕🍕', 'X').length > 0);
});
