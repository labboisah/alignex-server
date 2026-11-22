import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import { getLocalSyncConfig } from './activation-service.js';

export const READINESS_CONTENT_PACK = 'alignex.readiness-pack.v1';
export type ReadinessDrillStatus = 'draft' | 'preflight' | 'ready' | 'running' | 'completed' | 'failed';

export type ReadinessDrillSummary = {
    id: string;
    name: string;
    status: ReadinessDrillStatus;
    mode: string;
    content_pack_version: string;
    package_code: string | null;
    package_version: string | null;
    capacity_profile: number | null;
    backup_percent: number;
    autoboot_target_clients: number | null;
    duration_seconds: number;
    expected_clients: number;
    connected_clients_at_start: number;
    total_questions: number;
    started_at: string | null;
    closed_at: string | null;
    report_status: string;
};

export type ReadinessAttempt = {
    id: string;
    drill_id: string;
    client_id: string;
    status: 'prepared' | 'active' | 'submitted' | 'timed_out' | 'failed';
    starts_at: string | null;
    deadline_at: string | null;
    submitted_at: string | null;
    current_question_order: number;
    answered_count: number;
    total_questions: number;
    last_acknowledged_sequence: number;
};

export type ReadinessDeviceEnrollment = {
    id: string;
    drill_id: string;
    device_fingerprint: string;
    device_label: string | null;
    status: 'enrolled' | 'revoked';
    enrolled_at: string;
};

export class ReadinessDrillError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}

export function listReadinessDrills(connection: Database): ReadinessDrillSummary[] {
    return connection.prepare(`
    SELECT id, name, status, mode, content_pack_version, package_code, package_version,
             capacity_profile, backup_percent, autoboot_target_clients, duration_seconds,
               expected_clients, connected_clients_at_start, total_questions,
               started_at, closed_at, report_status
        FROM readiness_drills
        ORDER BY created_at DESC
    `).all() as ReadinessDrillSummary[];
}

