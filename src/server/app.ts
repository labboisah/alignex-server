import { initializeResultUploads, resultUploadStatus, uploadExamResults } from './result-upload-service.js';
import { ZipArchive, type ArchiverError } from 'archiver';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { createRequire } from 'node:module';
const { installPilot } = createRequire(import.meta.url)('./adaptive-pilot.cjs');
import { createServer, type Server as HttpServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketServer } from 'socket.io';
import { activateOffline, activateOnline, ActivationError, deactivateLocal, getActivationStatus, getLocalSyncConfig, loginLocalAdmin } from './activation-service.js';
import { CandidateAnswerError, saveCandidateAnswer } from './candidate-answer-service.js';
import { CandidateExamError, getAttemptTokenFromHeader, getCandidateExam } from './candidate-exam-service.js';
import { CandidateLoginError, loginCandidate } from './candidate-login-service.js';
import { autoSubmitCandidateAttempt, CandidateSubmitError, submitCandidateAttempt } from './candidate-submit-service.js';
import { createDatabase, type CenterDatabase } from './database.js';
import { closeExam, ExamControlError, startExam } from './exam-control-service.js';
import { getExamSummary, listExamCandidates, listExamSummaries, verifyExamPapers } from './exam-queries.js';
import { DuplicatePackageError, ImportCodeError, importExamPackageByCode, PackageValidationError } from './exam-import-service.js';
import { getCandidateSocketIdentityFromPayload, getMonitorSummary, listMonitorCandidates, resetCandidateDevice, type ConnectedCandidateSnapshot } from './monitor-service.js';
import { allPlanFeatures, assertPlanFeature, PlanFeatureError, verifiedLicenseProjection, type PlanFeatureKey } from './plan-features.js';
import { exportExamResults, ResultExportError } from './result-export-service.js';
import { acknowledgeReadinessAnswer, broadcastReadinessStart, createReadinessDrill, deleteReadinessDrill, enrollReadinessDevice, finalizeReadinessReport, getReadinessAttempt, getReadinessDrill, getReadinessMetrics, getReadinessMonitor, getReadinessReport, getReadinessReportPreview, getReadinessStartReadiness, getReadinessVisualization, importReadinessPackage, isReadinessDeviceEnrolled, listReadinessDeviceEnrollments, listReadinessDrills, listReadinessPackages, prepareReadinessAttempt, readinessManifest, ReadinessDrillError, recordReadinessEvent, startReadinessDrill, submitReadinessAttempt, updateReadinessPreflight, uploadReadinessReport } from './readiness-drill-service.js';
import { StatusService } from './status-service.js';
import { checkForUpdates, downloadUpdate, UpdateError, type UpdateArtifact } from './update-service.js';
import type { KernelBridgeLicenseRuntime } from './kernelbridge-licensing.js';

export type CenterServer = {
    app: express.Express;
    httpServer: HttpServer;
    socketServer: SocketServer;
    database: CenterDatabase;
    statusService: StatusService;
    url: string;
    stop: () => Promise<void>;
};

export type StartCenterServerOptions = {
    port: number;
    storagePath: string;
    centerId?: string | null;
    syncBaseUrl?: string | null;
    syncToken?: string | null;
    syncAdminEmail?: string | null;
    syncAdminPassword?: string | null;
    resultExportRootPath?: string | null;
    createKernelBridgeLicenseRuntime?: (database: CenterDatabase) => KernelBridgeLicenseRuntime;
    requireKernelBridgeLicense?: boolean;
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const rendererDistPath = join(currentDir, '..', 'renderer');

function isTrustedLocalOrigin(origin: string | undefined): boolean {
    if (!origin || origin === 'null' || origin === 'file://') {
        return true;
    }

    try {
        const url = new URL(origin);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return false;
        }

        const hostname = url.hostname.toLowerCase();
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
            return true;
        }

        const parts = hostname.split('.').map((part) => Number(part));
        if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
            return false;
        }

        return parts[0] === 10
            || (parts[0] === 192 && parts[1] === 168)
            || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
    } catch {
        return false;
    }
}

