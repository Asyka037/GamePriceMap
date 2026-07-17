import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { euSolrMetaUrl, parseEuSolrMeta } from '../lib/nintendo-meta.mjs';

const body = JSON.parse(readFileSync(new URL('./fixtures/eu-solr-super-mario-party.json', import.meta.url)));
const identity = { slug: 'super-mario-party', title: 'Super Mario Party', euNsuid: '70010000014063' };

test('EU Solr URL queries by exact EU base-game NSUID, GAME type only', () => {
  const url = euSolrMetaUrl('70010000014063');
  assert.match(url, /searching\.nintendo-europe\.com/);
  assert.match(decodeURIComponent(url).replace(/\+/g, ' '), /type:GAME AND nsuid_txt:70010000014063/);
});

test('real EU Solr document parses into the shared meta shape', () => {
  const meta = parseEuSolrMeta(body, { ...identity, now: new Date('2026-07-17T00:00:00Z') });
  assert.equal(meta.name, 'Super Mario Party');
  assert.match(meta.headerImage, /^https:\/\/www\.nintendo\.com\//);
  assert.ok(meta.genres.includes('Party'));
  assert.equal(meta.releaseDate, '2018-10-05T00:00:00Z');
  assert.equal(meta.comingSoon, false);
  assert.equal(meta.metaSource, 'nintendo-eu-solr');
  assert.equal(meta.reviewCount, 0, 'EU Solr has no review data; shape stays consistent');
});

test('identity guards fail closed: wrong nsuid, wrong title, non-base nsuid', () => {
  assert.equal(parseEuSolrMeta(body, { ...identity, euNsuid: '70010000099999' }), null);
  assert.equal(parseEuSolrMeta(body, { ...identity, title: 'Super Mario Party Jamboree' }), null);
  assert.equal(parseEuSolrMeta(body, { ...identity, euNsuid: '70070000014063' }), null, '7007 bundle prefix rejected');
  assert.equal(parseEuSolrMeta({ response: { docs: [] } }, identity), null);
});