export function createReadinessDrill(connection: Database, input: { name: string; expected_clients: number; duration_seconds: number; package_code: string; mode?: string }): ReadinessDrillSummary {
    const name = input.name.trim();
    const expectedClients = Math.floor(input.expected_clients);
    const durationSeconds = Math.floor(input.duration_seconds);

    if (!name) {
        throw new ReadinessDrillError('Drill name is required.', 422);
    }
    if (!Number.isInteger(expectedClients) || expectedClients < 1 || expectedClients > 5000) {
        throw new ReadinessDrillError('Expected clients must be between 1 and 5000.', 422);
    }
    if (!Number.isInteger(durationSeconds) || durationSeconds < 30 || durationSeconds > 86_400) {
        throw new ReadinessDrillError('Duration must be between 30 seconds and 24 hours.', 422);
    }
    const packageRow = connection.prepare('SELECT * FROM readiness_packages WHERE code = ? ORDER BY imported_at DESC LIMIT 1').get(input.package_code.trim().toLowerCase()) as ReadinessPackageRow | undefined;
    if (!packageRow) {
        throw new ReadinessDrillError('Import an approved readiness package before creating this drill.', 422);
    }
    const singleClientSmokeTest = input.mode === 'single_client_smoke';
    if (singleClientSmokeTest && expectedClients !== 1) {
        throw new ReadinessDrillError('Single-client smoke tests must use exactly one expected client.', 422);
    }
    if (!singleClientSmokeTest && expectedClients !== packageRow.autoboot_target_clients) {
        throw new ReadinessDrillError(`Expected clients must match the package target of ${packageRow.autoboot_target_clients}.`, 422);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    connection.prepare(`
        INSERT INTO readiness_drills (
            id, name, status, mode, content_pack_version, package_code, package_version,
            capacity_profile, backup_percent, autoboot_target_clients, duration_seconds,
            expected_clients, connected_clients_at_start, total_questions,
            started_at, closed_at, report_status, created_at, updated_at
        ) VALUES (?, ?, 'preflight', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, 'not_created', ?, ?)
    `).run(id, name, input.mode ?? 'synthetic_full', `${packageRow.code}:${packageRow.version}`, packageRow.code, packageRow.version, packageRow.capacity_profile, packageRow.backup_percent, packageRow.autoboot_target_clients, durationSeconds, expectedClients, packageRow.question_count, now, now);

    return getReadinessDrill(connection, id);
}

export function startReadinessDrill(connection: Database, id: string, connectedClients: number, preparedClients: number): ReadinessDrillSummary {
    return connection.transaction(() => {
        const drill = getReadinessDrill(connection, id);
        if (drill.status !== 'ready') {
            throw new ReadinessDrillError('Only a ready readiness drill can be started.', 409);
        }
        if (!Number.isInteger(connectedClients) || connectedClients < 0) {
            throw new ReadinessDrillError('Connected client count is invalid.', 422);
        }
        if (connectedClients < drill.expected_clients) {
            throw new ReadinessDrillError(`Only ${connectedClients} clients are connected; ${drill.expected_clients} are expected.`, 409);
        }
        if (preparedClients < drill.expected_clients) {
            throw new ReadinessDrillError(`Only ${preparedClients} clients have prepared their readiness papers; ${drill.expected_clients} are required before starting.`, 409);
        }
        const failedPreflight = connection.prepare(`SELECT COUNT(*) AS total FROM readiness_clients WHERE drill_id = ? AND preflight_status = 'failed'`).get(id) as { total: number } | undefined;
        if ((failedPreflight?.total ?? 0) > 0) {
            throw new ReadinessDrillError('At least one client failed preflight validation; resolve the failed checks before starting the drill.', 409);
        }
        const pendingPreflight = connection.prepare(`SELECT COUNT(*) AS total FROM readiness_clients WHERE drill_id = ? AND preflight_status = 'pending'`).get(id) as { total: number } | undefined;
        if ((pendingPreflight?.total ?? 0) > 0) {
            throw new ReadinessDrillError(`Waiting for ${pendingPreflight?.total ?? 0} clients to complete the Phase 1 readiness preflight before start.`, 409);
        }
        const activeExam = connection.prepare("SELECT title FROM imported_exams WHERE status = 'active' LIMIT 1").get() as { title: string } | undefined;
        if (activeExam) {
            throw new ReadinessDrillError(`Close the active exam "${activeExam.title}" before starting Autoboot.`, 409);
        }
        const runningDrill = connection.prepare("SELECT name FROM readiness_drills WHERE status = 'running' AND id != ? LIMIT 1").get(id) as { name: string } | undefined;
        if (runningDrill) {
            throw new ReadinessDrillError(`Finish the running drill "${runningDrill.name}" before starting another.`, 409);
        }

        const now = new Date().toISOString();
        connection.prepare(`
            UPDATE readiness_drills
            SET status = 'running', connected_clients_at_start = ?, started_at = ?, updated_at = ?
            WHERE id = ?
        `).run(connectedClients, now, now, id);
        connection.prepare(`
            INSERT INTO readiness_events (id, drill_id, client_id, event_type, severity, message, metadata, occurred_at, created_at, updated_at)
            VALUES (?, ?, NULL, 'drill_started', 'info', ?, ?, ?, ?, ?)
        `).run(randomUUID(), id, `Readiness drill ${drill.name} started.`, JSON.stringify({ connected_clients: connectedClients }), now, now, now);

        return getReadinessDrill(connection, id);
    })();
}

export function getReadinessStartReadiness(connection: Database, drillId: string, connectedClientKeys: ReadonlySet<string>): { connectedClients: number; preparedClientKeys: Set<string>; preflightReadyClientKeys: Set<string> } {
    getReadinessDrill(connection, drillId);
    const preparedRows = connection.prepare(`SELECT c.client_key
        FROM readiness_clients c
        JOIN readiness_attempts a ON a.readiness_client_id = c.id AND a.drill_id = c.drill_id
        WHERE c.drill_id = ? AND a.status IN ('prepared', 'active')`).all(drillId) as Array<{ client_key: string }>;
    const preparedClientKeys = new Set(preparedRows.map((row) => row.client_key).filter((clientKey) => connectedClientKeys.has(clientKey)));
    const preflightRows = connection.prepare(`SELECT client_key FROM readiness_clients WHERE drill_id = ? AND preflight_status = 'ready'`).all(drillId) as Array<{ client_key: string }>;
    const preflightReadyClientKeys = new Set(preflightRows.map((row) => row.client_key).filter((clientKey) => connectedClientKeys.has(clientKey)));
    return { connectedClients: connectedClientKeys.size, preparedClientKeys, preflightReadyClientKeys };
}

export function updateReadinessPreflight(connection: Database, drillId: string, clientKey: string, input: {
    status: 'ready' | 'failed';
    network_latency_ms?: number;
    network_jitter_ms?: number;
    packet_loss_percent?: number;
    network_download_mbps?: number;
    network_upload_mbps?: number;
    machine_memory_bytes?: number;
    machine_cpu_percent?: number;
    disk_free_gb?: number;
    time_offset_ms?: number;
    notes?: string;
}): { client_key: string; preflight_status: 'ready' | 'failed' } {
    const drill = getReadinessDrill(connection, drillId);
    if (drill.status !== 'preflight' && drill.status !== 'ready') {
        throw new ReadinessDrillError('Phase 1 preflight is only available while the drill is in the preflight or ready state.', 409);
    }

    const now = new Date().toISOString();
    const status = input.status === 'ready' ? 'ready' : 'failed';
    connection.prepare(`
        UPDATE readiness_clients
        SET preflight_status = ?, preflight_checked_at = ?, network_latency_ms = ?, network_jitter_ms = ?, packet_loss_percent = ?,
            network_download_mbps = ?, network_upload_mbps = ?, machine_memory_bytes = ?, machine_cpu_percent = ?, disk_free_gb = ?,
            time_offset_ms = ?, last_heartbeat_at = ?, updated_at = ?
        WHERE drill_id = ? AND client_key = ?
    `).run(status, now,
        Number(input.network_latency_ms ?? 0),
        Number(input.network_jitter_ms ?? 0),
        Number(input.packet_loss_percent ?? 0),
        Number(input.network_download_mbps ?? 0),
        Number(input.network_upload_mbps ?? 0),
        Number(input.machine_memory_bytes ?? 0),
        Number(input.machine_cpu_percent ?? 0),
        Number(input.disk_free_gb ?? 0),
        Number(input.time_offset_ms ?? 0),
        now,
        now,
        drillId,
        clientKey,
    );

    recordReadinessEvent(connection, {
        drill_id: drillId,
        client_id: clientKey,
        event_type: 'phase_1_preflight_result',
        severity: status === 'ready' ? 'info' : 'warning',
        message: status === 'ready' ? 'Phase 1 network and machine checks passed.' : 'Phase 1 network or machine checks failed.',
        metadata: {
            status,
            network_latency_ms: Number(input.network_latency_ms ?? 0),
            network_jitter_ms: Number(input.network_jitter_ms ?? 0),
            packet_loss_percent: Number(input.packet_loss_percent ?? 0),
            network_download_mbps: Number(input.network_download_mbps ?? 0),
            network_upload_mbps: Number(input.network_upload_mbps ?? 0),
            machine_memory_bytes: Number(input.machine_memory_bytes ?? 0),
            machine_cpu_percent: Number(input.machine_cpu_percent ?? 0),
            disk_free_gb: Number(input.disk_free_gb ?? 0),
            time_offset_ms: Number(input.time_offset_ms ?? 0),
            notes: typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : null,
        },
    });

    const summary = connection.prepare(`SELECT COUNT(*) AS total FROM readiness_clients WHERE drill_id = ? AND preflight_status = 'ready'`).get(drillId) as { total: number } | undefined;
    const readyCount = summary?.total ?? 0;
    if (readyCount >= drill.expected_clients) {
        const readyDrill = connection.prepare(`UPDATE readiness_drills SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'preflight'`).run(now, drillId);
        if (readyDrill.changes > 0) {
            recordReadinessEvent(connection, {
                drill_id: drillId,
                event_type: 'phase_1_ready',
                severity: 'info',
                message: 'Phase 1 readiness checks are complete and the drill is ready to start.',
                metadata: { expected_clients: drill.expected_clients, ready_clients: readyCount },
            });
        }
    }

    return { client_key: clientKey, preflight_status: status };
}

export function broadcastReadinessStart(connection: Database, id: string): ReadinessDrillSummary {
    return getReadinessDrill(connection, id);
}

export function deleteReadinessDrill(connection: Database, id: string): void {
    const drill = getReadinessDrill(connection, id);
    if (drill.status === 'running') {
        throw new ReadinessDrillError('A running readiness drill cannot be deleted. Finalize it first.', 409);
    }

    const transaction = connection.transaction(() => {
        connection.prepare(`DELETE FROM readiness_answers WHERE readiness_attempt_id IN (SELECT id FROM readiness_attempts WHERE drill_id = ?)`).run(id);
        connection.prepare('DELETE FROM readiness_attempts WHERE drill_id = ?').run(id);
        connection.prepare('DELETE FROM readiness_clients WHERE drill_id = ?').run(id);
        connection.prepare('DELETE FROM readiness_device_enrollments WHERE drill_id = ?').run(id);
        connection.prepare('DELETE FROM readiness_events WHERE drill_id = ?').run(id);
        connection.prepare('DELETE FROM readiness_reports WHERE drill_id = ?').run(id);
        connection.prepare('DELETE FROM readiness_drills WHERE id = ?').run(id);
    });
    transaction();
}

export function getReadinessDrill(connection: Database, id: string): ReadinessDrillSummary {
    const drill = connection.prepare(`
         SELECT id, name, status, mode, content_pack_version, package_code, package_version,
             capacity_profile, backup_percent, autoboot_target_clients, duration_seconds,
               expected_clients, connected_clients_at_start, total_questions,
               started_at, closed_at, report_status
        FROM readiness_drills WHERE id = ? LIMIT 1
    `).get(id) as ReadinessDrillSummary | undefined;

    if (!drill) {
        throw new ReadinessDrillError('Readiness drill was not found.', 404);
    }

    return drill;
}

export function enrollReadinessDevice(connection: Database, drillId: string, input: { device_fingerprint: string; device_label?: string }): ReadinessDeviceEnrollment {
    const drill = getReadinessDrill(connection, drillId);
    const fingerprint = input.device_fingerprint.trim().toLowerCase();
    const label = input.device_label?.trim() || null;
    if (drill.status !== 'preflight' && drill.status !== 'ready') throw new ReadinessDrillError('Devices can only be enrolled while a readiness drill is in preflight or ready state.', 409);
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new ReadinessDrillError('Device fingerprint must be a 64-character SHA-256 value.', 422);
    if (label && label.length > 120) throw new ReadinessDrillError('Device label must not exceed 120 characters.', 422);
    const now = new Date().toISOString();
    connection.prepare(`INSERT INTO readiness_device_enrollments (id, drill_id, device_fingerprint, device_label, status, enrolled_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'enrolled', ?, ?, ?)
        ON CONFLICT(drill_id, device_fingerprint) DO UPDATE SET device_label = excluded.device_label, status = 'enrolled', updated_at = excluded.updated_at`)
        .run(randomUUID(), drillId, fingerprint, label, now, now, now);
    return connection.prepare(`SELECT id, drill_id, device_fingerprint, device_label, status, enrolled_at
        FROM readiness_device_enrollments WHERE drill_id = ? AND device_fingerprint = ?`).get(drillId, fingerprint) as ReadinessDeviceEnrollment;
}

export function listReadinessDeviceEnrollments(connection: Database, drillId: string): ReadinessDeviceEnrollment[] {
    getReadinessDrill(connection, drillId);
    return connection.prepare(`SELECT id, drill_id, device_fingerprint, device_label, status, enrolled_at
        FROM readiness_device_enrollments WHERE drill_id = ? ORDER BY enrolled_at`).all(drillId) as ReadinessDeviceEnrollment[];
}

export function isReadinessDeviceEnrolled(connection: Database, drillId: string, fingerprint: string): boolean {
    return Boolean(connection.prepare(`SELECT 1 FROM readiness_device_enrollments
        WHERE drill_id = ? AND device_fingerprint = ? AND status = 'enrolled'`).get(drillId, fingerprint));
}

export function readinessManifest(connection: Database, id: string): ReadinessManifest {
    const drill = getReadinessDrill(connection, id);

    if (drill.status !== 'preflight' && drill.status !== 'ready' && drill.status !== 'running') {
        throw new ReadinessDrillError('This readiness drill is not available to clients.', 409);
    }

    const packageRow = connection.prepare('SELECT payload FROM readiness_packages WHERE code = ? AND version = ? LIMIT 1').get(drill.package_code, drill.package_version) as { payload: string } | undefined;
    if (!packageRow) throw new ReadinessDrillError('The readiness package for this drill is missing.', 409);
    const payload = JSON.parse(packageRow.payload) as ReadinessManifestPayload;
    return {
        drill_id: drill.id,
        mode: 'readiness_drill',
        name: drill.name,
        content_pack_version: drill.content_pack_version,
        duration_seconds: drill.duration_seconds,
        answer_interval_seconds: drill.total_questions > 0 ? drill.duration_seconds / drill.total_questions : drill.duration_seconds,
        status: drill.status,
        started_at: drill.started_at,
        subjects: payload.subjects,
    };
}

type ReadinessPackageRow = {
    id: string; code: string; version: string; capacity_profile: number; backup_percent: number;
    autoboot_target_clients: number; question_count: number; subject_count: number;
    checksum_sha256: string; payload: string;
};

type ReadinessManifestPayload = { subjects: ReadinessManifest['subjects'] };

export function listReadinessPackages(connection: Database): Array<Omit<ReadinessPackageRow, 'payload'>> {
    return connection.prepare(`SELECT id, code, version, capacity_profile, backup_percent,
        autoboot_target_clients, question_count, subject_count, checksum_sha256 FROM readiness_packages ORDER BY capacity_profile, imported_at DESC`).all() as Array<Omit<ReadinessPackageRow, 'payload'>>;
}

export async function importReadinessPackage(connection: Database, databasePath: string, code: string, adminPassword?: string | null): Promise<Omit<ReadinessPackageRow, 'payload'>> {
    const config = getLocalSyncConfig(connection, databasePath);
    if (!config.portal_url || !config.sync_token || !config.device_id) {
        throw new ReadinessDrillError('Portal activation token is missing. Reactivate the server before importing readiness packages.', 422);
    }
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-AlignEx-Device-Id': config.device_id,
        Authorization: `Bearer ${config.sync_token}`,
    };
    if (config.admin_email) headers['X-AlignEx-Admin-Email'] = config.admin_email;
    if (adminPassword?.trim()) headers['X-AlignEx-Admin-Password'] = adminPassword;
    const response = await fetch(`${config.portal_url.replace(/\/+$/, '')}/api/offline/readiness-packages/${encodeURIComponent(code)}`, { headers });
    const data = await response.json().catch(() => ({})) as { package?: ReadinessPackageRow & { payload_json?: string }; message?: string };
    if (!response.ok || !data.package) throw new ReadinessDrillError(data.message ?? `Readiness package import failed with status ${response.status}.`, response.status);
    const item = data.package;
    const payloadJson = typeof item.payload_json === 'string' ? item.payload_json : JSON.stringify(item.payload);
    const computed = createHash('sha256').update(payloadJson).digest('hex');
    let checksum = item.checksum_sha256;
    if (computed !== item.checksum_sha256) {
        if (!isLegacyReadinessPayload(item.payload, item.question_count)) throw new ReadinessDrillError('Readiness package checksum is invalid and its legacy payload shape could not be verified.', 422);
        checksum = computed;
    }
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const importedAt = new Date().toISOString();
    connection.prepare(`INSERT INTO readiness_packages (id, code, version, capacity_profile, backup_percent, autoboot_target_clients, question_count, subject_count, checksum_sha256, payload, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(code, version) DO UPDATE SET capacity_profile = excluded.capacity_profile, backup_percent = excluded.backup_percent, autoboot_target_clients = excluded.autoboot_target_clients, question_count = excluded.question_count, subject_count = excluded.subject_count, checksum_sha256 = excluded.checksum_sha256, payload = excluded.payload, imported_at = excluded.imported_at`).run(randomUUID(), item.code, item.version, item.capacity_profile, item.backup_percent, item.autoboot_target_clients, item.question_count, item.subject_count, checksum, JSON.stringify(payload), importedAt);
    return { id: item.id, code: item.code, version: item.version, capacity_profile: item.capacity_profile, backup_percent: item.backup_percent, autoboot_target_clients: item.autoboot_target_clients, question_count: item.question_count, subject_count: item.subject_count, checksum_sha256: checksum };
}

