import test from 'node:test';
import assert from 'node:assert/strict';
import { looksDegraded } from '../lib/meta-guard.mjs';

const healthy = {
  headerImage: 'https://img/x.jpg',
  genres: ['Action', 'Indie'],
  reviewCount: 12000,
};

test('first-ever meta is never degraded (nothing to protect)', () => {
  assert.equal(looksDegraded(null, { headerImage: null, genres: [], reviewCount: 0 }), false);
});

test('hollowed-out responses are rejected: vanished image, genres or reviews', () => {
  assert.ok(looksDegraded(healthy, { ...healthy, headerImage: null }));
  assert.ok(looksDegraded(healthy, { ...healthy, genres: [] }));
  assert.ok(looksDegraded(healthy, { ...healthy, reviewCount: 0 }));
});

test('legitimate updates pass: values changing without disappearing', () => {
  assert.equal(looksDegraded(healthy, { ...healthy, reviewCount: 12500, genres: ['Action'] }), false);
  assert.equal(looksDegraded(healthy, { ...healthy, headerImage: 'https://img/new.jpg' }), false);
});

test('small review counts may drop to zero (review purges happen on tiny games)', () => {
  assert.equal(looksDegraded({ ...healthy, reviewCount: 30 }, { ...healthy, reviewCount: 0 }), false);
});
