import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, fetchText, setRequestBudget, requestsMade, resetHostState } from '../lib/http.mjs';

function fakeFetch(script) {
  let call = 0;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const step = script[Math.min(call, script.length - 1)];
    call++;
    if (step.throw) throw new Error(step.throw);
    return {
      ok: step.status === 200,
      status: step.status,
      url,
      headers: { get: (name) => step.headers?.[name.toLowerCase()] ?? null },
      json: async () => step.body ?? {},
      text: async () => step.text ?? '',
    };
  };
  return calls;
}

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestBudget(Infinity);
  resetHostState();
});

test('permanent 4xx fails fast: one attempt, status surfaced', async () => {
  const calls = fakeFetch([{ status: 404 }]);
  await assert.rejects(
    fetchJson('https://a.example/x', { label: 't' }),
    (err) => err.status === 404 && err.permanent === true,
  );
  assert.equal(calls.length, 1, 'no retry on 404');
});

test('429 retries after Retry-After and succeeds', async () => {
  const calls = fakeFetch([
    { status: 429, headers: { 'retry-after': '0' } },
    { status: 200, body: { ok: 1 } },
  ]);
  const body = await fetchJson('https://b.example/x', { label: 't' });
  assert.deepEqual(body, { ok: 1 });
  assert.equal(calls.length, 2);
});

test('5xx retries up to the attempt limit, then throws', async () => {
  const calls = fakeFetch([{ status: 503 }]);
  await assert.rejects(
    fetchJson('https://c.example/x', { label: 't', attempts: 2 }),
    (err) => err.status === 503,
  );
  assert.equal(calls.length, 2);
});

test('request budget aborts retry storms with a distinguishable error', async () => {
  fakeFetch([{ status: 503 }]);
  setRequestBudget(2);
  await assert.rejects(
    fetchJson('https://d.example/x', { label: 't', attempts: 10 }),
    (err) => err.budget === true,
  );
  assert.equal(requestsMade(), 2);
});

test('fetchText returns text and the final URL after redirects', async () => {
  fakeFetch([{ status: 200, text: '<html>hi</html>' }]);
  const { text, finalUrl } = await fetchText('https://e.example/page', { label: 't' });
  assert.equal(text, '<html>hi</html>');
  assert.equal(finalUrl, 'https://e.example/page');
});
