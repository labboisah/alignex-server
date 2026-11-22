import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createDatabase } from '../dist/server/database.js';
import { activateOnline } from '../dist/server/activation-service.js';
import { planFeaturesFromEntitlements, entitlementKeyForFeature } from '../dist/server/plan-features.js';
import { startCenterServer } from '../dist/server/app.js';

const Database = createRequire(import.meta.url)('better-sqlite3');

test('existing activation databases are migrated without losing records or indexes', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'alignex-licensing-'));
    const path = join(dir, 'test.sqlite');
    const old = new Database(path);
    old.exec(`CREATE TABLE license_activations (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL, license_key TEXT NOT NULL,
        organization_name TEXT NOT NULL, center_name TEXT NOT NULL, center_id TEXT,
        status TEXT NOT NULL, activated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        raw_payload TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO license_activations VALUES ('old', 'device', 'key', 'org', 'center', NULL, 'activated', '2025', '2030', NULL, '2025', '2025');`);
    old.close();
    const db = createDatabase(path);
    t.after(() => { db.connection.close(); rmSync(dir, { recursive: true, force: true }); });
    assert.equal(db.connection.prepare('SELECT expires_at FROM license_activations WHERE id = ?').get('old').expires_at, '2030');
    assert.equal(db.connection.pragma('table_info(license_activations)').find((column) => column.name === 'expires_at').notnull, 0);
    assert.ok(db.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_license_activations_device_id'").get());
});

test('signed installation entitlements and expiry override platform values during activation', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'alignex-licensing-'));
    const db = createDatabase(join(dir, 'test.sqlite'));
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; db.connection.close(); rmSync(dir, { recursive: true, force: true }); });
    const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    globalThis.fetch = async () => new Response(JSON.stringify({
        license_key: 'test-key',
        organization_name: 'Test',
        center_name: 'Center',
        expires_at: '2034-01-01T00:00:00.000Z',
        plan_features: { adaptive_exam: false },
        kernelbridge: { activation_code: 'single-use-code', installation_uuid: uuid },
    }));
    const runtime = {
        activateWithCode: async () => ({
            productCode: 'ALIGNEX',
            installationIdentifier: uuid,
            status: 'active',
            expiresAt: '2031-02-01T00:00:00.000Z',
            entitlements: {
                adaptive_exam: { enabled: true, limit: null },
                csv_export: { enabled: false, limit: null },
                delivery_offline: { enabled: true, limit: null },
                exam_package_import: { enabled: false, limit: null },
            },
        }),
    };

    const result = await activateOnline(db.connection, db.path, {
        portal_url: 'https://alignex.example',
        activation_code: 'test-code',
        admin_email: 'admin@example.test',
        admin_password: 'password123',
        installation_uuid: uuid,
    }, runtime, true);

    assert.equal(result.expires_at, '2031-02-01T00:00:00.000Z');
    assert.equal(result.plan_features.adaptive_exam, true);
    assert.equal(result.plan_features.csv_export, false);
    assert.equal(result.plan_features.offline_delivery, true);
    assert.equal(result.plan_features.exam_package_import, false);
    assert.equal(entitlementKeyForFeature('exam_package_import', (await runtime.activateWithCode()).entitlements), 'exam_package_import');
    assert.equal(planFeaturesFromEntitlements({ max_server_installations: { enabled: true, limit: 0 } }).offline_activation, false);
});

test('a non-expiring signed license is not given an invented one-year expiry', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'alignex-licensing-'));
    const db = createDatabase(join(dir, 'test.sqlite'));
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; db.connection.close(); rmSync(dir, { recursive: true, force: true }); });
    const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    globalThis.fetch = async () => new Response(JSON.stringify({
        license_key: 'test-key', organization_name: 'Test', center_name: 'Center',
        expires_at: '2034-01-01T00:00:00.000Z',
        kernelbridge: { activation_code: 'single-use-code', installation_uuid: uuid },
    }));
    const result = await activateOnline(db.connection, db.path, {
        portal_url: 'https://alignex.example', activation_code: 'test-code',
        admin_email: 'admin@example.test', admin_password: 'password123', installation_uuid: uuid,
    }, { activateWithCode: async () => ({
        productCode: 'ALIGNEX', installationIdentifier: uuid, status: 'active', expiresAt: null, entitlements: {},
    }) }, true);
    assert.equal(result.expires_at, null);
    assert.equal(db.connection.prepare('SELECT expires_at FROM license_activations').get().expires_at, null);
});

test('verified subscription plan and entitlements refresh across server status surfaces', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'alignex-licensing-status-'));
    let license = {
        productCode: 'ALIGNEX', status: 'active', expiresAt: '2031-02-01T00:00:00.000Z',
        signedEntitlementPayload: JSON.stringify({ plan: { uuid: 'plan-one', name: 'Basic' } }),
        entitlements: { delivery_offline: { enabled: true, limit: null }, max_server_installations: { enabled: true, limit: 3 } },
    };
    let failure = false;
    const runtime = {
        hasInstallation: async () => true,
        verify: async () => { if (failure) throw new Error('Verification unavailable'); return license; },
    };
    const server = await startCenterServer({
        port: 0, storagePath: join(dir, 'test.sqlite'),
        createKernelBridgeLicenseRuntime: () => runtime, requireKernelBridgeLicense: true,
    });
    t.after(async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${server.httpServer.address().port}`;
    let state = (await (await fetch(`${url}/api/app/state`)).json()).status;
    assert.equal(state.plan.name, 'Basic');
    assert.equal(state.plan.id, 'plan-one');
    assert.equal(state.entitlements.max_server_installations.limit, 3);
    assert.equal(state.plan_features.offline_delivery, true);

    license = {
        ...license, signedEntitlementPayload: JSON.stringify({ plan: { uuid: 'plan-two', name: 'Advanced' } }),
        entitlements: { delivery_offline: { enabled: false, limit: null }, adaptive_exam: { enabled: true, limit: null } },
    };
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.plan.name, 'Advanced');
    assert.equal(health.plan_features.offline_delivery, false);
    assert.equal(health.plan_features.adaptive_exam, true);
    const info = await (await fetch(`${url}/api/server-info`)).json();
    assert.deepEqual(info.plan, health.plan);
    assert.deepEqual(info.plan_features, health.plan_features);
    state = (await (await fetch(`${url}/api/app/state`)).json()).status;
    assert.equal(state.entitlements.adaptive_exam.enabled, true);

    failure = true;
    state = (await (await fetch(`${url}/api/app/state`)).json()).status;
    assert.equal(state.state, 'invalid');
    assert.equal(state.message, 'Verification unavailable');
    assert.equal(state.entitlements, null);
    assert.equal(state.plan_features.adaptive_exam, false);
    assert.equal((await (await fetch(`${url}/api/health`)).json()).plan_features.adaptive_exam, false);
});
