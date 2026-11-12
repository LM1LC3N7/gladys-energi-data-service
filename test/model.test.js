// -----------------------------------------------------------------------------
// The pure parts: inputs, the directory of grid companies, the DataHub
// records (real answers of 2026-11-11 in test/fixtures), the spot days (a
// 25-hour day included), the local time of Denmark and the pricing.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Catalog, CompanyError, loadSnapshot, normalizeName } from '../src/catalog.js';
import { InputError, readInputs } from '../src/contract.js';
import {
  ENERGINET_CODES,
  ENERGINET_GLN,
  chargeAt,
  checkCharge,
  parsePricelist,
  parseRecord,
  pricelistUrl,
} from '../src/datahub.js';
import { SpotMissing, currentPrice, priceIntervals } from '../src/pricing.js';
import { checkSpotCache, parseSpotDays, priceIn, pruneSpot, spotUrl } from '../src/spot.js';
import { chargesAgree } from '../src/datahub.js';
import { local, localMidnight, nextDate, parseInstant } from '../src/time.js';
import { record } from './helpers/app.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const RADIUS = '5790000705689';

// --- inputs and companies -----------------------------------------------------------------

test('inputs: defaults, the area needed for spot, bounds, controls refused', () => {
  assert.deepEqual(readInputs({ grid_company: ' Radius ' }), {
    company: 'Radius',
    code: null,
    supply: 'grid_only',
    area: null,
    markup: 0,
  });
  assert.deepEqual(
    readInputs({
      grid_company: 'Radius',
      charge_code: 'TCL<100_02',
      supply: 'spot',
      price_area: 'DK1',
      supplier_markup: '0.25',
    }),
    { company: 'Radius', code: 'TCL<100_02', supply: 'spot', area: 'DK1', markup: 0.25 },
  );
  const bad = [
    {},
    { grid_company: 'a\u0000b' },
    { grid_company: 'x', supply: 'spot' },
    { grid_company: 'x', supply: 'fixed' },
    { grid_company: 'x', price_area: 'DK3' },
    { grid_company: 'x', supplier_markup: 6 },
    { grid_company: 'x', supplier_markup: '' + '1e3' },
    { grid_company: 'x', supplier_markup: true },
    { grid_company: 'x', charge_code: 'a"b' },
    { grid_company: 'x', charge_code: 'x'.repeat(33) },
  ];
  for (const inputs of bad)
    assert.throws(() => readInputs(inputs), InputError, JSON.stringify(inputs));
  // An empty markup is no markup, never NaN.
  assert.equal(readInputs({ grid_company: 'x', supplier_markup: '' }).markup, 0);
});

test('companies: by name, by GLN, ambiguous or unknown with suggestions', () => {
  const catalog = new Catalog(loadSnapshot());
  assert.equal(catalog.size, 32);
  assert.equal(catalog.resolve('Radius').gln, RADIUS);
  assert.equal(catalog.resolve('radius elnet a/s').gln, RADIUS);
  assert.equal(catalog.resolve('5790000705689').name, 'Radius Elnet A/S');
  assert.equal(catalog.resolve('TREFOR El-net A/S').codes[0].code, 'C');
  assert.equal(catalog.resolve('Aal El-Net').gln, '5790001095451');
  const unknown = catalog.resolve('5790009999999');
  assert.equal(unknown.known, false);
  assert.deepEqual(unknown.codes, []);
  assert.throws(
    () => catalog.resolve('N1'),
    (err) => err instanceof CompanyError && err.suggestions.length === 3,
  );
  assert.throws(() => catalog.resolve('Elvia'), /not found/);
  assert.throws(() => catalog.resolve(''), /no grid company/);
  assert.equal(normalizeName('Sunds Net A.m.b.a'), 'sunds net');
});

// --- DataHub --------------------------------------------------------------------------------

