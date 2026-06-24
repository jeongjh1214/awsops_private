import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeFiles = [
  'src/app/api/assets/route.ts',
  'src/app/api/assets/[id]/route.ts',
  'src/app/api/assets/custom-fields/route.ts',
  'src/app/api/assets/custom-fields/[id]/route.ts',
];

for (const file of routeFiles) {
  const source = readFileSync(file, 'utf8');
  assert.match(
    source,
    /openAssetDb\(getConfig\(\)\.assetInventory\?\.sqlitePath\)/,
    `${file} must use configured assetInventory.sqlitePath`,
  );
}
