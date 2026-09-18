import type { Server as SocketServer } from 'socket.io';
import type { CenterDatabase } from './database.js';
import { readLatestPlanFeatures, readLatestPlanSummary } from './plan-features.js';
import { detectLanIpAddress } from './network.js';
import type { CenterServerStatus, ServerInfo } from './types.js';

export type StatusServiceOptions = {
    database: CenterDatabase;
    port: number;
    startedAt: string;
};

export class StatusService {
    private readonly database: CenterDatabase;
    private readonly port: number;
    private readonly startedAt: string;
    private socketServer: SocketServer | null = null;
    private connectedCandidateCountProvider: (() => number) | null = null;

    constructor(options: StatusServiceOptions) {
        this.database = options.database;
        this.port = options.port;
        this.startedAt = options.startedAt;
    }

    attachSocketServer(socketServer: SocketServer): void {
        this.socketServer = socketServer;
    }

    setConnectedCandidateCountProvider(provider: () => number): void {
        this.connectedCandidateCountProvider = provider;
    }

    getStatus(): CenterServerStatus {
        const localIpAddress = detectLanIpAddress();
        const owner = this.getOrganizationIdentity();

        return {
            serverStatus: 'online',
            localIpAddress,
            candidateUrl: `http://${localIpAddress}:${this.port}/`,
            port: this.port,
            organizationDisplayName: owner.displayName,
            organizationName: owner.organizationName,
            centerName: owner.centerName,
            connectedCandidates: this.connectedCandidateCountProvider?.() ?? 0,
            importedExams: this.countImportedExams(),
            activeCandidates: this.countAttemptsByStatus(['active']),
            submittedCandidates: this.countAttemptsByStatus(['submitted', 'auto_submitted']),
            database: {
                path: this.database.path,
                walEnabled: this.database.walEnabled,
            },
            plan: readLatestPlanSummary(this.database.connection),
            plan_features: readLatestPlanFeatures(this.database.connection),
            startedAt: this.startedAt,
        };
    }

    getServerInfo(): ServerInfo {
        return {
            databaseConnected: this.database.connection.open,
            databaseFilePath: this.database.path,
            importedExamsCount: this.countImportedExams(),
            activeExamCount: this.countImportedExamsByStatus(['active']),
            totalCandidatesCount: this.countCandidates(),
            plan: readLatestPlanSummary(this.database.connection),
            plan_features: readLatestPlanFeatures(this.database.connection),
        };
    }

    private countImportedExams(): number {
        const row = this.database.connection.prepare('SELECT COUNT(*) as count FROM imported_exams').get() as { count: number };
        return row.count;
    }

    private countImportedExamsByStatus(statuses: string[]): number {
        const placeholders = statuses.map(() => '?').join(', ');
        const row = this.database.connection
            .prepare(`SELECT COUNT(*) as count FROM imported_exams WHERE status IN (${placeholders})`)
            .get(...statuses) as { count: number };

        return row.count;
    }

    private countCandidates(): number {
        const row = this.database.connection.prepare('SELECT COUNT(*) as count FROM candidates').get() as { count: number };
        return row.count;
    }

    private countAttemptsByStatus(statuses: string[]): number {
        const placeholders = statuses.map(() => '?').join(', ');
        const row = this.database.connection
            .prepare(`SELECT COUNT(*) as count FROM candidate_attempts WHERE status IN (${placeholders})`)
            .get(...statuses) as { count: number };

        return row.count;
    }

    private getOrganizationIdentity(): { displayName: string | null; organizationName: string | null; centerName: string | null } {
        const activation = this.database.connection.prepare(`
            SELECT organization_name, center_name
            FROM license_activations
            ORDER BY activated_at DESC, created_at DESC
            LIMIT 1
        `).get() as { organization_name: string | null; center_name: string | null } | undefined;

        if (activation) {
            return {
                displayName: activation.center_name || activation.organization_name || null,
                organizationName: activation.organization_name,
                centerName: activation.center_name,
            };
        }

        const exam = this.database.connection.prepare(`
            SELECT organization_name, institution_name
            FROM imported_exams
            ORDER BY imported_at DESC, created_at DESC
            LIMIT 1
        `).get() as { organization_name: string | null; institution_name: string | null } | undefined;

        return {
            displayName: exam?.institution_name || exam?.organization_name || null,
            organizationName: exam?.organization_name ?? null,
            centerName: exam?.institution_name ?? null,
        };
    }
}
