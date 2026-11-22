const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
    const Database = require(path.join(process.argv[2], 'node_modules', 'better-sqlite3'));
    const database = new Database(':memory:');
    try {
        if (database.prepare('SELECT 1 AS value').get().value !== 1) {
            throw new Error('SQLite returned an unexpected result.');
        }
    } finally {
        database.close();
    }
    const licensing = await import(pathToFileURL(path.join(process.argv[2], 'dist', 'server', 'kernelbridge-licensing.js')).href);
    if (typeof licensing.createKernelBridgeLicenseRuntime !== 'function') {
        throw new Error('KernelBridge licensing runtime was not loaded.');
    }
    console.log('Electron SQLite and KernelBridge SDK smoke tests passed.');
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