test('pricelist URL: GLN, codes and start in the filter, nothing else', () => {
  const url = new URL(pricelistUrl({ gln: RADIUS, codes: ['DT_C_01'] }));
  assert.equal(
    url.origin + url.pathname,
    'https://api.energidataservice.dk/dataset/DatahubPricelist',
  );
  assert.equal(url.searchParams.get('start'), null, 'start filters on ValidFrom');
  assert.deepEqual(JSON.parse(url.searchParams.get('filter')), {
    GLN_Number: [RADIUS],
    ChargeType: ['D03'],
    ChargeTypeCode: ['DT_C_01'],
  });
  assert.throws(() => pricelistUrl({ gln: '1', codes: ['A'] }));
  assert.throws(() => pricelistUrl({ gln: RADIUS, codes: [] }));
  assert.throws(() => pricelistUrl({ gln: RADIUS, codes: ['a"b'] }));
});

test('Radius (real answer): hourly prices of the local hours, the season in force', () => {
  const radius = parsePricelist(fixture('pricelist-radius'), { gln: RADIUS, codes: ['DT_C_01'] });
  const c = radius.DT_C_01;
  assert.equal(c.periods.length, 4);
  assert.equal(c.note, 'Nettarif C');
  // Winter 2026: night 0.106175, peak (17-21) 0.955573.
  assert.equal(chargeAt(c, { date: '2026-11-11', h: 3 }), 0.106175);
  assert.equal(chargeAt(c, { date: '2026-11-11', h: 17 }), 0.955573);
  assert.equal(chargeAt(c, { date: '2026-09-30', h: 17 }), 0.414082);
  assert.equal(chargeAt(c, { date: '2027-05-10', h: 17 }), undefined);
  assert.equal(chargeAt(c, { date: '2026-03-31', h: 17 }), undefined);
});

test('Energinet (real answer): the three charges by year', () => {
  const codes = Object.values(ENERGINET_CODES);
  const e = parsePricelist(fixture('pricelist-energinet'), { gln: ENERGINET_GLN, codes });
  const at = (code, date) => chargeAt(e[code], { date, h: 12 });
  assert.equal(at('40000', '2026-11-11'), 0.043);
  assert.equal(at('41000', '2026-11-11'), 0.072);
  assert.equal(at('EA-001', '2026-11-11'), 0.008);
  assert.equal(at('41000', '2027-01-01'), 0.049);
  assert.equal(at('40000', '2027-06-01'), 0.056);
});

test('records: a later period wins, a one-day record over a season, holes refused', () => {
  const answer = {
    records: [
      record({ from: '2026-10-01', to: '2027-04-01', prices: 0.2 }),
      record({ from: '2026-12-24', to: '2026-12-25', prices: 0.05 }),
    ],
  };
  const c = parsePricelist(answer, { gln: RADIUS, codes: ['DT_C_01'] }).DT_C_01;
  assert.equal(chargeAt(c, { date: '2026-12-23', h: 1 }), 0.2);
  assert.equal(chargeAt(c, { date: '2026-12-24', h: 1 }), 0.05);
  assert.equal(chargeAt(c, { date: '2026-12-25', h: 1 }), 0.2);
  // Another owner, a full page (maybe cut), an hour without its price: refused whole.
  assert.equal(
    parsePricelist(
      { records: [record({ gln: '5790000000000', from: '2026-01-01', prices: 1 })] },
      {
        gln: RADIUS,
        codes: ['DT_C_01'],
      },
    ),
    null,
  );
  const full = { records: new Array(5000).fill(record({ from: '2026-01-01', prices: 1 })) };
  // Compared without a diff: a 5000-period object printed would take gigabytes.
  assert.ok(parsePricelist(full, { gln: RADIUS, codes: ['DT_C_01'] }) === null, 'full page kept');
  const holed = record({ from: '2026-01-01', prices: 0.2 });
  holed.Price7 = 0.4;
  assert.equal(parseRecord(holed), null);
  assert.equal(
    parseRecord({
      ...record({ from: '2026-01-01', prices: 0.2 }),
      ValidFrom: '2026-01-01T06:00:00',
    }),
    null,
  );
  assert.equal(parseRecord({ ...record({ from: '2026-01-01', prices: 0.2 }), Price1: 99 }), null);
  assert.equal(
    parseRecord({ ...record({ from: '2026-01-01', prices: 0.2 }), Price1: '0.2' }),
    null,
  );
  assert.equal(parseRecord(record({ from: '2026-02-01', to: '2026-01-01', prices: 0.2 })), null);
  // A code asked without any record: kept empty (said "no tariff for" a date).
  const none = parsePricelist({ records: [] }, { gln: RADIUS, codes: ['A', 'B'] });
  assert.deepEqual(none, { A: { note: '', periods: [] }, B: { note: '', periods: [] } });
  // From /data: same checks.
  assert.equal(checkCharge({ periods: [{ from: '2026-01-01', to: null, prices: [1] }] }), null);
  assert.ok(checkCharge(c));
});

