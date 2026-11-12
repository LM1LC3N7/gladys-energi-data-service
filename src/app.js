// -----------------------------------------------------------------------------
// The integration: the contracts of the "energi-data-service-dk" template,
// their delegated pricing, the tariffs they use (grid company, Energinet) read
// once a day, the spot prices when a contract needs them, the devices and the
// status. index.js only wires the SDK handlers to it (src/handlers.js).
//
// Clocks: the wall clock gives the local time of the prices (a tariff is a
// local-time rule) and the due times kept in /data across restarts; the waits
// of this process (pauses, retries, request spacing) use the monotonic clock.
// Every request goes one after the other, REQUEST_GAP apart (the API allows
// about one call a minute); a 429 or a 5xx pauses the source (what it asks,
// at least 2 minutes, doubling up to 6 h), kept in /data. The pricing and the
// current price never make a request: they answer from what is held.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { Catalog, CompanyError, loadSnapshot } from './catalog.js';
import {
  CONTRACTS_INTERVAL,
  DAY,
  HOUR,
  MINUTE,
  PAUSE_MAX,
  PAUSE_MIN,
  REFRESH_INTERVAL,
  REQUEST_GAP,
  REQUEST_TIMEOUT,
  RETRY_MAX,
  RETRY_MIN,
  SPOT_DAYS_PER_ASK,
  SPOT_DAYS_PER_CALL,
  SPOT_FIRST_DAY,
  SPOT_MAX_BYTES,
  SPOT_QUEUE_MAX,
  SPOT_RETRY,
  SPOT_RETRY_OLD,
  SPOT_TOMORROW_HOUR,
  STORE_RETRY,
  STORE_WAIT,
  TARIFF_BACK_DAYS,
  TARIFF_MAX_BYTES,
  TARIFF_RETRY,
  TARIFF_STALE,
  TEST_CONTRACTS,
  TICK,
} from './constants.js';
import { InputError, TEMPLATE_KEY, readInputs } from './contract.js';
import {
  ENERGINET_CODES,
  ENERGINET_GLN,
  chargeAt,
  chargesAgree,
  checkCharge,
  parsePricelist,
  pricelistUrl,
} from './datahub.js';
import { buildDevice, buildStates, idsOf, validContractId } from './devices.js';
import { HttpError, getJson } from './http.js';
import { join, text } from './i18n.js';
import { PriceMissing, SpotMissing, currentPrice, partsAt, priceIntervals } from './pricing.js';
import { checkSpotCache, daysOf, parseSpotDays, priceIn, pruneSpot, spotUrl } from './spot.js';
import { FileStore } from './store.js';
import { local, localMidnight, nextDate } from './time.js';

export const ENERGINET = 'energinet';
const defaultTimers = { setTimeout, clearTimeout };
const defaultMonotonic = () => performance.timeOrigin + performance.now();
const MAX_CODES = 20;

/** Two charge codes of one company that give different prices: the contract must choose. */
export class CodeError extends InputError {
  constructor(company, choices) {
    super(
      `${company} has several household tariffs that differ; fill "Charge code" with one of: ${choices.join(', ')}`,
    );
    this.name = 'CodeError';
    this.code = 'ambiguous_code';
  }
}

/** A short, safe text of an error for the status and the logs (never a stack). */
export function problemOf(err) {
  if (err instanceof CompanyError) {
    return err.suggestions.length
      ? `${err.message} (did you mean: ${err.suggestions.join(', ')}?)`
      : `${err.message} (see the list in the documentation)`;
  }
  if (err instanceof InputError || err instanceof PriceMissing || err instanceof HttpError) {
    return err.message;
  }
  return 'internal error, see the logs';
}

/** The local date `days` before the local date of `ms`. */
function daysBefore(ms, days) {
  const d = new Date(Date.parse(`${local(ms).date}T00:00:00Z`) - days * DAY);
  return d.toISOString().slice(0, 10);
}

