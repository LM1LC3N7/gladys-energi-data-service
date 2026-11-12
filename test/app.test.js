// -----------------------------------------------------------------------------
// The app against the fake Gladys of the SDK, a scripted network and a
// virtual clock: start, Discovery, tariffs read in the background, delegated
// pricing, spot prices, the daily refresh, pauses, /data, the Test button.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAUSE_MIN as PAUSE, REQUEST_GAP } from '../src/constants.js';
import { USER_AGENT } from '../src/constants.js';
import {
  CONTRACT_ID,
  DAY,
  DAYAHEAD,
  DEVICE,
  ENERGINET_GLN,
  F,
  HOUR,
  MINUTE,
  NOW,
  OTHER_ID,
  PRICELIST,
  RADIUS,
  SECOND,
  apiNet,
  askedOf,
  contract,
  createNet,
  dayAhead,
  datesOf,
  energinetAnswer,
  intervalsFrom,
  json,
  memoryStores,
  priceRequest,
  pricelist,
  record,
  radiusAnswer,
  settle,
  setup,
} from './helpers/app.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const statusText = (env) => env.status()?.message?.en ?? '';
// Enough virtual time for the three first reads (one request a minute).
const WARM = 4 * REQUEST_GAP;

async function warm(options = {}) {
  const env = await setup({ net: apiNet(), ...options });
  await env.run(WARM);
  return env;
}

// --- start, status, Discovery -----------------------------------------------------------

test('start: one device per contract, then the tariffs and the spot read one a minute', async () => {
  const env = await setup({ net: apiNet() });
  await env.run(SECOND);
  assert.match(statusText(env), /^1 contract\(s\)\. Tariffs not read yet/);
  assert.equal(env.status().connected, true);
  const devices = env.gladys.fake.discoveredDevices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].external_id, DEVICE());
  assert.equal(devices[0].name, 'Elpris Radius Elnet A/S');
  assert.deepEqual(
    devices[0].features.map((f) => f.external_id),
    [F('price')],
  );
  await env.advance(WARM);
  // Energinet, Radius (its one code), the spot day of today: never closer than the gap.
  const calls = env.net.calls;
  assert.equal(calls.length, 3);
  assert.deepEqual(askedOf(calls[0].url).gln, ENERGINET_GLN);
  assert.deepEqual(askedOf(calls[0].url).codes, ['40000', '41000', 'EA-001']);
  assert.deepEqual(askedOf(calls[1].url), {
    gln: RADIUS,
    codes: ['DT_C_01'],
    area: undefined,
    start: null,
    end: null,
  });
  assert.ok(calls[2].url.startsWith(DAYAHEAD));
  assert.deepEqual(datesOf(calls[2].url), ['2026-11-11']);
  for (const c of calls) assert.equal(c.headers['User-Agent'], USER_AGENT);
  assert.equal(
    statusText(env),
    '1 contract(s). Data: Energi Data Service (Energinet), tariffs read on 2026-11-11.',
  );
  // The price now: 09:20 is a day hour (0.20) + Energinet 0.098 + spot 1.00, VAT 25 %.
  await env.advance(15 * MINUTE);
  close(env.last(F('price')), (0.2 + 0.098 + 1) * 1.25);
});

test('requests one after the other, never closer than the gap', async () => {
  const env = await setup({ net: apiNet() });
  const times = [];
  const fetch = env.net.fetch;
  env.app.fetchImpl = (...args) => {
    times.push(env.clock.now);
    return fetch(...args);
  };
  await env.run(WARM);
  // Tomorrow asked too after 13:00.
  await env.advance(5 * HOUR);
  assert.ok(times.length >= 4, `${times.length} requests`);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] - times[i - 1] >= REQUEST_GAP - 1, `gap ${times[i] - times[i - 1]}`);
  }
});

test('no contract: no request at all, the status says how to start', async () => {
  const env = await setup({ net: apiNet(), contracts: [] });
  await env.run(2 * DAY);
  assert.equal(env.net.calls.length, 0);
  assert.match(statusText(env), /^Ready\. Create a contract .* 32 grid companies listed\.$/);
});

test('grid_only: no spot request; the price is the tariffs and the elafgift with VAT', async () => {
  const env = await warm({
    contracts: [contract({ supply: 'grid_only', price_area: undefined })],
  });
  assert.equal(env.net.count(DAYAHEAD), 0);
  // 2026-11-11 17:00-17:30 local = 16:00Z: peak 0.50.
  const [cost] = await env.app.energyPrice(
    priceRequest(intervalsFrom('2026-11-11T16:00:00Z', 1, 2), {
      inputs: { supply: 'grid_only', price_area: undefined },
    }),
  );
  close(cost.cost, 2 * (0.5 + 0.098) * 1.25);
  assert.equal(cost.label, 'Tariffs');
});

// --- delegated pricing -------------------------------------------------------------------

