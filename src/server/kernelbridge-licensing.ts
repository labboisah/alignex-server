import type DatabaseConstructor from 'better-sqlite3';
import {
    DeploymentProfileService,
    ElectronSafeStorageVault,
    KernelBridgeLicenseClient,
    LicenseActivationService,
    LicenseCacheService,
    LicenseGuard,
    LicenseVerificationService,
    SqliteDeploymentProfileStore,
    SqliteLicenseStore,
    type LicenseState,
    type LicensingClientOptions,
} from '@kernelbridge/licensing-client-typescript';
import { entitlementKeyForFeature, type PlanFeatureKey } from './plan-features.js';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export interface KernelBridgeLicenseRuntime {
    installationUuid(): Promise<string>;
    hasInstallation(): Promise<boolean>;
    activateWithCode(activationCode: string, deviceName?: string): Promise<LicenseState>;
    verify(): Promise<LicenseState>;
    assertFeature(feature: PlanFeatureKey): Promise<void>;
    deactivate(): Promise<void>;
}

export interface ElectronSafeStorage {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
}

export function createKernelBridgeLicenseRuntime(
    database: SqliteDatabase,
    safeStorage: ElectronSafeStorage,
    options: LicensingClientOptions,
): KernelBridgeLicenseRuntime {
    const vault = new ElectronSafeStorageVault(safeStorage);
    const store = new SqliteLicenseStore(database);
    const profiles = new DeploymentProfileService(
        new SqliteDeploymentProfileStore(database),
        vault,
        options,
    );
    const cache = new LicenseCacheService(store, vault, options, profiles);
    const client = new KernelBridgeLicenseClient(options);
    const activation = new LicenseActivationService(client, cache, options);
    const verification = new LicenseVerificationService(client, cache, options);
    const guard = new LicenseGuard(cache);

    return {
        async installationUuid(): Promise<string> {
            return (await cache.state()).installationIdentifier;
        },
        async hasInstallation(): Promise<boolean> {
            return (await cache.state()).credentialKind === 'installation_bearer';
        },
        activateWithCode(activationCode: string, deviceName?: string): Promise<LicenseState> {
            return activation.activateWithCode(activationCode, deviceName);
        },
        async verify(): Promise<LicenseState> {
            const state = await verification.verify();
            await guard.assertActive();
            return state;
        },
        async assertFeature(feature: PlanFeatureKey): Promise<void> {
            const state = await this.verify();
            const kernelBridgeKey = entitlementKeyForFeature(feature, state.entitlements);
            await guard.assertFeature(kernelBridgeKey);
        },
        deactivate(): Promise<void> {
            return verification.deactivate();
        },
    };
}

export function parseEntitlementPublicKeys(value: string | undefined): Readonly<Record<string, string>> | undefined {
    if (!value?.trim()) {
        return undefined;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch (error) {
        throw new Error('KERNELBRIDGE_ENTITLEMENT_PUBLIC_KEYS must be a JSON object of key IDs to Ed25519 public keys.', { cause: error });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.entries(parsed).some(([key, publicKey]) => key.trim() === '' || typeof publicKey !== 'string' || publicKey.trim() === '')) {
        throw new Error('KERNELBRIDGE_ENTITLEMENT_PUBLIC_KEYS must be a JSON object of key IDs to Ed25519 public keys.');
    }

    return parsed as Record<string, string>;
}

export function kernelBridgeOptions(
    apiUrl: string,
    publicKeys: Readonly<Record<string, string>> | undefined,
    cacheSigningKey: string,
): LicensingClientOptions {
    return {
        apiUrl,
        productCode: 'ALIGNEX',
        cacheSigningKey,
        ed25519PublicKeys: publicKeys,
        requireSignedEntitlements: true,
        deploymentProfileMode: 'compatibility',
        verificationIntervalMs: 15 * 60_000,
        offlineGraceMs: 72 * 60 * 60_000,
    };
}
