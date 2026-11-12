# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors.

## What this is

A Gladys Assistant **external integration** of type `device` (Node.js 22+,
ESM, no build step, sandboxed Docker container, `@gladysassistant/integration-sdk`
0.16). It offers one delegated **energy contract** template,
"energi-data-service-dk": the Danish household price from Energi Data Service
(Energinet open data): grid company tariff, Energinet tariffs, elafgift,
optional DK1/DK2 spot and markup, VAT. A device per contract shows the price
now. Unofficial. Read-only: nothing is ever commanded.

## Commands

```bash
npm install
npm test                                  # node --test (or gi test)
npm run lint && npm run format:check
node scripts/snapshot.mjs                 # directory of grid companies (1 API call)
memcap node scripts/mutants.mjs           # mutation check, one mutant at a time
```

## Architecture

```
index.js          SDK wiring only (src/handlers.js)
src/app.js        EnergiDataServiceApp: lifecycle, contracts, pricing, background
                  reads (tariffs, spot), daily refresh, pauses, status, Test
src/datahub.js    DatahubPricelist: URL, records, periods, price at a local hour (pure)
src/spot.js       DayAheadPrices: URL, whole days of quarters, cache (pure)
src/pricing.js    cost of the 30-minute intervals, current price (pure)
src/catalog.js    directory of grid companies; company from an input (pure)
src/contract.js   template key and inputs (pure)
src/time.js       Europe/Copenhagen local time (pure)
src/http.js       the only network access (User-Agent, bounds, deadline, 429 wait)
src/store.js      /data files (state, tariffs, spot)
```

## Rules

- **About one request a minute** (the API's limit): one lane, REQUEST_GAP
  apart; 429/5xx pause kept in /data. Never more requests to warm up faster.
- **The pricing never waits for the network**: it answers from what is held;
  a missing tariff or spot day is queued and read in the background.
- **Never guess a price.** An unknown tariff, Energinet charge or spot
  quarter throws: the core gives the interval no cost and asks again. Two
  codes that disagree: the contract must choose.
- **`start` filters on ValidFrom** in this API: never use it for tariffs.
- **Keys are forever**: template key, input keys and option values, feature
  key.
- **Attribution**: "Conditions for use of Danish public-sector data", Energi
  Data Service (docs, notices). Never suggest Energinet endorses it.
- Never read the GPL Home Assistant integration "energidataservice".
- Bilingual texts (en/fr), CHANGELOG `[Unreleased]`, versions by the Release
  workflow only.