test('pricing: every interval at its local hour, spot mean of its two quarters', async () => {
  const env = await warm({ net: apiNet({ spotPrice: (i) => (i % 2 === 0 ? 800 : 1200) }) });
  const intervals = intervalsFrom('2026-11-09T23:00:00Z', 48, (i) => i / 10);
  // Today asked by the tick; yesterday is missing: queued, read in the background.
  await assert.rejects(env.app.energyPrice(priceRequest(intervals)), /no DK2 spot price/);
  await env.advance(2 * REQUEST_GAP);
  const costs = await env.app.energyPrice(priceRequest(intervals));
  assert.equal(costs.length, 48);
  for (const [i, c] of costs.entries()) {
    const h = Math.floor(i / 2);
    const grid = h < 6 ? 0.1 : h >= 17 && h < 21 ? 0.5 : 0.2;
    close(c.cost, (i / 10) * (grid + 0.098 + 1.0) * 1.25);
    assert.equal(c.starts_at, intervals[i].starts_at);
    assert.equal(c.label, 'Spot + tariffs');
  }
});

test('pricing never waits: tariffs not read yet fail at once, read in the background', async () => {
  const env = await setup({ net: apiNet() });
  await env.run(SECOND);
  const started = env.clock.now;
  await assert.rejects(
    env.app.energyPrice(priceRequest(intervalsFrom('2026-11-11T08:00:00Z', 2))),
    /not read yet/,
  );
  assert.equal(env.clock.now, started);
  assert.match(
    statusText(env),
    /Problem: (Energinet tariffs|tariffs of Radius Elnet A\/S) not read yet/,
  );
  const current = await env.app.energyCurrent({ contract: contract() });
  assert.deepEqual(current, { price: null });
  await env.advance(WARM);
  const costs = await env.app.energyPrice(priceRequest(intervalsFrom('2026-11-11T08:00:00Z', 2)));
  assert.equal(costs.length, 2);
  // The problem is cleared by the success.
  assert.doesNotMatch(statusText(env), /Problem/);
});

test('a negative total costs zero, never a credit; the current price may be negative', async () => {
  const env = await warm({ net: apiNet({ spotPrice: () => -2000 }) });
  const [cost] = await env.app.energyPrice(priceRequest(intervalsFrom('2026-11-11T08:00:00Z', 1)));
  assert.equal(cost.cost, 0);
  const current = await env.app.energyCurrent({ contract: contract() });
  close(current.price, (0.2 + 0.098 - 2) * 1.25);
  assert.equal(current.valid_until, '2026-11-11T08:30:00.000Z');
});

test('the markup is added to the spot price, VAT on it too', async () => {
  const env = await warm();
  const inputs = { supplier_markup: 0.3 };
  const [cost] = await env.app.energyPrice(
    priceRequest(intervalsFrom('2026-11-11T08:00:00Z', 1), { inputs }),
  );
  close(cost.cost, (0.2 + 0.098 + 1 + 0.3) * 1.25);
});

