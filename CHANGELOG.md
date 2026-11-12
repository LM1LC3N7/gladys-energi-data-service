# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- The "Energi Data Service (Denmark)" contract template (delegated pricing):
  the hourly household tariff of the grid company (DataHub), Energinet's
  transmission and system tariffs, the elafgift and optionally the DK1/DK2
  15-minute spot price with the supplier's markup, VAT 25 % included.
- One device per contract: the price of a kWh now.
- Tariffs read from Energi Data Service when a contract needs them and again
  once a day, spot prices of today and tomorrow, one request a minute at
  most, pauses on 429/5xx kept across restarts.
- A Test button: company, date of the tariffs, parts of the price now.
- Several household codes are used without a charge code only when they agree
  over every period held; spot days read for the history are kept.
- Declared for Denmark only in the store (`countries: ["DK"]`, Gladys 5.3.0 or later).
