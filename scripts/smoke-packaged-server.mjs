import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const archive = resolve(process.argv[2]);
const work = resolve(process.argv[3]);
mkdirSync(work, { recursive: true });
const pkg = JSON.parse(readFileSync(join(archive, 'package.json'), 'utf8'));
assert.equal(pkg.version, '0.1.5');
const uploader = readFileSync(join(archive, 'dist/server/result-upload-service.js'), 'utf8');
assert.ok(uploader.includes("status = 'pending'"));
assert.ok(uploader.includes("'blocked'"));
const { startCenterServer } = await import(pathToFileURL(join(archive, 'dist/server/app.js')).href);
const server = await startCenterServer({ port: 0, storagePath: join(work, 'smoke.sqlite') });
try {
    const port = server.httpServer.address().port;
    const health = await fetch('http://127.0.0.1:' + port + '/api/health');
    assert.equal(health.status, 200);
    const forbidden = await fetch('http://127.0.0.1:' + port + '/api/results/uploads/test');
    assert.equal(forbidden.status, 401);
    assert.ok(server.database.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'result_uploads'").get());
    console.log(JSON.stringify({ version: pkg.version, health: health.status, receipt_auth: forbidden.status, sqlite: 'ok', final_uploader: 'ok' }));
} finally { await server.stop(); }