test('a wrong input fails with its reason, never a default price', async () => {
  const env = await warm();
  const ask = (inputs) =>
    env.app.energyPrice(priceRequest(intervalsFrom('2026-11-11T08:00:00Z', 1), { inputs }));
  await assert.rejects(ask({ price_area: undefined }), /price_area is needed/);
  await assert.rejects(ask({ price_area: 'DK3' }), /price_area is not a known option/);
  await assert.rejects(ask({ supplier_markup: 9 }), /supplier_markup/);
  await assert.rejects(ask({ grid_company: 'Nowhere Net' }), /not found/);
  await assert.rejects(ask({ grid_company: 'N1' }), /ambiguous \(did you mean: N1 A\/S/);
  await assert.rejects(ask({ grid_company: '5790009999999' }), /fill "Charge code"/);
  await assert.rejects(
    env.app.energyPrice({ ...priceRequest([]), contract: { template_key: 'other' } }),
    /not this integration's/,
  );
});

test('a company with two codes: priced when they agree, asks for the code when they differ', async () => {
  const VEKSEL = '5790001088217';
  let second = 0.3;
  const net = apiNet({
    extra: {
      [PRICELIST]: (url) => {
        const { gln, codes } = askedOf(url);
        if (gln === ENERGINET_GLN) return json(energinetAnswer());
        const records = [];
        if (codes.includes('NT-01')) {
          records.push(record({ gln, code: 'NT-01', from: '2026-10-01', to: null, prices: 0.3 }));
        }
        if (codes.includes('NT-10')) {
          records.push(
            record({ gln, code: 'NT-10', from: '2026-10-01', to: null, prices: second }),
          );
        }
        return json(pricelist(records));
      },
    },
  });
  const inputs = { grid_company: VEKSEL, supply: 'grid_only', price_area: undefined };
  const env = await warm({ net, contracts: [contract(inputs)] });
  const ask = (extra = {}) =>
    env.app.energyPrice(
      priceRequest(intervalsFrom('2026-11-11T08:00:00Z', 1), { inputs: { ...inputs, ...extra } }),
    );
  close((await ask())[0].cost, (0.3 + 0.098) * 1.25);
  assert.deepEqual(askedOf(env.net.calls[1].url).codes, ['NT-01', 'NT-10']);
  // The tariffs read again with NT-10 different: the contract must choose.
  second = 0.4;
  await env.advance(DAY + WARM);
  await assert.rejects(ask(), /fill "Charge code" with one of: NT-01 \(Nettarif C\), NT-10/);
  assert.match(statusText(env), /Problem: Veksel A\/S has several household tariffs/);
  // With the code given: that one only.
  close((await ask({ charge_code: 'NT-10' }))[0].cost, (0.4 + 0.098) * 1.25);
});

test('a GLN not in the list with its charge code: that code is read and priced', async () => {
  const GLN = '5790009999999';
  const net = apiNet({
    extra: {
      [PRICELIST]: (url) => {
        const { gln, codes } = askedOf(url);
        if (gln === ENERGINET_GLN) return json(energinetAnswer());
        assert.deepEqual(codes, ['X-1']);
        return json(pricelist([record({ gln, code: 'X-1', from: '2026-01-01', prices: 0.7 })]));
      },
    },
  });
  const inputs = { grid_company: GLN, charge_code: 'X-1', supply: 'grid_only' };
  const env = await warm({ net, contracts: [contract(inputs)] });
  const [cost] = await env.app.energyPrice(
    priceRequest(intervalsFrom('2026-11-11T08:00:00Z', 1), { inputs }),
  );
  close(cost.cost, (0.7 + 0.098) * 1.25);
});

test('no tariff for the date: no cost, the reason named', async () => {
  const env = await warm();
  // Radius' period ends on 2027-04-01: a day after it is unknown.
  await assert.rejects(
    env.app.energyPrice(priceRequest(intervalsFrom('2025-09-01T08:00:00Z', 1))),
    /no tariff of Radius Elnet A\/S for 2025-09-01/,
  );
});

test('a contract created later gets its tariffs read in the background', async () => {
  const env = await warm();
  const before = env.net.count(PRICELIST);
  const inputs = { grid_company: 'TREFOR El-net A/S', supply: 'grid_only' };
  await assert.rejects(
    env.app.energyPrice(
      priceRequest(intervalsFrom('2026-11-11T08:00:00Z', 1), { inputs, id: OTHER_ID }),
    ),
    /tariffs of TREFOR El-net A\/S not read yet/,
  );
  await env.advance(2 * REQUEST_GAP);
  assert.equal(env.net.count(PRICELIST), before + 1);
  assert.deepEqual(askedOf(env.net.calls.at(-1).url).codes, ['C']);
});

// --- spot ---------------------------------------------------------------------------------

test('spot: tomorrow asked from 13:00, a day not published yet asked again after 15 min', async () => {
  let published = false;
  const net = apiNet({
    extra: {
      [DAYAHEAD]: (url) => {
        const dates = datesOf(url).filter((d) => d !== '2026-11-12' || published);
        return json(dayAhead('DK2', dates));
      },
    },
  });
  const env = await warm({ net });
  // 13:05 local: tomorrow asked, not there yet (the answer holds no quarter of it).
  await env.advance(Date.parse('2026-11-11T12:05:00Z') - env.clock.now);
  const asked = () =>
    net.calls.filter((c) => c.url.startsWith(DAYAHEAD) && datesOf(c.url).includes('2026-11-12'));
  assert.equal(asked().length, 1);
  await env.advance(10 * MINUTE);
  assert.equal(asked().length, 1, 'not asked again before 15 minutes');
  published = true;
  await env.advance(10 * MINUTE);
  assert.equal(asked().length, 2);
  await env.advance(HOUR);
  assert.equal(asked().length, 2, 'held: never asked again');
  const [cost] = await env.app.energyPrice(priceRequest(intervalsFrom('2026-11-12T08:00:00Z', 1)));
  close(cost.cost, (0.2 + 0.098 + 1) * 1.25);
});

test('spot: a month of missing days read in one request', async () => {
  const env = await warm();
  const intervals = intervalsFrom('2026-10-11T22:00:00Z', 30 * 48);
  await assert.rejects(env.app.energyPrice(priceRequest(intervals)), /no DK2 spot price/);
  await env.advance(2 * REQUEST_GAP);
  const spotCalls = env.net.calls.filter((c) => c.url.startsWith(DAYAHEAD));
  assert.equal(spotCalls.length, 2);
  assert.equal(datesOf(spotCalls[1].url).length, 30);
  const costs = await env.app.energyPrice(priceRequest(intervals));
  assert.equal(costs.length, 30 * 48);
});

test('spot: a day with a quarter missing is never kept in part', async () => {
  const net = apiNet({
    extra: {
      [DAYAHEAD]: (url) => {
        const answer = dayAhead('DK2', datesOf(url));
        answer.records.splice(10, 1);
        return json(answer);
      },
    },
  });
  const env = await warm({ net });
  await assert.rejects(
    env.app.energyPrice(priceRequest(intervalsFrom('2026-11-11T08:00:00Z', 1))),
    /no DK2 spot price/,
  );
  assert.equal(env.stores.spot.saves, 0);
});

test('spot: a day before the 15-minute market is never asked', async () => {
  const env = await warm();
  const before = env.net.calls.length;
  await assert.rejects(
    env.app.energyPrice(priceRequest(intervalsFrom('2025-09-20T08:00:00Z', 1))),
    /no DK2 spot price|no tariff/,
  );
  await env.advance(3 * REQUEST_GAP);
  assert.equal(env.net.calls.length, before);
});

// --- pauses, errors -----------------------------------------------------------------------

test('429: the wait the API asks (at least 2 min), kept in /data, nothing asked meanwhile', async () => {
  let limited = true;
  const base = apiNet();
  const net = createNet({
    [`https://api.energidataservice.dk/`]: (url, init) => {
      if (limited) {
        return json(
          { statusCode: 429, message: 'Rate limit is exceeded. Try again in 36 seconds.' },
          429,
        );
      }
      return base.fetch(url, init);
    },
  });
  const env = await setup({ net });
  await env.run(SECOND);
  await env.advance(REQUEST_GAP);
  assert.equal(net.calls.length, 1);
  const pause = env.stores.state.data.pause;
  assert.equal(pause.status, 429);
  assert.equal(pause.until - env.clock.now <= 2 * MINUTE, true);
  assert.match(statusText(env), /Energi Data Service asks to wait \(HTTP 429\): paused until/);
  await env.advance(30 * SECOND);
  assert.equal(net.calls.length, 1, 'nothing during the pause');
  // A second 429 in a row doubles the wait (4 min).
  await env.advance(2 * MINUTE);
  assert.equal(net.calls.length, 2);
  assert.equal(env.stores.state.data.pause.delay, 4 * MINUTE);
  limited = false;
  await env.advance(10 * MINUTE);
  assert.equal(env.stores.state.data.pause, null);
  assert.match(statusText(env), /tariffs read on 2026-11-11/);
});

test('a 429 that asks longer than the minimum is waited in full', async () => {
  const net = createNet({
    [`https://api.energidataservice.dk/`]: () =>
      json({ statusCode: 429, message: 'Try again in 600 seconds.' }, 429),
  });
  const env = await setup({ net });
  await env.run(SECOND);
  await env.advance(9 * MINUTE);
  assert.equal(net.calls.length, 1);
});

test('a pause from /data is kept across a restart', async () => {
  const stores = memoryStores({
    state: { pause: { until: NOW + 30 * MINUTE, delay: 4 * MINUTE, status: 503 } },
  });
  const env = await setup({ net: apiNet(), stores });
  await env.run(25 * MINUTE);
  assert.equal(env.net.calls.length, 0);
  await env.advance(WARM + 10 * MINUTE);
  assert.ok(env.net.calls.length >= 3);
});

test('a pause in /data too far ahead is not trusted', async () => {
  const stores = memoryStores({
    state: { pause: { until: NOW + 30 * DAY, delay: 4 * MINUTE, status: 429 } },
  });
  const env = await setup({ net: apiNet(), stores });
  await env.run(WARM);
  assert.equal(env.net.calls.length, 3);
});

test('an answer refused by the checks keeps the tariffs held', async () => {
  let broken = false;
  const net = apiNet({
    extra: {
      [PRICELIST]: (url) => {
        const { gln } = askedOf(url);
        if (gln === ENERGINET_GLN) {
          if (!broken) return json(energinetAnswer());
          // The elafgift missing: refused whole.
          return json(pricelist(energinetAnswer().records.slice(0, 2)));
        }
        if (!broken) return json(radiusAnswer());
        const r = record({ from: '2026-10-01', to: '2027-04-01', prices: 0.2 });
        r.Price5 = 0.3; // some hours given, others not
        return json(pricelist([r]));
      },
    },
  });
  const env = await warm({ net });
  broken = true;
  await env.advance(DAY + WARM);
  const [cost] = await env.app.energyPrice(priceRequest(intervalsFrom('2026-11-11T08:00:00Z', 1)));
  close(cost.cost, (0.2 + 0.098 + 1) * 1.25);
  assert.ok(env.lines.some((l) => /Energinet tariffs: a charge is missing/.test(l)));
  assert.ok(env.lines.some((l) => /refused by the checks/.test(l)));
});

test('the tariffs read again once a day, never faster; stale ones said by the status', async () => {
  let down = false;
  const base = apiNet();
  const net = createNet({
    [`https://api.energidataservice.dk/`]: (url, init) => {
      if (down && url.startsWith(PRICELIST)) {
        throw Object.assign(new Error('offline'), { code: 'ECONNRESET' });
      }
      return base.fetch(url, init);
    },
  });
  const env = await setup({ net });
  await env.run(WARM);
  await env.advance(3 * DAY);
  // 1 + 3 rounds of 2 files (Energinet, Radius).
  assert.equal(net.count(PRICELIST), 8);
  down = true;
  await env.advance(3 * DAY);
  // Failed reads tried again every hour, never faster.
  const failed = net.count(PRICELIST) - 8;
  assert.ok(failed <= 3 * 24 * 2 + 2, `${failed} requests`);
  assert.match(statusText(env), /Tariffs not read again since 2026-11-14/);
  // Still priced from the tariffs held.
  await env.app.energyPrice(priceRequest(intervalsFrom('2026-11-17T08:00:00Z', 1)));
});

// --- /data ---------------------------------------------------------------------------------

test('restart: tariffs and spot from /data, priced at once without a request', async () => {
  const first = await warm();
  const stores = first.stores;
  await first.app.stop();
  const net = createNet();
  const env = await setup({ net, stores });
  await env.run(SECOND);
  const [cost] = await env.app.energyPrice(priceRequest(intervalsFrom('2026-11-11T08:00:00Z', 1)));
  close(cost.cost, (0.2 + 0.098 + 1) * 1.25);
  assert.equal(net.calls.length, 0);
  // The daily refresh due time kept: no read before a day.
  await env.advance(20 * HOUR);
  assert.equal(net.count(PRICELIST), 0);
});

test('/data unreadable: never written, the tariffs not read again daily, said by the status', async () => {
  const stores = memoryStores();
  stores.state.unreadable = true;
  stores.tariffs.unreadable = true;
  const env = await setup({ net: apiNet(), stores });
  await env.run(WARM);
  assert.match(statusText(env), /\/data unreadable/);
  assert.equal(stores.state.saves, 0);
  assert.equal(stores.tariffs.saves, 0);
  // The tariffs needed are still read (kept in memory), the refresh is not.
  const [cost] = await env.app.energyPrice(priceRequest(intervalsFrom('2026-11-11T08:00:00Z', 1)));
  close(cost.cost, (0.2 + 0.098 + 1) * 1.25);
  const before = env.net.count(PRICELIST);
  await env.advance(2 * DAY);
  assert.equal(env.net.count(PRICELIST), before);
});

test('/data that hangs never holds the start', async () => {
  const stores = memoryStores();
  stores.tariffs.hang = true;
  const env = await setup({ net: apiNet(), stores });
  // Not awaited: the start waits for /data on the virtual clock (5 s at most).
  const started = env.app.connected();
  await env.advance(10 * SECOND);
  await started;
  assert.equal(env.gladys.fake.discoveredDevices.length, 1);
  assert.match(statusText(env), /\/data unreadable/);
});

test('/data of another shape: ignored, never a crash', async () => {
  const stores = memoryStores({
    state: { refreshAt: 'x', pause: 'y' },
    tariffs: {
      tariffs: {
        [RADIUS]: { at: NOW, codes: { DT_C_01: { periods: [{ from: 'x', prices: [] }] } } },
        '../x': { at: NOW, codes: {} },
        energinet: { at: NOW + 30 * DAY, codes: {} },
      },
    },
    spot: { areas: { DK2: { '2026-11-11': { from: 1, prices: [1] } } } },
  });
  const env = await setup({ net: apiNet(), stores });
  await env.run(WARM);
  const [cost] = await env.app.energyPrice(priceRequest(intervalsFrom('2026-11-11T08:00:00Z', 1)));
  close(cost.cost, (0.2 + 0.098 + 1) * 1.25);
});

// --- Gladys ---------------------------------------------------------------------------------

test('getConfig() failing in connected: retried, doubling, then the start', async () => {
  let fails = 2;
  let calls = 0;
  const env = await setup({ net: apiNet() });
  const real = env.gladys.getConfig.bind(env.gladys);
  env.gladys.getConfig = async () => {
    calls += 1;
    if (fails-- > 0) throw new Error('down');
    return real();
  };
  await env.app.connected();
  assert.equal(env.status().connected, false);
  assert.match(statusText(env), /configuration could not be read/);
  await env.advance(9 * SECOND);
  assert.equal(calls, 1);
  await env.advance(2 * SECOND);
  assert.equal(calls, 2);
  await env.advance(20 * SECOND);
  assert.equal(calls, 3);
  assert.equal(env.status().connected, true);
  assert.equal(env.gladys.fake.discoveredDevices.length, 1);
});

test('getEnergyContracts() failing: retried, said, then the devices', async () => {
  let fails = 1;
  const env = await setup({ net: apiNet() });
  const real = env.gladys.getEnergyContracts.bind(env.gladys);
  env.gladys.getEnergyContracts = async () => {
    if (fails-- > 0) throw new Error('down');
    return real();
  };
  await env.run(SECOND);
  assert.match(statusText(env), /contracts could not be read/);
  await env.advance(11 * SECOND);
  assert.equal(env.gladys.fake.discoveredDevices.length, 1);
  assert.doesNotMatch(statusText(env), /could not be read/);
});

test('expired and orphaned contracts and other templates are left out', async () => {
  const env = await setup({
    net: apiNet(),
    contracts: [
      contract({}, CONTRACT_ID, { status: 'expired' }),
      contract({}, OTHER_ID, { template_key: 'other' }),
    ],
  });
  await env.run(WARM);
  assert.equal(env.gladys.fake.discoveredDevices.length, 0);
  assert.equal(env.net.calls.length, 0);
});

test('Discovery lists the contracts again, never a request outside Gladys', async () => {
  const env = await warm();
  const before = env.net.calls.length;
  await env.app.scan();
  assert.equal(env.net.calls.length, before);
});

test('stop: nothing leaves after it, even a request waiting its turn', async () => {
  const env = await setup({ net: apiNet() });
  await env.run(SECOND);
  // Energinet read; Radius waits its turn.
  await env.app.stop();
  await env.advance(5 * REQUEST_GAP);
  assert.equal(env.net.calls.length, 1);
  assert.equal(env.pending.size, 0);
});

test('the device state: price now every quarter, nothing while unknown', async () => {
  const env = await setup({ net: apiNet() });
  await env.run(SECOND);
  assert.equal(env.states(F('price')).length, 0);
  await env.advance(WARM + 15 * MINUTE);
  assert.equal(env.states(F('price')).length, 1);
});

// --- Test button ------------------------------------------------------------------------------

test('Test: the parts of the price now, no request', async () => {
  const env = await warm();
  const before = env.net.calls.length;
  const answer = await env.app.testConnection();
  assert.equal(env.net.calls.length, before);
  assert.equal(
    answer.en,
    'Radius Elnet A/S (GLN 5790000705689, tariffs read on 2026-11-11): grid 0.2000, Energinet 0.0900, elafgift 0.0080, spot 1.0000 DKK/kWh without VAT; price now 1.6225 DKK/kWh with VAT.',
  );
  assert.match(answer.fr, /^Radius Elnet A\/S \(GLN 5790000705689, tarifs lus le 2026-11-11\)/);
});

test('Test: no contract, a wrong contract, data not read yet', async () => {
  const none = await setup({ net: apiNet(), contracts: [] });
  await none.run(SECOND);
  assert.match((await none.app.testConnection()).en, /^No contract uses .* 32 grid companies/);
  const env = await setup({
    net: apiNet(),
    contracts: [contract(), contract({ grid_company: 'Nowhere' }, OTHER_ID)],
  });
  await env.run(SECOND);
  const answer = await env.app.testConnection();
  const [first, second] = answer.en.split('\n');
  assert.match(
    first,
    /price now unknown \((Energinet tariffs|tariffs of Radius Elnet A\/S) not read yet\)/,
  );
  assert.match(second, /^Contract 0a1b2c3d: grid company "Nowhere" not found/);
});

// --- guards found by the mutation check -----------------------------------------------------

test('an Energinet charge missing on a date: no cost, the charge named', async () => {
  const net = apiNet({
    extra: {
      [PRICELIST]: (url) => {
        const { gln } = askedOf(url);
        if (gln !== ENERGINET_GLN) return json(radiusAnswer());
        const [a, b] = energinetAnswer().records;
        const tax = record({
          gln: ENERGINET_GLN,
          code: 'EA-001',
          from: '2026-01-01',
          to: '2026-12-01',
          prices: 0.008,
        });
        return json(pricelist([a, b, tax]));
      },
    },
  });
  const env = await warm({ net, contracts: [contract({ supply: 'grid_only' })] });
  const inputs = { supply: 'grid_only' };
  await env.app.energyPrice(priceRequest(intervalsFrom('2026-11-30T08:00:00Z', 1), { inputs }));
  await assert.rejects(
    env.app.energyPrice(priceRequest(intervalsFrom('2026-12-05T08:00:00Z', 1), { inputs })),
    /no Energinet elafgift for 2026-12-05/,
  );
});

test('a pause from /data holds the daily refresh too', async () => {
  const first = await warm();
  const stores = first.stores;
  await first.app.stop();
  stores.state.data = {
    refreshAt: 0,
    pause: { until: NOW + 2 * DAY + 30 * MINUTE, delay: 4 * MINUTE, status: 503 },
  };
  const net = apiNet();
  const env = await setup({ net, stores, start: NOW + 2 * DAY });
  await env.run(20 * MINUTE);
  assert.equal(net.calls.length, 0);
  // The refresh that met the pause is tried again an hour later.
  await env.advance(HOUR + WARM);
  assert.ok(net.count(PRICELIST) >= 2);
});

test('an empty answer keeps the tariffs held', async () => {
  let empty = false;
  const net = apiNet({
    extra: {
      [PRICELIST]: (url) => {
        const { gln } = askedOf(url);
        if (gln === ENERGINET_GLN) return json(energinetAnswer());
        return json(empty ? pricelist([]) : radiusAnswer());
      },
    },
  });
  const env = await warm({ net });
  empty = true;
  await env.advance(DAY + WARM);
  assert.ok(env.lines.some((l) => /empty answer, the previous ones stay/.test(l)));
  const [cost] = await env.app.energyPrice(priceRequest(intervalsFrom('2026-11-12T08:00:00Z', 1)));
  close(cost.cost, (0.2 + 0.098 + 1) * 1.25);
});

test('spot: a day before 1 October 2025 is never asked, even with its tariffs known', async () => {
  const net = apiNet({
    extra: {
      [PRICELIST]: (url) => {
        const { gln } = askedOf(url);
        if (gln === ENERGINET_GLN) {
          return json(
            pricelist(
              ['40000', '41000', 'EA-001'].map((code) =>
                record({ gln, code, from: '2024-01-01', to: null, prices: 0.01 }),
              ),
            ),
          );
        }
        return json(pricelist([record({ from: '2024-01-01', to: null, prices: 0.2 })]));
      },
    },
  });
  const env = await warm({ net });
  const before = net.calls.length;
  await assert.rejects(
    env.app.energyPrice(priceRequest(intervalsFrom('2025-09-20T08:00:00Z', 1))),
    /no DK2 spot price/,
  );
  await env.advance(3 * REQUEST_GAP);
  assert.equal(net.calls.length, before);
});

test('spot: a day that failed is not asked again by the pricing before 15 minutes', async () => {
  const net = apiNet({
    extra: {
      [DAYAHEAD]: (url) =>
        json(
          dayAhead(
            'DK2',
            datesOf(url).filter((d) => d !== '2026-11-12'),
          ),
        ),
    },
  });
  const env = await warm({ net });
  const ask = () =>
    env.app.energyPrice(priceRequest(intervalsFrom('2026-11-12T08:00:00Z', 1))).catch(() => {});
  const asked = () =>
    net.calls.filter((c) => c.url.startsWith(DAYAHEAD) && datesOf(c.url).includes('2026-11-12'))
      .length;
  await ask();
  await env.advance(2 * MINUTE);
  assert.equal(asked(), 1);
  for (let i = 0; i < 5; i += 1) {
    await ask();
    await env.advance(2 * MINUTE);
  }
  assert.equal(asked(), 1);
  await env.advance(5 * MINUTE);
  await ask();
  await env.advance(2 * MINUTE);
  assert.equal(asked(), 2);
});

test('while paused a request is refused at once, never after waiting its turn', async () => {
  const env = await warm();
  env.app.state.pause = { until: env.clock.now + HOUR, delay: PAUSE, status: 429 };
  env.app.pauseEnd = env.app.monotonic() + HOUR;
  env.app.lane.last = env.app.monotonic();
  let outcome = 'pending';
  env.app.request(`${PRICELIST}?x`).then(
    () => (outcome = 'sent'),
    (err) => (outcome = err.code),
  );
  await settle();
  assert.equal(outcome, 'paused');
  assert.equal(env.net.calls.filter((c) => c.url.endsWith('?x')).length, 0);
});

test('a pause that begins while a request waits its turn stops it', async () => {
  const env = await warm();
  env.app.lane.last = env.app.monotonic();
  let outcome = 'pending';
  env.app.request(`${PRICELIST}?y`).then(
    () => (outcome = 'sent'),
    (err) => (outcome = err.code),
  );
  await settle();
  env.app.state.pause = { until: env.clock.now + HOUR, delay: PAUSE, status: 429 };
  env.app.pauseEnd = env.app.monotonic() + HOUR;
  await env.advance(REQUEST_GAP + SECOND);
  assert.equal(outcome, 'paused');
  assert.equal(env.net.calls.filter((c) => c.url.endsWith('?y')).length, 0);
});

// --- review r1 ------------------------------------------------------------------------------

test('two codes, one published ahead (the Cerius case): the code is asked, never guessed', async () => {
  const VEKSEL = '5790001088217';
  const net = apiNet({
    extra: {
      [PRICELIST]: (url) => {
        const { gln } = askedOf(url);
        if (gln === ENERGINET_GLN) return json(energinetAnswer());
        return json(
          pricelist([
            record({ gln, code: 'NT-01', from: '2026-10-01', to: '2026-11-20', prices: 0.3 }),
            record({ gln, code: 'NT-01', from: '2026-11-20', to: null, prices: 0.3 }),
            record({ gln, code: 'NT-10', from: '2026-10-01', to: '2026-11-20', prices: 0.3 }),
          ]),
        );
      },
    },
  });
  const inputs = { grid_company: VEKSEL, supply: 'grid_only' };
  const env = await warm({ net, contracts: [contract(inputs)] });
  const ask = (iso, extra = {}) =>
    env.app.energyPrice(priceRequest(intervalsFrom(iso, 1), { inputs: { ...inputs, ...extra } }));
  // Neither the day only NT-01 covers, nor a day both agree on.
  await assert.rejects(ask('2026-11-25T08:00:00Z'), /fill "Charge code" with one of: NT-01/);
  await assert.rejects(ask('2026-11-10T08:00:00Z'), /fill "Charge code"/);
  assert.match(statusText(env), /Problem: Veksel A\/S has several household tariffs/);
  close(
    (await ask('2026-11-25T08:00:00Z', { charge_code: 'NT-01' }))[0].cost,
    (0.3 + 0.098) * 1.25,
  );
  await assert.rejects(ask('2026-11-25T08:00:00Z', { charge_code: 'NT-10' }), /no tariff of/);
});

test('spot history older than 62 days: read once, priced, kept 62 days after its read', async () => {
  const net = apiNet({
    extra: {
      [PRICELIST]: (url) => {
        const { gln } = askedOf(url);
        if (gln === ENERGINET_GLN) return json(energinetAnswer());
        return json(pricelist([record({ from: '2026-01-01', to: null, prices: 0.2 })]));
      },
    },
  });
  const env = await warm({ net });
  // August 2026: 31 days, 3 months before today.
  const intervals = intervalsFrom('2026-07-31T22:00:00Z', 31 * 48);
  const spotCalls = () => net.calls.filter((c) => c.url.startsWith(DAYAHEAD)).length;
  const before = spotCalls();
  await assert.rejects(env.app.energyPrice(priceRequest(intervals)), /no DK2 spot price/);
  await env.advance(2 * REQUEST_GAP);
  assert.equal(spotCalls(), before + 1);
  assert.equal((await env.app.energyPrice(priceRequest(intervals))).length, 31 * 48);
  // Recalculated again days later: priced from /data-kept days, never read again.
  await env.advance(10 * DAY);
  assert.equal((await env.app.energyPrice(priceRequest(intervals))).length, 31 * 48);
  await env.advance(2 * REQUEST_GAP);
  const afterTen = net.calls.filter(
    (c) => c.url.startsWith(DAYAHEAD) && datesOf(c.url).includes('2026-08-15'),
  ).length;
  assert.equal(afterTen, 1);
  assert.ok(env.stores.spot.data.areas.DK2['2026-08-15']);
});

test('updateStatus after stop sends nothing', async () => {
  const env = await warm();
  await env.app.stop();
  const sent = [];
  env.gladys.setConnectionStatus = async (...args) => sent.push(args);
  env.app.lastStatus = undefined;
  await env.app.updateStatus();
  assert.deepEqual(sent, []);
});

test('stop cuts the request on the wire; its late 429 neither pauses nor arms a timer', async () => {
  let release;
  let signal;
  // A server that answers late whatever the abort says.
  const net = createNet({
    [`https://api.energidataservice.dk/`]: (url, init) =>
      new Promise((resolve) => {
        signal = init.signal;
        release = () =>
          resolve(json({ statusCode: 429, message: 'Try again in 600 seconds.' }, 429));
      }),
  });
  const env = await setup({ net });
  await env.run(SECOND);
  assert.equal(net.calls.length, 1);
  await env.app.stop();
  assert.equal(signal.aborted, true);
  release();
  await settle();
  assert.equal(env.app.state.pause, null);
  assert.equal(env.pending.size, 0);
});

test('restart: the gap since the last request holds across it', async () => {
  const stores = memoryStores({ state: { lastRequestAt: NOW - 10 * SECOND } });
  const env = await setup({ net: apiNet(), stores });
  const times = [];
  const fetch = env.net.fetch;
  env.app.fetchImpl = (...args) => {
    times.push(env.clock.now);
    return fetch(...args);
  };
  await env.run(WARM);
  assert.ok(times[0] - NOW >= REQUEST_GAP - 10 * SECOND - 1, `first after ${times[0] - NOW} ms`);
  // A time in /data in the future or long ago is not a reason to wait.
  const env2 = await setup({
    net: apiNet(),
    stores: memoryStores({ state: { lastRequestAt: NOW + HOUR } }),
  });
  await env2.run(SECOND);
  assert.equal(env2.net.calls.length, 1);
});

test('once stopped, no timer is armed (a late callback never wakes the app)', async () => {
  const env = await warm();
  await env.app.stop();
  let ran = false;
  env.app.setTimer('late', 0, () => {
    ran = true;
  });
  env.app.armResume(MINUTE);
  assert.equal(env.pending.size, 0);
  await env.advance(2 * MINUTE);
  assert.equal(ran, false);
});

test('stop then a new start: a request of the earlier run never leaves, the gap holds', async () => {
  const env = await setup({ net: apiNet() });
  const times = [];
  const fetch = env.net.fetch;
  env.app.fetchImpl = (...args) => {
    times.push(env.clock.now);
    return fetch(...args);
  };
  await env.run(SECOND);
  // Energinet read; Radius waits its turn. Stopped and started again at once.
  await env.app.stop();
  await env.app.connected();
  await env.advance(WARM);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] - times[i - 1] >= REQUEST_GAP - 1, `gap ${times[i] - times[i - 1]}`);
  }
});

test('a reconnection without stop: the tariffs are not asked twice', async () => {
  const env = await setup({ net: apiNet() });
  await env.run(SECOND);
  // Energinet read; Radius waits its turn. Gladys says "connected" again.
  await env.app.connected();
  await env.advance(WARM);
  const radius = env.net.calls.filter((c) => askedOf(c.url).gln === RADIUS);
  assert.equal(radius.length, 1);
});

test('stop while a request waits its turn: it never leaves nor writes /data', async () => {
  const env = await setup({ net: apiNet() });
  await env.run(SECOND);
  const saves = env.stores.state.saves;
  await env.app.stop();
  await env.advance(5 * REQUEST_GAP);
  assert.equal(env.net.calls.length, 1);
  assert.equal(env.stores.state.saves, saves);
});
