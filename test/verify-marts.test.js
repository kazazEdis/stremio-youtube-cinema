import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { verifyMarts } from '../src/dwh/publish.js';

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
