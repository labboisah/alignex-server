import { initializeResultUploads, resultUploadStatus, uploadExamResults } from './result-upload-service.js';
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
import { assertPlanFeature, PlanFeatureError } from './plan-features.js';
import { exportExamResults, ResultExportError } from './result-export-service.js';
import { StatusService } from './status-service.js';
import { checkForUpdates, downloadUpdate, UpdateError, type UpdateArtifact } from './update-service.js';

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
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const rendererDistPath = join(currentDir, '..', 'renderer');

export async function startCenterServer(options: StartCenterServerOptions): Promise<CenterServer> {
    const app = express();
    const database = createDatabase(options.storagePath);
    const httpServer = createServer(app);
    const socketServer = new SocketServer(httpServer, {
        cors: {
            origin: '*',
        },
    });
    const statusService = new StatusService({
        database,
        port: options.port,
        startedAt: new Date().toISOString(),
    });
    const connectedClientSockets = new Map<string, { connected_at: string; user_agent: string | null }>();
    const connectedCandidateSockets = new Map<string, ConnectedCandidateSnapshot>();
    const autoClosingExamIds = new Set<string>();

    statusService.attachSocketServer(socketServer);
    statusService.setConnectedCandidateCountProvider(() => connectedClientSockets.size);

    app.use((_request, response, next) => {
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-AlignEx-Admin-Email, X-AlignEx-Admin-Password, X-AlignEx-Device-Id');
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
    app.get('/api/results/uploads/:examId', authenticateResultAdmin, (request, response) => {
        response.json({ uploads: resultUploadStatus(database.connection, String(request.params.examId)) });
    });
    app.post('/api/results/upload', authenticateResultAdmin, async (request, response) => {
        try {
            response.json({ uploads: await uploadExamResults(database.connection, database.path, String(request.body.exam_id ?? '')) });
        } catch (error) { response.status(409).json({ message: error instanceof Error ? error.message : 'Unable to upload results.' }); }
    });

    app.get('/api/health', (_request, response) => {
        response.json(statusService.getStatus());
    });

    app.get('/api/server-info', (_request, response) => {
        response.json(statusService.getServerInfo());
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

    app.get('/api/app/state', (_request, response) => {
        response.json({ status: getActivationStatus(database.connection, database.path) });
    });

    app.post('/api/app/activate-online', async (request, response) => {
        try {
            const status = await activateOnline(database.connection, database.path, {
                portal_url: String(request.body.portal_url ?? ''),
                activation_code: String(request.body.activation_code ?? ''),
                admin_email: String(request.body.admin_email ?? ''),
                admin_password: String(request.body.admin_password ?? ''),
                center_name: String(request.body.center_name ?? ''),
                organization_name: String(request.body.organization_name ?? ''),
            });

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
            const status = await activateOnline(database.connection, database.path, {
                portal_url: String(request.body.portal_url ?? ''),
                activation_code: String(request.body.activation_code ?? ''),
                admin_email: String(request.body.admin_email ?? ''),
                admin_password: String(request.body.admin_password ?? ''),
                center_name: String(request.body.center_name ?? ''),
            });

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
            response.json(loginLocalAdmin(database.connection, String(request.body.email ?? ''), String(request.body.password ?? '')));
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
            const status = await deactivateLocal(database.connection, database.path, String(request.body.password ?? ''));
            response.json({ success: true, status });
        } catch (error) {
            if (error instanceof ActivationError) {
                response.status(error.statusCode).json({ message: error.message });
                return;
            }

            response.status(500).json({ message: error instanceof Error ? error.message : 'Deactivation failed.' });
        }
    });

    app.use(['/api/exams', '/api/monitor', '/api/results', '/api/candidate'], (_request, response, next) => {
        const activation = getActivationStatus(database.connection, database.path);

        if (activation.state !== 'activated') {
            response.status(423).json({ message: activation.message, state: activation.state });
            return;
        }

        try {
            assertPlanFeature(database.connection, 'offline_delivery');
        } catch (error) {
            if (error instanceof PlanFeatureError) {
                response.status(error.statusCode).json({ message: error.message, feature: error.feature });
                return;
            }

            throw error;
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
            assertPlanFeature(database.connection, 'exam_package_import');
            const runtimeConfig = getLocalSyncConfig(database.connection, database.path);
            const summary = await importExamPackageByCode(database.connection, String(request.body.import_code ?? ''), String(request.body.exam_code ?? ''), {
                centerId: runtimeConfig.center_id ?? options.centerId ?? null,
                deviceId: runtimeConfig.device_id ?? null,
                syncBaseUrl: runtimeConfig.portal_url ?? options.syncBaseUrl ?? null,
                syncToken: runtimeConfig.sync_token ?? options.syncToken ?? null,
                syncAdminEmail: runtimeConfig.admin_email ?? options.syncAdminEmail ?? null,
                syncAdminPassword: runtimeConfig.admin_password ?? options.syncAdminPassword ?? null,
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

    app.post('/api/results/export', (request, response) => {
        try {
            assertPlanFeature(database.connection, 'result_package_export');
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
        socket.on('candidate_online', registerCandidateSocket);
        socket.on('heartbeat', registerCandidateSocket);

        socket.on('disconnect', () => {
            const identity = socket.data.candidateIdentity as ConnectedCandidateSnapshot | undefined;
            connectedClientSockets.delete(socket.id);

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
