import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { verifyMarts } from '../src/dwh/publish.js';
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
