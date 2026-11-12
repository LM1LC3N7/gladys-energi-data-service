// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code (config, action, contract template and its inputs, devices), so
// a key renamed on one side only fails here. No version is pinned: only its
// shape and its agreement across files. When the Gladys clone is on the
// machine, the core's own manifest validation runs on it too.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTIONS } from '../src/constants.js';
import { AREA_OPTIONS, SUPPLY_OPTIONS, TEMPLATE_KEY, readInputs } from '../src/contract.js';
import { buildDevice } from '../src/devices.js';
import { TEXTS } from '../src/i18n.js';

const CORE = '/home/claude/code/Gladys/server';
const coreRequire = createRequire(import.meta.url);
const UNITS = existsSync(`${CORE}/utils/constants.js`)
  ? coreRequire(`${CORE}/utils/constants.js`).DEVICE_FEATURE_UNITS_BY_CATEGORY
  : { currency: [] };
const normalizeSupportedOptions = existsSync(`${CORE}/utils/normalizeSupportedOptions.js`)
  ? coreRequire(`${CORE}/utils/normalizeSupportedOptions.js`).normalizeSupportedOptions
  : undefined;

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const [template] = manifest.energy_contracts.templates;
const input = (key) => template.inputs.find((i) => i.key === key);

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics, the version agreeing everywhere, never pinned', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.3.0', 'countries need 5.3.0 (energy_contracts 5.2.0)');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'gladys-energi-data-service');
  assert.equal(lock.name, pkg.name);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(
    manifest.docker_image,
    `ghcr.io/lm1lc3n7/gladys-energi-data-service:${manifest.version}`,
  );
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-energi-data-service\//,
  );
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.categories, ['energy']);
  assert.equal(manifest.keywords, undefined);
  // Denmark only (Louis, 2026-11-12): countries declared, ISO alpha-2 upper case.
  assert.deepEqual(manifest.countries, ['DK']);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@gladysassistant/integration-sdk']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300);
    assert.match(docs, /never been tested with a real|jamais été testée avec un vrai/i);
    assert.match(docs, /Energi Data Service/);
    assert.match(docs, /Energinet/);
  }
});

test('every text is in English and French; sections within their limits', () => {
  for (const [path, entry] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(entry[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    for (const lang of ['en', 'fr']) assert.ok(section.description[lang].length <= 1000);
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('no key starts with gladys_; no secret at all; nothing said encrypted', () => {
  const fields = [...manifest.config_schema, ...template.inputs];
  for (const f of fields) {
    assert.doesNotMatch(f.key, /^gladys_/);
    assert.notEqual(f.type, 'secret');
  }
  for (const file of [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'CHANGELOG.md',
    'TODO.md',
    'CLAUDE.md',
    'src/i18n.js',
  ]) {
    assert.doesNotMatch(read(file), /chiffr|encrypt|hachage/i, file);
  }
});

test('the config: no setting, the contracts carry everything', () => {
  assert.deepEqual(
    manifest.config_schema.filter((f) => f.type !== 'section'),
    [],
  );
});

test('the action is the one the code handles; nothing is ever commanded', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(handlers.includes('onAction(ACTIONS.TEST'));
  for (const a of manifest.actions) assert.ok(a.timeout_seconds >= 5 && a.timeout_seconds <= 120);
  assert.ok(!handlers.includes('onSetValue'));
  assert.ok(handlers.includes('onEnergyPrice') && handlers.includes('onEnergyCurrent'));
});

test('the template: delegated, Denmark, its inputs those the code reads, its defaults valid', () => {
  assert.equal(manifest.energy_contracts.templates.length, 1);
  assert.equal(manifest.energy_contracts.calendars, undefined);
  assert.equal(template.key, TEMPLATE_KEY);
  assert.equal(template.pricing_mode, 'delegated');
  assert.equal(template.country, 'DK');
  assert.equal(template.currency, 'DKK');
  assert.equal(template.timezone, 'Europe/Copenhagen');
  assert.equal(input('price_area').default, undefined, 'no default area');
  assert.deepEqual(input('supply').options, SUPPLY_OPTIONS);
  assert.deepEqual(input('price_area').options, AREA_OPTIONS);
  assert.equal(input('grid_company').required, true);
  // The defaults of the manifest give the defaults of the code.
  const defaults = Object.fromEntries(template.inputs.map((i) => [i.key, i.default]));
  assert.deepEqual(
    readInputs({ ...defaults, grid_company: 'Radius' }),
    readInputs({ grid_company: 'Radius' }),
  );
  // A delegated tariff may only carry fixed components, from inputs.
  for (const c of template.tariff.components) {
    assert.equal(c.kind, 'fixed');
    assert.match(c.amount, /^\{\{input:monthly_fees\}\}$/);
  }
  const code = read('src/contract.js');
  for (const i of template.inputs.filter((x) => x.key !== 'monthly_fees')) {
    assert.ok(code.includes(`raw.${i.key}`), i.key);
  }
});

test('the core accepts the manifest (its own validation, when the clone is here)', (t) => {
  const path = `${CORE}/lib/external-integration/externalIntegration.validateManifest.js`;
  if (!existsSync(path)) {
    t.skip('no Gladys clone');
    return;
  }
  // In a child process with its own directory: loading the core opens a
  // DuckDB file in the current directory.
  const dir = mkdtempSync(join(tmpdir(), 'eds-core-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifestPath = fileURLToPath(
    new URL('../gladys-assistant-integration.json', import.meta.url),
  );
  const script = `const { validateManifest } = require(${JSON.stringify(path)});
    validateManifest(require(${JSON.stringify(manifestPath)})); console.log('VALID');`;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.match(out, /VALID/);
});

test('the device: units of the core only, every feature read-only, no switch, no options', () => {
  const gladys = createFakeGladys({ selector: 'energi-data-service' });
  const device = buildDevice(gladys, {
    id: '6f1c2b1e-4d3a-4c1b-9a8e-0b1c2d3e4f50',
    companyName: 'Radius Elnet A/S',
  });
  assert.equal(device.name, 'Elpris Radius Elnet A/S');
  for (const f of device.features) {
    assert.equal(f.read_only, true);
    assert.notEqual(f.category, 'switch');
    assert.ok(!/binary/.test(f.type));
    if (f.unit) assert.ok(UNITS[f.category].includes(f.unit), f.external_id);
    const options = f.supported_options ?? [];
    for (const o of options) {
      assert.equal(typeof o.label, 'string');
      assert.ok(o.label.trim() === o.label && o.label.length > 0);
    }
    if (normalizeSupportedOptions && options.length) {
      assert.deepEqual(normalizeSupportedOptions(options), options);
    }
  }
});

test('every runtime text exists in both languages, same placeholders', () => {
  for (const [key, entry] of Object.entries(TEXTS)) {
    assert.deepEqual(Object.keys(entry).sort(), ['en', 'fr'], key);
    const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(names(entry.fr), names(entry.en), key);
  }
});
