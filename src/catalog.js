// -----------------------------------------------------------------------------
// The grid companies (DSOs): the directory shipped in the image
// (src/snapshot/companies.json, made by scripts/snapshot.mjs from the
// DatahubPricelist dataset): GLN, name and household tariff codes ("Nettarif
// C", "Nettarif C time"). Only the directory: the prices are read live.
//
// A contract names its company by its GLN (13 digits, any GLN of DataHub is
// accepted, with a charge code when it is not in the directory) or its name
// ("Radius", "N1 A/S - 131"). Pure.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { CODE } from './contract.js';

export class CompanyError extends Error {
  constructor(message, suggestions = []) {
    super(message);
    this.name = 'CompanyError';
    this.code = 'unknown_company';
    this.suggestions = suggestions;
  }
}

/** "Radius Elnet A/S" -> "radius elnet"; "Aal El-Net A M B A" -> "aal el net". */
export function normalizeName(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFC')
    .replace(/\ba\s*\/\s*s\b/g, ' ')
    .replace(/\ba\s*\.?\s*m\s*\.?\s*b\s*\.?\s*a\b\.?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function loadSnapshot(url = new URL('./snapshot/companies.json', import.meta.url)) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

export class Catalog {
  constructor(snapshot) {
    this.source = snapshot?.source ?? {};
    /** gln -> { gln, name, codes: [{ code, note }] } */
    this.companies = new Map();
    for (const c of snapshot?.companies ?? []) {
      if (!/^\d{13}$/.test(c?.gln ?? '') || typeof c.name !== 'string') continue;
      const codes = (Array.isArray(c.codes) ? c.codes : []).filter(
        (x) => typeof x?.code === 'string' && CODE.test(x.code),
      );
      this.companies.set(c.gln, { gln: c.gln, name: c.name, codes });
    }
  }

  get size() {
    return this.companies.size;
  }

  /**
   * The company of a contract input -> `{ gln, name, codes, known }`; throws a
   * CompanyError with suggestions. A GLN not in the directory is accepted
   * (`known: false`, no codes: the contract must give its charge code).
   */
  resolve(query) {
    const raw = String(query ?? '').trim();
    if (!raw) throw new CompanyError('no grid company given');
    const digits = raw.replace(/\s+/g, '');
    if (/^\d{13}$/.test(digits)) {
      const found = this.companies.get(digits);
      return found
        ? { ...found, known: true }
        : { gln: digits, name: digits, codes: [], known: false };
    }
    const all = [...this.companies.values()];
    const wanted = normalizeName(raw);
    const exact = all.filter((c) => normalizeName(c.name) === wanted);
    if (exact.length === 1) return { ...exact[0], known: true };
    const near = all.filter((c) => wanted && normalizeName(c.name).includes(wanted));
    if (near.length === 1 && exact.length === 0) return { ...near[0], known: true };
    throw new CompanyError(
      `grid company "${raw.slice(0, 60)}" ${near.length > 1 ? 'is ambiguous' : 'not found'}`,
      (exact.length > 1 ? exact : near).slice(0, 6).map((c) => `${c.name} (${c.gln})`),
    );
  }
}
