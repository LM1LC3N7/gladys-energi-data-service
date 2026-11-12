# TODO

## Before announcing

- [ ] Review r1 (xhigh: energy, cloud data).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic at publication only.
- [ ] Store field not set in the manifest: `keywords` (elpris, nettarif,
      elafgift, Energinet, DataHub, spot, Denmark).

## To watch

- [ ] Not tested with a real Gladys contract nor a real Danish meter: the
      costs are checked against real API answers (test/fixtures, 2026-11-11).
- [ ] The API limit (about one call a minute, header `remainingcalls`, 429
      "Try again in N seconds") is not documented as a number: REQUEST_GAP
      is 65 s. Many contracts on many companies take minutes to warm up.
- [ ] DataHub 3.0 (September 2026): ChargeOwner names may change; the
      integration keys on the GLN. Run `scripts/snapshot.mjs` before each
      release for new companies and codes.
- [ ] Elafgift: 0.008 DKK/kWh in 2026-2027 (political agreement); the
      reduced electric-heating rate is not handled (gone while the tax is at
      the EU minimum).
- [ ] A negative total counts as zero (the core takes no credit): say it
      again if the core learns credits.

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, docker_image).
- `gladys_version: ">=5.3.0"`: `countries: ["DK"]` (Louis, 2026-11-12) needs
  5.3.0; `energy_contracts` needs 5.2.0.
- One delegated template (limit 20): the company is an input (32 companies
  in the directory, more than a select should hold, any GLN accepted with a
  charge code).
- No calendar declared: `spot-dk1`/`spot-dk2` may be owned by another
  integration (Nord Pool, ENTSO-E); the spot prices are read here for the
  delegated pricing only.
- The API's `start` filters on ValidFrom: the tariffs are read over their
  whole history (filtered by GLN and code) and only the periods of the last
  400 days kept.
- Several household codes for one company: used without a code only when
  they agree over every period held (same prices, same days), else the
  contract must give its charge code (never a guess, review r1). Ended codes
  are left out of the directory by `scripts/snapshot.mjs`.
- Spot days kept 62 days after their read (not their date), 800 per area:
  a recalculation of the history is read once (review r1). Tariff periods
  kept 400 days.
- The pricing and the current price never make a request: a missing value
  fails at once and is read in the background (one request a minute).
- Subscriptions (D01) not read: a fixed monthly input (the core bills fixed
  components, a delegated cost is the energy only).
- No setting in the configuration: the contracts carry everything.
