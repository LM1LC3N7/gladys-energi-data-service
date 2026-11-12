// -----------------------------------------------------------------------------
// One Gladys device per contract of the template (found in Discovery once the
// contract exists): the price of a kWh now, VAT included. The external id is
// the contract id (a UUID given by Gladys); keys are forever. Pure.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { TEXTS } from './i18n.js';

export const DEVICE_TYPE = 'contract';
export const FEATURE = { PRICE: 'price' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a contract id can name a device (a UUID, nothing else). */
export const validContractId = (id) => typeof id === 'string' && UUID.test(id);

export const idsOf = (gladys, contractId) => gladys.externalIds(DEVICE_TYPE, contractId);

export function buildDevice(gladys, { id, companyName }) {
  const ids = idsOf(gladys, id);
  return {
    name: `Elpris ${companyName}`.slice(0, 100),
    external_id: ids.device,
    params: [{ name: 'CONTRACT', value: id }],
    should_poll: false,
    features: [
      {
        name: TEXTS.featurePrice.en,
        category: DEVICE_FEATURE_CATEGORIES.CURRENCY,
        type: DEVICE_FEATURE_TYPES.CURRENCY.DECIMAL,
        external_id: ids.feature(FEATURE.PRICE),
        read_only: true,
        has_feedback: false,
        keep_history: true,
        min: -50,
        max: 100,
      },
    ],
  };
}

/** The states of a contract device: the price (DKK/kWh) when known, else nothing. */
export function buildStates(gladys, id, { price }) {
  if (typeof price !== 'number' || !Number.isFinite(price)) return [];
  return [
    {
      device_feature_external_id: idsOf(gladys, id).feature(FEATURE.PRICE),
      state: Math.round(price * 1e5) / 1e5,
    },
  ];
}
