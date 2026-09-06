import test from 'node:test';
import assert from 'node:assert/strict';

import { classify, regionVerdict } from '../src/dwh/verify-streams.js';

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
