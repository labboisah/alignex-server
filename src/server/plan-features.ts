import type { Database } from 'better-sqlite3';
import type { LicenseState } from '@kernelbridge/licensing-client-typescript';

export type PlanFeatureKey =
    | 'online_delivery'
    | 'offline_delivery'
    | 'traditional_cbt'
    | 'adaptive_exam'
    | 'candidate_import'
    | 'question_import'
    | 'teacher_management'
    | 'facilitator_management'
    | 'csv_export'
    | 'pdf_export'
    | 'certificate_generation'
    | 'custom_branding'
    | 'webcam_proctoring'
    | 'result_sync'
    | 'multi_center'
    | 'custom_reports'
    | 'advanced_analytics'
    | 'priority_support'
    | 'dedicated_support'
    | 'api_integration'
    | 'offline_activation'
    | 'exam_package_import'
    | 'offline_question_authoring'
    | 'result_package_export'
    | 'email_notifications'
    | 'sms_notifications'
    | 'official_live_exam_allowed'
    | 'demo_watermark';

export type PlanSummary = {
    id: number | string | null;
    slug: string | null;
    name: string | null;
};

export type PlanFeatures = Record<PlanFeatureKey, boolean>;

type EntitlementGrant = { enabled: boolean; limit: number | string | null };
export type LicenseEntitlements = Record<string, EntitlementGrant>;

const entitlementAliases: Partial<Record<PlanFeatureKey, string[]>> = {
    online_delivery: ['delivery_online'],
    offline_delivery: ['delivery_offline'],
    exam_package_import: ['delivery_offline'],
    result_package_export: ['delivery_offline'],
    sms_notifications: ['sms_enabled'],
    offline_activation: ['max_server_installations'],
};

export function entitlementKeyForFeature(feature: PlanFeatureKey, entitlements: LicenseEntitlements): string {
    return [feature, ...(entitlementAliases[feature] ?? [])].find((key) => key in entitlements) ?? feature;
}

export function planFeaturesFromEntitlements(entitlements: LicenseEntitlements): PlanFeatures {
    return Object.fromEntries(featureKeys.map((feature) => {
        const key = entitlementKeyForFeature(feature, entitlements);
        const grant = entitlements[key];
        const allowed = grant?.enabled === true && (key !== 'max_server_installations'
            || grant.limit === 'unlimited'
            || (grant.limit !== null && Number(grant.limit) > 0));
        return [feature, allowed];
    })) as PlanFeatures;
}

export function verifiedLicenseProjection(state: LicenseState): { plan: PlanSummary | null; features: PlanFeatures; entitlements: LicenseEntitlements } {
    let plan: PlanSummary | null = null;
    if (state.signedEntitlementPayload) {
        const claims: unknown = JSON.parse(state.signedEntitlementPayload);
        if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
            throw new Error('The verified KernelBridge entitlement payload is malformed.');
        }
        const value = (claims as Record<string, unknown>).plan;
        if (value !== undefined) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error('The verified KernelBridge plan is malformed.');
            }
            const record = value as Record<string, unknown>;
            if (typeof record.uuid !== 'string' || typeof record.name !== 'string') {
                throw new Error('The verified KernelBridge plan is malformed.');
            }
            plan = { id: record.uuid, slug: null, name: record.name };
        }
    }

    return { plan, features: planFeaturesFromEntitlements(state.entitlements), entitlements: state.entitlements };
}

export class PlanFeatureError extends Error {
    constructor(
        message: string,
        public readonly feature: PlanFeatureKey,
        public readonly statusCode = 403,
    ) {
        super(message);
    }
}

export const planFeatureLabels: Record<PlanFeatureKey, string> = {
    online_delivery: 'Online exam delivery',
    offline_delivery: 'Offline center delivery',
    traditional_cbt: 'Traditional CBT',
    adaptive_exam: 'Adaptive exams',
    candidate_import: 'Candidate import',
    question_import: 'Question import',
    teacher_management: 'Teacher management',
    facilitator_management: 'Facilitator management',
    csv_export: 'CSV result export',
    pdf_export: 'PDF result export',
    certificate_generation: 'Certificate generation',
    custom_branding: 'Custom branding',
    webcam_proctoring: 'Webcam proctoring',
    result_sync: 'Result sync',
    multi_center: 'Multi-center delivery',
    custom_reports: 'Custom reports',
    advanced_analytics: 'Advanced analytics',
    priority_support: 'Priority support',
    dedicated_support: 'Dedicated support',
    api_integration: 'API integration',
    offline_activation: 'Offline activation',
    exam_package_import: 'Exam package import',
    offline_question_authoring: 'Offline question authoring',
    result_package_export: 'Result package export',
    email_notifications: 'Email notifications',
    sms_notifications: 'SMS notifications',
    official_live_exam_allowed: 'Official live exams',
    demo_watermark: 'Demo watermark',
};

const featureKeys = Object.keys(planFeatureLabels) as PlanFeatureKey[];

export function allPlanFeatures(enabled: boolean): PlanFeatures {
    return Object.fromEntries(featureKeys.map((key) => [key, enabled])) as PlanFeatures;
}

export function normalizePlanFeatures(value: unknown, legacyDefault = true): PlanFeatures {
    const defaults = allPlanFeatures(legacyDefault);

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return defaults;
    }

    const input = value as Record<string, unknown>;

    return Object.fromEntries(featureKeys.map((key) => [key, Boolean(input[key] ?? defaults[key])])) as PlanFeatures;
}

export function readLatestPlanFeatures(connection: Database): PlanFeatures {
    const payload = readLatestLicensePayload(connection);
    return normalizePlanFeatures(payload?.plan_features, true);
}

export function readLatestPlanSummary(connection: Database): PlanSummary {
    const payload = readLatestLicensePayload(connection);
    const plan = payload?.plan;

    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        return { id: null, slug: 'legacy', name: 'Legacy Offline License' };
    }

    const record = plan as Record<string, unknown>;

    return {
        id: typeof record.id === 'string' || typeof record.id === 'number' ? record.id : null,
        slug: typeof record.slug === 'string' ? record.slug : null,
        name: typeof record.name === 'string' ? record.name : null,
    };
}

export function hasPlanFeature(connection: Database, feature: PlanFeatureKey): boolean {
    return readLatestPlanFeatures(connection)[feature] === true;
}

export function assertPlanFeature(connection: Database, feature: PlanFeatureKey): void {
    if (!hasPlanFeature(connection, feature)) {
        throw new PlanFeatureError(`${planFeatureLabels[feature]} is not available on this license plan.`, feature);
    }
}

function readLatestLicensePayload(connection: Database): Record<string, unknown> | null {
    const row = connection
        .prepare('SELECT raw_payload FROM license_activations ORDER BY created_at DESC LIMIT 1')
        .get() as { raw_payload: string | null } | undefined;

    if (!row?.raw_payload) {
        return null;
    }

    try {
        const parsed = JSON.parse(row.raw_payload) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}
