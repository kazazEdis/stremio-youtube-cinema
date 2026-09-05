/**
 * Spec §7 — normalize() against diacritics, articles and roman numerals.
 *
 * These matter more than they look. normalize() runs on both sides of every
 * comparison, so a change here silently changes what 1.1M indexed rows mean.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize, stripArticle, normVariants, similarity } from '../src/resolve/normalize.js';

test('diacritics decompose to ASCII', () => {
  assert.equal(normalize('Ivan Grozný'), 'ivan grozny');
  assert.equal(normalize('Les Diaboliques'), 'les diaboliques');
  assert.equal(normalize('Ördög'), 'ordog');
  assert.equal(normalize('Άνθρωπος'), 'ανθρωπος');   // Greek tonos stripped
});

test('characters NFD does not decompose are transliterated', () => {
  // The whole reason TRANSLIT exists: NFD leaves these alone, so without the
  // map Polish, Nordic and Balkan titles never match their aka rows.
  assert.equal(normalize('Løve'), 'love');
  assert.equal(normalize('Łódź'), 'lodz');
  assert.equal(normalize('Đavo'), 'davo');
  assert.equal(normalize('Straße'), 'strasse');
  assert.equal(normalize('Æon'), 'aeon');
});

test('punctuation becomes a separator and whitespace collapses', () => {
  assert.equal(normalize('Dr. Strangelove:  Or, How I Learned'), 'dr strangelove or how i learned');
  assert.equal(normalize('  M —  Eine Stadt  '), 'm eine stadt');
});

test('non-Latin scripts stay in their own script rather than transliterating', () => {
  assert.equal(normalize('七人の侍'), '七人の侍');
  assert.equal(normalize('오발탄'), '오발탄');
  // Cyrillic stays Cyrillic — we never romanize, because the akas rows we are
  // matching against are themselves Cyrillic.
  assert.match(normalize('Иван Грозный'), /^[\u0430-\u044f ]+$/);
});

test('combining marks collapse inside Cyrillic too, and that is wanted', () => {
  // NFD decomposes й into и + breve and the breve is stripped, so "Грозный"
  // normalizes to "грозныи". This is symmetric — the IMDb aka row goes through
  // the same function — and it folds together the й/и and ё/е spellings that
  // Russian titles are inconsistent about, which gains recall rather than
  // losing it. Pinned here so nobody "fixes" it.
  assert.equal(normalize('Иван Грозный'), 'иван грозныи');
  assert.equal(normalize('Ёжик'), normalize('Ежик'));
});

test('roman numerals are preserved — Rocky II is not Rocky', () => {
  assert.equal(normalize('Rocky II'), 'rocky ii');
  assert.notEqual(normalize('Rocky II'), normalize('Rocky'));
});

test('stripArticle removes only a leading article', () => {
  assert.equal(stripArticle('the killers'), 'killers');
  assert.equal(stripArticle('la strada'), 'strada');
  assert.equal(stripArticle('django'), 'django');
  // Not an article, just a word that starts like one.
  assert.equal(stripArticle('theatre of blood'), 'theatre of blood');
});

test('normVariants indexes both forms, deduped', () => {
  assert.deepEqual(normVariants('The Killers'), ['the killers', 'killers']);
  assert.deepEqual(normVariants('Django'), ['django']);
  assert.deepEqual(normVariants(''), []);
});

test('similarity is bounded, symmetric and 1 on identity', () => {
  assert.equal(similarity('nosferatu', 'nosferatu'), 1);
  assert.equal(similarity('abc', 'xyz'), 0);
  assert.equal(similarity('django', 'djanga'), similarity('djanga', 'django'));
  const s = similarity('the sea wolf', 'sea wolf');
  assert.ok(s > 0 && s < 1, `expected 0<s<1, got ${s}`);
});
