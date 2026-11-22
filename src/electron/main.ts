import type { BrowserWindow as BrowserWindowType } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../services/config.js';
import { startCenterServer, type CenterServer } from '../server/app.js';
import { loginLocalAdmin } from '../server/activation-service.js';
import { createKernelBridgeLicenseRuntime, kernelBridgeOptions, parseEntitlementPublicKeys } from '../server/kernelbridge-licensing.js';

const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron') as typeof import('electron');

let mainWindow: BrowserWindowType | null = null;
let centerServer: CenterServer | null = null;
const currentDir = dirname(fileURLToPath(import.meta.url));
const appIconPath = join(currentDir, '..', 'renderer', 'images', 'logo.ico');

if (process.platform === 'win32') {
    app.setAppUserModelId('com.alignex.center-server');
}

async function createWindow(): Promise<void> {
    const config = loadConfig();
    const storagePath = resolveStoragePath(config.storagePath, config.usesDefaultStoragePath);
    const kernelBridgePublicKeys = parseEntitlementPublicKeys(config.kernelBridgeEntitlementPublicKeys ?? undefined);
    const kernelBridgeCacheSigningKey = config.kernelBridgeApiUrl
        ? getOrCreateKernelBridgeCacheSigningKey(app.getPath('userData'))
        : null;

    centerServer = await startCenterServer({
        port: config.port,
        storagePath,
        centerId: config.centerId,
        syncBaseUrl: config.syncBaseUrl,
        syncToken: config.syncToken,
        syncAdminEmail: config.syncAdminEmail,
        syncAdminPassword: config.syncAdminPassword,
        resultExportRootPath: app.getPath('downloads'),
        createKernelBridgeLicenseRuntime: config.kernelBridgeApiUrl && kernelBridgeCacheSigningKey
            ? (database) => createKernelBridgeLicenseRuntime(
                database.connection,
                safeStorage,
                kernelBridgeOptions(config.kernelBridgeApiUrl!, kernelBridgePublicKeys, kernelBridgeCacheSigningKey),
            )
            : undefined,
        requireKernelBridgeLicense: config.requireKernelBridgeLicense,
    });

    mainWindow = new BrowserWindow({
        width: 1360,
        height: 860,
        minWidth: 1120,
        minHeight: 720,
        title: 'AlignEx Center Server',
        icon: appIconPath,
        backgroundColor: '#F8FAFC',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: join(currentDir, 'preload.js'),
        },
    });

    const devServerUrl = process.env.VITE_DEV_SERVER_URL;

    if (devServerUrl) {
        await waitForDevServer(devServerUrl);
        await mainWindow.loadURL(devServerUrl);
    } else {
        await mainWindow.loadFile(join(currentDir, '..', 'renderer', 'index.html'));
    }
}

function getOrCreateKernelBridgeCacheSigningKey(userDataPath: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Windows secure storage is unavailable; KernelBridge licensing cannot securely initialize.');
    }

    const keyPath = join(userDataPath, 'kernelbridge-cache-signing-key.bin');
    if (existsSync(keyPath)) {
        const key = safeStorage.decryptString(readFileSync(keyPath));
        if (!key) {
            throw new Error('The saved KernelBridge cache signing key is empty.');
        }

        return key;
    }

    mkdirSync(userDataPath, { recursive: true });
    const key = randomBytes(32).toString('base64url');
    const temporaryPath = `${keyPath}.tmp`;
    writeFileSync(temporaryPath, safeStorage.encryptString(key), { flag: 'wx' });
    renameSync(temporaryPath, keyPath);

    return key;
}

function resolveStoragePath(configuredStoragePath: string, usesDefaultStoragePath: boolean): string {
    if (!usesDefaultStoragePath) {
        return configuredStoragePath;
    }

    const stableStoragePath = join(app.getPath('userData'), 'data', 'offline.sqlite');
    migrateLegacyDefaultStorage(configuredStoragePath, stableStoragePath);

    return stableStoragePath;
}

function migrateLegacyDefaultStorage(legacyStoragePath: string, stableStoragePath: string): void {
    const legacyPath = resolve(legacyStoragePath);

    if (legacyPath === stableStoragePath || existsSync(stableStoragePath)) {
        return;
    }

    const legacyFolder = dirname(legacyPath);
    const stableFolder = dirname(stableStoragePath);
    const legacyConfigPath = join(legacyFolder, 'center-config.json');
    const stableConfigPath = join(stableFolder, 'center-config.json');

    if (!existsSync(legacyPath) && !existsSync(legacyConfigPath)) {
        return;
    }

    mkdirSync(stableFolder, { recursive: true });

    if (existsSync(legacyPath)) {
        copyFileSync(legacyPath, stableStoragePath);
        copyIfExists(`${legacyPath}-wal`, `${stableStoragePath}-wal`);
        copyIfExists(`${legacyPath}-shm`, `${stableStoragePath}-shm`);
    }

    copyIfExists(legacyConfigPath, stableConfigPath);
}

function copyIfExists(sourcePath: string, destinationPath: string): void {
    if (existsSync(sourcePath) && !existsSync(destinationPath)) {
        copyFileSync(sourcePath, destinationPath);
    }
}

async function waitForDevServer(url: string): Promise<void> {
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);

            if (response.ok) {
                return;
            }
        } catch {
            // Vite is still starting.
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    throw new Error(`Renderer dev server did not become ready at ${url}`);
}

app.whenReady().then(() => {
    registerIpcHandlers();
    void createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', async (event) => {
    if (!centerServer) {
        return;
    }

    event.preventDefault();
    const server = centerServer;
    centerServer = null;
    await server.stop();
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
    }
});

function registerIpcHandlers(): void {
    ipcMain.handle('alignex:open-export-folder', async (_event, folderPath: unknown) => {
        if (typeof folderPath !== 'string' || folderPath.trim().length === 0) {
            return { success: false, message: 'Export folder path is required.' };
        }

        if (!existsSync(folderPath)) {
            return { success: false, message: 'Export folder does not exist.' };
        }

        const errorMessage = await shell.openPath(folderPath);

        return errorMessage ? { success: false, message: errorMessage } : { success: true };
    });

    ipcMain.handle('alignex:uninstall-local-data', async (_event, password: unknown) => {
        if (typeof password !== 'string' || password.length === 0 || !centerServer) {
            return { success: false, message: 'A running server and local administrator password are required.' };
        }

        const database = centerServer.database;
        const configPath = join(dirname(database.path), 'center-config.json');

        try {
            const admin = database.connection.prepare("SELECT email FROM local_users WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1").get() as { email: string } | undefined;

            if (!admin) {
                return { success: false, message: 'No active local administrator was found.' };
            }

            loginLocalAdmin(database.connection, admin.email, password);

            const activeAttempt = database.connection
                .prepare("SELECT COUNT(*) AS count FROM candidate_attempts WHERE status = 'active'")
                .get() as { count: number };

            if (Number(activeAttempt.count) > 0) {
                return { success: false, message: 'Uninstall is blocked while a candidate exam is active. Close the exam first.' };
            }

            await centerServer.stop();
            centerServer = null;

            for (const path of [database.path, `${database.path}-wal`, `${database.path}-shm`, configPath]) {
                rmSync(path, { force: true });
            }

            setTimeout(() => app.quit(), 100);

            return { success: true, message: 'Local server data was deleted. The application will now close.' };
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : 'Unable to delete local server data.' };
        }
    });
}
