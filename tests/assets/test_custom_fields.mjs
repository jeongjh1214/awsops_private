import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-assets-custom-fields-'));
const dbPath = join(outDir, 'assets.db');
const tsc = resolve('node_modules/.bin/tsc');

try {
  execFileSync(tsc, [
    'src/lib/app-config.ts',
    'src/lib/assets/asset-types.ts',
    'src/lib/assets/asset-db.ts',
    'src/lib/assets/asset-admin.ts',
    'src/lib/assets/custom-fields.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--moduleResolution', 'node',
    '--rootDir', 'src',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });

  const require = createRequire(import.meta.url);
  const { openAssetDb } = require(join(outDir, 'lib/assets/asset-db.js'));
  const {
    hashAdminToken,
    requireAssetAdmin,
    verifyAdminToken,
  } = require(join(outDir, 'lib/assets/asset-admin.js'));
  const {
    createCustomField,
    deactivateCustomField,
    listCustomFields,
    updateCustomField,
  } = require(join(outDir, 'lib/assets/custom-fields.js'));

  assert.equal(
    hashAdminToken('secret'),
    'sha256:2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b',
  );
  assert.equal(verifyAdminToken('secret', hashAdminToken('secret')), true);
  assert.equal(verifyAdminToken('wrong', hashAdminToken('secret')), false);
  assert.equal(verifyAdminToken('', hashAdminToken('secret')), false);
  assert.equal(verifyAdminToken('secret', 'not-a-sha256-hash'), false);

  process.env.AWSOPS_ASSET_ADMIN_TOKEN_HASH = hashAdminToken('secret');
  assert.doesNotThrow(() => {
    requireAssetAdmin(new Headers({ 'x-awsops-asset-admin-token': 'secret' }));
  });
  assert.throws(
    () => requireAssetAdmin(new Headers({ 'x-awsops-asset-admin-token': 'wrong' })),
    /asset admin/i,
  );
  delete process.env.AWSOPS_ASSET_ADMIN_TOKEN_HASH;

  const db = openAssetDb(dbPath);
  const now = '2026-06-24T00:00:00.000Z';
  const updatedAt = '2026-06-24T01:00:00.000Z';
  const deactivatedAt = '2026-06-24T02:00:00.000Z';

  const created = createCustomField(db, {
    key: 'ops_owner',
    label: 'Ops Owner',
    type: 'select',
    options: ['platform', 'security'],
    required: true,
    appliesToServices: ['ec2', 's3'],
    appliesToResourceTypes: ['ec2_instance'],
    displayOrder: 20,
    createdBy: 'admin@example.com',
  }, now);

  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.key, 'ops_owner');
  assert.equal(created.label, 'Ops Owner');
  assert.equal(created.type, 'select');
  assert.deepEqual(created.options, ['platform', 'security']);
  assert.equal(created.required, true);
  assert.deepEqual(created.appliesToServices, ['ec2', 's3']);
  assert.deepEqual(created.appliesToResourceTypes, ['ec2_instance']);
  assert.equal(created.displayOrder, 20);
  assert.equal(created.active, true);
  assert.equal(created.createdBy, 'admin@example.com');
  assert.equal(created.createdAt, now);
  assert.equal(created.updatedAt, now);

  let fields = listCustomFields(db, true);
  assert.equal(fields.length, 1);
  assert.deepEqual(fields[0], created);
  assert.equal(db.prepare('select count(*) as count from asset_change_events').get().count, 0);

  assert.throws(
    () => createCustomField(db, { key: 'BadKey', label: 'Bad', type: 'text' }, now),
    /key/i,
  );
  assert.throws(
    () => createCustomField(db, { key: 'bad_type', label: 'Bad', type: 'bogus' }, now),
    /type/i,
  );
  assert.throws(
    () => createCustomField(db, {
      key: 'bad_options',
      label: 'Bad',
      type: 'select',
      options: ['ok', 1],
    }, now),
    /options/i,
  );

  const updated = updateCustomField(db, created.id, {
    label: 'Service Owner',
    type: undefined,
    options: ['app', 'infra'],
    required: false,
    appliesToServices: undefined,
    displayOrder: 5,
    updatedBy: 'admin2@example.com',
  }, updatedAt);

  assert.ok(updated);
  assert.equal(updated.id, created.id);
  assert.equal(updated.key, 'ops_owner');
  assert.equal(updated.label, 'Service Owner');
  assert.equal(updated.type, 'select');
  assert.deepEqual(updated.options, ['app', 'infra']);
  assert.equal(updated.required, false);
  assert.deepEqual(updated.appliesToServices, ['ec2', 's3']);
  assert.deepEqual(updated.appliesToResourceTypes, ['ec2_instance']);
  assert.equal(updated.displayOrder, 5);
  assert.equal(updated.active, true);
  assert.equal(updated.createdBy, 'admin@example.com');
  assert.equal(updated.createdAt, now);
  assert.equal(updated.updatedAt, updatedAt);

  assert.equal(updateCustomField(db, 'missing-field', { label: 'Missing' }, updatedAt), null);
  assert.throws(
    () => updateCustomField(db, created.id, { key: 'renamed_key' }, updatedAt),
    /key/i,
  );

  const deactivated = deactivateCustomField(db, created.id, 'admin3@example.com', deactivatedAt);
  assert.ok(deactivated);
  assert.equal(deactivated.active, false);
  assert.equal(deactivated.updatedAt, deactivatedAt);

  fields = listCustomFields(db, true);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].active, false);
  assert.equal(fields[0].label, 'Service Owner');
  assert.deepEqual(fields[0].options, ['app', 'infra']);
  assert.deepEqual(listCustomFields(db, false), []);
  assert.equal(deactivateCustomField(db, 'missing-field', 'admin', deactivatedAt), null);
  assert.equal(db.prepare('select count(*) as count from asset_change_events').get().count, 0);

  db.close();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
