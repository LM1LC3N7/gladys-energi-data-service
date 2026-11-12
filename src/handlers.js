// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container. Every handler is registered
// before connect(). Nothing is ever commanded: no setValue handler.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: one device per contract of the template.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.onDeviceCreated(device));

  // Delegated pricing of the "energi-data-service-dk" contracts.
  gladys.onEnergyPrice((request) => app.energyPrice(request));
  gladys.onEnergyCurrent((request) => app.energyCurrent(request));

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());

  // Configuration saved by the user.
  gladys.onConfigUpdated(() => app.start());

  // Every connection: the config read again (retried for ever), then start.
  gladys.on('connected', async () => {
    try {
      await app.connected();
    } catch (err) {
      logger?.error(`Start failed (${err?.name ?? 'Error'})`);
    }
  });
}
