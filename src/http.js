// -----------------------------------------------------------------------------
// The only way out to the network: GET with the integration's own User-Agent,
// a deadline that covers the whole body, and a size bound checked while the
// body arrives (a huge answer is cut, never read whole). The fetch function
// is injected (tests run without network).
// -----------------------------------------------------------------------------

import { USER_AGENT } from './constants.js';

export class HttpError extends Error {
  constructor(code, message, { status, retryAfter } = {}) {
    super(message);
    this.name = 'HttpError';
    this.code = code; // 'status' | 'timeout' | 'too_large' | 'network' | 'parse'
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Retry-After in ms (seconds or an HTTP date), or undefined. */
export function retryAfterMs(value, nowMs) {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  if (/^\d{1,7}$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

/** "Try again in 36 seconds" -> 36000 (at most a day), or undefined. */
export function waitInMessage(text) {
  const m = /try again in (\d{1,6}) seconds?/i.exec(String(text ?? '').slice(0, 2048));
  return m ? Math.min(Number(m[1]), 86_400) * 1000 : undefined;
}

/** The first `max` bytes of a body as text ('' when it cannot be read). */
async function readSome(response, max) {
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    while (size < max) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      size += part.value.byteLength;
    }
  } catch {
    return '';
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}

/**
 * GET `url` -> `{ status, text, etag }` (200, 204 or 304), or throws an
 * HttpError. `headers` adds request headers (If-None-Match).
 */
export async function getText(
  fetchImpl,
  url,
  {
    headers = {},
    timeoutMs = 15_000,
    maxBytes = 512 * 1024,
    accept = 'application/json',
    now = Date.now,
    timers = { setTimeout, clearTimeout },
  },
) {
  const controller = new AbortController();
  const timer = timers.setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: accept, ...headers },
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new HttpError('timeout', 'no answer in time');
      throw new HttpError('network', `network error (${err?.code ?? err?.name ?? 'error'})`);
    }
    const status = response.status;
    const etag = response.headers?.get?.('etag') ?? null;
    if (status === 304 || status === 204) {
      await response.body?.cancel?.().catch(() => {});
      return { status, text: '', etag };
    }
    if (status < 200 || status >= 300) {
      let retryAfter = retryAfterMs(response.headers?.get?.('retry-after') ?? undefined, now());
      if (status === 429 && retryAfter === undefined) {
        // Energi Data Service says the wait in its body only:
        // { "statusCode": 429, "message": "... Try again in 36 seconds." }
        retryAfter = waitInMessage(await readSome(response, 2048));
      } else {
        await response.body?.cancel?.().catch(() => {});
      }
      throw new HttpError('status', `HTTP ${status}`, { status, retryAfter });
    }
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel?.().catch(() => {});
      throw new HttpError('too_large', 'answer too large');
    }
    const reader = response.body?.getReader?.();
    if (!reader) throw new HttpError('network', 'no body');
    const chunks = [];
    let size = 0;
    for (;;) {
      let part;
      try {
        part = await reader.read();
      } catch {
        if (controller.signal.aborted) throw new HttpError('timeout', 'answer cut by the deadline');
        throw new HttpError('network', 'answer cut');
      }
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new HttpError('too_large', 'answer too large');
      }
      chunks.push(part.value);
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new HttpError('parse', 'answer is not UTF-8');
    }
    return { status, text, etag };
  } finally {
    timers.clearTimeout(timer);
  }
}

/** GET and parse JSON (`undefined` on 204). */
export async function getJson(fetchImpl, url, options) {
  const { status, text, etag } = await getText(fetchImpl, url, options);
  if (status === 204 || status === 304) return { status, data: undefined, etag };
  try {
    return { status, data: JSON.parse(text), etag };
  } catch {
    throw new HttpError('parse', 'answer is not JSON');
  }
}