function isLegacyReadinessPayload(payload: unknown, expectedQuestions: number): payload is ReadinessManifestPayload {
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { subjects?: unknown }).subjects)) return false;
    const subjects = (payload as ReadinessManifestPayload).subjects;
    const questions = subjects.flatMap((subject) => Array.isArray(subject.questions) ? subject.questions : []);
    return subjects.length > 0 && questions.length === expectedQuestions && questions.every((question) => typeof question.id === 'string' && typeof question.body === 'string' && Array.isArray(question.options) && question.options.length >= 2 && question.options.every((option) => typeof option.label === 'string' && typeof option.text === 'string'));
}

export function recordReadinessEvent(connection: Database, input: { drill_id: string; client_id?: string; event_type: string; severity?: string; message: string; metadata?: Record<string, unknown> }): void {
    const drill = getReadinessDrill(connection, input.drill_id);
    const preflightResultAllowed = drill.status === 'preflight' && input.event_type === 'phase_1_preflight_result';
    const preflightCompleteAllowed = drill.status === 'ready' && input.event_type === 'phase_1_ready';
    if (drill.status !== 'running' && !preflightResultAllowed && !preflightCompleteAllowed && input.event_type !== 'client_registered') {
        throw new ReadinessDrillError('Readiness drill is not accepting this event.', 409);
    }

    const now = new Date().toISOString();
    connection.prepare(`
        INSERT INTO readiness_events (id, drill_id, client_id, event_type, severity, message, metadata, occurred_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        randomUUID(), input.drill_id, input.client_id ?? null, input.event_type,
        input.severity ?? 'info', input.message, JSON.stringify(input.metadata ?? {}), now, now, now,
    );
}

export function prepareReadinessAttempt(connection: Database, drillId: string, clientKey: string): ReadinessAttempt {
    const drill = getReadinessDrill(connection, drillId);
    if (drill.status !== 'ready' && drill.status !== 'running') throw new ReadinessDrillError('This readiness drill is not available until Phase 1 readiness is complete.', 409);
    const now = new Date().toISOString();
    const clientId = randomUUID();
    connection.prepare(`INSERT INTO readiness_clients (id, drill_id, client_key, status, connected_at, last_heartbeat_at, updated_at)
        VALUES (?, ?, ?, 'autoboot_enabled', ?, ?, ?)
        ON CONFLICT(drill_id, client_key) DO UPDATE SET status = 'autoboot_enabled', last_heartbeat_at = excluded.last_heartbeat_at, updated_at = excluded.updated_at, reconnect_count = readiness_clients.reconnect_count + 1`).run(clientId, drillId, clientKey, now, now, now);
    const client = connection.prepare('SELECT id FROM readiness_clients WHERE drill_id = ? AND client_key = ?').get(drillId, clientKey) as { id: string };
    const existing = connection.prepare('SELECT * FROM readiness_attempts WHERE drill_id = ? AND readiness_client_id = ?').get(drillId, client.id) as ReadinessAttempt | undefined;
    if (existing) return { ...existing, client_id: client.id };
    const manifest = readinessManifest(connection, drillId);
    const startsAt = drill.started_at;
    const deadline = startsAt ? new Date(new Date(startsAt).getTime() + drill.duration_seconds * 1000).toISOString() : null;
    const attemptId = randomUUID();
    connection.prepare(`INSERT INTO readiness_attempts (id, drill_id, readiness_client_id, status, starts_at, deadline_at, total_questions)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(attemptId, drillId, client.id, drill.status === 'running' ? 'active' : 'prepared', startsAt, deadline, manifest.subjects.reduce((total, subject) => total + subject.questions.length, 0));
    return getReadinessAttempt(connection, drillId, attemptId);
}

export function getReadinessAttempt(connection: Database, drillId: string, attemptId: string): ReadinessAttempt {
    const row = connection.prepare(`SELECT id, drill_id, readiness_client_id AS client_id, status, starts_at, deadline_at,
        submitted_at, current_question_order, answered_count, total_questions, last_acknowledged_sequence
        FROM readiness_attempts WHERE drill_id = ? AND id = ? LIMIT 1`).get(drillId, attemptId) as ReadinessAttempt | undefined;
    if (!row) throw new ReadinessDrillError('Readiness attempt was not found.', 404);
    return row;
}

export function getReadinessMonitor(connection: Database, drillId: string, connectedClientKeys: ReadonlySet<string> = new Set()): { drill: ReadinessDrillSummary; clients: Array<Record<string, unknown>>; counts: Record<string, number> } {
    const drill = getReadinessDrill(connection, drillId);
    const clients = connection.prepare(`SELECT c.id AS client_id, c.client_key, c.client_key AS candidate_label, c.ip_address, c.user_agent,
        c.status AS client_status, c.preflight_status, c.preflight_checked_at, c.network_latency_ms, c.network_jitter_ms, c.packet_loss_percent,
        c.network_download_mbps, c.network_upload_mbps, c.machine_memory_bytes, c.machine_cpu_percent, c.disk_free_gb, c.time_offset_ms,
        c.connected_at, c.last_heartbeat_at, c.reconnect_count, c.heartbeat_miss_count,
        c.error_count, c.average_rtt_ms, c.last_rtt_ms, c.memory_rss_bytes, c.memory_private_bytes,
        a.id AS attempt_id, a.status AS attempt_status, a.current_question_order,
        a.answered_count, a.total_questions, MAX(a.total_questions - a.answered_count, 0) AS remaining_questions,
        a.deadline_at, a.submitted_at
        FROM readiness_clients c LEFT JOIN readiness_attempts a ON a.readiness_client_id = c.id AND a.drill_id = c.drill_id
        WHERE c.drill_id = ? ORDER BY c.connected_at`).all(drillId) as Array<Record<string, unknown>>;
    for (const client of clients) {
        const clientKey = String(client.client_key ?? '');
        if (connectedClientKeys.has(`${drillId}:${clientKey}`)) {
            client.client_status = 'autoboot_enabled';
        }
    }
    const counts = clients.reduce<Record<string, number>>((summary, client) => {
        const status = String(client.attempt_status ?? client.client_status ?? 'connected');
        summary[status] = (summary[status] ?? 0) + 1;
        return summary;
    }, {});
    return { drill, clients, counts };
}

export function getReadinessMetrics(connection: Database, drillId: string, databasePath: string): Record<string, number | string> {
    const answerCount = connection.prepare(`SELECT COUNT(*) AS total FROM readiness_answers a
        JOIN readiness_attempts r ON r.id = a.readiness_attempt_id WHERE r.drill_id = ?`).get(drillId) as { total: number };
    const eventCount = connection.prepare('SELECT COUNT(*) AS total FROM readiness_events WHERE drill_id = ?').get(drillId) as { total: number };
    const clientCount = connection.prepare('SELECT COUNT(*) AS total FROM readiness_clients WHERE drill_id = ?').get(drillId) as { total: number };
    const attemptCount = connection.prepare('SELECT COUNT(*) AS total FROM readiness_attempts WHERE drill_id = ?').get(drillId) as { total: number };
    const memory = process.memoryUsage();
    return {
        process_uptime_seconds: Math.round(process.uptime()),
        process_rss_bytes: memory.rss,
        process_heap_used_bytes: memory.heapUsed,
        process_heap_total_bytes: memory.heapTotal,
        database_size_bytes: databaseFileSize(databasePath),
        wal_size_bytes: databaseFileSize(`${databasePath}-wal`),
        readiness_client_count: clientCount.total,
        readiness_attempt_count: attemptCount.total,
        acknowledged_answer_count: answerCount.total,
        readiness_event_count: eventCount.total,
        sampled_at: new Date().toISOString(),
    };
}

function databaseFileSize(path: string): number {
    try {
        return statSync(path).size || 0;
    } catch {
        return 0;
    }
}

export function getReadinessVisualization(connection: Database, drillId: string, attemptId: string): Record<string, unknown> {
    const attempt = getReadinessAttempt(connection, drillId, attemptId);
    const drill = getReadinessDrill(connection, drillId);
    const answers = connection.prepare(`SELECT question_id, question_order, option_label, sequence_number, client_sent_at, acknowledged_at
        FROM readiness_answers WHERE readiness_attempt_id = ? ORDER BY question_order`).all(attemptId);
    return { drill, attempt, answers, manifest: readinessManifest(connection, drillId) };
}

export function acknowledgeReadinessAnswer(connection: Database, input: { drill_id: string; attempt_id: string; client_key: string; question_id: string; question_order: number; option_label: string; sequence_number: number; client_sent_at?: string }): { attempt: ReadinessAttempt; acknowledged_at: string; duplicate: boolean } {
    const attempt = getReadinessAttempt(connection, input.drill_id, input.attempt_id);
    const client = connection.prepare('SELECT client_key FROM readiness_clients WHERE id = ?').get(attempt.client_id) as { client_key: string } | undefined;
    if (!client || client.client_key !== input.client_key) throw new ReadinessDrillError('This attempt does not belong to the connected client.', 403);
    if (attempt.status !== 'active' && attempt.status !== 'prepared') throw new ReadinessDrillError('This readiness attempt is closed.', 409);
    const manifest = readinessManifest(connection, input.drill_id);
    const question = manifest.subjects.flatMap((subject) => subject.questions).find((item) => item.id === input.question_id && item.options.some((option) => option.label === input.option_label));
    if (!question || question.id !== input.question_id) throw new ReadinessDrillError('The question or option is not part of this readiness paper.', 422);
    const existing = connection.prepare('SELECT acknowledged_at FROM readiness_answers WHERE readiness_attempt_id = ? AND (question_id = ? OR sequence_number = ?)').get(input.attempt_id, input.question_id, input.sequence_number) as { acknowledged_at: string } | undefined;
    if (existing) return { attempt: getReadinessAttempt(connection, input.drill_id, input.attempt_id), acknowledged_at: existing.acknowledged_at, duplicate: true };
    const acknowledgedAt = new Date().toISOString();
    connection.transaction(() => {
        connection.prepare(`INSERT INTO readiness_answers (id, readiness_attempt_id, question_id, question_order, option_label, sequence_number, client_sent_at, acknowledged_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), input.attempt_id, input.question_id, input.question_order, input.option_label, input.sequence_number, input.client_sent_at ?? null, acknowledgedAt);
        connection.prepare(`UPDATE readiness_attempts SET status = 'active', current_question_order = ?, answered_count = answered_count + 1,
            last_acknowledged_sequence = CASE WHEN last_acknowledged_sequence < ? THEN ? ELSE last_acknowledged_sequence END WHERE id = ?`).run(input.question_order, input.sequence_number, input.sequence_number, input.attempt_id);
    })();
    return { attempt: getReadinessAttempt(connection, input.drill_id, input.attempt_id), acknowledged_at: acknowledgedAt, duplicate: false };
}

export function submitReadinessAttempt(connection: Database, drillId: string, attemptId: string, clientKey: string): ReadinessAttempt {
    const attempt = getReadinessAttempt(connection, drillId, attemptId);
    const client = connection.prepare('SELECT client_key FROM readiness_clients WHERE id = ?').get(attempt.client_id) as { client_key: string } | undefined;
    if (!client || client.client_key !== clientKey) throw new ReadinessDrillError('This attempt does not belong to the connected client.', 403);
    if (attempt.status === 'submitted') return attempt;
    const submittedAt = new Date().toISOString();
    connection.prepare("UPDATE readiness_attempts SET status = 'submitted', submitted_at = ? WHERE id = ?").run(submittedAt, attemptId);
    recordReadinessEvent(connection, { drill_id: drillId, client_id: clientKey, event_type: 'drill_submitted', message: 'Synthetic readiness attempt submitted.' });
    return getReadinessAttempt(connection, drillId, attemptId);
}

export type ReadinessReport = {
    report_id: string;
    report_version: 'alignex.readiness-report.v1';
    drill_id: string;
    drill_name: string;
    status: 'ready' | 'incomplete';
    expected_clients: number;
    connected_clients: number;
    completed_clients: number;
    failed_clients: number;
    total_questions: number;
    total_answers: number;
    total_submissions: number;
    event_count: number;
    started_at: string | null;
    closed_at: string;
    content_pack_version: string;
    payload: Record<string, unknown>;
    payload_hash: string;
};

type ReadinessAssessmentClient = {
    client_key: string; ip_address: string | null; user_agent: string | null; reconnect_count: number; heartbeat_miss_count: number; error_count: number; average_rtt_ms: number; last_rtt_ms: number; memory_rss_bytes: number; memory_private_bytes: number; memory_sample_count: number; memory_rss_total_bytes: number; memory_rss_peak_bytes: number; memory_private_total_bytes: number; memory_private_peak_bytes: number; attempt_status: string | null; answered_count: number | null; total_questions: number | null; submitted_at: string | null;
};

function percentage(numerator: number, denominator: number): number { return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0; }
function networkScore(rttMs: number): number { if (rttMs <= 100) return 100; if (rttMs <= 250) return 85; if (rttMs <= 500) return 65; if (rttMs <= 1_000) return 40; return 20; }
function resourceScore(peakBytes: number): number { if (peakBytes <= 1.5 * 1024 ** 3) return 100; if (peakBytes <= 3 * 1024 ** 3) return 80; if (peakBytes <= 4 * 1024 ** 3) return 60; return 30; }
function operatingSystem(userAgent: string | null): string { if (!userAgent) return 'Unavailable'; if (/Windows NT/i.test(userAgent)) return 'Windows'; if (/Mac OS X/i.test(userAgent)) return 'macOS'; if (/Linux/i.test(userAgent)) return 'Linux'; return 'Other'; }

export function finalizeReadinessReport(connection: Database, id: string): ReadinessReport {
    const drill = getReadinessDrill(connection, id);
    if (drill.status !== 'running') {
        throw new ReadinessDrillError('Only a running readiness drill can be finalized.', 409);
    }
    const deadline = drill.started_at ? new Date(drill.started_at).getTime() + drill.duration_seconds * 1000 : Number.NaN;
    if (!Number.isFinite(deadline) || Date.now() < deadline) {
        throw new ReadinessDrillError('The readiness drill is still running. Finalize the report after the configured duration ends.', 409);
    }

    const events = connection.prepare(`SELECT event_type, severity, message, metadata, occurred_at FROM readiness_events WHERE drill_id = ? ORDER BY occurred_at`).all(id) as Array<{ event_type: string; severity: string; message: string; metadata: string; occurred_at: string }>;
    const clients = connection.prepare(`SELECT c.client_key, c.ip_address, c.user_agent, c.reconnect_count, c.heartbeat_miss_count, c.error_count, c.average_rtt_ms, c.last_rtt_ms, c.memory_rss_bytes, c.memory_private_bytes, c.memory_sample_count, c.memory_rss_total_bytes, c.memory_rss_peak_bytes, c.memory_private_total_bytes, c.memory_private_peak_bytes, a.status AS attempt_status, a.answered_count, a.total_questions, a.submitted_at FROM readiness_clients c LEFT JOIN readiness_attempts a ON a.readiness_client_id = c.id AND a.drill_id = c.drill_id WHERE c.drill_id = ? ORDER BY c.client_key`).all(id) as ReadinessAssessmentClient[];
    const completedClients = clients.filter((client) => ['submitted', 'timed_out'].includes(client.attempt_status ?? '')).length;
    const submittedClients = clients.filter((client) => client.attempt_status === 'submitted').length;
    const timedOutClients = clients.filter((client) => client.attempt_status === 'timed_out').length;
    const failedClients = clients.filter((client) => client.attempt_status === 'failed' || client.error_count > 0).length;
    const totalQuestions = drill.total_questions;
    const totalAnswers = (connection.prepare(`SELECT COUNT(*) AS count FROM readiness_answers a JOIN readiness_attempts t ON t.id = a.readiness_attempt_id WHERE t.drill_id = ?`).get(id) as { count: number }).count;
    const average = (values: number[]): number => values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : 0;
    const completionRate = percentage(completedClients, drill.expected_clients);
    const acknowledgementRate = percentage(totalAnswers, drill.expected_clients * totalQuestions);
    const networkReadinessScore = average(clients.map((client) => networkScore(client.average_rtt_ms)));
    const reliabilityScore = average(clients.map((client) => Math.max(0, 100 - client.reconnect_count * 5 - client.heartbeat_miss_count * 5 - client.error_count * 10)));
    const sampledClients = clients.filter((client) => client.memory_sample_count > 0);
    const resourceReadinessScore = sampledClients.length ? average(sampledClients.map((client) => resourceScore(client.memory_rss_peak_bytes))) : 0;
    const overallScore = Math.round(completionRate * 0.30 + acknowledgementRate * 0.25 + networkReadinessScore * 0.20 + reliabilityScore * 0.15 + resourceReadinessScore * 0.10);
    const readiness = completionRate === 100 && acknowledgementRate >= 95 && overallScore >= 85 ? 'ready' : overallScore >= 65 ? 'conditional' : 'not_ready';
    const closedAt = new Date().toISOString();
    const reportId = randomUUID();
    const base = {
        report_id: reportId,
        report_version: 'alignex.readiness-report.v1' as const,
        drill_id: drill.id,
        drill_name: drill.name,
        status: completedClients >= drill.expected_clients ? 'ready' as const : 'incomplete' as const,
        expected_clients: drill.expected_clients,
        connected_clients: drill.connected_clients_at_start,
        completed_clients: completedClients,
        failed_clients: failedClients,
        total_questions: totalQuestions,
        total_answers: totalAnswers,
        total_submissions: submittedClients,
        event_count: events.length,
        started_at: drill.started_at,
        closed_at: closedAt,
        content_pack_version: drill.content_pack_version,
    };
    const payload = JSON.stringify({ ...base, assessment: { version: 'alignex.readiness-assessment.v1', outcome: readiness, overall_score: overallScore, factors: { completion_rate: completionRate, acknowledgement_rate: acknowledgementRate, network_score: networkReadinessScore, reliability_score: reliabilityScore, resource_score: resourceReadinessScore }, thresholds: { ready: 'completion 100%, acknowledgements >=95%, overall >=85', conditional: 'overall 65-84', network_rtt_ms: '100/250/500/1000', memory_rss_peak_gib: '1.5/3/4' } }, evidence: { drill: { mode: drill.mode, duration_seconds: drill.duration_seconds, deadline_at: new Date(deadline).toISOString(), content_pack_version: drill.content_pack_version }, clients: clients.map((client) => ({ ...client, operating_system: operatingSystem(client.user_agent), average_memory_rss_bytes: client.memory_sample_count ? Math.round(client.memory_rss_total_bytes / client.memory_sample_count) : null, average_memory_private_bytes: client.memory_sample_count ? Math.round(client.memory_private_total_bytes / client.memory_sample_count) : null })), outcomes: { submitted_clients: submittedClients, timed_out_clients: timedOutClients, failed_clients: failedClients }, events } });
    const payloadHash = createHash('sha256').update(payload).digest('hex');
    const report = { ...base, payload: JSON.parse(payload) as Record<string, unknown>, payload_hash: payloadHash };
    const transaction = connection.transaction(() => {
        connection.prepare(`INSERT INTO readiness_reports (id, drill_id, report_version, payload, payload_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'local_ready', ?, ?)`).run(reportId, id, report.report_version, JSON.stringify(report), payloadHash, closedAt, closedAt);
        connection.prepare(`UPDATE readiness_drills SET status = 'completed', closed_at = ?, report_status = 'local_ready', updated_at = ? WHERE id = ?`).run(closedAt, closedAt, id);
    });
    transaction();
    return report;
}

export function getReadinessReport(connection: Database, id: string): ReadinessReport {
    const row = connection.prepare('SELECT payload FROM readiness_reports WHERE drill_id = ? LIMIT 1').get(id) as { payload: string } | undefined;
    if (!row) throw new ReadinessDrillError('Readiness report is not available.', 404);
    return JSON.parse(row.payload) as ReadinessReport;
}

export function getReadinessReportPreview(connection: Database, id: string): Record<string, unknown> {
    const report = getReadinessReport(connection, id);
    const clients = connection.prepare(`SELECT c.client_key, c.ip_address, c.user_agent, c.status AS client_status,
        c.reconnect_count, c.heartbeat_miss_count, c.error_count, c.average_rtt_ms, c.memory_rss_bytes,
        c.memory_sample_count, c.memory_rss_peak_bytes, CASE WHEN c.memory_sample_count > 0 THEN CAST(c.memory_rss_total_bytes / c.memory_sample_count AS INTEGER) END AS average_memory_rss_bytes,
        CASE WHEN c.user_agent LIKE '%Windows NT%' THEN 'Windows' WHEN c.user_agent LIKE '%Mac OS X%' THEN 'macOS' WHEN c.user_agent LIKE '%Linux%' THEN 'Linux' ELSE 'Unavailable' END AS operating_system,
        a.status AS attempt_status, a.answered_count, a.total_questions, a.submitted_at
        FROM readiness_clients c LEFT JOIN readiness_attempts a ON a.readiness_client_id = c.id AND a.drill_id = c.drill_id
        WHERE c.drill_id = ? ORDER BY c.client_key`).all(id);
    const events = connection.prepare(`SELECT event_type, severity, message, metadata, occurred_at
        FROM readiness_events WHERE drill_id = ? ORDER BY occurred_at`).all(id);
    return { report, clients, events };
}

export async function uploadReadinessReport(connection: Database, databasePath: string, id: string): Promise<{ status: string; report_id: string; payload_hash: string }> {
    const report = getReadinessReport(connection, id);
    const config = getLocalSyncConfig(connection, databasePath);
    if (!config.portal_url || !config.sync_token || !config.device_id) {
        throw new ReadinessDrillError('Portal activation token is missing. Reactivate the server before uploading readiness reports.', 422);
    }

    const response = await fetch(`${config.portal_url.replace(/\/+$/, '')}/api/offline/readiness-reports`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-AlignEx-Device-Id': config.device_id,
            Authorization: `Bearer ${config.sync_token}`,
        },
        body: JSON.stringify(report),
    });
    const data = await response.json().catch(() => ({})) as { status?: string; report_id?: string; payload_hash?: string; message?: string };
    if (!response.ok) {
        throw new ReadinessDrillError(data.message ?? `Readiness report upload failed with status ${response.status}.`, response.status);
    }

    const now = new Date().toISOString();
    connection.prepare("UPDATE readiness_reports SET status = 'uploaded', uploaded_at = ?, updated_at = ? WHERE drill_id = ?").run(now, now, id);
    connection.prepare("UPDATE readiness_drills SET report_status = 'uploaded', updated_at = ? WHERE id = ?").run(now, id);

    return {
        status: data.status ?? 'accepted',
        report_id: data.report_id ?? report.report_id,
        payload_hash: data.payload_hash ?? report.payload_hash,
    };
}

export type ReadinessManifest = {
    drill_id: string;
    mode: 'readiness_drill';
    name: string;
    content_pack_version: string;
    duration_seconds: number;
    answer_interval_seconds: number;
    status: ReadinessDrillStatus;
    started_at: string | null;
    subjects: Array<{
        id: string;
        name: string;
        questions: Array<{
            id: string;
            subject_id: string;
            body: string;
            options: Array<{ label: string; text: string }>;
        }>;
    }>;
};