// --- spot -----------------------------------------------------------------------------------

test('spot (real answers): 96 quarters, 100 on the night of the autumn change', () => {
  const nov = parseSpotDays(fixture('dayahead-dk2-2026-11-10'), 'DK2', ['2026-11-10']);
  assert.equal(nov['2026-11-10'].prices.length, 96);
  assert.equal(nov['2026-11-10'].from, Date.parse('2026-11-09T23:00:00Z'));
  const oct = parseSpotDays(fixture('dayahead-dk1-2026-10-25'), 'DK1', ['2026-10-25']);
  assert.equal(oct['2026-10-25'].prices.length, 100);
  // The first quarter: 43.204344 DKK/MWh -> 0.04320 DKK/kWh.
  close(oct['2026-10-25'].prices[0], 0.0432);
  // Asked for another area: nothing kept.
  assert.deepEqual(parseSpotDays(fixture('dayahead-dk1-2026-10-25'), 'DK2', ['2026-10-25']), {});
  const url = new URL(spotUrl('DK1', '2026-10-25', '2026-10-26'));
  assert.equal(url.searchParams.get('start'), '2026-10-25T00:00');
  assert.equal(url.searchParams.get('end'), '2026-10-26T00:00');
  assert.throws(() => spotUrl('NO1', '2026-10-25', '2026-10-26'));
});

test('spot: a quarter missing, doubled or without price leaves the day out', () => {
  const answer = fixture('dayahead-dk2-2026-11-10');
  const drop = structuredClone(answer);
  drop.records.splice(3, 1);
  assert.deepEqual(parseSpotDays(drop, 'DK2', ['2026-11-10']), {});
  const twice = structuredClone(answer);
  twice.records.push(twice.records[5]);
  assert.deepEqual(parseSpotDays(twice, 'DK2', ['2026-11-10']), {});
  const empty = structuredClone(answer);
  empty.records[9].DayAheadPriceDKK = null;
  assert.deepEqual(parseSpotDays(empty, 'DK2', ['2026-11-10']), {});
});

test('spot cache from /data: checked; prices found by quarter; old days pruned', () => {
  const days = parseSpotDays(fixture('dayahead-dk2-2026-11-10'), 'DK2', ['2026-11-10']);
  const cache = checkSpotCache({ DK2: { ...days, '2026-11-11': { from: 0, prices: [] } }, XX: {} });
  assert.deepEqual(Object.keys(cache.DK2), ['2026-11-10']);
  const day = cache.DK2['2026-11-10'];
  assert.equal(priceIn(day, day.from + 15 * 60_000), day.prices[1]);
  assert.equal(priceIn(day, day.from - 1), undefined);
  // Kept 62 days after its read, whatever its date.
  pruneSpot(cache, 62 * 86_400_000 - 1);
  assert.deepEqual(Object.keys(cache.DK2), ['2026-11-10']);
  pruneSpot(cache, 62 * 86_400_000 + 1);
  assert.deepEqual(cache.DK2, {});
});

// --- time -----------------------------------------------------------------------------------

