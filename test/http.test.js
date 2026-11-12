// -----------------------------------------------------------------------------
// The network helper: our User-Agent, a body bounded while it arrives, a
// deadline over the whole answer, Retry-After read, bytes that are not UTF-8.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USER_AGENT } from '../src/constants.js';
import { HttpError, getJson, getText, retryAfterMs, waitInMessage } from '../src/http.js';
import { createFakeClock } from './helpers/app.js';

const URL_ = 'https://example.test/x';

test('our User-Agent and the Accept asked; JSON parsed; 204 and 304 carry no body', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = init;
    return new Response('{"a":1}', { status: 200, headers: { etag: '"1"' } });
  };
  const answer = await getJson(fetchImpl, URL_, {});
  assert.deepEqual(answer, { status: 200, data: { a: 1 }, etag: '"1"' });
  assert.equal(seen.headers['User-Agent'], USER_AGENT);
  assert.equal(seen.headers.Accept, 'application/json');
  const none = await getJson(async () => new Response(null, { status: 204 }), URL_, {});
  assert.equal(none.data, undefined);
  const same = await getText(async () => new Response(null, { status: 304 }), URL_, {});
  assert.equal(same.status, 304);
  await assert.rejects(
    getJson(async () => new Response('<html>'), URL_, {}),
    { code: 'parse' },
  );
});

test('a body larger than the bound is cut while it arrives, never read whole', async () => {
  let pulls = 0;
  const endless = () =>
    new Response(
      new ReadableStream({
        // 2.5 MB at most: a broken bound makes the test fail, never fill the RAM.
        pull(controller) {
          pulls += 1;
          if (pulls > 40) controller.close();
          else controller.enqueue(new Uint8Array(64 * 1024));
        },
      }),
    );
  await assert.rejects(
    getText(async () => endless(), URL_, { maxBytes: 256 * 1024 }),
    {
      code: 'too_large',
    },
  );
  assert.ok(pulls < 10, `${pulls} chunks read`);
  // A Content-Length above the bound: refused before reading.
  const declared = new Response('small', {
    headers: { 'content-length': String(10 * 1024 * 1024) },
  });
  await assert.rejects(
    getText(async () => declared, URL_, { maxBytes: 1024 }),
    {
      code: 'too_large',
    },
  );
});

test('the deadline covers the whole answer, a stalled body included', async () => {
  const fake = createFakeClock(0);
  const stalled = (url, init) =>
    new Promise((resolve) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(10));
          init.signal.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      resolve(new Response(body));
    });
  const p = getText(stalled, URL_, { timeoutMs: 5000, timers: fake.timers });
  const check = assert.rejects(p, { code: 'timeout' });
  await fake.advance(5000);
  await check;
  const never = (url, init) =>
    new Promise((resolve, reject) =>
      init.signal.addEventListener('abort', () => reject(new Error('abort'))),
    );
  const q = getText(never, URL_, { timeoutMs: 5000, timers: fake.timers });
  const check2 = assert.rejects(q, { code: 'timeout' });
  await fake.advance(5000);
  await check2;
  assert.equal(fake.pending.size, 0);
});

test('HTTP errors carry the status and Retry-After; network errors say so', async () => {
  const err = await getText(
    async () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
    URL_,
    {},
  ).catch((e) => e);
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 429);
  assert.equal(err.retryAfter, 120_000);
  assert.equal(
    retryAfterMs('Wed, 11 Nov 2026 09:00:00 GMT', Date.parse('2026-11-11T08:59:00Z')),
    60_000,
  );
  assert.equal(retryAfterMs('soon', 0), undefined);
  assert.equal(retryAfterMs(undefined, 0), undefined);
  await assert.rejects(
    getText(
      async () => Promise.reject(Object.assign(new Error('x'), { code: 'ECONNRESET' })),
      URL_,
      {},
    ),
    { code: 'network', message: 'network error (ECONNRESET)' },
  );
  await assert.rejects(
    getText(async () => new Response(new Uint8Array([0xff, 0xfe])), URL_, {}),
    {
      code: 'parse',
    },
  );
});

test('a 429 without Retry-After: the wait read from the message of Energi Data Service', async () => {
  const body =
    '{ "statusCode": 429, "message": "Rate limit is exceeded. Try again in 36 seconds." }';
  await assert.rejects(
    getJson(async () => new Response(body, { status: 429 }), URL_, {}),
    (err) => err instanceof HttpError && err.status === 429 && err.retryAfter === 36_000,
  );
  assert.equal(waitInMessage('Try again in 99999999 seconds'), undefined);
  assert.equal(waitInMessage('try again in 2 second'), 2000);
  assert.equal(waitInMessage('Try again in 900000 seconds'), 86_400_000);
  assert.equal(waitInMessage(null), undefined);
});
