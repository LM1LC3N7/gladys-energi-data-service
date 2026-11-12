// -----------------------------------------------------------------------------
// On a real clock (sped up): the device states every quarter of an hour,
// never faster; the requests never closer than the gap; the tariffs read
// again once a day, never faster. Cleanup in t.after: a failing test never
// leaves the app running.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EnergiDataServiceApp } from '../src/app.js';
import { REQUEST_GAP } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { PRICELIST, apiNet, contract, memoryStores } from './helpers/app.js';
import { measurePeriod, realClock, spyOn } from './helpers/realclock.js';

async function start(t, { speed, net = apiNet() }) {
  const clock = realClock({ speed, start: Date.parse('2026-11-11T08:20:00Z') });
  const gladys = createFakeGladys({
    selector: 'energi-data-service',
    config: {},
    energyContracts: [contract()],
  });
  await gladys.connect();
  const quiet = () => {};
  const app = new EnergiDataServiceApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    fetchImpl: net.fetch,
    stores: memoryStores(),
  });
  registerHandlers(gladys, app, { error: quiet });
  t.after(async () => {
    await app.stop();
    clock.close();
  });
  return { app, clock, net };
}

test('real clock: the quarter tick every 15 minutes, never faster', async (t) => {
  const speed = 1000;
  const { app, clock } = await start(t, { speed });
  const calls = spyOn(app, 'tick', clock);
  await app.connected();
  await measurePeriod(calls, { count: 3, period: 15 * 60_000, speed, skip: 1 });
  await app.stop();
  assert.equal(clock.pending, 0);
});

test('real clock: requests one after the other, never closer than the gap', async (t) => {
  const speed = 200;
  const net = apiNet();
  const { app, clock } = await start(t, { speed, net });
  const calls = [];
  const fetch = net.fetch;
  app.fetchImpl = (...args) => {
    calls.push(clock.monotonic());
    return fetch(...args);
  };
  await app.connected();
  // Energinet, Radius, the spot day: two gaps.
  await measurePeriod(calls, { count: 2, period: REQUEST_GAP, speed });
});

test('real clock: the tariffs read again once a day, never faster', async (t) => {
  const speed = 40_000;
  const net = apiNet();
  const { app, clock } = await start(t, { speed, net });
  const calls = spyOn(app, 'readTariff', clock);
  await app.connected();
  // Two keys a round: the first of each round measured.
  const rounds = [];
  const deadline = Date.now() + 20_000;
  while (rounds.length < 3 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    const firsts = calls.filter((c, i) => i % 2 === 0);
    rounds.splice(0, rounds.length, ...firsts);
  }
  assert.ok(rounds.length >= 3, `${rounds.length} rounds`);
  for (let i = 1; i < 3; i += 1) {
    const gap = rounds[i] - rounds[i - 1];
    assert.ok(gap >= 0.9 * 86_400_000 && gap <= 1.5 * 86_400_000, `gap ${gap}`);
  }
  assert.ok(net.count(PRICELIST) <= 7, `${net.count(PRICELIST)} requests`);
});
