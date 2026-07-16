import test from 'node:test';
import assert from 'node:assert/strict';
import { pageCount, pageSlice, pagePath, pagerModel, extraPageNumbers, PAGE_SIZE } from '../../site/src/lib/paginate.mjs';

test('single page: no pager, no extra routes', () => {
  assert.equal(pageCount(0), 1);
  assert.equal(pageCount(PAGE_SIZE), 1);
  assert.equal(pagerModel('/x', 1, PAGE_SIZE), null);
  assert.deepEqual(extraPageNumbers(PAGE_SIZE), []);
});

test('page 1 keeps the canonical base path; later pages get /n', () => {
  assert.equal(pagePath('/steam/deals', 1), '/steam/deals');
  assert.equal(pagePath('/steam/deals', 3), '/steam/deals/3');
});

test('slices are exact and the tail page is short', () => {
  const items = Array.from({ length: 205 }, (_, i) => i);
  assert.equal(pageCount(205), 3);
  assert.equal(pageSlice(items, 1).length, PAGE_SIZE);
  assert.equal(pageSlice(items, 3).length, 5);
  assert.equal(pageSlice(items, 2)[0], PAGE_SIZE);
  assert.deepEqual(extraPageNumbers(205), [2, 3]);
});

test('pager model wires prev/next and marks the current page', () => {
  const m = pagerModel('/x', 2, 205);
  assert.equal(m.count, 3);
  assert.equal(m.prevHref, '/x');
  assert.equal(m.nextHref, '/x/3');
  assert.deepEqual(m.pages.map((p) => p.current), [false, true, false]);
  assert.equal(pagerModel('/x', 1, 205).prevHref, null);
  assert.equal(pagerModel('/x', 3, 205).nextHref, null);
});