test('Copenhagen time: midnights and the changes of time', () => {
  assert.equal(localMidnight('2026-11-11'), Date.parse('2026-11-10T23:00:00Z'));
  assert.equal(localMidnight('2026-07-01'), Date.parse('2026-06-30T22:00:00Z'));
  assert.equal(localMidnight('2026-02-30'), undefined);
  // 25 hours on 25 October 2026, 23 on 29 March 2026.
  assert.equal(localMidnight('2026-10-26') - localMidnight('2026-10-25'), 25 * 3600_000);
  assert.equal(localMidnight('2026-03-30') - localMidnight('2026-03-29'), 23 * 3600_000);
  assert.equal(local(Date.parse('2026-10-25T00:30:00Z')).h, 2);
  assert.equal(local(Date.parse('2026-10-25T01:30:00Z')).h, 2);
  assert.equal(local(Date.parse('2026-03-29T01:30:00Z')).h, 3);
  assert.equal(nextDate('2026-12-31'), '2027-01-01');
  assert.equal(parseInstant('2026-11-11T08:00:00'), undefined);
});

// --- pricing --------------------------------------------------------------------------------

const PRICES = Array.from({ length: 24 }, (_, h) => h / 100);
const context = (spot = () => 1) => ({
  grid: (t) => PRICES[t.h],
  energinet: () => ({ transmission: 0.05, system: 0.04, elafgift: 0.008 }),
  spot: (area, ms) => spot(ms),
});
const SPOT = { supply: 'spot', area: 'DK1', markup: 0.1 };
const GRID = { supply: 'grid_only', area: null, markup: 0 };
const half = (iso, n, kwh = 1) =>
  Array.from({ length: n }, (_, i) => ({
    starts_at: new Date(Date.parse(iso) + i * 1800_000).toISOString(),
    kwh,
  }));

test('pricing: the hour of the autumn change twice at the price of hour 2', () => {
  // 25 October 2026: 00:00Z and 01:00Z are both 02:xx local.
  const costs = priceIntervals(half('2026-10-25T00:00:00Z', 4), GRID, context());
  for (const c of costs) close(c.cost, (0.02 + 0.098) * 1.25);
});

test('pricing: the spring change has no hour 2 (01:00Z is 03:00)', () => {
  const [c] = priceIntervals(half('2026-03-29T01:00:00Z', 1), GRID, context());
  close(c.cost, (0.03 + 0.098) * 1.25);
});

test('pricing: the spot mean of the two quarters, markup, VAT; zero kWh costs zero', () => {
  const quarters = (ms) => (Math.floor(ms / 900_000) % 2 === 0 ? 0.5 : 1.5);
  const [a, b] = priceIntervals(
    [...half('2026-11-11T08:00:00Z', 1, 2), ...half('2026-11-11T09:00:00Z', 1, 0)],
    SPOT,
    context(quarters),
  );
  close(a.cost, 2 * (0.09 + 0.098 + 1 + 0.1) * 1.25);
  assert.equal(b.cost, 0);
});

test('pricing: a missing quarter, a bad interval or one off the half hour throw', () => {
  const holed = (ms) => (ms === Date.parse('2026-11-11T08:15:00Z') ? undefined : 1);
  assert.throws(
    () => priceIntervals(half('2026-11-11T08:00:00Z', 1), SPOT, context(holed)),
    SpotMissing,
  );
  assert.throws(
    () => priceIntervals([{ starts_at: 'x', kwh: 1 }], GRID, context()),
    /not readable/,
  );
  assert.throws(() =>
    priceIntervals([{ starts_at: '2026-11-11T08:00:00Z', kwh: -1 }], GRID, context()),
  );
  assert.throws(() =>
    priceIntervals([{ starts_at: '2026-11-11T08:00:00Z', kwh: NaN }], GRID, context()),
  );
  assert.throws(
    () => priceIntervals([{ starts_at: '2026-11-11T08:15:00Z', kwh: 1 }], GRID, context()),
    /half hour/,
  );
});

test('current price: the quarter with spot, the hour without; next unknown is null', () => {
  const now = Date.parse('2026-11-11T08:20:00Z');
  const spot = (ms) => (ms < Date.parse('2026-11-11T08:30:00Z') ? 1 : undefined);
  const p = currentPrice(now, SPOT, context(spot));
  close(p.price, (0.09 + 0.098 + 1.1) * 1.25);
  assert.equal(p.valid_until, '2026-11-11T08:30:00.000Z');
  assert.equal(p.next_price, null);
  const g = currentPrice(now, GRID, context());
  assert.equal(g.valid_until, '2026-11-11T09:00:00.000Z');
  close(g.next_price, (0.1 + 0.098) * 1.25);
});

