// -----------------------------------------------------------------------------
// Constants: identity, source, schedule, limits.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

// The integration's own User-Agent, on every request (never a browser's).
export const USER_AGENT = `gladys-energi-data-service/${VERSION} (+https://github.com/LM1LC3N7/gladys-energi-data-service)`;

// Energi Data Service (Energinet), open data without a key.
export const API_BASE = 'https://api.energidataservice.dk/dataset/';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// The API answers about one call a minute per address (header
// "remainingcalls", then a 429 "Try again in N seconds"): every request goes
// one after the other, REQUEST_GAP apart.
export const REQUEST_GAP = 65 * SECOND;
// After a 429: what the API asks (Retry-After or its message), at least
// PAUSE_MIN, doubled on each 429 or 5xx in a row up to PAUSE_MAX.
export const PAUSE_MIN = 2 * MINUTE;
export const PAUSE_MAX = 6 * HOUR;

// The tariffs (grid companies used, Energinet) read again once a day; a read
// that failed is tried again after TARIFF_RETRY. Read back TARIFF_BACK_DAYS.
export const REFRESH_INTERVAL = DAY;
export const TARIFF_RETRY = HOUR;
export const TARIFF_BACK_DAYS = 400;
// Tariffs not read again for this long: said by the status (still used).
export const TARIFF_STALE = 3 * DAY;

// Spot prices (DayAheadPrices, 15 minutes, DKK/MWh): tomorrow's from 13:00 in
// Denmark; a day not published yet or that failed is asked again after
// SPOT_RETRY (SPOT_RETRY_OLD for a day before yesterday). The pricing never
// waits for them: the missing days are queued (SPOT_QUEUE_MAX at most) and
// read in the background, up to SPOT_DAYS_PER_CALL days in one request. The
// dataset starts on SPOT_FIRST_DAY (the 15-minute market).
export const SPOT_TOMORROW_HOUR = 13;
export const SPOT_RETRY = 15 * MINUTE;
export const SPOT_RETRY_OLD = 6 * HOUR;
export const SPOT_DAYS_PER_ASK = 40;
export const SPOT_DAYS_PER_CALL = 31;
export const SPOT_QUEUE_MAX = 80;
export const SPOT_FIRST_DAY = '2025-10-01';
export const SPOT_KEEP_DAYS = 62;

// The device states (price now) every quarter of an hour.
export const TICK = 15 * MINUTE;
// The contracts listed again from Gladys every hour (and at each Discovery).
export const CONTRACTS_INTERVAL = HOUR;
// getConfig() or getEnergyContracts() that failed: retried, doubling.
export const RETRY_MIN = 10 * SECOND;
export const RETRY_MAX = 10 * MINUTE;
// /data unreadable: read again on its own timer.
export const STORE_RETRY = 10 * SECOND;
// A read of /data waited for at most this long by the start.
export const STORE_WAIT = 5 * SECOND;

// Answers bounded in size and time.
export const TARIFF_MAX_BYTES = 4 * 1024 * 1024;
export const SPOT_MAX_BYTES = 2 * 1024 * 1024;
export const REQUEST_TIMEOUT = 30 * SECOND;

// Test button: at most this many contracts.
export const TEST_CONTRACTS = 3;

export const ACTIONS = { TEST: 'test' };
