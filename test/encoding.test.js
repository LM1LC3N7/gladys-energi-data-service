// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, never
// mojibake (UTF-8 bytes read as Latin-1 / Windows-1252 and saved again: "é"
// becoming "Ã" + "©"), and no file carries a control byte.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOJIBAKE = /[ÂÃ][\u0080-¿€]|â€/;
const FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'SECURITY.md',
  'src/i18n.js',
  'src/constants.js',
  'THIRD_PARTY_NOTICES.md',
  'src/app.js',
  'src/catalog.js',
  'src/snapshot/companies.json',
];

const root = fileURLToPath(new URL('..', import.meta.url));

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake`, () => {
    const bytes = readFileSync(join(root, file));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}`);
  });
}

/** Every text file of the repository (not node_modules, .git, data, images). */
function* sources(dir = root) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'data'].includes(name)) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      yield* sources(path);
    } else if (/\.(js|mjs|json|md|yml|yaml)$|^(Dockerfile|LICENSE|\.\w+)$/.test(name)) {
      yield path;
    }
  }
}

test('no control byte and no BOM in any text file (tab, CR and LF only)', () => {
  let count = 0;
  for (const path of sources()) {
    const bytes = readFileSync(path);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${path}: BOM`);
    const bad = bytes.findIndex(
      (b) => (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f,
    );
    assert.equal(bad, -1, `${path}: control byte at ${bad}`);
    count += 1;
  }
  assert.ok(count > 20);
});

test('the mojibake pattern catches what it should', () => {
  assert.match('FranÃ§ais', MOJIBAKE, 'ç read as Latin-1');
  assert.match('Â«', MOJIBAKE, '« read as Latin-1');
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app…', MOJIBAKE);
});

test('LICENSE names nobody', () => {
  const license = readFileSync(join(root, 'LICENSE'), 'utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Copyright (?:\(c\) )?\d{4}/i);
});

test('the cover is a PNG of 800 x 534', () => {
  const png = readFileSync(join(root, 'cover.png'));
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
  assert.ok(png.length <= 150 * 1024);
});
