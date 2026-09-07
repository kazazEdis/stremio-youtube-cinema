import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classify, regionVerdict, publishedStreams, rootRegion, FREE } from '../src/dwh/verify-streams.js';

const video = (over = {}) => ({
  id: 'x',
  status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: true },
  contentDetails: {},
  ...over,
});

test('a video the API does not return at all is gone', () => {
  // videos.list simply omits ids that are deleted, private, or on a terminated
  // channel — there is no error and no placeholder, so absence is the signal.
  assert.equal(classify(undefined, 'HR'), 'gone');
  assert.equal(classify(null, 'HR'), 'gone');
});

test('a healthy public video passes', () => {
  assert.equal(classify(video(), 'HR'), 'ok');
});

test('the ways a video stops being servable are told apart', () => {
  // Each one wants a different response, so they must not collapse into one
  // bucket: a private video is gone for good, a geo-block is regional, and an
  // un-embeddable video still plays on YouTube itself.
  assert.equal(classify(video({ status: { privacyStatus: 'private' } }), 'HR'), 'not-public');
  assert.equal(classify(video({ status: { privacyStatus: 'public', embeddable: false } }), 'HR'),
               'not-embeddable');
  assert.equal(classify(video({ status: { privacyStatus: 'public', uploadStatus: 'rejected' } }), 'HR'),
               'upload:rejected');
});

test('region restrictions are read the way publish reads them', () => {
  // Mirrors playableInRegion: a blocked list wins outright, otherwise an
  // allowed list must contain the region, otherwise it plays.
  assert.equal(regionVerdict({ blocked: ['HR', 'DE'] }, 'HR'), 'blocked');
  assert.equal(regionVerdict({ blocked: ['DE'] }, 'HR'), 'ok');
  assert.equal(regionVerdict({ allowed: ['US', 'CA'] }, 'HR'), 'not-allowed');
  assert.equal(regionVerdict({ allowed: ['US', 'HR'] }, 'HR'), 'ok');
  assert.equal(regionVerdict(undefined, 'HR'), 'ok');
  assert.equal(regionVerdict({}, 'HR'), 'ok');

  assert.equal(classify(video({ contentDetails: { regionRestriction: { allowed: ['US'] } } }), 'HR'),
               'region:not-allowed');
});

test('a missing status block does not read as broken', () => {
  // The API omits fields rather than nulling them, and treating an absent
  // embeddable flag as false would condemn the whole catalogue.
  assert.equal(classify({ id: 'x' }, 'HR'), 'ok');
});

test('every stream in a file is collected, not just the first', async () => {
  // A film can offer several copies. Reading only streams[0] meant the
  // alternates were never checked by anything, so "100% coverage" covered the
  // winners alone while the fallbacks went unmeasured — any of which could be
  // gated or dead and still be offered to a viewer.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-'));
  fs.mkdirSync(path.join(dir, 'stream', 'movie'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'stream', 'movie', 'tt1.json'),
    JSON.stringify({ streams: [{ ytId: 'a' }, { ytId: 'b' }, { ytId: 'c' }] }));
  fs.writeFileSync(path.join(dir, 'stream', 'movie', 'tt2.json'),
    JSON.stringify({ streams: [{ ytId: 'd' }] }));

  const got = await publishedStreams(dir);
  assert.deepEqual(got.map(s => s.ytId).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(got.filter(s => s.id === 'tt1').map(s => s.rank), [0, 1, 2]);
});

// #region ------------------------------------------------ per-tree regions
test('a tree is judged against its own region, not one global one', () => {
  // GKs2Dsdm-GU and 528 siblings are allowed in AS,CA,FM,GU,MH,MP,PR,PW,UM,US,VI.
  // They are correctly listed in region=ca and region=us. Judging all 21 trees
  // against a single --region HR called them broken and produced 3,662
  // problems, nearly all of them the checker's own error -- which left a real
  // regional failure indistinguishable from the noise.
  const usOnly = { allowed: ['AS', 'CA', 'FM', 'GU', 'MH', 'MP', 'PR', 'PW', 'UM', 'US', 'VI'] };
  assert.equal(regionVerdict(usOnly, rootRegion('docs/region=us')), 'ok');
  assert.equal(regionVerdict(usOnly, rootRegion('docs/region=ca')), 'ok');
  assert.equal(regionVerdict(usOnly, rootRegion('docs/region=hr')), 'not-allowed');
});

test('rootRegion reads the tree, and the bare root is not a region', () => {
  assert.equal(rootRegion('docs/region=ca'), 'CA');
  assert.equal(rootRegion('docs/region=jp'), 'JP');
  assert.equal(rootRegion('docs'), FREE);
  assert.equal(rootRegion('out'), FREE);
});

test('FREE means no restriction at all, not "playable where I am"', () => {
  // Mirrors playableIn's FREE branch in publish.js: the unrestricted build must
  // work for a viewer anywhere, so ANY list disqualifies. Passing null through
  // the ordinary branches returned 'ok' for a blocked list with no allowed
  // list -- the one case that most needs catching.
  assert.equal(regionVerdict({ blocked: ['DE'] }, FREE), 'restricted');
  assert.equal(regionVerdict({ allowed: ['US'] }, FREE), 'restricted');
  assert.equal(regionVerdict(undefined, FREE), 'ok');
  assert.equal(regionVerdict({}, FREE), 'ok');
  // and through classify, which is what the run actually calls
  assert.equal(classify(video({ contentDetails: { regionRestriction: { blocked: ['DE'] } } }), FREE),
               'region:restricted');
  assert.equal(classify(video(), FREE), 'ok');
});
// #endregion
