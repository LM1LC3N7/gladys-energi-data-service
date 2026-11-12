// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted network (fake fetch by
// URL) and a virtual clock that only moves when the test says so (each read
// of the monotonic clock moves 1 µs, so a decision reading it twice is
// caught). Nothing touches the network.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EnergiDataServiceApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { createMemoryStore } from '../../src/store.js';
import { localMidnight, nextDate } from '../../src/time.js';

export const SELECTOR = 'energi-data-service';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
// Wednesday 11 November 2026, 09:20 in Copenhagen (UTC+1).
export const NOW = Date.parse('2026-11-11T08:20:00Z');
export const CONTRACT_ID = '6f1c2b1e-4d3a-4c1b-9a8e-0b1c2d3e4f50';
export const OTHER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
export const DEVICE = (id = CONTRACT_ID) => `ext:${SELECTOR}:contract:${id}`;
export const F = (key, id = CONTRACT_ID) => `ext:${SELECTOR}:contract:${id}:${key}`;

export const API = 'https://api.energidataservice.dk/dataset/';
export const PRICELIST = `${API}DatahubPricelist`;
export const DAYAHEAD = `${API}DayAheadPrices`;
export const RADIUS = '5790000705689';
export const ENERGINET_GLN = '5790000432752';

export function contract(inputs = {}, id = CONTRACT_ID, extra = {}) {
  return {
    id,
    template_key: 'energi-data-service-dk',
    template_version: '2026-11-11',
    pricing_mode: 'delegated',
    inputs: { grid_company: 'Radius', supply: 'spot', price_area: 'DK2', ...inputs },
    valid_from: '2026-01-01',
    valid_to: null,
    timezone: 'Europe/Copenhagen',
    currency: 'DKK',
    billing_period_start_day: 1,
    status: 'active',
    ...extra,
  };
}

/** Lets every pending promise run (a few event-loop turns). */
export async function settle(turns = 20) {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
}

export function createFakeClock(start) {
  const clock = { now: start };
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  async function advance(ms) {
    const target = clock.now + ms;
    await settle();
    for (let i = 0; i < 100_000; i += 1) {
      let next;
      for (const [id, timer] of pending) {
        if (timer.at <= target && (!next || timer.at < next.timer.at)) next = { id, timer };
      }
      if (!next) break;
      pending.delete(next.id);
      clock.now = Math.max(clock.now, next.timer.at);
      next.timer.fn();
      await settle();
    }
    clock.now = Math.max(clock.now, target);
    await settle();
  }
  return { clock, timers, pending, advance };
}

/**
 * A scripted network: `routes` maps a URL prefix to a function
 * `(url, init) => Response | Promise<Response>`; an unknown URL is a network
 * error. `calls` records every request (url, headers).
 */
export function createNet(routes = {}) {
  const net = {
    routes,
    calls: [],
    fetch: async (url, init = {}) => {
      net.calls.push({ url, headers: init.headers ?? {} });
      const prefix = Object.keys(net.routes)
        .filter((p) => url.startsWith(p))
        .sort((a, b) => b.length - a.length)[0];
      if (!prefix) throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' });
      return net.routes[prefix](url, init);
    },
    count: (prefix) => net.calls.filter((c) => c.url.startsWith(prefix)).length,
  };
  return net;
}

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const plain = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });

export function memoryStores(initial = {}) {
  return {
    state: createMemoryStore(initial.state ?? {}),
    tariffs: createMemoryStore(initial.tariffs ?? {}),
    spot: createMemoryStore(initial.spot ?? {}),
  };
}

export async function setup({
  contracts = [contract()],
  stores = memoryStores(),
  net = createNet(),
  start = NOW,
  devices = [],
  getConfig,
  getEnergyContracts,
} = {}) {
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: {},
    devices,
    energyContracts: contracts,
  });
  await gladys.connect();
  if (getConfig) gladys.getConfig = getConfig;
  if (getEnergyContracts) gladys.getEnergyContracts = getEnergyContracts;
  const fake = createFakeClock(start);
  let drift = 0;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new EnergiDataServiceApp({
    gladys,
    logger: { info: log, warn: log, error: log, debug: log },
    now: () => fake.clock.now,
    monotonic: () => fake.clock.now + (drift += 0.001),
    timers: fake.timers,
    fetchImpl: net.fetch,
    stores,
  });
  registerHandlers(gladys, app, { error: log });
  return {
    app,
    gladys,
    net,
    stores,
    lines,
    clock: fake.clock,
    pending: fake.pending,
    advance: fake.advance,
    async run(ms = 1 * SECOND) {
      await app.connected();
      await fake.advance(ms);
    },
    status: () => gladys.fake.connectionStatus,
    last: (id) => gladys.fake.lastState(id),
    states: (id) => gladys.fake.states.filter((s) => s.device_feature_external_id === id),
  };
}

/** The 30-minute intervals from `startIso`, `count` of them, `kwh` each (or a function). */
export function intervalsFrom(startIso, count, kwh = 1) {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => ({
    starts_at: new Date(start + i * 30 * MINUTE).toISOString(),
    kwh: typeof kwh === 'function' ? kwh(i) : kwh,
    max_power_kw: 0,
  }));
}