export async function startCenterServer(options: StartCenterServerOptions): Promise<CenterServer> {
    const app = express();
    const database = createDatabase(options.storagePath);
    const kernelBridgeLicense = options.createKernelBridgeLicenseRuntime?.(database);
    const httpServer = createServer(app);
    const socketServer = new SocketServer(httpServer, {
        cors: {
            origin: (origin, callback) => callback(isTrustedLocalOrigin(origin) ? null : new Error('Origin is not allowed by the Center Server.'), isTrustedLocalOrigin(origin)),
        },
    });
    const statusService = new StatusService({
        database,
        port: options.port,
        startedAt: new Date().toISOString(),
    });
    if (options.requireKernelBridgeLicense) {
        statusService.setLicenseProjection(null, true);
    }
    const connectedClientSockets = new Map<string, { connected_at: string; user_agent: string | null }>();
    const readinessClientSockets = new Map<string, { client_id: string; device_fingerprint: string; drill_id: string; connected_at: string; last_heartbeat_at: string; user_agent: string | null; session_token: string }>();
    const readinessSessions = new Map<string, { socket_id: string; drill_id: string; device_fingerprint: string; expires_at: number }>();
    const localAdminSessions = new Map<string, { email: string; expires_at: number }>();
    const connectedCandidateSockets = new Map<string, ConnectedCandidateSnapshot>();
    const autoClosingExamIds = new Set<string>();
    let pendingLicenseVerification: ReturnType<KernelBridgeLicenseRuntime['verify']> | null = null;

    statusService.attachSocketServer(socketServer);
    statusService.setConnectedCandidateCountProvider(() => connectedClientSockets.size);

    app.use((request, response, next) => {
        const origin = request.header('Origin');
        if (origin && !isTrustedLocalOrigin(origin)) {
            response.status(403).json({ message: 'Origin is not allowed by the Center Server.' });
            return;
        }
        if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-AlignEx-Admin-Email, X-AlignEx-Admin-Password, X-AlignEx-Device-Id, X-AlignEx-Local-Admin-Session, X-AlignEx-Readiness-Session');
        if (request.method === 'OPTIONS') {
            response.status(204).end();
            return;
        }
        next();
    });
    app.use(express.json({ limit: '15mb' }));
    const pilot = installPilot({
        connection: database.connection,
        getConfig: () => getLocalSyncConfig(database.connection, database.path),
        authenticateAdmin: (email: string, password: string) => loginLocalAdmin(database.connection, email, password),
    });
    app.use('/api/adaptive-pilot', pilot.router);
    initializeResultUploads(database.connection);
    const authenticateResultAdmin = (request: express.Request, response: express.Response, next: express.NextFunction) => {
        try {
            const email = String(request.header('X-AlignEx-Admin-Email') ?? '');
            const password = String(request.header('X-AlignEx-Admin-Password') ?? '');
            const active = database.connection.prepare("SELECT 1 FROM local_users WHERE email = ? AND status = 'active' AND role = 'admin'").get(email.trim());
            if (!active) { response.status(401).json({ message: 'Active local administrator credentials are required.' }); return; }
            loginLocalAdmin(database.connection, email, password);
            next();
        } catch { response.status(401).json({ message: 'Local administrator credentials are invalid.' }); }
    };
    const authenticateReadinessAdmin = (request: express.Request, response: express.Response, next: express.NextFunction) => {
        const token = String(request.header('X-AlignEx-Local-Admin-Session') ?? '');
        const session = localAdminSessions.get(token);
        if (!session || session.expires_at <= Date.now()) {
            localAdminSessions.delete(token);
            response.status(401).json({ message: 'Active local administrator session is required.' });
            return;
        }
        next();
    };
    const authenticateReadinessClient = (request: express.Request, response: express.Response, next: express.NextFunction) => {
        const token = String(request.header('X-AlignEx-Readiness-Session') ?? '');
        const drillId = String(request.params.drillId ?? '');
        const session = readinessSessions.get(token);
        if (!session || session.expires_at <= Date.now() || session.drill_id !== drillId) {
            readinessSessions.delete(token);
            response.status(401).json({ message: 'Active readiness client session is required.' });
            return;
        }
        next();
    };
    app.get('/api/results/uploads/:examId', authenticateResultAdmin, (request, response) => {
        response.json({ uploads: resultUploadStatus(database.connection, String(request.params.examId)) });
    });
    app.post('/api/results/upload', authenticateResultAdmin, async (request, response) => {
        try {
            response.json({ uploads: await uploadExamResults(database.connection, database.path, String(request.body.exam_id ?? '')) });
        } catch (error) { response.status(409).json({ message: error instanceof Error ? error.message : 'Unable to upload results.' }); }
    });

    app.post('/api/readiness/drills/:drillId/attempts/prepare', authenticateReadinessClient, (request, response) => {
        try {
            const clientId = getReadinessClientForRequest(request, readinessSessions, readinessClientSockets);
            response.status(201).json({ attempt: prepareReadinessAttempt(database.connection, String(request.params.drillId), clientId) });
        } catch (error) { handleReadinessError(response, error, 'Unable to prepare readiness attempt.'); }
    });

    app.get('/api/readiness/drills/:drillId/attempts/:attemptId', authenticateReadinessClient, (request, response) => {
        try { response.json({ attempt: getReadinessAttempt(database.connection, String(request.params.drillId), String(request.params.attemptId)) }); }
        catch (error) { handleReadinessError(response, error, 'Unable to load readiness attempt.'); }
    });

    app.post('/api/readiness/drills/:drillId/attempts/:attemptId/answers', authenticateReadinessClient, (request, response) => {
        try {
            const result = acknowledgeReadinessAnswer(database.connection, {
                drill_id: String(request.params.drillId),
                attempt_id: String(request.params.attemptId),
                client_key: getReadinessClientForRequest(request, readinessSessions, readinessClientSockets),
                question_id: String(request.body.question_id ?? ''),
                question_order: Number(request.body.question_order ?? 0),
                option_label: String(request.body.option_label ?? ''),
                sequence_number: Number(request.body.sequence_number ?? 0),
                client_sent_at: typeof request.body.client_sent_at === 'string' ? request.body.client_sent_at : undefined,
            });
            response.json(result);
        } catch (error) { handleReadinessError(response, error, 'Unable to acknowledge readiness answer.'); }
    });

    app.post('/api/readiness/drills/:drillId/attempts/:attemptId/submit', authenticateReadinessClient, (request, response) => {
        try { response.json({ attempt: submitReadinessAttempt(database.connection, String(request.params.drillId), String(request.params.attemptId), getReadinessClientForRequest(request, readinessSessions, readinessClientSockets)) }); }
        catch (error) { handleReadinessError(response, error, 'Unable to submit readiness attempt.'); }
    });
    app.get('/api/health', async (_request, response) => {
        await resolveActivationStatus();
        response.json(statusService.getStatus());
    });

    app.get('/api/server-info', (_request, response) => {
        response.json(statusService.getServerInfo());
    });

    app.get('/api/readiness/drills', authenticateReadinessAdmin, (_request, response) => {
        response.json({ drills: listReadinessDrills(database.connection) });
    });

    app.get('/api/readiness/drills/:drillId/monitor', authenticateReadinessAdmin, (request, response) => {
        try {
            const drillId = String(request.params.drillId);
            const connectedClientKeys = new Set([...readinessClientSockets.values()]
                .filter((client) => client.drill_id === drillId)
                .map((client) => `${client.drill_id}:${client.client_id}`));
            response.json({ ...getReadinessMonitor(database.connection, drillId, connectedClientKeys), metrics: getReadinessMetrics(database.connection, drillId, database.path) });
        }
        catch (error) { handleReadinessError(response, error, 'Unable to load readiness monitor.'); }
    });

    app.get('/api/readiness/drills/:drillId/attempts/:attemptId/visualization', authenticateReadinessAdmin, (request, response) => {
        try { response.json(getReadinessVisualization(database.connection, String(request.params.drillId), String(request.params.attemptId))); }
        catch (error) { handleReadinessError(response, error, 'Unable to load readiness visualization.'); }
    });

    app.get('/api/readiness/available', (_request, response) => {
        const drill = database.connection.prepare(`
            SELECT id, name, status, package_code, package_version, capacity_profile,
                     backup_percent, autoboot_target_clients, duration_seconds, expected_clients, total_questions
            FROM readiness_drills
            WHERE status IN ('preflight', 'ready', 'running')
            ORDER BY created_at DESC
            LIMIT 1
        `).get() as Record<string, unknown> | undefined;
        response.json({ drill: drill ?? null, mode: 'readiness_drill' });
    });

    app.get('/api/readiness/packages', authenticateReadinessAdmin, (_request, response) => {
        response.json({ packages: listReadinessPackages(database.connection) });
    });

    app.get('/api/readiness/drills/:drillId/devices', authenticateReadinessAdmin, (request, response) => {
        try { response.json({ devices: listReadinessDeviceEnrollments(database.connection, String(request.params.drillId)) }); }
        catch (error) { handleReadinessError(response, error, 'Unable to list enrolled readiness devices.'); }
    });

    app.post('/api/readiness/drills/:drillId/devices', authenticateReadinessAdmin, (request, response) => {
        try {
            response.status(201).json({ device: enrollReadinessDevice(database.connection, String(request.params.drillId), {
                device_fingerprint: String(request.body.device_fingerprint ?? ''),
                device_label: typeof request.body.device_label === 'string' ? request.body.device_label : undefined,
            }) });
        } catch (error) { handleReadinessError(response, error, 'Unable to enroll readiness device.'); }
    });

    app.post('/api/readiness/packages/import', authenticateReadinessAdmin, async (request, response) => {
        try {
            response.status(201).json({ package: await importReadinessPackage(database.connection, database.path, String(request.body.code ?? ''), String(request.body.admin_password ?? '')) });
        } catch (error) {
            if (error instanceof ReadinessDrillError) { response.status(error.statusCode).json({ message: error.message }); return; }
            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to import readiness package.' });
        }
    });

    app.post('/api/readiness/drills', authenticateReadinessAdmin, (request, response) => {
        try {
            response.status(201).json({ drill: createReadinessDrill(database.connection, {
                name: String(request.body.name ?? ''),
                expected_clients: Number(request.body.expected_clients ?? 0),
                duration_seconds: Number(request.body.duration_seconds ?? 0),
                package_code: String(request.body.package_code ?? ''),
                mode: String(request.body.mode ?? 'synthetic_full'),
            }) });
        } catch (error) {
            if (error instanceof ReadinessDrillError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }
            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to create readiness drill.' });
        }
    });

    app.delete('/api/readiness/drills/:drillId', authenticateReadinessAdmin, (request, response) => {
        try {
            deleteReadinessDrill(database.connection, String(request.params.drillId));
            response.status(204).end();
        } catch (error) {
            if (error instanceof ReadinessDrillError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }
            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to delete readiness drill.' });
        }
    });

    app.post('/api/readiness/drills/:drillId/preflight', authenticateReadinessClient, (request, response) => {
        try {
            const drillId = String(request.params.drillId);
            const clientKey = getReadinessClientForRequest(request, readinessSessions, readinessClientSockets);
            const result = updateReadinessPreflight(database.connection, drillId, clientKey, {
                status: typeof request.body.status === 'string' && (request.body.status === 'ready' || request.body.status === 'failed') ? request.body.status : 'failed',
                network_latency_ms: Number(request.body.network_latency_ms ?? 0),
                network_jitter_ms: Number(request.body.network_jitter_ms ?? 0),
                packet_loss_percent: Number(request.body.packet_loss_percent ?? 0),
                network_download_mbps: Number(request.body.network_download_mbps ?? 0),
                network_upload_mbps: Number(request.body.network_upload_mbps ?? 0),
                machine_memory_bytes: Number(request.body.machine_memory_bytes ?? 0),
                machine_cpu_percent: Number(request.body.machine_cpu_percent ?? 0),
                disk_free_gb: Number(request.body.disk_free_gb ?? 0),
                time_offset_ms: Number(request.body.time_offset_ms ?? 0),
                notes: typeof request.body.notes === 'string' ? request.body.notes : undefined,
            });
            response.json({ preflight: result });
        } catch (error) {
            if (error instanceof ReadinessDrillError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }
            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to record readiness preflight.' });
        }
    });

    app.post('/api/readiness/drills/:drillId/start', authenticateReadinessAdmin, (request, response) => {
        try {
            const drillId = String(request.params.drillId);
            const connectedClientKeys = new Set([...readinessClientSockets.values()]
                .filter((client) => client.drill_id === drillId)
                .map((client) => client.client_id));
            const readiness = getReadinessStartReadiness(database.connection, drillId, connectedClientKeys);
            const drill = startReadinessDrill(database.connection, drillId, readiness.connectedClients, readiness.preparedClientKeys.size);
            const started = broadcastReadinessStart(database.connection, drill.id);
            for (const [socketId, client] of readinessClientSockets.entries()) {
                if (client.drill_id === started.id) {
                    socketServer.to(socketId).emit('readiness_drill_started', { drill_id: started.id, started_at: started.started_at, duration_seconds: started.duration_seconds });
                }
            }
            response.json({ drill });
        } catch (error) {
            if (error instanceof ReadinessDrillError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }
            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to start readiness drill.' });
        }
    });

    app.get('/api/readiness/drills/:drillId/clients', authenticateReadinessAdmin, (request, response) => {
        const drillId = String(request.params.drillId);
        const connectedClientKeys = new Set([...readinessClientSockets.values()]
            .filter((client) => client.drill_id === drillId)
            .map((client) => client.client_id));
        const readiness = getReadinessStartReadiness(database.connection, drillId, connectedClientKeys);
        const clients = [...readinessClientSockets.values()]
            .filter((client) => client.drill_id === drillId)
            .map(({ client_id, connected_at, last_heartbeat_at, user_agent }) => {
                const clientRecord = database.connection.prepare(`SELECT client_key, preflight_status, network_latency_ms, network_jitter_ms, packet_loss_percent, network_download_mbps, network_upload_mbps, machine_memory_bytes, machine_cpu_percent, disk_free_gb, time_offset_ms FROM readiness_clients WHERE drill_id = ? AND client_key = ? LIMIT 1`).get(drillId, client_id) as { client_key: string; preflight_status?: string; network_latency_ms?: number; network_jitter_ms?: number; packet_loss_percent?: number; network_download_mbps?: number; network_upload_mbps?: number; machine_memory_bytes?: number; machine_cpu_percent?: number; disk_free_gb?: number; time_offset_ms?: number } | undefined;
                return {
                    client_id,
                    connected_at,
                    last_heartbeat_at,
                    user_agent,
                    paper_ready: readiness.preparedClientKeys.has(client_id),
                    preflight_status: clientRecord?.preflight_status ?? 'pending',
                    network_latency_ms: Number(clientRecord?.network_latency_ms ?? 0),
                    network_jitter_ms: Number(clientRecord?.network_jitter_ms ?? 0),
                    packet_loss_percent: Number(clientRecord?.packet_loss_percent ?? 0),
                    network_download_mbps: Number(clientRecord?.network_download_mbps ?? 0),
                    network_upload_mbps: Number(clientRecord?.network_upload_mbps ?? 0),
                    machine_memory_bytes: Number(clientRecord?.machine_memory_bytes ?? 0),
                    machine_cpu_percent: Number(clientRecord?.machine_cpu_percent ?? 0),
                    disk_free_gb: Number(clientRecord?.disk_free_gb ?? 0),
                    time_offset_ms: Number(clientRecord?.time_offset_ms ?? 0),
                };
            });
        response.json({ clients, count: clients.length, prepared_count: readiness.preparedClientKeys.size });
    });

    app.get('/api/readiness/drills/:drillId/manifest', authenticateReadinessClient, (request, response) => {
        try {
            response.json({ manifest: readinessManifest(database.connection, String(request.params.drillId)) });
        } catch (error) {
            if (error instanceof ReadinessDrillError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }
            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to load readiness manifest.' });
        }
    });

    app.post('/api/readiness/drills/:drillId/events', authenticateReadinessClient, (request, response) => {
        try {
            recordReadinessEvent(database.connection, {
                drill_id: String(request.params.drillId),
                client_id: typeof request.body.client_id === 'string' ? request.body.client_id : undefined,
                event_type: String(request.body.event_type ?? ''),
                severity: typeof request.body.severity === 'string' ? request.body.severity : undefined,
                message: String(request.body.message ?? ''),
                metadata: typeof request.body.metadata === 'object' && request.body.metadata !== null ? request.body.metadata : undefined,
            });
            response.status(201).json({ success: true });
        } catch (error) {
            if (error instanceof ReadinessDrillError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }
            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to record readiness event.' });
        }
    });

    app.post('/api/readiness/drills/:drillId/finalize', authenticateReadinessAdmin, (request, response) => {
        try {
            response.json({ report: finalizeReadinessReport(database.connection, String(request.params.drillId)) });
        } catch (error) {
            if (error instanceof ReadinessDrillError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }
            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to finalize readiness report.' });
        }
    });

    app.get('/api/readiness/drills/:drillId/report', authenticateReadinessAdmin, (request, response) => {
        try {
            response.json({ report: getReadinessReport(database.connection, String(request.params.drillId)) });
        } catch (error) {
            if (error instanceof ReadinessDrillError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }
            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to load readiness report.' });
        }
    });

    app.get('/api/readiness/drills/:drillId/report/download', authenticateReadinessAdmin, (request, response) => {
        try {
            const drillId = String(request.params.drillId);
            const report = getReadinessReport(database.connection, drillId);
            const hash = createHash('sha256').update(JSON.stringify(report.payload)).digest('hex');
            if (hash !== report.payload_hash) {
                throw new ReadinessDrillError('The stored readiness report checksum is invalid.', 409);
            }
            const preview = getReadinessReportPreview(database.connection, drillId);
            const metrics = getReadinessMetrics(database.connection, drillId, database.path);
            const config = getLocalSyncConfig(database.connection, database.path);
            const journalMode = database.connection.pragma('journal_mode', { simple: true });
            const integrityCheck = database.connection.pragma('integrity_check', { simple: true });
            const clients = Array.isArray(preview.clients) ? preview.clients : [];
            const events = Array.isArray(preview.events) ? preview.events : [];

            response
                .type('application/zip')
                .attachment(`alignex-readiness-evidence-${report.drill_id}.zip`);
            const archive = new ZipArchive({ zlib: { level: 9 } });
            archive.on('error', (error: ArchiverError) => response.destroy(error));
            archive.pipe(response);
            archive.append(JSON.stringify({
                evidence_bundle_version: 'alignex.center-server-readiness-evidence.v2',
                exported_at: new Date().toISOString(),
                drill_id: report.drill_id,
                report_payload_sha256: report.payload_hash,
                files: [
                    'readiness-report.json',
                    'readiness-report-preview.json',
                    'readiness-clients.csv',
                    'readiness-events.csv',
                    'server-diagnostics.json',
                    'server-config.redacted.json',
                ],
            }, null, 2), { name: 'manifest.json' });
            archive.append(JSON.stringify(report, null, 2), { name: 'readiness-report.json' });
            archive.append(JSON.stringify(preview, null, 2), { name: 'readiness-report-preview.json' });
            archive.append(csvFromRecords(clients), { name: 'readiness-clients.csv' });
            archive.append(csvFromRecords(events), { name: 'readiness-events.csv' });
            archive.append(JSON.stringify({
                captured_at: new Date().toISOString(),
                metrics,
                sqlite: { journal_mode: journalMode, integrity_check: integrityCheck },
            }, null, 2), { name: 'server-diagnostics.json' });
            archive.append(JSON.stringify({
                portal_url: config.portal_url,
                center_id: config.center_id,
                device_id_sha256: config.device_id ? createHash('sha256').update(config.device_id).digest('hex') : null,
                activation_token_present: Boolean(config.sync_token),
                admin_email_present: Boolean(config.admin_email),
                activation_token: '[redacted]',
                admin_email: '[redacted]',
            }, null, 2), { name: 'server-config.redacted.json' });
            void archive.finalize();
        } catch (error) {
            if (error instanceof ReadinessDrillError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }
            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to download readiness evidence.' });
        }
    });

    app.get('/api/readiness/drills/:drillId/report/preview', authenticateReadinessAdmin, (request, response) => {
        try { response.json(getReadinessReportPreview(database.connection, String(request.params.drillId))); }
        catch (error) { handleReadinessError(response, error, 'Unable to load readiness report preview.'); }
    });

    app.post('/api/readiness/drills/:drillId/report/upload', authenticateReadinessAdmin, async (request, response) => {
        try {
            response.json(await uploadReadinessReport(database.connection, database.path, String(request.params.drillId)));
        } catch (error) {
            if (error instanceof ReadinessDrillError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }
            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to upload readiness report.' });
        }
    });

    app.get('/api/updates/check', async (_request, response) => {
        try {
            response.json(await checkForUpdates(database.connection, database.path));
        } catch (error) {
            if (error instanceof UpdateError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to check updates.' });
        }
    });

    app.post('/api/updates/download', async (request, response) => {
        const artifact = String(request.body.artifact ?? '') as UpdateArtifact;

        if (artifact !== 'server' && artifact !== 'client_app') {
            response.status(422).json({ message: 'Update artifact must be server or client_app.' });
            return;
        }

        try {
            response.json(await downloadUpdate(database.connection, database.path, artifact));
        } catch (error) {
            if (error instanceof UpdateError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to download update.' });
        }
    });

    async function resolveActivationStatus() {
        const status = getActivationStatus(database.connection, database.path);
        if (kernelBridgeLicense) {
            try {
                if (await kernelBridgeLicense.hasInstallation()) {
                    if (!pendingLicenseVerification) {
                        pendingLicenseVerification = kernelBridgeLicense.verify().finally(() => { pendingLicenseVerification = null; });
                    }
                    const license = await pendingLicenseVerification;
                    const projection = verifiedLicenseProjection(license);
                    status.plan = projection.plan ?? status.plan;
                    status.plan_features = projection.features;
                    status.entitlements = projection.entitlements;
                    statusService.setLicenseProjection(projection);
                    status.expires_at = license.expiresAt;
                    if (['active', 'trial', 'grace'].includes(license.status)) {
                        status.state = 'activated';
                        status.configured = true;
                        status.message = `KernelBridge license is ${license.status}.`;
                        status.days_remaining = license.expiresAt
                            ? Math.max(0, Math.ceil((Date.parse(license.expiresAt) - Date.now()) / 86_400_000))
                            : null;
                    } else {
                        status.state = license.status === 'expired' ? 'expired' : 'revoked';
                        status.message = `KernelBridge license is ${license.status}.`;
                    }
                } else if (options.requireKernelBridgeLicense) {
                    status.state = 'not_configured';
                    status.message = 'KernelBridge installation activation is required.';
                    status.plan_features = allPlanFeatures(false);
                    statusService.setLicenseProjection(null, true);
                } else {
                    statusService.setLicenseProjection(null);
                }
            } catch (error) {
                status.state = 'invalid';
                status.message = error instanceof Error ? error.message : 'KernelBridge license verification failed.';
                status.plan_features = allPlanFeatures(false);
                status.entitlements = null;
                statusService.setLicenseProjection(null, true);
            }
        } else if (options.requireKernelBridgeLicense) {
            status.state = 'invalid';
            status.message = 'KernelBridge licensing is not configured for this server.';
            status.plan_features = allPlanFeatures(false);
            statusService.setLicenseProjection(null, true);
        }

        return status;
    }

    app.get('/api/app/state', async (_request, response) => {
        response.json({ status: await resolveActivationStatus() });
    });

    app.post('/api/app/activate-online', async (request, response) => {
        try {
            if (!kernelBridgeLicense) {
                throw new ActivationError('KernelBridge licensing is not configured for this server.', 503);
            }
            const installationUuid = await kernelBridgeLicense.installationUuid();
            const status = await activateOnline(database.connection, database.path, {
                portal_url: String(request.body.portal_url ?? ''),
                activation_code: String(request.body.activation_code ?? ''),
                admin_email: String(request.body.admin_email ?? ''),
                admin_password: String(request.body.admin_password ?? ''),
                center_name: String(request.body.center_name ?? ''),
                organization_name: String(request.body.organization_name ?? ''),
                installation_uuid: installationUuid,
            }, kernelBridgeLicense, options.requireKernelBridgeLicense === true);

            response.json({ success: true, status });
        } catch (error) {
            if (error instanceof ActivationError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Activation failed.' });
        }
    });

    app.post('/api/app/activate', async (request, response) => {
        try {
            if (!kernelBridgeLicense) {
                throw new ActivationError('KernelBridge licensing is not configured for this server.', 503);
            }
            const installationUuid = await kernelBridgeLicense.installationUuid();
            const status = await activateOnline(database.connection, database.path, {
                portal_url: String(request.body.portal_url ?? ''),
                activation_code: String(request.body.activation_code ?? ''),
                admin_email: String(request.body.admin_email ?? ''),
                admin_password: String(request.body.admin_password ?? ''),
                center_name: String(request.body.center_name ?? ''),
                installation_uuid: installationUuid,
            }, kernelBridgeLicense, options.requireKernelBridgeLicense === true);

            response.json({ success: true, status });
        } catch (error) {
            if (error instanceof ActivationError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Activation failed.' });
        }
    });

    app.post('/api/app/activate-offline', (request, response) => {
        try {
            if (options.requireKernelBridgeLicense) {
                throw new ActivationError('Offline file activation is not available for KernelBridge-linked installations.', 403);
            }

            const status = activateOffline(database.connection, database.path, {
                signed_config: String(request.body.signed_config ?? ''),
                admin_name: String(request.body.admin_name ?? ''),
                admin_email: String(request.body.admin_email ?? ''),
                admin_password: String(request.body.admin_password ?? ''),
            });

            response.json({ success: true, status });
        } catch (error) {
            if (error instanceof SyntaxError) {
                response.status(422).json({ message: 'Signed config file must be valid JSON.' });
                return;
            }

            if (error instanceof ActivationError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Offline activation failed.' });
        }
    });

    app.post('/api/app/login', (request, response) => {
        try {
            const email = String(request.body.email ?? '');
            const password = String(request.body.password ?? '');
            const result = loginLocalAdmin(database.connection, email, password);
            const sessionToken = randomUUID();
            localAdminSessions.set(sessionToken, { email: result.admin.email, expires_at: Date.now() + 8 * 60 * 60 * 1000 });
            response.json({ ...result, session_token: sessionToken });
        } catch (error) {
            if (error instanceof ActivationError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Login failed.' });
        }
    });

    app.post('/api/app/deactivate', async (request, response) => {
        try {
            const status = await deactivateLocal(
                database.connection,
                database.path,
                String(request.body.password ?? ''),
                kernelBridgeLicense
                    ? async () => {
                        if (await kernelBridgeLicense.hasInstallation()) {
                            await kernelBridgeLicense.deactivate();
                        }
                    }
                    : undefined,
            );
            response.json({ success: true, status });
        } catch (error) {
            if (error instanceof ActivationError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Deactivation failed.' });
        }
    });

    app.use(['/api/exams', '/api/monitor', '/api/results', '/api/candidate'], async (_request, response, next) => {
        const activation = getActivationStatus(database.connection, database.path);

        const kernelBridgeControlsActivation = options.requireKernelBridgeLicense === true
            && kernelBridgeLicense !== undefined
            && activation.state === 'expired';
        if (activation.state !== 'activated' && !kernelBridgeControlsActivation) {
            response.status(423).json({ message: activation.message, state: activation.state });
            return;
        }
        try {
            await assertServerFeature(
                database.connection,
                'offline_delivery',
                kernelBridgeLicense,
                options.requireKernelBridgeLicense === true,
            );
        } catch (error) {
            if (error instanceof PlanFeatureError) {
                response.status(error.statusCode).json({ message: error.message, feature: error.feature });
                return;
            }

            response.status(503).json({
                message: error instanceof Error ? error.message : 'KernelBridge license verification failed.',
                feature: 'offline_delivery',
            });
            return;
        }

        next();
    });

    app.get('/api/exams', (_request, response) => {
        response.json({ exams: listExamSummaries(database.connection) });
    });

    app.get('/api/exams/:examId', (request, response) => {
        const exam = getExamSummary(database.connection, request.params.examId);

        if (!exam) {
            response.status(404).json({ message: 'Exam not found.' });
            return;
        }

        response.json({ exam });
    });

    app.get('/api/exams/:examId/candidates', (request, response) => {
        const exam = getExamSummary(database.connection, request.params.examId);

        if (!exam) {
            response.status(404).json({ message: 'Exam not found.' });
            return;
        }

        response.json({ candidates: listExamCandidates(database.connection, request.params.examId) });
    });

    app.get('/api/exams/:examId/paper-verification', (request, response) => {
        const exam = getExamSummary(database.connection, request.params.examId);

        if (!exam) {
            response.status(404).json({ message: 'Exam not found.' });
            return;
        }

        response.json({ verification: verifyExamPapers(database.connection, request.params.examId) });
    });

    app.get('/api/monitor/exams/:examId', (request, response) => {
        const connectedCandidates = getConnectedCandidateSnapshot(connectedCandidateSockets);

        response.json({
            summary: getMonitorSummary(database.connection, request.params.examId, new Set(connectedCandidates.keys())),
        });
    });

    app.get('/api/monitor/exams/:examId/candidates', (request, response) => {
        response.json({
            candidates: listMonitorCandidates(database.connection, request.params.examId, getConnectedCandidateSnapshot(connectedCandidateSockets)),
        });
    });

    app.post('/api/monitor/exams/:examId/candidates/:candidateId/reset-device', (request, response) => {
        const candidate = resetCandidateDevice(database.connection, request.params.examId, request.params.candidateId);

        if (!candidate) {
            response.status(404).json({ message: 'Active candidate attempt was not found.' });
            return;
        }

        socketServer.emit('candidate_device_reset', candidate);
        response.json({ success: true, candidate });
    });

    app.post('/api/exams/:examId/start', (request, response) => {
        try {
            const exam = startExam(database.connection, request.params.examId);
            socketServer.emit('exam_started', { exam });
            socketServer.emit('server:status', statusService.getStatus());
            response.json({ exam });
        } catch (error) {
            if (error instanceof ExamControlError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to start exam.' });
        }
    });

    app.post('/api/exams/:examId/close', (request, response) => {
        try {
            const result = closeExam(database.connection, request.params.examId);
            emitExamClosed(socketServer, statusService, result);
            response.json({
                exam: result.exam,
                auto_submitted_count: result.auto_submitted_attempts.length,
            });
        } catch (error) {
            if (error instanceof ExamControlError || error instanceof CandidateSubmitError) {
                response.status(error.statusCode).json({ message: error.message, code: error instanceof CandidateSubmitError ? error.code : undefined });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to close exam.' });
        }
    });

    app.post('/api/exams/import-code', async (request, response) => {
        try {
            await assertServerFeature(database.connection, 'exam_package_import', kernelBridgeLicense, options.requireKernelBridgeLicense === true);
            const runtimeConfig = getLocalSyncConfig(database.connection, database.path);
            const summary = await importExamPackageByCode(database.connection, String(request.body.import_code ?? ''), String(request.body.exam_code ?? ''), {
                centerId: runtimeConfig.center_id ?? options.centerId ?? null,
                deviceId: runtimeConfig.device_id ?? null,
                syncBaseUrl: runtimeConfig.portal_url ?? options.syncBaseUrl ?? null,
                syncToken: runtimeConfig.sync_token ?? options.syncToken ?? null,
                syncAdminEmail: runtimeConfig.admin_email ?? options.syncAdminEmail ?? null,
                syncAdminPassword: (String(request.body.admin_password ?? '').trim() || options.syncAdminPassword) ?? null,
            });

            socketServer.emit('server:status', statusService.getStatus());
            response.status(201).json({ summary });
        } catch (error) {
            if (error instanceof PlanFeatureError) {
                response.status(error.statusCode).json({ message: error.message, feature: error.feature });
                return;
            }

            if (error instanceof ImportCodeError) {
                response.status(error.statusCode).json({ message: error.message, code: error.code, errors: [error.message] });
                return;
            }

            if (error instanceof PackageValidationError) {
                response.status(422).json({ message: error.message, errors: error.errors });
                return;
            }

            if (error instanceof DuplicatePackageError) {
                response.status(409).json({ message: error.message, errors: [error.message] });
                return;
            }

            response.status(500).json({
                message: 'Exam package import failed.',
                errors: [error instanceof Error ? error.message : 'Unknown import error.'],
            });
        }
    });

    app.post('/api/results/export', async (request, response) => {
        try {
            await assertServerFeature(database.connection, 'result_package_export', kernelBridgeLicense, options.requireKernelBridgeLicense === true);
            const summary = exportExamResults(database.connection, String(request.body.exam_id ?? ''), {
                fallbackStoragePath: database.path,
                rootPath: options.resultExportRootPath,
            });
            socketServer.emit('server:status', statusService.getStatus());
            response.json({ success: true, summary });
        } catch (error) {
            if (error instanceof PlanFeatureError) {
                response.status(error.statusCode).json({ message: error.message, feature: error.feature });
                return;
            }

            if (error instanceof ResultExportError) {
                response.status(error.statusCode).json({ message: error.message, code: error.code });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to export results.' });
        }
    });

    app.post('/api/candidate/login', (request, response) => {
        try {
            const result = loginCandidate(database.connection, {
                exam_code: request.body.exam_code ? String(request.body.exam_code) : undefined,
                registration_number: String(request.body.registration_number ?? ''),
                device_fingerprint: String(request.body.device_fingerprint ?? ''),
                ip_address: getRequestIpAddress(request),
            });

            socketServer.emit('candidate_logged_in', {
                exam_id: result.exam.id,
                candidate_id: result.candidate.id,
                candidate: result.candidate,
                exam: result.exam,
            });
            socketServer.emit('server:status', statusService.getStatus());
            response.json(result);
        } catch (error) {
            if (error instanceof CandidateLoginError) {
                response.status(error.statusCode).json({ message: error.message, code: error.code });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Candidate login failed.' });
        }
    });

    app.get('/api/candidate/exam', (request, response) => {
        try {
            const attemptToken = getAttemptTokenFromHeader(request.headers.authorization);
            response.json(getCandidateExam(database.connection, attemptToken));
        } catch (error) {
            if (error instanceof CandidateExamError) {
                response.status(error.statusCode).json({ message: error.message, code: error.code });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to load candidate exam.' });
        }
    });

    app.post('/api/candidate/answer', (request, response) => {
        try {
            const attemptToken = getAttemptTokenFromHeader(request.headers.authorization);
            const result = saveCandidateAnswer(database.connection, {
                attemptToken,
                question_id: String(request.body.question_id ?? ''),
                selected_option_id: String(request.body.selected_option_id ?? ''),
                time_spent_seconds: Number(request.body.time_spent_seconds ?? 0),
            });

            socketServer.emit('candidate_progress_updated', {
                exam_id: result.exam_id,
                candidate_id: result.candidate_id,
                answered_count: result.answered_count,
                total_questions: result.total_questions,
                unanswered_count: Math.max(result.total_questions - result.answered_count, 0),
                progress_percentage: result.total_questions > 0 ? Math.round((result.answered_count / result.total_questions) * 100) : 0,
                saved_at: result.saved_at,
            });
            response.json({
                success: result.success,
                answered_count: result.answered_count,
                total_questions: result.total_questions,
                saved_at: result.saved_at,
            });
        } catch (error) {
            if (error instanceof CandidateAnswerError || error instanceof CandidateExamError) {
                response.status(error.statusCode).json({ message: error.message, code: error.code });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to save answer.' });
        }
    });

    app.post('/api/candidate/auto-submit', (request, response) => {
        try {
            const attemptToken = getAttemptTokenFromHeader(request.headers.authorization);
            const result = autoSubmitCandidateAttempt(database.connection, attemptToken);

            socketServer.emit('candidate_submitted', {
                exam_id: result.exam_id,
                candidate_id: result.candidate_id,
                attempt_id: result.attempt_id,
                status: result.status,
                answered_count: result.answered_count,
                total_questions: result.total_questions,
                submitted_at: result.submitted_at,
            });
            socketServer.emit('server:status', statusService.getStatus());
            response.json({
                success: result.success,
                status: result.status,
                answered_count: result.answered_count,
                total_questions: result.total_questions,
                score: result.score,
                total_marks: result.total_marks,
                submitted_at: result.submitted_at,
            });
        } catch (error) {
            if (error instanceof CandidateSubmitError || error instanceof CandidateExamError) {
                response.status(error.statusCode).json({ message: error.message, code: error.code });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to auto-submit exam.' });
        }
    });

    app.post('/api/candidate/submit', (request, response) => {
        try {
            const attemptToken = getAttemptTokenFromHeader(request.headers.authorization);
            const result = submitCandidateAttempt(database.connection, attemptToken);

            socketServer.emit('candidate_submitted', {
                exam_id: result.exam_id,
                candidate_id: result.candidate_id,
                attempt_id: result.attempt_id,
                status: result.status,
                answered_count: result.answered_count,
                total_questions: result.total_questions,
                submitted_at: result.submitted_at,
            });
            socketServer.emit('server:status', statusService.getStatus());
            response.json({
                success: result.success,
                status: result.status,
                answered_count: result.answered_count,
                total_questions: result.total_questions,
                score: result.score,
                total_marks: result.total_marks,
                submitted_at: result.submitted_at,
            });
        } catch (error) {
            if (error instanceof CandidateSubmitError || error instanceof CandidateExamError) {
                response.status(error.statusCode).json({ message: error.message, code: error.code });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Unable to submit exam.' });
        }
    });

    app.use(express.static(rendererDistPath, { index: false }));

    app.get('/', (_request, response) => {
        response.sendFile(join(rendererDistPath, 'candidate.html'));
    });

    const autoCloseTimer = setInterval(() => {
        pilot.expire();
        closeDueActiveExams(database.connection, socketServer, statusService, autoClosingExamIds);
        closeDueReadinessDrills(database.connection, socketServer);
        markStaleReadinessClients(database.connection, socketServer, readinessClientSockets);
    }, 1000);

    socketServer.on('connection', (socket) => {
        const registerClientSocket = () => {
            if (!connectedClientSockets.has(socket.id)) {
                connectedClientSockets.set(socket.id, {
                    connected_at: new Date().toISOString(),
                    user_agent: typeof socket.handshake.headers['user-agent'] === 'string' ? socket.handshake.headers['user-agent'] : null,
                });
            }

            socketServer.emit('server:status', statusService.getStatus());
        };

        const registerReadinessClient = (payload?: { device_fingerprint?: unknown; drill_id?: unknown; mode?: unknown }) => {
            if (payload?.mode !== 'readiness_drill' || typeof payload.device_fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(payload.device_fingerprint) || typeof payload.drill_id !== 'string' || payload.drill_id.trim().length === 0) {
                socket.emit('readiness_registration_rejected', { message: 'A valid enrolled device fingerprint and drill are required.' });
                return;
            }

            const now = new Date().toISOString();
            const drillId = payload.drill_id.trim();
            const deviceFingerprint = payload.device_fingerprint.toLowerCase();
            const drill = getReadinessDrill(database.connection, drillId);
            if (drill.status !== 'preflight' && drill.status !== 'ready' && drill.status !== 'running') {
                socket.emit('readiness_registration_rejected', { message: 'This readiness drill is not accepting candidate devices.' });
                return;
            }
            if (!isReadinessDeviceEnrolled(database.connection, drillId, deviceFingerprint)) {
                const enrolledCount = database.connection
                    .prepare("SELECT COUNT(*) AS count FROM readiness_device_enrollments WHERE drill_id = ? AND status = 'enrolled'")
                    .get(drillId) as { count: number };
                if (Number(enrolledCount.count) >= drill.expected_clients) {
                    socket.emit('readiness_registration_rejected', { message: `This readiness drill already has its ${drill.expected_clients} enrolled devices.` });
                    return;
                }
                enrollReadinessDevice(database.connection, drillId, {
                    device_fingerprint: deviceFingerprint,
                    device_label: `Autoboot client ${Number(enrolledCount.count) + 1}`,
                });
            }
            for (const [socketId, existing] of readinessClientSockets.entries()) {
                if (socketId !== socket.id && existing.drill_id === drillId && existing.device_fingerprint === deviceFingerprint) {
                    readinessSessions.delete(existing.session_token);
                    readinessClientSockets.delete(socketId);
                    socketServer.to(socketId).emit('readiness_registration_rejected', { message: 'This device reconnected from another session.' });
                }
            }
            const sessionToken = randomUUID();
            readinessClientSockets.set(socket.id, {
                client_id: deviceFingerprint,
                device_fingerprint: deviceFingerprint,
                drill_id: drillId,
                connected_at: readinessClientSockets.get(socket.id)?.connected_at ?? now,
                last_heartbeat_at: now,
                user_agent: typeof socket.handshake.headers['user-agent'] === 'string' ? socket.handshake.headers['user-agent'] : null,
                session_token: sessionToken,
            });
            const ipAddress = requestAddress(socket.handshake.address);
            const userAgent = typeof socket.handshake.headers['user-agent'] === 'string' ? socket.handshake.headers['user-agent'] : null;
            database.connection.prepare(`INSERT INTO readiness_clients (id, drill_id, client_key, device_fingerprint, ip_address, user_agent, status, preflight_status, connected_at, last_heartbeat_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'autoboot_enabled', 'pending', ?, ?, ?)
                ON CONFLICT(drill_id, client_key) DO UPDATE SET device_fingerprint = excluded.device_fingerprint, ip_address = excluded.ip_address, user_agent = excluded.user_agent, status = 'autoboot_enabled', preflight_status = COALESCE(readiness_clients.preflight_status, 'pending'), last_heartbeat_at = excluded.last_heartbeat_at, updated_at = excluded.updated_at, reconnect_count = readiness_clients.reconnect_count + 1`).run(randomUUID(), drillId, deviceFingerprint, deviceFingerprint, ipAddress, userAgent, now, now, now);
            readinessSessions.set(sessionToken, { socket_id: socket.id, drill_id: drillId, device_fingerprint: deviceFingerprint, expires_at: Date.now() + 15 * 60 * 1000 });
            socket.emit('readiness_client_registered', { client_id: deviceFingerprint, drill_id: drillId, mode: 'readiness_drill', session_token: sessionToken, preflight_status: 'pending' });
            socketServer.emit('readiness_client_count', { drill_id: drill.id, connected: [...readinessClientSockets.values()].filter((client) => client.drill_id === drill.id).length, expected: drill.expected_clients });
        };

        const heartbeatReadinessClient = (payload?: { sent_at?: unknown; memory_rss_bytes?: unknown; memory_private_bytes?: unknown }) => {
            const client = readinessClientSockets.get(socket.id);
            if (client) {
                const now = new Date().toISOString();
                client.last_heartbeat_at = now;
                const rtt = typeof payload?.sent_at === 'string' ? Math.max(0, Date.now() - new Date(payload.sent_at).getTime()) : 0;
                const memoryRssBytes = Math.max(0, Number(payload?.memory_rss_bytes ?? 0));
                const memoryPrivateBytes = Math.max(0, Number(payload?.memory_private_bytes ?? 0));
                database.connection.prepare(`UPDATE readiness_clients SET status = 'autoboot_enabled', last_heartbeat_at = ?, updated_at = ?, last_rtt_ms = ?, average_rtt_ms = CASE WHEN average_rtt_ms = 0 THEN ? ELSE (average_rtt_ms * 0.8) + (? * 0.2) END, memory_rss_bytes = ?, memory_private_bytes = ?, memory_sample_count = memory_sample_count + 1, memory_rss_total_bytes = memory_rss_total_bytes + ?, memory_rss_peak_bytes = MAX(memory_rss_peak_bytes, ?), memory_private_total_bytes = memory_private_total_bytes + ?, memory_private_peak_bytes = MAX(memory_private_peak_bytes, ?) WHERE drill_id = ? AND client_key = ?`).run(now, now, rtt, rtt, rtt, memoryRssBytes, memoryPrivateBytes, memoryRssBytes, memoryRssBytes, memoryPrivateBytes, memoryPrivateBytes, client.drill_id, client.client_id);
            }
        };

        if (socket.handshake.auth?.client_type === 'candidate_client') {
            registerClientSocket();
        }

        socket.emit('server:status', statusService.getStatus());
        socket.broadcast.emit('server:status', statusService.getStatus());

        const registerCandidateSocket = (payload?: { attempt_token?: unknown; candidate_id?: unknown; exam_id?: unknown }) => {
            const identity = getCandidateSocketIdentityFromPayload(database.connection, {
                attempt_token: payload?.attempt_token,
                candidate_id: payload?.candidate_id,
                exam_id: payload?.exam_id,
            });

            if (!identity) {
                return;
            }

            const existingConnection = connectedCandidateSockets.get(socket.id);
            const connectedCandidate: ConnectedCandidateSnapshot = {
                ...identity,
                connected_at: existingConnection?.connected_at ?? new Date().toISOString(),
                socket_id: socket.id,
                user_agent: typeof socket.handshake.headers['user-agent'] === 'string' ? socket.handshake.headers['user-agent'] : null,
            };

            socket.data.candidateIdentity = connectedCandidate;
            connectedCandidateSockets.set(socket.id, connectedCandidate);
            socket.join(`exam:${identity.exam_id}`);

            if (!existingConnection) {
                socketServer.emit('candidate_reconnected', connectedCandidate);
            }

            socketServer.emit('server:status', statusService.getStatus());
        };

        const authAttemptToken = typeof socket.handshake.auth?.attempt_token === 'string'
            ? socket.handshake.auth.attempt_token
            : typeof socket.handshake.auth?.token === 'string'
                ? socket.handshake.auth.token
                : '';

        if (authAttemptToken) {
            registerCandidateSocket({
                attempt_token: authAttemptToken,
                candidate_id: typeof socket.handshake.auth?.candidate_id === 'string' ? socket.handshake.auth.candidate_id : undefined,
                exam_id: typeof socket.handshake.auth?.exam_id === 'string' ? socket.handshake.auth.exam_id : undefined,
            });
        }

        socket.on('candidate:join', registerCandidateSocket);
        socket.on('client_connected', registerClientSocket);
        socket.on('readiness_client_register', registerReadinessClient);
        socket.on('readiness_heartbeat', heartbeatReadinessClient);
        socket.on('candidate_online', registerCandidateSocket);
        socket.on('heartbeat', registerCandidateSocket);

        socket.on('disconnect', () => {
            const identity = socket.data.candidateIdentity as ConnectedCandidateSnapshot | undefined;
            connectedClientSockets.delete(socket.id);
            const readinessClient = readinessClientSockets.get(socket.id);
            if (readinessClient) readinessSessions.delete(readinessClient.session_token);
            readinessClientSockets.delete(socket.id);

            if (readinessClient) {
                database.connection.prepare(`UPDATE readiness_clients SET status = 'disconnected' WHERE drill_id = ? AND client_key = ?`).run(readinessClient.drill_id, readinessClient.client_id);
                try {
                    recordReadinessEvent(database.connection, {
                        drill_id: readinessClient.drill_id,
                        client_id: readinessClient.client_id,
                        event_type: 'client_disconnected',
                        severity: 'warning',
                        message: 'Readiness client socket disconnected.',
                    });
                } catch {}
                try {
                    const drill = getReadinessDrill(database.connection, readinessClient.drill_id);
                    socketServer.emit('readiness_client_count', { drill_id: drill.id, connected: [...readinessClientSockets.values()].filter((client) => client.drill_id === drill.id).length, expected: drill.expected_clients });
                } catch {}
            }

            if (identity) {
                connectedCandidateSockets.delete(socket.id);
                socketServer.emit('candidate_disconnected', identity);
            }

            socketServer.emit('server:status', statusService.getStatus());
        });
    });

    await new Promise<void>((resolve) => {
        httpServer.listen(options.port, '0.0.0.0', resolve);
    });

    return {
        app,
        httpServer,
        socketServer,
        database,
        statusService,
        url: `http://127.0.0.1:${options.port}`,
        stop: () => stopCenterServer(httpServer, socketServer, database, autoCloseTimer),
    };
}

function csvFromRecords(records: unknown[]): string {
    const keys = [...new Set(records.flatMap((record) => record && typeof record === 'object' && !Array.isArray(record) ? Object.keys(record as Record<string, unknown>) : []))];
    const escape = (value: unknown): string => `"${String(value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value).replace(/"/g, '""')}"`;
    return `${keys.map(escape).join(',')}\n${records.map((record) => {
        const row = record && typeof record === 'object' && !Array.isArray(record) ? record as Record<string, unknown> : {};
        return keys.map((key) => escape(row[key])).join(',');
    }).join('\n')}\n`;
}

function getConnectedCandidateSnapshot(connectedCandidateSockets: Map<string, ConnectedCandidateSnapshot>): Map<string, ConnectedCandidateSnapshot> {
    const candidates = new Map<string, ConnectedCandidateSnapshot>();

    for (const candidate of connectedCandidateSockets.values()) {
        const existing = candidates.get(candidate.candidate_id);

        if (!existing || existing.connected_at < candidate.connected_at) {
            candidates.set(candidate.candidate_id, candidate);
        }
    }

    return candidates;
}

function getReadinessClientForRequest(request: express.Request, sessions: Map<string, { socket_id: string; drill_id: string; expires_at: number }>, clients: Map<string, { client_id: string; drill_id: string }>): string {
    const token = String(request.header('X-AlignEx-Readiness-Session') ?? '');
    const session = sessions.get(token);
    const client = session ? clients.get(session.socket_id) : undefined;
    if (!session || !client) throw new ReadinessDrillError('Active readiness client session is required.', 401);
    return client.client_id;
}

function handleReadinessError(response: express.Response, error: unknown, fallback: string): void {
    if (error instanceof ReadinessDrillError) {
        response.status(error.statusCode).json({ message: error.message });
        return;
    }
    response.status(500).json({ message: error instanceof Error ? error.message : fallback });
}

async function assertServerFeature(
    connection: CenterDatabase['connection'],
    feature: PlanFeatureKey,
    kernelBridgeLicense: KernelBridgeLicenseRuntime | undefined,
    requireKernelBridgeLicense: boolean,
): Promise<void> {
    if (!kernelBridgeLicense) {
        if (requireKernelBridgeLicense) {
            throw new PlanFeatureError('KernelBridge licensing is not configured for this server.', feature, 503);
        }

        assertPlanFeature(connection, feature);
        return;
    }

    try {
        if (!requireKernelBridgeLicense && !await kernelBridgeLicense.hasInstallation()) {
            assertPlanFeature(connection, feature);
            return;
        }

        await kernelBridgeLicense.assertFeature(feature);
    } catch (error) {
        if (error instanceof PlanFeatureError) {
            throw error;
        }

        const code = error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : '';
        const statusCode = code === 'feature_unavailable' || code === 'limit_exceeded' ? 403 : 503;
        throw new PlanFeatureError(
            error instanceof Error ? error.message : 'KernelBridge license verification failed.',
            feature,
            statusCode,
        );
    }
}

function requestAddress(address: string | undefined): string | null {
    if (!address) return null;
    return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function markStaleReadinessClients(connection: CenterDatabase['connection'], socketServer: SocketServer, activeSockets: ReadonlyMap<string, { client_id: string; drill_id: string }>): void {
    const cutoff = Date.now() - 15_000;
    const rows = connection.prepare(`SELECT id, drill_id, client_key, last_heartbeat_at FROM readiness_clients
        WHERE status = 'autoboot_enabled'`).all() as Array<{ id: string; drill_id: string; client_key: string; last_heartbeat_at: string }>;
    for (const row of rows) {
        const socketIsLive = [...activeSockets.values()].some((client) => client.drill_id === row.drill_id && client.client_id === row.client_key);
        if (socketIsLive) continue;
        if (new Date(row.last_heartbeat_at).getTime() > cutoff) continue;
        connection.prepare(`UPDATE readiness_clients SET status = 'disconnected', heartbeat_miss_count = heartbeat_miss_count + 1 WHERE id = ? AND status = 'autoboot_enabled'`).run(row.id);
        socketServer.emit('readiness_client_stale', { drill_id: row.drill_id, client_id: row.client_key });
    }
}

function closeDueReadinessDrills(connection: CenterDatabase['connection'], socketServer: SocketServer): void {
    const drills = connection.prepare(`SELECT id, started_at, duration_seconds FROM readiness_drills
        WHERE status = 'running' AND started_at IS NOT NULL`).all() as Array<{ id: string; started_at: string; duration_seconds: number }>;
    const now = Date.now();
    for (const drill of drills) {
        const deadline = new Date(drill.started_at).getTime() + drill.duration_seconds * 1000;
        if (!Number.isFinite(deadline) || deadline > now) continue;
        const attempts = connection.prepare("SELECT id, readiness_client_id FROM readiness_attempts WHERE drill_id = ? AND status IN ('prepared', 'active')").all(drill.id) as Array<{ id: string; readiness_client_id: string }>;
        const close = connection.transaction(() => {
            const closedAt = new Date().toISOString();
            for (const attempt of attempts) {
                connection.prepare("UPDATE readiness_attempts SET status = 'timed_out', submitted_at = ? WHERE id = ?").run(closedAt, attempt.id);
                connection.prepare(`INSERT INTO readiness_events (id, drill_id, client_id, event_type, severity, message, metadata, occurred_at, created_at, updated_at)
                    VALUES (?, ?, ?, 'drill_auto_submitted', 'warning', ?, ?, ?, ?, ?)`).run(randomUUID(), drill.id, attempt.readiness_client_id, 'Attempt closed automatically at the server deadline.', JSON.stringify({ reason: 'deadline' }), closedAt, closedAt, closedAt);
            }
        });
        close();
        socketServer.emit('readiness_drill_closing', { drill_id: drill.id, closed_attempts: attempts.length });
    }
}

function closeDueActiveExams(connection: CenterDatabase['connection'], socketServer: SocketServer, statusService: StatusService, autoClosingExamIds: Set<string>): void {
    const activeExams = connection.prepare(`
        SELECT id, actual_started_at, duration_minutes
        FROM imported_exams
        WHERE status = 'active'
          AND actual_started_at IS NOT NULL
    `).all() as Array<{ id: string; actual_started_at: string | null; duration_minutes: number }>;
    const now = Date.now();

    for (const exam of activeExams) {
        const startedAt = exam.actual_started_at ? new Date(exam.actual_started_at).getTime() : Number.NaN;
        const dueAt = startedAt + Number(exam.duration_minutes) * 60 * 1000;

        if (!Number.isFinite(dueAt) || dueAt > now) {
            continue;
        }

        if (autoClosingExamIds.has(exam.id)) {
            continue;
        }

        autoClosingExamIds.add(exam.id);

        try {
            const result = closeExam(connection, exam.id);
            emitExamClosed(socketServer, statusService, result);
        } catch {
            // The manual close endpoint reports detailed errors; this background guard stays quiet.
        } finally {
            autoClosingExamIds.delete(exam.id);
        }
    }
}

function emitExamClosed(socketServer: SocketServer, statusService: StatusService, result: ReturnType<typeof closeExam>): void {
    for (const submittedAttempt of result.auto_submitted_attempts) {
        socketServer.emit('candidate_submitted', {
            exam_id: submittedAttempt.exam_id,
            candidate_id: submittedAttempt.candidate_id,
            attempt_id: submittedAttempt.attempt_id,
            status: submittedAttempt.status,
            answered_count: submittedAttempt.answered_count,
            total_questions: submittedAttempt.total_questions,
            submitted_at: submittedAttempt.submitted_at,
        });
    }

    socketServer.emit('exam_closed', { exam: result.exam });
    socketServer.emit('server:status', statusService.getStatus());
}

function getRequestIpAddress(request: express.Request): string {
    const forwardedFor = request.headers['x-forwarded-for'];

    if (typeof forwardedFor === 'string' && forwardedFor.trim().length > 0) {
        return forwardedFor.split(',')[0].trim();
    }

    return request.socket.remoteAddress ?? 'unknown';
}

async function stopCenterServer(httpServer: HttpServer, socketServer: SocketServer, database: CenterDatabase, autoCloseTimer?: ReturnType<typeof setInterval>): Promise<void> {
    if (autoCloseTimer) {
        clearInterval(autoCloseTimer);
    }

    await new Promise<void>((resolve) => {
        socketServer.close(() => resolve());
    });

    if (httpServer.listening) {
        await new Promise<void>((resolve, reject) => {
            httpServer.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    }

    database.connection.close();
}
