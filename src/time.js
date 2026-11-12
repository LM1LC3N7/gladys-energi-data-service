// -----------------------------------------------------------------------------
// Local time of Denmark (Europe/Copenhagen), from the time zone database of Node
// (Intl): the changes of time are Denmark's own. Every tariff rule reads the
// local wall clock: the DataHub prices Price1..Price24 are the local hours of
// the day, and on the night of the autumn change the hour 02 happens twice
// (both take Price3, "the same price as the preceding hour" says Energinet);
// on the spring change it does not happen.
// Pure functions.
// -----------------------------------------------------------------------------

export const TIME_ZONE = 'Europe/Copenhagen';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
});

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const pad = (v) => String(v).padStart(2, '0');

/**
 * The local clock of Denmark at `ms`: { y, mo, d, h, mi, weekday (1 = Monday
 * .. 7 = Sunday), date: "YYYY-MM-DD", month: "YYYY-MM" }.
 */
export function local(ms) {
  const out = {};
  for (const { type, value } of formatter.formatToParts(new Date(ms))) {
    out[type] = value;
  }
  const y = Number(out.year);
  const mo = Number(out.month);
  const d = Number(out.day);
  return {
    y,
    mo,
    d,
    h: Number(out.hour),
    mi: Number(out.minute),
    weekday: WEEKDAYS[out.weekday],
    date: `${y}-${pad(mo)}-${pad(d)}`,
    month: `${y}-${pad(mo)}`,
  };
}

/**
 * The instant of a local midnight ("YYYY-MM-DD" of Denmark). Denmark changes
 * time at 02:00 or 03:00, never at midnight: a local midnight always exists
 * once. Undefined for a malformed date.
 */
export function localMidnight(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (!match) return undefined;
  const [y, mo, d] = match.slice(1).map(Number);
  const asUtc = Date.UTC(y, mo - 1, d);
  const check = new Date(asUtc);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return undefined;
  for (const offset of [1, 2]) {
    const candidate = asUtc - offset * HOUR;
    const t = local(candidate);
    if (t.date === date && t.h === 0 && t.mi === 0) return candidate;
  }
  return undefined;
}

/** The local date after `date` ("YYYY-MM-DD"). */
export function nextDate(date) {
  const [y, mo, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** The local month before `month` ("YYYY-MM"). */
export function previousMonth(month) {
  const [y, mo] = month.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${pad(mo - 1)}`;
}

/** The start of the hour holding `ms` (Denmark's offsets are whole hours). */
export const hourStart = (ms) => Math.floor(ms / HOUR) * HOUR;

/** The start of the 15-minute slot holding `ms`. */
export const quarterStart = (ms) => Math.floor(ms / (15 * MINUTE)) * 15 * MINUTE;

/** Strict ISO instant -> ms; undefined when it is not one. */
export function parseInstant(value) {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
