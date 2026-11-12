// -----------------------------------------------------------------------------
// The delegated pricing: the cost of each 30-minute interval of a contract,
// in DKK, VAT included.
//
//   grid      the tariff of the grid company at the local hour (DataHub, the
//             contract's charge code);
//   Energinet the transmission tariff, the system tariff and the electricity
//             tax (elafgift) of that day;
//   supply    nothing ("grid_only"), or the spot price of the area plus the
//             supplier's markup ("spot");
//   VAT       25 % on everything.
//
// The spot price of a 30-minute interval is the mean of its two quarters (the
// meter data of Gladys is half-hourly: consumption is taken as even inside
// it). Any unknown (no tariff on that date, two charge codes that disagree,
// no spot price) throws: the interval gets no cost and Gladys asks again at
// its next run, never a silent zero. A negative total (negative spot price)
// is counted as zero: Gladys takes no credit. Pure.
// -----------------------------------------------------------------------------

import { MINUTE, local, parseInstant } from './time.js';

export const VAT = 0.25;
export const INTERVAL = 30 * MINUTE;
const QUARTER = 15 * MINUTE;

export class PriceMissing extends Error {
  constructor(message, { area, at } = {}) {
    super(message);
    this.name = 'PriceMissing';
    this.code = 'price_missing';
    this.area = area;
    this.at = at;
  }
}

export class SpotMissing extends PriceMissing {
  constructor(area, ms) {
    super(`no ${area} spot price for ${new Date(ms).toISOString()}`, { area, at: ms });
    this.name = 'SpotMissing';
    this.code = 'spot_missing';
  }
}

function spotAt(spot, area, ms) {
  const price = spot(area, ms);
  if (typeof price !== 'number' || !Number.isFinite(price)) throw new SpotMissing(area, ms);
  return price;
}

/** The mean spot price (DKK/kWh) of the quarters of [start, start + length). */
function spotOf(spot, area, start, length) {
  let sum = 0;
  let n = 0;
  for (let t = start; t < start + length; t += QUARTER) {
    sum += spotAt(spot, area, t);
    n += 1;
  }
  return sum / n;
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * The parts of the price of [start, start + length) in DKK/kWh without VAT:
 * `{ grid, transmission, system, elafgift, spot, markup, total }` where
 * `total` includes VAT. `context` = `{ grid(local), energinet(local),
 * spot(area, ms) }`; grid and energinet throw a PriceMissing when unknown.
 */
export function partsAt(start, length, settings, context) {
  const t = local(start);
  const grid = context.grid(t);
  const { transmission, system, elafgift } = context.energinet(t);
  let spot = 0;
  let markup = 0;
  if (settings.supply === 'spot') {
    spot = spotOf(context.spot, settings.area, start, length);
    markup = settings.markup;
  }
  const net = grid + transmission + system + elafgift + spot + markup;
  return { grid, transmission, system, elafgift, spot, markup, total: net * (1 + VAT) };
}

const labelOf = (settings) => (settings.supply === 'spot' ? 'Spot + tariffs' : 'Tariffs');

/**
 * The costs of the intervals of one request: one `{ starts_at, cost, label }`
 * per interval, in the request order.
 */
export function priceIntervals(intervals, settings, context) {
  return intervals.map((interval, index) => {
    const start = parseInstant(interval?.starts_at);
    const kwh = interval?.kwh;
    if (start === undefined || typeof kwh !== 'number' || !Number.isFinite(kwh) || kwh < 0) {
      throw new Error(`interval ${index} is not readable`);
    }
    if (start % INTERVAL !== 0) throw new Error(`interval ${index} is not on a half hour`);
    const { total } = partsAt(start, INTERVAL, settings, context);
    return {
      starts_at: interval.starts_at,
      cost: Math.max(0, round6(kwh * total)),
      label: labelOf(settings),
    };
  });
}

/**
 * The price of a kWh at `nowMs` (VAT included) and its next change:
 * `{ price, valid_until, next_price, label }`; throws like the pricing. The
 * price changes every quarter with a spot supply, every hour without.
 */
export function currentPrice(nowMs, settings, context) {
  const slot = settings.supply === 'spot' ? QUARTER : 60 * MINUTE;
  const start = Math.floor(nowMs / slot) * slot;
  const now = partsAt(start, slot, settings, context);
  let next;
  try {
    next = round6(partsAt(start + slot, slot, settings, context).total);
  } catch {
    next = null;
  }
  return {
    price: round6(now.total),
    valid_until: new Date(start + slot).toISOString(),
    next_price: next,
    label: labelOf(settings),
  };
}
