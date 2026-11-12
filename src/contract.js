// -----------------------------------------------------------------------------
// The contract template of the manifest (`energy_contracts`, delegated mode)
// and the reading of its inputs. The keys are forever: contracts store them.
// Pure.
// -----------------------------------------------------------------------------

export const TEMPLATE_KEY = 'energi-data-service-dk';

export const SUPPLY_OPTIONS = ['grid_only', 'spot'];
export const AREA_OPTIONS = ['DK1', 'DK2'];
export const MIN_MARKUP = -1;
export const MAX_MARKUP = 5;

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.code = 'bad_input';
  }
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** Whether a text holds a control character (C0, DEL or C1). */
export const hasControl = (s) =>
  [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n < 32 || (n >= 127 && n < 160);
  });
const has = (v) => v !== undefined && v !== null && v !== '';

// A DataHub charge code: letters, digits and the signs seen in the codes
// ("TCL<100_02", "FE1 NT-01", "T-C-F-F-TD"), 1 to 32 characters.
export const CODE = /^[A-Za-z0-9][A-Za-z0-9 _<>.\-/]{0,31}$/;

/**
 * The inputs of a contract -> `{ company, code, supply, area, markup }`.
 * Throws an InputError naming the first wrong input (a wrong input is never
 * replaced by a default: the price would be wrong).
 */
export function readInputs(inputs = {}) {
  const raw = inputs && typeof inputs === 'object' ? inputs : {};
  const company = text(raw.grid_company, 120);
  if (!company || hasControl(company)) throw new InputError('grid_company is empty');
  const rawCode = typeof raw.charge_code === 'string' ? raw.charge_code.trim() : '';
  if (rawCode && !CODE.test(rawCode)) {
    throw new InputError('charge_code is not a DataHub charge code');
  }
  const supply = has(raw.supply) ? String(raw.supply) : 'grid_only';
  if (!SUPPLY_OPTIONS.includes(supply)) throw new InputError('supply is not a known option');
  // No default area: a spot price of the wrong area would be priced unnoticed.
  const area = has(raw.price_area) ? String(raw.price_area) : null;
  if (area !== null && !AREA_OPTIONS.includes(area)) {
    throw new InputError('price_area is not a known option');
  }
  if (area === null && supply === 'spot') {
    throw new InputError('price_area is needed with the spot supply');
  }
  let markup = 0;
  if (has(raw.supplier_markup)) {
    markup = NaN;
    if (typeof raw.supplier_markup === 'number') markup = raw.supplier_markup;
    if (typeof raw.supplier_markup === 'string' && /^-?\d+(\.\d+)?$/.test(raw.supplier_markup)) {
      markup = Number(raw.supplier_markup);
    }
    if (!Number.isFinite(markup) || markup < MIN_MARKUP || markup > MAX_MARKUP) {
      throw new InputError('supplier_markup must be between -1 and 5 DKK/kWh');
    }
  }
  return { company, code: rawCode || null, supply, area, markup };
}