/** A delegated pricing request of the fake core. */
export function priceRequest(intervals, { inputs, id = CONTRACT_ID } = {}) {
  const c = contract(inputs, id);
  return {
    contract: {
      id: c.id,
      template_key: c.template_key,
      inputs: c.inputs,
      currency: 'DKK',
      timezone: 'Europe/Copenhagen',
      billing_period_start_day: 1,
    },
    billing_period: { starts_at: '2026-10-31T23:00:00.000Z', ends_at: '2026-11-30T23:00:00.000Z' },
    cumulative_before: { day: 0, month: 0, billing_period: 0 },
    intervals,
  };
}

/** One DatahubPricelist record: `prices` = one number (whole day) or 24 numbers. */
export function record({ gln = RADIUS, code = 'DT_C_01', note = 'Nettarif C', from, to, prices }) {
  const r = {
    ChargeOwner: 'Owner',
    GLN_Number: gln,
    ChargeType: 'D03',
    ChargeTypeCode: code,
    Note: note,
    Description: '',
    ValidFrom: `${from}T00:00:00`,
    ValidTo: to ? `${to}T00:00:00` : null,
    VATClass: 'D02',
    TransparentInvoicing: 0,
    TaxIndicator: 0,
    ResolutionDuration: Array.isArray(prices) ? 'PT1H' : 'P1D',
  };
  for (let h = 1; h <= 24; h += 1) {
    r[`Price${h}`] = Array.isArray(prices) ? prices[h - 1] : h === 1 ? prices : null;
  }
  return r;
}

export const pricelist = (records) => ({
  total: records.length,
  dataset: 'DatahubPricelist',
  records,
});

// Radius C: 0.10 at night (0-5), 0.20 by day (6-16 and 21-23), 0.50 at peak (17-20).
export const RADIUS_PRICES = Array.from({ length: 24 }, (_, h) =>
  h < 6 ? 0.1 : h >= 17 && h < 21 ? 0.5 : 0.2,
);

export const radiusAnswer = () =>
  pricelist([record({ from: '2026-10-01', to: '2027-04-01', prices: RADIUS_PRICES })]);

// Energinet: transmission 0.05, system 0.04, elafgift 0.008 (whole days).
export const energinetAnswer = () =>
  pricelist([
    record({
      gln: ENERGINET_GLN,
      code: '40000',
      from: '2026-01-01',
      to: '2027-01-01',
      prices: 0.05,
    }),
    record({
      gln: ENERGINET_GLN,
      code: '41000',
      from: '2026-01-01',
      to: '2027-01-01',
      prices: 0.04,
    }),
    record({ gln: ENERGINET_GLN, code: 'EA-001', from: '2026-01-01', to: null, prices: 0.008 }),
  ]);

/** A DayAheadPrices answer for local days of Denmark: every quarter at `price(i)` DKK/MWh. */
export function dayAhead(area, dates, price = () => 1000) {
  const records = [];
  for (const date of dates) {
    const start = localMidnight(date);
    const end = localMidnight(nextDate(date));
    for (let t = start, i = 0; t < end; t += 15 * MINUTE, i += 1) {
      const iso = new Date(t).toISOString().slice(0, 19);
      records.push({
        TimeUTC: iso,
        TimeDK: iso,
        PriceArea: area,
        DayAheadPriceEUR: 0,
        DayAheadPriceDKK: price(i, date),
      });
    }
  }
  return { total: records.length, dataset: 'DayAheadPrices', records };
}

/** The GLN, codes and area asked by a request URL. */
export function askedOf(url) {
  const u = new URL(url);
  const filter = JSON.parse(u.searchParams.get('filter') ?? '{}');
  return {
    gln: filter.GLN_Number?.[0],
    codes: filter.ChargeTypeCode ?? [],
    area: filter.PriceArea?.[0],
    start: u.searchParams.get('start'),
    end: u.searchParams.get('end'),
  };
}

/** The dates [start, end) of a DayAheadPrices request. */
export function datesOf(url) {
  const { start, end } = askedOf(url);
  const out = [];
  for (let d = start.slice(0, 10); d < end.slice(0, 10); d = nextDate(d)) out.push(d);
  return out;
}

/**
 * The normal network: Radius and Energinet tariffs, spot prices of any day
 * asked (`spotPrice(i, date)`), or what `extra` says.
 */
export function apiNet({ spotPrice = () => 1000, extra = {} } = {}) {
  return createNet({
    [PRICELIST]: (url) => {
      const { gln } = askedOf(url);
      if (gln === ENERGINET_GLN) return json(energinetAnswer());
      if (gln === RADIUS) return json(radiusAnswer());
      return json(pricelist([]));
    },
    [DAYAHEAD]: (url) => {
      const { area } = askedOf(url);
      return json(dayAhead(area, datesOf(url), spotPrice));
    },
    ...extra,
  });
}
