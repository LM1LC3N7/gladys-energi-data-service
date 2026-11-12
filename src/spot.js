// -----------------------------------------------------------------------------
// Day-ahead spot prices of the Danish areas (DK1 west, DK2 east) from the
// DayAheadPrices dataset of Energi Data Service: 15-minute prices in DKK/MWh
// (the European day-ahead market since 1 October 2025), kept as DKK/kWh
// without VAT. One request reads several local days of one area (the API
// filters on the local time "TimeDK"); a day is kept only whole: every
// quarter from local midnight to the next one (92, 96 or 100). Pure, except
// the cache object.
// -----------------------------------------------------------------------------

import { API_BASE, SPOT_KEEP_DAYS } from './constants.js';
import { AREA_OPTIONS } from './contract.js';
import { MINUTE, local, localMidnight, nextDate } from './time.js';

export const QUARTER = 15 * MINUTE;
const MAX_PRICE_MWH = 50_000;
const MAX_SLOTS = 100;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** The URL of the local days [from, to) of one area. */
export function spotUrl(area, from, to) {
  if (!AREA_OPTIONS.includes(area) || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    throw new Error('bad spot request');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to) || to <= from) throw new Error('bad spot request');
  const url = new URL(`${API_BASE}DayAheadPrices`);
  url.searchParams.set('filter', JSON.stringify({ PriceArea: [area] }));
  url.searchParams.set('start', `${from}T00:00`);
  url.searchParams.set('end', `${to}T00:00`);
  url.searchParams.set('sort', 'TimeUTC asc');
  url.searchParams.set('limit', '4000');
  return url.toString();
}

/**
 * The answer -> `{ [date]: { from, prices } }` for each of `dates` that is
 * whole (prices DKK/kWh by quarter from the local midnight). A day with a
 * quarter missing, doubled, without a DKK price or of another area is left
 * out (asked again later).
 */
export function parseSpotDays(answer, area, dates) {
  const out = {};
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.records)) return out;
  if (answer.records.length > dates.length * MAX_SLOTS) return out;
  const byDay = new Map(dates.map((d) => [d, new Map()]));
  const bad = new Set();
  for (const r of answer.records) {
    if (typeof r?.TimeUTC !== 'string' || !UTC.test(r.TimeUTC)) continue;
    const start = Date.parse(`${r.TimeUTC}Z`);
    if (!Number.isFinite(start)) continue;
    const date = local(start).date;
    const day = byDay.get(date);
    if (!day) continue;
    const mwh = r.DayAheadPriceDKK;
    if (r.PriceArea !== area || typeof mwh !== 'number' || !Number.isFinite(mwh)) {
      bad.add(date);
      continue;
    }
    if (Math.abs(mwh) > MAX_PRICE_MWH || day.has(start)) {
      bad.add(date);
      continue;
    }
    day.set(start, Math.round(mwh * 100) / 100_000);
  }
  for (const [date, day] of byDay) {
    if (bad.has(date)) continue;
    const from = localMidnight(date);
    const to = localMidnight(nextDate(date));
    if (from === undefined || to === undefined) continue;
    const prices = [];
    let whole = true;
    for (let t = from; t < to; t += QUARTER) {
      const p = day.get(t);
      if (p === undefined) {
        whole = false;
        break;
      }
      prices.push(p);
    }
    if (whole && prices.length === day.size) out[date] = { from, prices };
  }
  return out;
}

/** The spot cache read from /data: `{ [area]: { [date]: { from, prices, at } } }`, checked. */
export function checkSpotCache(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const area of AREA_OPTIONS) {
    const days = raw[area];
    if (!days || typeof days !== 'object') continue;
    for (const [date, day] of Object.entries(days)) {
      const from = localMidnight(date);
      const to = from === undefined ? undefined : localMidnight(nextDate(date));
      if (from === undefined || to === undefined || day?.from !== from) continue;
      if (!Array.isArray(day.prices) || day.prices.length !== (to - from) / QUARTER) continue;
      if (
        !day.prices.every((p) => typeof p === 'number' && Number.isFinite(p) && Math.abs(p) <= 50)
      ) {
        continue;
      }
      (out[area] ??= {})[date] = { from, prices: [...day.prices], at: Number(day.at) || 0 };
    }
  }
  return out;
}

/** The price (DKK/kWh) of the quarter holding `ms` in a cached day, or undefined. */
export function priceIn(day, ms) {
  if (!day) return undefined;
  const i = Math.floor((ms - day.from) / QUARTER);
  return i >= 0 && i < day.prices.length ? day.prices[i] : undefined;
}

/** Drops the days older than SPOT_KEEP_DAYS before `today` ("YYYY-MM-DD"). */
export function pruneSpot(cache, today) {
  const limit = new Date(Date.parse(`${today}T00:00:00Z`) - SPOT_KEEP_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  for (const days of Object.values(cache)) {
    for (const date of Object.keys(days)) if (date < limit) delete days[date];
  }
  return cache;
}

/** The local days of a list of instants ("YYYY-MM-DD"), sorted, distinct. */
export const daysOf = (instants) => [...new Set(instants.map((ms) => local(ms).date))].sort();
