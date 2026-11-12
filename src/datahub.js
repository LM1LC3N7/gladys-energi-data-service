// -----------------------------------------------------------------------------
// The DatahubPricelist dataset of Energi Data Service: the tariffs (charge
// type D03) of the grid companies and of Energinet, in DKK/kWh without VAT.
// Energinet's metadata: "Price1 indicates the first hour of the day (00.00-
// 01.00) local Danish time. If the price is a flat rate price, only price 1
// is used. On both DST transition days, the DST-affected hour is assigned the
// same price as the preceding hour."
//
// A record is one period of one charge: ValidFrom (local date, included),
// ValidTo (local date, excluded; null = open), Price1..Price24 for the local
// hours 00..23 (PT1H), or Price1 alone for the whole day (P1D). A later
// period overrides an earlier one on the days they share (a one-day record
// over a season). Energinet's charges for every consumer: the transmission
// tariff (40000), the system tariff (41000) and the electricity tax
// (elafgift, EA-001). Pure.
// -----------------------------------------------------------------------------

import { API_BASE } from './constants.js';
import { CODE } from './contract.js';

export const ENERGINET_GLN = '5790000432752';
export const ENERGINET_CODES = { transmission: '40000', system: '41000', elafgift: 'EA-001' };
export const MAX_RECORDS = 5000;
const MAX_PRICE = 50;
const DATE = /^(\d{4}-\d{2}-\d{2})T00:00:00$/;

/**
 * The URL of the tariffs of one owner (GLN) and its codes, whole history: the
 * API's "start" filters on ValidFrom, so an open period that began long ago
 * would be missed. The integration keeps the recent periods only.
 */
export function pricelistUrl({ gln, codes }) {
  if (!/^\d{13}$/.test(gln) || !Array.isArray(codes) || codes.length === 0 || codes.length > 20) {
    throw new Error('bad pricelist request');
  }
  if (!codes.every((c) => CODE.test(c))) {
    throw new Error('bad pricelist request');
  }
  const url = new URL(`${API_BASE}DatahubPricelist`);
  url.searchParams.set(
    'filter',
    JSON.stringify({ GLN_Number: [gln], ChargeType: ['D03'], ChargeTypeCode: codes }),
  );
  url.searchParams.set('sort', 'ValidFrom asc');
  url.searchParams.set('limit', String(MAX_RECORDS));
  return url.toString();
}

const price = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_PRICE;

/** One record -> `{ code, note, from, to, prices[24] }`, or null when it is not readable. */
export function parseRecord(r) {
  if (!r || typeof r !== 'object' || r.ChargeType !== 'D03') return null;
  if (typeof r.ChargeTypeCode !== 'string' || !CODE.test(r.ChargeTypeCode)) return null;
  const from = DATE.exec(String(r.ValidFrom ?? ''))?.[1];
  const to = r.ValidTo === null ? null : DATE.exec(String(r.ValidTo ?? ''))?.[1];
  if (!from || to === undefined || (to !== null && to <= from)) return null;
  if (!price(r.Price1)) return null;
  const rest = [];
  for (let h = 2; h <= 24; h += 1) rest.push(r[`Price${h}`]);
  let prices;
  if (rest.every((v) => v === null || v === undefined)) {
    // One price for the whole day (P1D, or PT1H with Price1 alone).
    prices = new Array(24).fill(r.Price1);
  } else if (rest.every(price)) {
    prices = [r.Price1, ...rest];
  } else {
    // Some hours without a price: unknown, never guessed.
    return null;
  }
  const note = typeof r.Note === 'string' ? r.Note.trim().slice(0, 60) : '';
  return { code: r.ChargeTypeCode, note, from, to, prices: prices.map((p) => round6(p)) };
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * The answer for one owner -> `{ [code]: { note, periods } }` holding every
 * code asked (a code without a period is kept empty), or null when the
 * answer is not whole (a full page, maybe cut, another owner, a record not
 * readable). `skipped` counts the unreadable records of the codes asked.
 */
export function parsePricelist(answer, { gln, codes, since = '0000-00-00' }) {
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.records)) return null;
  const { records } = answer;
  // The API's "total" is the count returned, not the count found: a full
  // page may be cut, never trusted.
  if (records.length >= MAX_RECORDS) return null;
  const out = {};
  for (const code of codes) out[code] = { note: '', periods: [] };
  let skipped = 0;
  for (const r of records) {
    if (r?.GLN_Number !== gln) return null;
    if (!Object.hasOwn(out, r?.ChargeTypeCode)) continue;
    const period = parseRecord(r);
    if (!period) {
      skipped += 1;
      continue;
    }
    const { code, note, ...rest } = period;
    // Periods ended before `since` are of no use: not kept.
    if (rest.to === null || rest.to > since) out[code].periods.push(rest);
    if (note) out[code].note = note;
  }
  // A record not readable leaves a hole: refused whole (the previous stays).
  if (skipped > 0) return null;
  for (const charge of Object.values(out)) charge.periods.sort(byStart);
  return out;
}

// Later start first; on the same start, the shorter period first (more specific).
function byStart(a, b) {
  if (a.from !== b.from) return a.from < b.from ? 1 : -1;
  const ta = a.to ?? '9999-12-31';
  const tb = b.to ?? '9999-12-31';
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

/** Checks a charge read from /data (same shape as parsePricelist gives); null when not usable. */
export function checkCharge(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.periods)) return null;
  const periods = [];
  for (const p of raw.periods.slice(0, MAX_RECORDS)) {
    if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(p.from)) return null;
    if (p.to !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(p.to) || p.to <= p.from)) return null;
    if (!Array.isArray(p.prices) || p.prices.length !== 24 || !p.prices.every(price)) return null;
    periods.push({ from: p.from, to: p.to, prices: [...p.prices] });
  }
  periods.sort(byStart);
  return { note: typeof raw.note === 'string' ? raw.note.slice(0, 60) : '', periods };
}

/**
 * The price of a charge at a local time (`{ date, h }`), DKK/kWh without VAT,
 * or undefined when no period covers that date.
 */
export function chargeAt(charge, { date, h }) {
  if (!charge) return undefined;
  for (const p of charge.periods) {
    if (p.from <= date && (p.to === null || date < p.to)) return p.prices[h];
  }
  return undefined;
}
