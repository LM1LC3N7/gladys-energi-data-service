// -----------------------------------------------------------------------------
// Builds src/snapshot/companies.json: the Danish grid companies (DSOs) with
// their household tariff codes ("Nettarif C", "Nettarif C time"), from the
// DatahubPricelist dataset of Energi Data Service (Energinet, open data). One
// request (the API allows about one call a minute). Only the directory is
// shipped: the prices are read live by the integration.
//
//   node scripts/snapshot.mjs
//
// The API's "start" filters on ValidFrom (an open record of 2022 would be
// missed): the request filters on the notes instead, over the whole history,
// and keeps the companies with a record still valid on or after `since`.
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';

const pkg = JSON.parse(
  (await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const UA = `gladys-energi-data-service/${pkg.version} (+https://github.com/LM1LC3N7/gladys-energi-data-service)`;
const since = `${new Date().getUTCFullYear() - 1}-01-01`;
const NOTES = ['Nettarif C', 'Nettarif C time', 'Nettarif C Time', 'Nettarif C tid'];
const NOTE = /^nettarif c( time)?$/i;
const ENERGINET = '5790000432752';

const url = new URL('https://api.energidataservice.dk/dataset/DatahubPricelist');
url.searchParams.set('filter', JSON.stringify({ ChargeType: ['D03'], Note: NOTES }));
url.searchParams.set('columns', 'ChargeOwner,GLN_Number,ChargeTypeCode,Note,ValidFrom,ValidTo');
url.searchParams.set('sort', 'ValidFrom asc');
url.searchParams.set('limit', '0');

const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
const body = await res.json();
const companies = new Map();
for (const r of body.records) {
  const note = String(r.Note ?? '').trim();
  if (!NOTE.test(note) || r.GLN_Number === ENERGINET) continue;
  if (!/^\d{13}$/.test(r.GLN_Number ?? '')) continue;
  if (r.ValidTo !== null && String(r.ValidTo).slice(0, 10) < since) continue;
  const c = companies.get(r.GLN_Number) ?? { gln: r.GLN_Number, name: null, codes: new Map() };
  if (r.ChargeOwner) c.name = String(r.ChargeOwner).replace(/\s+/g, ' ').trim();
  const code = c.codes.get(r.ChargeTypeCode) ?? { code: r.ChargeTypeCode, note, last: '' };
  code.note = note;
  if ((r.ValidTo ?? '9999') > code.last) code.last = (r.ValidTo ?? '9999-12-31').slice(0, 10);
  c.codes.set(r.ChargeTypeCode, code);
  companies.set(r.GLN_Number, c);
}
const out = {
  source: {
    dataset: 'DatahubPricelist',
    url: 'https://www.energidataservice.dk/tso-electricity/DatahubPricelist',
    read: new Date().toISOString().slice(0, 10),
    validSince: since,
  },
  companies: [...companies.values()]
    .filter((c) => c.name)
    .map((c) => ({
      gln: c.gln,
      name: c.name,
      codes: [...c.codes.values()]
        .map(({ code, note }) => ({ code, note }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'da')),
};
writeFileSync(
  new URL('../src/snapshot/companies.json', import.meta.url),
  `${JSON.stringify(out, null, 1)}\n`,
);
console.log(`${out.companies.length} companies, ${body.records.length} records read`);
