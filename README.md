# gladys-energi-data-service

Unofficial [Gladys Assistant](https://gladysassistant.com) integration: the
**Danish electricity prices** as a delegated **energy contract**: the hourly
grid tariff of every grid company (netselskab), Energinet's transmission and
system tariffs, the electricity tax (elafgift) and optionally the DK1/DK2
spot price with the supplier's markup, VAT included. A device per contract
shows the price now. Never tested with a real Gladys contract: see the
documentation.

- Documentation: [English](docs/en.md), [français](docs/fr.md).
- Data: [Energi Data Service](https://www.energidataservice.dk) (Energinet),
  datasets DatahubPricelist and DayAheadPrices, open data without a key.
  Contains data used pursuant to "Conditions for use of Danish public-sector
  data" from the Energi Data Service portal. See
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Requires Gladys 5.3.0 or later (energy contracts).

## Development

```bash
npm install
npm test                    # node --test
npm run lint
npm run format:check
node scripts/snapshot.mjs   # new directory of grid companies (one API call)
memcap node scripts/mutants.mjs   # mutation check
```

The release (version, image, GitHub Release) is made by the Release workflow
of the template. Licensed under the Apache License 2.0.
