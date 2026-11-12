// -----------------------------------------------------------------------------
// Runtime texts, English and French: feature name, the status of the
// configuration screen and the answer of the Test button.
// -----------------------------------------------------------------------------

export const TEXTS = {
  featurePrice: { en: 'Price now (DKK/kWh)', fr: 'Prix actuel (DKK/kWh)' },

  noContract: {
    en: 'Ready. Create a contract with the "Energi Data Service (Denmark)" template in Energy > Contracts. {count} grid companies listed.',
    fr: 'Prêt. Créez un contrat avec le modèle « Energi Data Service (Danemark) » dans Énergie > Contrats. {count} gestionnaires listés.',
  },
  ready: {
    en: '{count} contract(s). Data: Energi Data Service (Energinet), tariffs read on {date}.',
    fr: '{count} contrat(s). Données : Energi Data Service (Energinet), tarifs lus le {date}.',
  },
  readyUnread: {
    en: '{count} contract(s). Tariffs not read yet from Energi Data Service (one request a minute): the prices come in the next minutes.',
    fr: '{count} contrat(s). Tarifs pas encore lus sur Energi Data Service (une requête par minute) : les prix arrivent dans les minutes qui suivent.',
  },
  problem: { en: ' Problem: {problem}', fr: ' Problème : {problem}' },
  stale: {
    en: ' Tariffs not read again since {date}: the prices use the last ones read.',
    fr: ' Tarifs non relus depuis le {date} : les prix utilisent les derniers lus.',
  },
  storage: {
    en: ' /data unreadable: the tariffs and the spot prices are not kept.',
    fr: ' /data illisible : les tarifs et les prix spot ne sont pas gardés.',
  },
  paused: {
    en: ' Energi Data Service asks to wait (HTTP {status}): paused until {time}.',
    fr: ' Energi Data Service demande d’attendre (HTTP {status}) : pause jusqu’à {time}.',
  },
  configUnread: {
    en: 'The configuration could not be read from Gladys: trying again.',
    fr: 'La configuration n’a pas pu être lue depuis Gladys : nouvel essai.',
  },
  contractsUnread: {
    en: ' The contracts could not be read from Gladys: trying again.',
    fr: ' Les contrats n’ont pas pu être lus depuis Gladys : nouvel essai.',
  },

  testNone: {
    en: 'No contract uses the "Energi Data Service (Denmark)" template yet. {count} grid companies listed.',
    fr: 'Aucun contrat n’utilise encore le modèle « Energi Data Service (Danemark) ». {count} gestionnaires listés.',
  },
  testContract: {
    en: '{company} (GLN {gln}, tariffs read on {date}): grid {grid}, Energinet {tso}, elafgift {tax}, spot {spot} DKK/kWh without VAT; price now {price} DKK/kWh with VAT.',
    fr: '{company} (GLN {gln}, tarifs lus le {date}) : réseau {grid}, Energinet {tso}, elafgift {tax}, spot {spot} DKK/kWh hors TVA ; prix actuel {price} DKK/kWh TVA comprise.',
  },
  testUnknown: {
    en: '{company} (GLN {gln}): price now unknown ({problem}).',
    fr: '{company} (GLN {gln}) : prix actuel inconnu ({problem}).',
  },
  testError: { en: 'Contract {id}: {problem}', fr: 'Contrat {id} : {problem}' },
};

/** `{ en, fr }` with `{name}` placeholders filled. */
export function text(key, values = {}) {
  const fill = (s) => s.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));
  return { en: fill(TEXTS[key].en), fr: fill(TEXTS[key].fr) };
}

/** Joins `{ en, fr }` parts. */
export function join(...parts) {
  return {
    en: parts.map((p) => p.en).join(''),
    fr: parts.map((p) => p.fr).join(''),
  };
}
