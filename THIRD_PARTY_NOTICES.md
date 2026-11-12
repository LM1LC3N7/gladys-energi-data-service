# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains no code taken from another project: the pricing and the client are
written for it from the official description of the datasets (Energi Data
Service metadata). The Home Assistant integration "energidataservice"
(GPL-3.0) was not read.

## Energi Data Service data (Energinet)

The tariffs (dataset DatahubPricelist) and the spot prices (dataset
DayAheadPrices) are read from the API of Energi Data Service
(<https://www.energidataservice.dk>), and the directory of grid companies
(`src/snapshot/companies.json`, GLN, names and charge codes) was built from
DatahubPricelist by `scripts/snapshot.mjs`.

Contains data used pursuant to "Conditions for use of Danish public-sector
data" from the Energi Data Service portal (www.energidataservice.dk).
Licensor: Energinet. The data is provided "as is"; Energinet does not
endorse, support or recommend this integration.

Changes made to the data: the prices are converted (DKK/MWh to DKK/kWh),
combined (grid, Energinet, elafgift, spot, markup) and VAT 25 % is added; a
half hour takes the mean of its two spot quarters.

## npm dependencies

- `@gladysassistant/integration-sdk` (Apache-2.0).