test('records: an open period begun years ago is kept, periods ended before `since` dropped', () => {
  const answer = {
    records: [
      record({ from: '2019-01-01', to: '2020-01-01', prices: 0.9 }),
      record({ from: '2022-01-01', to: null, prices: 0.3 }),
    ],
  };
  const c = parsePricelist(answer, {
    gln: RADIUS,
    codes: ['DT_C_01'],
    since: '2025-10-07',
  }).DT_C_01;
  assert.equal(c.periods.length, 1);
  assert.equal(chargeAt(c, { date: '2026-11-11', h: 12 }), 0.3);
});

test('spot cache: the oldest read dropped beyond 800 days an area', () => {
  const day = parseSpotDays(fixture('dayahead-dk2-2026-11-10'), 'DK2', ['2026-11-10'])[
    '2026-11-10'
  ];
  const cache = { DK2: {} };
  for (let i = 0; i < 805; i += 1) cache.DK2[`d${i}`] = { ...day, at: 1000 + i };
  pruneSpot(cache, 2000);
  assert.equal(Object.keys(cache.DK2).length, 800);
  assert.equal(cache.DK2.d0, undefined);
  assert.ok(cache.DK2.d804);
});

test('spot cache from /data: a day of the wrong length is not used', () => {
  const days = parseSpotDays(fixture('dayahead-dk2-2026-11-10'), 'DK2', ['2026-11-10']);
  const short = { ...days['2026-11-10'], prices: days['2026-11-10'].prices.slice(0, 95), at: 1 };
  assert.deepEqual(checkSpotCache({ DK2: { '2026-11-10': short } }), {});
  const long = { ...days['2026-11-10'], prices: [...days['2026-11-10'].prices, 1], at: 1 };
  assert.deepEqual(checkSpotCache({ DK2: { '2026-11-10': long } }), {});
});

test('spot: an answer with more records than the days asked can hold is refused', () => {
  const answer = fixture('dayahead-dk2-2026-11-10');
  const padded = structuredClone(answer);
  // 101 records for one day: the quarters of the day are all there, still refused.
  for (let i = 0; i < 5; i += 1) {
    padded.records.push({ ...answer.records[0], TimeUTC: `2026-11-1${i % 2}T23:59:0${i}` });
  }
  assert.deepEqual(parseSpotDays(padded, 'DK2', ['2026-11-10']), {});
});

test('spot: a price beyond 50,000 DKK/MWh leaves the day out', () => {
  const answer = structuredClone(fixture('dayahead-dk2-2026-11-10'));
  answer.records[7].DayAheadPriceDKK = 60_000;
  assert.deepEqual(parseSpotDays(answer, 'DK2', ['2026-11-10']), {});
  answer.records[7].DayAheadPriceDKK = -60_000;
  assert.deepEqual(parseSpotDays(answer, 'DK2', ['2026-11-10']), {});
});

test('codes agree only when equal over every period and the same days (the Cerius case)', () => {
  const a = {
    periods: [{ from: '2026-10-01', to: '2026-11-20', prices: new Array(24).fill(0.3) }],
  };
  const same = structuredClone(a);
  assert.equal(chargesAgree([a, same]), true);
  // 30TR_C_ET published for the next season, 93TR_C_ET not yet: not the same tariff.
  const ahead = structuredClone(a);
  ahead.periods.unshift({ from: '2026-11-20', to: null, prices: new Array(24).fill(0.3) });
  assert.equal(chargesAgree([ahead, a]), false);
  // A price different at one hour of one day only.
  const hour = structuredClone(a);
  hour.periods[0].prices[17] = 0.31;
  assert.equal(chargesAgree([a, hour]), false);
  assert.equal(chargesAgree([a]), true);
});