export class EnergiDataServiceApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'energi-data-service' }),
    now = Date.now,
    monotonic = defaultMonotonic,
    timers = defaultTimers,
    fetchImpl = (...args) => globalThis.fetch(...args),
    stores = {
      state: new FileStore({ name: 'eds-state.json' }),
      tariffs: new FileStore({ name: 'eds-tariffs.json' }),
      spot: new FileStore({ name: 'eds-spot.json' }),
    },
    snapshot = loadSnapshot(),
  }) {
    this.gladys = gladys;
    this.log = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.fetchImpl = fetchImpl;
    this.stores = stores;
    this.catalog = new Catalog(snapshot);
    /** id -> { id, inputs, status } of the contracts of the template. */
    this.contracts = new Map();
    this.contractsUnread = false;
    /** key ("energinet" or a GLN) -> { at, codes: { [code]: charge } }. */
    this.tariffs = {};
    /** area -> { date -> { from, prices, at } }. */
    this.spot = {};
    /** "area|date" or a tariff key -> monotonic time before which it is not asked again. */
    this.waits = new Map();
    this.spotQueue = new Set();
    this.tariffQueue = new Set();
    /** Tariff keys being read. */
    this.inFlight = new Set();
    this.draining = null;
    /** Cut by stop(): the request on the wire with it. */
    this.aborter = new AbortController();
    /** id -> short problem text of the last pricing (cleared by a success). */
    this.problems = new Map();
    this.state = { refreshAt: 0, pause: null, lastRequestAt: 0 };
    /** Monotonic end of the pause. */
    this.pauseEnd = undefined;
    this.loaded = { state: false, tariffs: false, spot: false };
    this.storeReads = {};
    this.unreadable = false;
    this.lane = { tail: Promise.resolve(), last: -Infinity };
    this.timerIds = {};
    this.sleeps = new Set();
    this.gen = 0;
    this.stopped = true;
    this.configDelay = 0;
    this.contractsDelay = 0;
    this.lastStatus = undefined;
  }

  // --- Timers ------------------------------------------------------------------------

  setTimer(name, ms, fn) {
    this.clearTimer(name);
    if (this.stopped) return;
    const gen = this.gen;
    this.timerIds[name] = this.timers.setTimeout(
      () => {
        delete this.timerIds[name];
        if (this.stopped || gen !== this.gen) return;
        Promise.resolve()
          .then(fn)
          .catch((err) => this.log.error(`${name} failed (${err?.name ?? 'Error'})`));
      },
      Math.max(0, ms),
    );
  }

  clearTimer(name) {
    if (this.timerIds[name] !== undefined) {
      this.timers.clearTimeout(this.timerIds[name]);
      delete this.timerIds[name];
    }
  }

  clearAllTimers() {
    for (const name of Object.keys(this.timerIds)) this.clearTimer(name);
  }

  stale(gen) {
    return this.stopped || gen !== this.gen;
  }

  /** Waits `ms` on a timer that stop() cancels (the wait then ends at once). */
  sleep(ms) {
    return new Promise((resolve) => {
      const wait = { resolve };
      wait.id = this.timers.setTimeout(() => {
        this.sleeps.delete(wait);
        resolve();
      }, ms);
      this.sleeps.add(wait);
    });
  }

  // --- Lifecycle -----------------------------------------------------------------------

  /** Every (re)connection to Gladys: the config (retried for ever), then start. */
  async connected() {
    const gen = ++this.gen;
    this.stopped = false;
    this.lastStatus = undefined;
    // What Gladys holds may be older than this process: published again.
    this.gladys.forgetPublishedStates?.();
    this.clearTimer('config');
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      if (this.stale(gen)) return;
      this.configDelay = Math.min(RETRY_MAX, Math.max(RETRY_MIN, this.configDelay * 2));
      this.log.warn(
        `Configuration not read (${err?.name ?? 'Error'}): again in ${this.configDelay / 1000} s`,
      );
      await this.setStatus(false, text('configUnread'));
      this.setTimer('config', this.configDelay, () => this.connected());
      return;
    }
    if (this.stale(gen)) return;
    this.configDelay = 0;
    await this.start(config);
  }

  // The configuration holds no setting (the contracts carry everything).
  async start() {
    this.clearAllTimers();
    const gen = ++this.gen;
    this.stopped = false;
    if (this.aborter.signal.aborted) this.aborter = new AbortController();
    // A loop of an earlier start ends on its own (stale generation): it never
    // holds the queues of this one.
    this.draining = null;
    await this.loadStores();
    if (this.stale(gen)) return;
    await this.loadContracts();
    if (this.stale(gen)) return;
    await this.publishDevices();
    this.scheduleRefresh();
    if (this.pauseOf()) this.armResume(this.pauseEnd - this.monotonic());
    this.setTimer('tick', 0, () => this.tick());
    await this.updateStatus();
  }

  async stop() {
    this.stopped = true;
    this.gen += 1;
    this.clearAllTimers();
    // The requests waiting their turn wake up now and see the stop.
    for (const wait of this.sleeps) {
      this.timers.clearTimeout(wait.id);
      wait.resolve();
    }
    this.sleeps.clear();
    // The request on the wire is cut: nothing it answers is used.
    this.aborter.abort();
    this.spotQueue.clear();
    this.tariffQueue.clear();
    await Promise.all(Object.values(this.stores).map((s) => s.flush?.())).catch(() => {});
  }

  // --- /data ---------------------------------------------------------------------------

  /**
   * Reads the stores not read yet, each waited for STORE_WAIT at most (a slow
   * /data never holds the start); one read per store at a time. A store
   * unreadable or still reading is read again on its own timer; a late answer
   * is merged when it comes.
   */
  async loadStores() {
    const gen = this.gen;
    const names = Object.keys(this.loaded);
    await Promise.all(names.map((name) => this.loadStore(name)));
    if (this.stale(gen)) return;
    this.unreadable = names.some((name) => !this.loaded[name]);
    if (this.unreadable) {
      this.setTimer('store', STORE_RETRY, async () => {
        await this.loadStores();
        await this.updateStatus();
      });
    }
  }

  async loadStore(name) {
    if (this.loaded[name]) return true;
    let read = this.storeReads[name];
    if (!read) {
      read = this.stores[name].load().then(
        (data) => {
          delete this.storeReads[name];
          if (this.loaded[name]) return true;
          this.loaded[name] = true;
          try {
            this.merge(name, data);
          } catch (err) {
            // A file of an unexpected shape never stops the start: its unusable
            // part is ignored, the next save writes it clean.
            this.log.warn(`/data ${name}: unexpected content ignored (${err?.name ?? 'Error'})`);
          }
          return true;
        },
        (err) => {
          delete this.storeReads[name];
          this.log.warn(
            `/data ${name} unreadable (${err?.message ?? 'error'}): not written until it reads`,
          );
          return false;
        },
      );
      this.storeReads[name] = read;
    }
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(false), STORE_WAIT);
    });
    try {
      return await Promise.race([read, late]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** What /data held, merged under what this process already knows. */
  merge(name, data) {
    if (name === 'state') {
      // The last request before a restart: the gap holds across it.
      const last = Number(data.lastRequestAt);
      const ago = this.now() - last;
      if (Number.isFinite(last) && ago >= 0 && ago < REQUEST_GAP) {
        this.state.lastRequestAt = last;
        this.lane.last = Math.max(this.lane.last, this.monotonic() - ago);
      }
      const refreshAt = Number(data.refreshAt);
      // A due time far in the future is not trusted (clock changed): due now.
      this.state.refreshAt =
        Number.isFinite(refreshAt) && refreshAt <= this.now() + REFRESH_INTERVAL ? refreshAt : 0;
      const pause = data.pause;
      const until = Number(pause?.until);
      if (
        !this.state.pause &&
        Number.isFinite(until) &&
        until > this.now() &&
        until <= this.now() + PAUSE_MAX
      ) {
        this.state.pause = {
          until,
          delay: Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, Number(pause.delay) || PAUSE_MIN)),
          status: Number(pause.status) || 0,
        };
        // The wall time only carries the pause across the restart: this
        // process waits on its monotonic clock.
        this.pauseEnd = this.monotonic() + (until - this.now());
      }
    } else if (name === 'tariffs') {
      for (const [key, entry] of Object.entries(data.tariffs ?? {})) {
        if (key !== ENERGINET && !/^\d{13}$/.test(key)) continue;
        if (this.tariffs[key] || !entry || typeof entry.codes !== 'object') continue;
        const at = Number(entry.at);
        // A read dated in the future is not trusted.
        if (!Number.isFinite(at) || at > this.now() + HOUR) continue;
        const codes = {};
        for (const [code, raw] of Object.entries(entry.codes).slice(0, MAX_CODES)) {
          const charge = checkCharge(raw);
          if (charge) codes[code] = charge;
        }
        this.tariffs[key] = { at, codes };
      }
    } else if (name === 'spot') {
      const cache = checkSpotCache(data.areas);
      for (const [area, days] of Object.entries(cache)) {
        this.spot[area] = { ...days, ...(this.spot[area] ?? {}) };
      }
    }
  }

  /** Saves one store; true when written. Never while it has not been read (it would erase it). */
  async save(name) {
    if (!this.loaded[name]) return false;
    let data;
    if (name === 'state') data = { v: 1, ...this.state };
    else if (name === 'tariffs') data = { v: 1, tariffs: this.tariffs };
    else data = { v: 1, areas: this.spot };
    try {
      await this.stores[name].save(data);
      return true;
    } catch (err) {
      this.log.warn(`/data ${name} not written (${err?.code ?? err?.name ?? 'Error'})`);
      return false;
    }
  }

  // --- Contracts -----------------------------------------------------------------------

  async loadContracts() {
    const gen = this.gen;
    let list;
    try {
      list = await this.gladys.getEnergyContracts();
    } catch (err) {
      if (this.stale(gen)) return;
      this.contractsUnread = true;
      this.contractsDelay = Math.min(RETRY_MAX, Math.max(RETRY_MIN, this.contractsDelay * 2));
      this.log.warn(
        `Contracts not read (${err?.name ?? 'Error'}): again in ${this.contractsDelay / 1000} s`,
      );
      this.setTimer('contracts', this.contractsDelay, async () => {
        await this.loadContracts();
        await this.publishDevices();
        await this.updateStatus();
      });
      return;
    }
    if (this.stale(gen)) return;
    this.contractsUnread = false;
    this.contractsDelay = 0;
    const next = new Map();
    for (const c of Array.isArray(list) ? list : []) {
      if (c?.template_key !== TEMPLATE_KEY || !validContractId(c.id)) continue;
      if (c.status === 'expired' || c.status === 'orphaned') continue;
      next.set(c.id, { id: c.id, inputs: c.inputs ?? {}, status: c.status });
    }
    this.contracts = next;
    for (const id of this.problems.keys()) if (!next.has(id)) this.problems.delete(id);
    this.wantTariffs();
    this.setTimer('contracts', CONTRACTS_INTERVAL, async () => {
      await this.loadContracts();
      await this.updateStatus();
    });
  }

  /** The settings of a contract: `{ settings, company }`; throws on a wrong input. */
  resolve(inputs) {
    const settings = readInputs(inputs);
    const company = this.catalog.resolve(settings.company);
    if (!company.known && !settings.code) {
      throw new InputError(
        `GLN ${company.gln} is not in the list of grid companies: fill "Charge code"`,
      );
    }
    return { settings, company };
  }

  /** The codes to read for a GLN: those of every contract using it. */
  codesFor(gln) {
    const codes = new Set();
    for (const { inputs } of this.contracts.values()) {
      try {
        const { settings, company } = this.resolve(inputs);
        if (company.gln !== gln) continue;
        if (settings.code) codes.add(settings.code);
        else for (const c of company.codes) codes.add(c.code);
      } catch {
        // reported by the pricing
      }
    }
    return [...codes].sort().slice(0, MAX_CODES);
  }

  /** The GLNs the contracts use, in order. */
  usedGlns() {
    const glns = new Set();
    for (const { inputs } of this.contracts.values()) {
      try {
        glns.add(this.resolve(inputs).company.gln);
      } catch {
        // reported by the pricing
      }
    }
    return [...glns].sort();
  }

  /** The grid price (DKK/kWh without VAT) of a contract at a local time; throws when unknown. */
  gridAt(settings, company, t) {
    const held = this.tariffs[company.gln];
    const codes = settings.code ? [settings.code] : company.codes.map((c) => c.code);
    if (!held || !codes.every((c) => held.codes[c])) {
      this.wantTariff(company.gln);
      throw new PriceMissing(`tariffs of ${company.name} not read yet`);
    }
    // Without a code given, the codes of the company are used only when they
    // agree over every period held (the same price every hour of every day,
    // the same days without a price): never the one that happens to have a
    // price on a date, since the other may be the contract's.
    if (codes.length > 1 && !chargesAgree(codes.map((c) => held.codes[c]))) {
      throw new CodeError(
        company.name,
        codes.map((code) => {
          const note = held.codes[code].note;
          return note ? `${code} (${note})` : code;
        }),
      );
    }
    const v = chargeAt(held.codes[codes[0]], t);
    if (v === undefined) throw new PriceMissing(`no tariff of ${company.name} for ${t.date}`);
    return v;
  }

  /** Energinet's charges (DKK/kWh without VAT) at a local time; throws when unknown. */
  energinetAt(t) {
    const held = this.tariffs[ENERGINET];
    if (!held) {
      this.wantTariff(ENERGINET);
      throw new PriceMissing('Energinet tariffs not read yet');
    }
    const out = {};
    for (const [name, code] of Object.entries(ENERGINET_CODES)) {
      const v = chargeAt(held.codes[code], t);
      if (v === undefined) throw new PriceMissing(`no Energinet ${name} for ${t.date}`);
      out[name] = v;
    }
    return out;
  }

  context(settings, company) {
    return {
      grid: (t) => this.gridAt(settings, company, t),
      energinet: (t) => this.energinetAt(t),
      spot: (area, ms) => priceIn(this.spot[area]?.[local(ms).date], ms),
    };
  }

  // --- Delegated pricing ---------------------------------------------------------------

  async energyPrice({ contract, intervals = [] }) {
    if (contract?.template_key !== TEMPLATE_KEY) {
      throw new Error(
        `template ${String(contract?.template_key).slice(0, 64)} is not this integration's`,
      );
    }
    const id = contract.id;
    if (validContractId(id)) {
      const known = this.contracts.get(id);
      if (known) known.inputs = contract.inputs ?? {};
      else this.contracts.set(id, { id, inputs: contract.inputs ?? {}, status: 'active' });
    }
    if (!Array.isArray(intervals) || intervals.length === 0) return [];
    try {
      const { settings, company } = this.resolve(contract.inputs);
      try {
        const costs = priceIntervals(intervals, settings, this.context(settings, company));
        if (this.problems.delete(id)) this.updateStatus().catch(() => {});
        return costs;
      } catch (err) {
        // Never a wait here: the days missing are read in the background and
        // Gladys asks again at its next run (30 minutes at most).
        if (err instanceof SpotMissing) {
          const starts = intervals.map((i) => Date.parse(i?.starts_at)).filter(Number.isFinite);
          this.wantSpot(err.area, daysOf(starts));
        }
        throw err;
      }
    } catch (err) {
      const problem = problemOf(err);
      if (validContractId(id)) this.problems.set(id, problem);
      this.log.warn(`Contract ${String(id).slice(0, 36)} not priced: ${problem}`);
      this.updateStatus().catch(() => {});
      throw new Error(problem, { cause: err });
    }
  }

  /** The current price, from what is held (never a request: Gladys waits 5 s). */
  async energyCurrent({ contract }) {
    try {
      const { settings, company } = this.resolve(contract?.inputs);
      return currentPrice(this.now(), settings, this.context(settings, company));
    } catch {
      return { price: null };
    }
  }

  // --- Devices -------------------------------------------------------------------------

  devicesToPublish() {
    const devices = [];
    for (const { id, inputs } of this.contracts.values()) {
      let companyName;
      try {
        companyName = this.resolve(inputs).company.name;
      } catch {
        companyName = String(inputs?.grid_company ?? '?').slice(0, 60);
      }
      devices.push(buildDevice(this.gladys, { id, companyName }));
    }
    return devices;
  }

  async publishDevices() {
    try {
      await this.gladys.publishDiscoveredDevices(this.devicesToPublish());
    } catch (err) {
      this.log.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  /** Discovery: the contracts listed again, never a request outside Gladys. */
  async scan() {
    await this.loadContracts();
    await this.publishDevices();
  }

  async publishContract(id) {
    const contract = this.contracts.get(id);
    if (!contract || this.stopped) return;
    let price;
    try {
      const { settings, company } = this.resolve(contract.inputs);
      price = currentPrice(this.now(), settings, this.context(settings, company)).price;
    } catch {
      // unknown: nothing published (never a zero)
      return;
    }
    const states = buildStates(this.gladys, id, { price });
    if (states.length === 0) return;
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.log.warn(`States not published (${err?.name ?? 'Error'})`);
    }
  }

  async onDeviceCreated(device) {
    for (const id of this.contracts.keys()) {
      if (device?.external_id === idsOf(this.gladys, id).device) await this.publishContract(id);
    }
  }

  // --- Quarter tick: states and spot prices --------------------------------------------

  async tick() {
    const gen = this.gen;
    const now = this.now();
    for (const id of this.contracts.keys()) {
      await this.publishContract(id);
      if (this.stale(gen)) return;
    }
    const t = local(now);
    const dates = [t.date];
    if (t.h >= SPOT_TOMORROW_HOUR) dates.push(nextDate(t.date));
    for (const area of this.spotAreas()) this.wantSpot(area, dates);
    // Next tick at the next quarter of the wall clock (+5 s, after the change).
    const quarter = 15 * MINUTE;
    this.setTimer('tick', Math.min(TICK, quarter - (now % quarter) + 5000), () => this.tick());
  }

  /** The areas of the contracts that read spot prices. */
  spotAreas() {
    const areas = new Set();
    for (const { inputs } of this.contracts.values()) {
      try {
        const settings = readInputs(inputs);
        if (settings.supply === 'spot') areas.add(settings.area);
      } catch {
        // a wrong input is reported by its pricing
      }
    }
    return [...areas].sort();
  }

  waiting(key) {
    const wait = this.waits.get(key);
    return wait !== undefined && this.monotonic() < wait;
  }

  /**
   * Queues the days of an area that are not held for a read in the background
   * (never awaited). A day not published yet or that failed is not asked
   * again before SPOT_RETRY; a day before the dataset or after tomorrow is
   * never asked.
   */
  wantSpot(area, dates) {
    const tomorrow = nextDate(local(this.now()).date);
    for (const date of dates.slice(0, SPOT_DAYS_PER_ASK)) {
      if (date < SPOT_FIRST_DAY || date > tomorrow) continue;
      if (this.spot[area]?.[date]) continue;
      const key = `${area}|${date}`;
      if (this.waiting(key)) continue;
      if (this.spotQueue.size >= SPOT_QUEUE_MAX) break;
      this.spotQueue.add(key);
    }
    this.drain();
  }

  /** Queues the tariffs of a key (GLN or "energinet") not held, for a read in the background. */
  wantTariff(key) {
    if (this.waiting(`tariff|${key}`)) return;
    this.tariffQueue.add(key);
    this.drain();
  }

  /** Whether the tariffs of a key are held, every code the contracts need included. */
  holds(key) {
    const held = this.tariffs[key];
    if (key === ENERGINET) return Boolean(held);
    return Boolean(held) && this.codesFor(key).every((c) => held.codes[c]);
  }

  /** Queues the tariffs every contract needs and that are not held (codes included). */
  wantTariffs() {
    if (this.contracts.size === 0) return;
    for (const key of [ENERGINET, ...this.usedGlns()]) if (!this.holds(key)) this.wantTariff(key);
  }

  drain() {
    if (this.draining || this.stopped) return;
    if (this.spotQueue.size === 0 && this.tariffQueue.size === 0) return;
    const loop = this.drainLoop()
      .catch((err) => this.log.error(`Background read failed (${err?.name ?? 'Error'})`))
      .finally(() => {
        // Only its own loop: the end of a loop of an earlier start never
        // frees the slot of the current one (two loops of one start, never).
        if (this.draining === loop) this.draining = null;
      });
    this.draining = loop;
  }

  async drainLoop() {
    const gen = this.gen;
    while (!this.stale(gen)) {
      // While paused, nothing is asked: the queues wait for the next want.
      if (this.pauseOf()) return;
      if (this.tariffQueue.size > 0) {
        const key = this.tariffQueue.values().next().value;
        this.tariffQueue.delete(key);
        // Read meanwhile (by the daily refresh): not asked twice.
        if (this.holds(key) || this.inFlight.has(key)) continue;
        const ok = await this.readTariff(key);
        // A failure that paused the source is asked again at the end of the pause.
        if (!ok && !this.pauseOf()) {
          this.waits.set(`tariff|${key}`, this.monotonic() + TARIFF_RETRY);
        }
        if (!this.stale(gen)) await this.updateStatus();
        continue;
      }
      if (this.spotQueue.size === 0) return;
      await this.readSpotRange(gen);
    }
  }

  yesterday() {
    const t = local(this.now());
    return local(localMidnight(t.date) - HOUR).date;
  }

  /** Reads the first queued day of an area and the queued days that follow it (one request). */
  async readSpotRange(gen) {
    const first = [...this.spotQueue].sort()[0];
    const area = first.split('|')[0];
    const dates = [...this.spotQueue]
      .filter((k) => k.startsWith(`${area}|`))
      .map((k) => k.slice(area.length + 1))
      .sort();
    // A run of days in a row from the first one, SPOT_DAYS_PER_CALL at most.
    const run = [dates[0]];
    for (const d of dates.slice(1)) {
      if (run.length >= SPOT_DAYS_PER_CALL || d !== nextDate(run[run.length - 1])) break;
      run.push(d);
    }
    for (const d of run) this.spotQueue.delete(`${area}|${d}`);
    const missing = run.filter((d) => !this.spot[area]?.[d]);
    if (missing.length === 0) return;
    const from = missing[0];
    const to = nextDate(missing[missing.length - 1]);
    let answer;
    try {
      answer = await this.request(spotUrl(area, from, to), { maxBytes: SPOT_MAX_BYTES });
    } catch (err) {
      this.markSpotWait(area, missing);
      if (err?.code !== 'paused' && err?.code !== 'stopped') {
        this.log.warn(`Spot prices ${area} ${from}..${to} not read (${err?.message ?? 'error'})`);
      }
      return;
    }
    if (this.stale(gen)) return;
    const days = parseSpotDays(answer.data, area, missing);
    const at = this.now();
    for (const [date, day] of Object.entries(days)) (this.spot[area] ??= {})[date] = { ...day, at };
    // Not whole (tomorrow before its publication): never kept in part.
    this.markSpotWait(
      area,
      missing.filter((d) => !days[d]),
    );
    if (Object.keys(days).length > 0) {
      pruneSpot(this.spot, this.now());
      await this.save('spot');
    }
  }

  markSpotWait(area, dates) {
    const old = this.yesterday();
    for (const d of dates) {
      this.waits.set(`${area}|${d}`, this.monotonic() + (d < old ? SPOT_RETRY_OLD : SPOT_RETRY));
    }
  }

  // --- Requests: one lane, paused after a 429/5xx --------------------------------------

  pauseOf() {
    return this.pauseEnd !== undefined && this.pauseEnd > this.monotonic()
      ? this.state.pause
      : null;
  }

  request(url, { maxBytes, timeoutMs = REQUEST_TIMEOUT } = {}) {
    const lane = this.lane;
    const run = async () => {
      const paused = this.pauseOf();
      if (paused) {
        throw new HttpError('paused', `Energi Data Service paused after HTTP ${paused.status}`);
      }
      const gap = lane.last + REQUEST_GAP - this.monotonic();
      if (gap > 0) await this.sleep(gap);
      // Stopped while waiting its turn: nothing leaves after stop(), nothing
      // is written to /data for it.
      if (this.stopped) throw new HttpError('stopped', 'integration stopped');
      // A pause that began while this request waited its turn.
      if (this.pauseOf()) throw new HttpError('paused', 'Energi Data Service paused');
      lane.last = this.monotonic();
      // The time of the attempt in /data before it leaves: a restart keeps the gap.
      this.state.lastRequestAt = this.now();
      this.save('state').catch(() => {});
      try {
        const result = await getJson(this.fetchImpl, url, {
          accept: 'application/json',
          maxBytes,
          timeoutMs,
          now: this.now,
          timers: this.timers,
          signal: this.aborter.signal,
        });
        if (this.stopped) throw new HttpError('stopped', 'integration stopped');
        if (this.state.pause) {
          this.state.pause = null;
          this.pauseEnd = undefined;
          this.save('state').catch(() => {});
        }
        return result;
      } catch (err) {
        if (
          !this.stopped &&
          err instanceof HttpError &&
          err.code === 'status' &&
          (err.status === 429 || err.status >= 500)
        ) {
          const previous = this.state.pause;
          const delay = previous ? Math.min(PAUSE_MAX, previous.delay * 2) : PAUSE_MIN;
          const wait = Math.min(PAUSE_MAX, Math.max(err.retryAfter ?? 0, delay));
          this.state.pause = { until: this.now() + wait, delay, status: err.status };
          this.pauseEnd = this.monotonic() + wait;
          this.save('state').catch(() => {});
          this.armResume(wait);
          this.updateStatus().catch(() => {});
        }
        throw err;
      } finally {
        lane.last = this.monotonic();
      }
    };
    const job = lane.tail.then(run, run);
    lane.tail = job.catch(() => {});
    return job;
  }

  /** After a pause: the queues read again and the status said again. */
  armResume(wait) {
    this.setTimer('resume', wait + 1000, () => {
      this.wantTariffs();
      this.drain();
      return this.updateStatus();
    });
  }

  // --- Tariffs: read when missing, again once a day ------------------------------------

  scheduleRefresh() {
    const due = Math.max(0, this.state.refreshAt - this.now());
    this.setTimer('refresh', Math.min(due, REFRESH_INTERVAL), () => this.refresh());
  }

  /**
   * The daily read: every key the contracts use whose tariffs were read more
   * than a day ago (less one hour), never one queued or being read. The next
   * due time is a day after the oldest read.
   */
  async refresh() {
    const gen = this.gen;
    if (this.contracts.size === 0) {
      // Nothing to read for: looked at again in an hour.
      this.setTimer('refresh', TARIFF_RETRY, () => this.refresh());
      return;
    }
    // Due time written before the requests: a restart never asks sooner.
    this.state.refreshAt = this.now() + TARIFF_RETRY;
    if (!(await this.save('state'))) {
      // Not written (/data unreadable or read-only): no read, or every restart
      // would read again. The tariffs held stay; tried again in an hour.
      if (!this.stale(gen)) this.setTimer('refresh', TARIFF_RETRY, () => this.refresh());
      return;
    }
    let ok = true;
    const keys = [ENERGINET, ...this.usedGlns()];
    for (const key of keys) {
      if (this.stale(gen)) return;
      if (this.tariffQueue.has(key) || this.inFlight.has(key)) continue;
      const held = this.tariffs[key];
      if (this.holds(key) && this.now() - held.at < REFRESH_INTERVAL - TARIFF_RETRY) continue;
      ok = (await this.readTariff(key)) && ok;
    }
    if (this.stale(gen)) return;
    if (ok) {
      const oldest = Math.min(...keys.map((k) => this.tariffs[k]?.at ?? this.now()));
      this.state.refreshAt = Math.max(this.now() + TARIFF_RETRY, oldest + REFRESH_INTERVAL);
    }
    await this.save('state');
    this.scheduleRefresh();
    await this.updateStatus();
  }

  /** Reads the tariffs of one key (GLN or "energinet"); true when read and kept. */
  async readTariff(key) {
    this.inFlight.add(key);
    try {
      return await this.readTariffNow(key);
    } finally {
      this.inFlight.delete(key);
    }
  }

  async readTariffNow(key) {
    const gln = key === ENERGINET ? ENERGINET_GLN : key;
    const codes = key === ENERGINET ? Object.values(ENERGINET_CODES) : this.codesFor(key);
    if (codes.length === 0) return true;
    const since = daysBefore(this.now(), TARIFF_BACK_DAYS);
    let answer;
    try {
      answer = await this.request(pricelistUrl({ gln, codes }), {
        maxBytes: TARIFF_MAX_BYTES,
      });
    } catch (err) {
      if (err?.code !== 'paused' && err?.code !== 'stopped') {
        this.log.warn(`Tariffs of ${key} not read (${err?.message ?? 'error'})`);
      }
      return false;
    }
    // Stopped meanwhile: nothing kept, nothing written.
    if (this.stopped) return false;
    const parsed = parsePricelist(answer.data, { gln, codes, since });
    if (!parsed) {
      this.log.warn(`Tariffs of ${key}: answer refused by the checks, the previous ones stay`);
      return false;
    }
    const empty = Object.values(parsed).every((c) => c.periods.length === 0);
    const held = this.tariffs[key];
    if (key === ENERGINET && Object.values(parsed).some((c) => c.periods.length === 0)) {
      this.log.warn(
        'Energinet tariffs: a charge is missing from the answer, the previous ones stay',
      );
      return false;
    }
    if (empty && held && Object.values(held.codes).some((c) => c.periods.length > 0)) {
      this.log.warn(`Tariffs of ${key}: empty answer, the previous ones stay`);
      return false;
    }
    if (empty) this.log.warn(`Tariffs of ${key}: no tariff found for ${codes.join(', ')}`);
    this.tariffs[key] = { at: this.now(), codes: parsed };
    this.waits.delete(`tariff|${key}`);
    await this.save('tariffs');
    return true;
  }

  // --- Status --------------------------------------------------------------------------

  /** The oldest read of the tariffs the contracts use (ms), or null when one is not read. */
  oldestRead() {
    const keys = [ENERGINET, ...this.usedGlns()];
    let oldest = Infinity;
    for (const key of keys) {
      const held = this.tariffs[key];
      if (!held) return null;
      oldest = Math.min(oldest, held.at);
    }
    return oldest;
  }

  async updateStatus() {
    if (this.stopped) return;
    const count = this.contracts.size;
    const parts = [];
    if (count === 0) {
      parts.push(text('noContract', { count: this.catalog.size }));
    } else {
      const oldest = this.oldestRead();
      if (oldest === null) {
        parts.push(text('readyUnread', { count }));
      } else {
        const date = local(oldest).date;
        parts.push(text('ready', { count, date }));
        if (this.now() - oldest > TARIFF_STALE) parts.push(text('stale', { date }));
      }
    }
    const problem = [...this.problems.values()][0];
    if (problem) parts.push(text('problem', { problem }));
    const pause = this.pauseOf();
    if (pause) {
      const time = new Date(pause.until).toISOString().slice(11, 16);
      parts.push(text('paused', { status: pause.status, time: `${time} UTC` }));
    }
    if (this.unreadable) parts.push(text('storage'));
    if (this.contractsUnread) parts.push(text('contractsUnread'));
    await this.setStatus(true, join(...parts));
  }

  async setStatus(connected, message) {
    const key = `${connected}|${message.en}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    try {
      await this.gladys.setConnectionStatus(connected, message);
    } catch (err) {
      this.lastStatus = undefined;
      this.log.warn(`Status not sent (${err?.name ?? 'Error'})`);
    }
  }

  // --- Test button: from what is held, never a request ---------------------------------

  async testConnection() {
    if (this.contracts.size === 0) return text('testNone', { count: this.catalog.size });
    const lines = [];
    for (const { id, inputs } of [...this.contracts.values()].slice(0, TEST_CONTRACTS)) {
      lines.push(this.testContract(id, inputs));
    }
    return {
      en: lines.map((l) => l.en).join('\n'),
      fr: lines.map((l) => l.fr).join('\n'),
    };
  }

  testContract(id, inputs) {
    let resolved;
    try {
      resolved = this.resolve(inputs);
    } catch (err) {
      return text('testError', { id: id.slice(0, 8), problem: problemOf(err) });
    }
    const { settings, company } = resolved;
    const now = this.now();
    try {
      const slot = settings.supply === 'spot' ? 15 * MINUTE : HOUR;
      const start = Math.floor(now / slot) * slot;
      const p = partsAt(start, slot, settings, this.context(settings, company));
      const read = this.tariffs[company.gln]?.at;
      return text('testContract', {
        company: company.name,
        gln: company.gln,
        date: read ? local(read).date : '?',
        grid: p.grid.toFixed(4),
        tso: (p.transmission + p.system).toFixed(4),
        tax: p.elafgift.toFixed(4),
        spot: settings.supply === 'spot' ? p.spot.toFixed(4) : '-',
        price: p.total.toFixed(4),
      });
    } catch (err) {
      return text('testUnknown', {
        company: company.name,
        gln: company.gln,
        problem: problemOf(err),
      });
    }
  }
}
