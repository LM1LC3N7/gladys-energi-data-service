// -----------------------------------------------------------------------------
// Entry point: SDK wiring only (src/handlers.js), every handler registered
// before connect(). The app lives in src/app.js.
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { EnergiDataServiceApp } from './src/app.js';
import { registerHandlers } from './src/handlers.js';

const gladys = new GladysIntegration();
const app = new EnergiDataServiceApp({ gladys });
registerHandlers(gladys, app, logger);

gladys.on('disconnected', () => {
  app.stop().catch((err) => logger.error(`Stop failed (${err?.name ?? 'Error'})`));
});
gladys.handleShutdown(() => app.stop());

logger.info('Starting the Energi Data Service integration...');
gladys.connect().catch((err) => {
  logger.error(`Initial connection failed (${err?.name ?? 'Error'})`);
  process.exit(1);
});
