import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { verifyMarts, streamsFor, playableIn, FREE } from '../src/dwh/publish.js';
import { toStream } from '../src/publish.js';

function mart(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mart-'));
  fs.mkdirSync(path.join(dir, 'stream', 'movie'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'stream', 'series'), { recursive: true });
  for (const [file, body] of entries) fs.writeFileSync(path.join(dir, file), body);
  return dir;
}
const ok = (id, ytId) => [`stream/movie/${id}.json`, JSON.stringify({ streams: [{ ytId }] })];

test('a complete mart passes', async () => {
  const dir = mart([ok('tt1', 'a'), ok('tt2', 'b')]);
  await verifyMarts(dir, [{ imdbId: 'tt1', ytId: 'a' }, { imdbId: 'tt2', ytId: 'b' }]);
});

test('a zero-byte stream file is caught', async () => {
  // The real one: a publish left tt0317268.json empty because the host VM was
  // killed mid-run, and a kill here is power loss. The catalogue still listed
  // the film, so Stremio would have offered it and then had no stream at all.
  const dir = mart([ok('tt1', 'a'), ['stream/movie/tt2.json', '']]);
  await assert.rejects(
    () => verifyMarts(dir, [{ imdbId: 'tt1', ytId: 'a' }, { imdbId: 'tt2', ytId: 'b' }]),
    /1 unusable stream file/);
});

test('a missing file and a stale ytId are caught too', async () => {
  const dir = mart([ok('tt1', 'a'), ok('tt2', 'STALE')]);
  await assert.rejects(
    () => verifyMarts(dir, [
      { imdbId: 'tt1', ytId: 'a' },
      { imdbId: 'tt2', ytId: 'b' },
      { imdbId: 'tt3', ytId: 'c' },
    ]),
    /2 unusable stream file/);
});

test('an episode is looked up under its composite id', async () => {
  const dir = mart([['stream/series/tt9:1:2.json', JSON.stringify({ streams: [{ ytId: 'z' }] })]]);
  await verifyMarts(dir, [{ imdbId: 'tt9', id: 'tt9:1:2', stremioType: 'series', ytId: 'z' }]);
});

test('a gated upload we cannot replace is served honestly, not hidden', () => {
  // "Re-resolve to another upload" is not "delete when there is no other
  // upload": three of the first four gated films found had no spare at all.
  // They keep their stream, and notWebReady stops the app from failing
  // silently in the embedded player, which is exactly where gating bites.
  const plain = toStream({ ytId: 'a', channel: 'Mosfilm', imdbRuntimeMin: 95, confidence: 86 });
  assert.equal(plain.behaviorHints.notWebReady, false);
  assert.ok(!plain.title.includes('sign-in'));

  const gated = toStream({ ytId: 'b', channel: 'Mosfilm', imdbRuntimeMin: 95,
                           confidence: 86, playback: 'age-gated' });
  assert.equal(gated.behaviorHints.notWebReady, true);
  assert.match(gated.title, /sign-in required/);
  assert.equal(gated.externalUrl, 'https://www.youtube.com/watch?v=b');
});

test('a film offers every playable copy, best first and gated last', () => {
  // Stremio's stream endpoint is an array and this addon only ever put one
  // thing in it, so 579 films quietly threw away a second working copy. That is
  // also why the age-gate swap helped only one gated upload in seven: a film
  // with a spare did not need choosing between, it needed both offered.
  const row = (ytId, confidence, published_id) => ({
    ytId, confidence, published_id, imdb_id: 'tt1', status: 0,
    channel_name: 'Ch', grp: 'G', raw_title: 't', clean_title: 't',
    match_name: 'Film', imdb_runtime: 95, runtime_min: 95,
  });
  const winner = { ytId: 'best', imdbId: 'tt1', id: 'tt1', confidence: 92, channel: 'Ch', imdbRuntimeMin: 95 };
  const regional = [row('best', 92, 'tt1'), row('good', 88, 'tt1'),
                    row('gated', 99, 'tt1'), row('other', 90, 'tt2')];

  const streams = streamsFor(winner, regional, new Set(['gated']));
  assert.deepEqual(streams.map(s => s.ytId), ['best', 'good', 'gated']);
  // The winner leads because the scorer trusts it most; the gated copy sorts
  // last despite the highest confidence, so a viewer reaches a working stream
  // before one that asks them to sign in. tt2 belongs to another film.
  assert.equal(streams[2].behaviorHints.notWebReady, true);
  assert.match(streams[2].title, /sign-in required/);
  assert.equal(streams[0].behaviorHints.notWebReady, false);
});

test('an alternate stream must be an accepted match, not a reviewed one', () => {
  // Filtering on the published id alone offered uploads the scorer had rejected
  // as too uncertain: 127 films were served a low-score or narrow-margin match
  // as a playable alternative. A viewer picking the second stream and getting a
  // different film is worse than a film with only one stream.
  const row = (ytId, status, reason) => ({
    ytId, status, reason, confidence: 90, published_id: 'tt1', imdb_id: 'tt1',
    channel_name: 'Ch', grp: 'G', raw_title: 't', clean_title: 't',
    match_name: 'Film', imdb_runtime: 95, runtime_min: 95,
  });
  const winner = { ytId: 'best', imdbId: 'tt1', id: 'tt1', confidence: 92, channel: 'Ch' };
  const streams = streamsFor(winner, [
    row('best', 0, null), row('alsoGood', 0, null),
    row('unsure', 1, 'low-score'), row('close', 1, 'narrow-margin'),
  ], new Set());
  assert.deepEqual(streams.map(s => s.ytId), ['best', 'alsoGood']);
});

test('the free region means unrestricted, not "playable here"', () => {
  // A viewer in Bogotá and one in Zagreb install the same URL, so every stream
  // in the unrestricted build has to work for both. An upload allowed only in
  // the US passes playableIn('US') and must not pass this.
  assert.equal(playableIn(FREE, null, null), true);
  assert.equal(playableIn(FREE, '', ''), true);
  assert.equal(playableIn(FREE, null, 'US,CA'), false, 'allow-listed is still restricted');
  assert.equal(playableIn(FREE, 'DE', null), false, 'blocked anywhere is still restricted');

  // Named regions are unchanged.
  assert.equal(playableIn('US', null, 'US,CA'), true);
  assert.equal(playableIn('HR', null, 'US,CA'), false);
  assert.equal(playableIn('HR', 'DE,FR', null), true);
  assert.equal(playableIn('DE', 'DE,FR', null), false);
});
