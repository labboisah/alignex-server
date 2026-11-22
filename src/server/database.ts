import type DatabaseConstructor from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

const schema = `
CREATE TABLE IF NOT EXISTS app_settings (
    id TEXT PRIMARY KEY,
    setting_key TEXT NOT NULL UNIQUE,
    setting_value TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS local_users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS license_activations (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    license_key TEXT NOT NULL,
    organization_name TEXT NOT NULL,
    center_name TEXT NOT NULL,
    center_id TEXT,
    status TEXT NOT NULL DEFAULT 'activated' CHECK (status IN ('activated', 'expired', 'revoked', 'maintenance')),
    activated_at TEXT NOT NULL,
    expires_at TEXT,
    raw_payload TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS readiness_drills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'preflight', 'ready', 'running', 'completed', 'failed')),
    mode TEXT NOT NULL DEFAULT 'synthetic_full',
    content_pack_version TEXT NOT NULL,
    package_code TEXT,
    package_version TEXT,
    capacity_profile INTEGER,
    backup_percent REAL NOT NULL DEFAULT 15,
    autoboot_target_clients INTEGER,
    duration_seconds INTEGER NOT NULL,
    expected_clients INTEGER NOT NULL DEFAULT 1,
    connected_clients_at_start INTEGER NOT NULL DEFAULT 0,
    total_questions INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    closed_at TEXT,
    report_status TEXT NOT NULL DEFAULT 'not_created',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS readiness_packages (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    version TEXT NOT NULL,
    capacity_profile INTEGER NOT NULL,
    backup_percent REAL NOT NULL DEFAULT 15,
    autoboot_target_clients INTEGER NOT NULL,
    question_count INTEGER NOT NULL,
    subject_count INTEGER NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    payload TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    UNIQUE(code, version)
);

CREATE TABLE IF NOT EXISTS readiness_events (
    id TEXT PRIMARY KEY,
    drill_id TEXT NOT NULL,
    client_id TEXT,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (drill_id) REFERENCES readiness_drills(id)
);

CREATE TABLE IF NOT EXISTS readiness_clients (
    id TEXT PRIMARY KEY,
    drill_id TEXT NOT NULL,
    client_key TEXT NOT NULL,
    device_fingerprint TEXT NOT NULL DEFAULT '',
    ip_address TEXT,
    user_agent TEXT,
    status TEXT NOT NULL DEFAULT 'connected',
    preflight_status TEXT NOT NULL DEFAULT 'pending' CHECK (preflight_status IN ('pending', 'ready', 'failed')),
    preflight_checked_at TEXT,
    network_latency_ms REAL NOT NULL DEFAULT 0,
    network_jitter_ms REAL NOT NULL DEFAULT 0,
    packet_loss_percent REAL NOT NULL DEFAULT 0,
    network_download_mbps REAL NOT NULL DEFAULT 0,
    network_upload_mbps REAL NOT NULL DEFAULT 0,
    machine_memory_bytes INTEGER NOT NULL DEFAULT 0,
    machine_cpu_percent REAL NOT NULL DEFAULT 0,
    disk_free_gb REAL NOT NULL DEFAULT 0,
    time_offset_ms INTEGER NOT NULL DEFAULT 0,
    connected_at TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL,
    reconnect_count INTEGER NOT NULL DEFAULT 0,
    heartbeat_miss_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    average_rtt_ms REAL NOT NULL DEFAULT 0,
    last_rtt_ms REAL NOT NULL DEFAULT 0,
    memory_rss_bytes INTEGER NOT NULL DEFAULT 0,
    memory_private_bytes INTEGER NOT NULL DEFAULT 0,
    memory_sample_count INTEGER NOT NULL DEFAULT 0,
    memory_rss_total_bytes INTEGER NOT NULL DEFAULT 0,
    memory_rss_peak_bytes INTEGER NOT NULL DEFAULT 0,
    memory_private_total_bytes INTEGER NOT NULL DEFAULT 0,
    memory_private_peak_bytes INTEGER NOT NULL DEFAULT 0,
    UNIQUE(drill_id, client_key),
    FOREIGN KEY (drill_id) REFERENCES readiness_drills(id)
);

CREATE TABLE IF NOT EXISTS readiness_device_enrollments (
    id TEXT PRIMARY KEY,
    drill_id TEXT NOT NULL,
    device_fingerprint TEXT NOT NULL,
    device_label TEXT,
    status TEXT NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled', 'revoked')),
    enrolled_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(drill_id, device_fingerprint),
    FOREIGN KEY (drill_id) REFERENCES readiness_drills(id)
);

CREATE TABLE IF NOT EXISTS readiness_attempts (
    id TEXT PRIMARY KEY,
    drill_id TEXT NOT NULL,
    readiness_client_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'prepared',
    starts_at TEXT,
    deadline_at TEXT,
    submitted_at TEXT,
    current_question_order INTEGER NOT NULL DEFAULT 0,
    answered_count INTEGER NOT NULL DEFAULT 0,
    total_questions INTEGER NOT NULL DEFAULT 0,
    last_acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
    UNIQUE(drill_id, readiness_client_id),
    FOREIGN KEY (drill_id) REFERENCES readiness_drills(id),
    FOREIGN KEY (readiness_client_id) REFERENCES readiness_clients(id)
);

CREATE TABLE IF NOT EXISTS readiness_answers (
    id TEXT PRIMARY KEY,
    readiness_attempt_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    question_order INTEGER NOT NULL,
    option_label TEXT NOT NULL,
    sequence_number INTEGER NOT NULL,
    client_sent_at TEXT,
    acknowledged_at TEXT NOT NULL,
    UNIQUE(readiness_attempt_id, question_id),
    UNIQUE(readiness_attempt_id, sequence_number),
    FOREIGN KEY (readiness_attempt_id) REFERENCES readiness_attempts(id)
);

CREATE TABLE IF NOT EXISTS readiness_reports (
    id TEXT PRIMARY KEY,
    drill_id TEXT NOT NULL UNIQUE,
    report_version TEXT NOT NULL,
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'local_ready',
    uploaded_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (drill_id) REFERENCES readiness_drills(id)
);

CREATE TABLE IF NOT EXISTS imported_exams (
    id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL UNIQUE,
    exam_id TEXT NOT NULL,
    exam_code TEXT NOT NULL,
    title TEXT NOT NULL,
    organization_name TEXT NOT NULL,
    institution_name TEXT,
    institution_type TEXT NOT NULL DEFAULT 'cbt_center',
    unit_label TEXT NOT NULL DEFAULT 'Subject',
    exam_type TEXT NOT NULL DEFAULT 'exam',
    center_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    imported_at TEXT,
    starts_at TEXT,
    ends_at TEXT,
    actual_started_at TEXT,
    actual_closed_at TEXT,
    duration_minutes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'active', 'closed', 'exported')),
    raw_payload TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS exam_sessions (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    session_name TEXT NOT NULL,
    hall_name TEXT,
    server_id TEXT,
    status TEXT NOT NULL DEFAULT 'ready',
    opened_at TEXT,
    closed_at TEXT,
    candidate_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (exam_id) REFERENCES imported_exams(id)
);

CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    name TEXT NOT NULL,
    code TEXT,
    unit_type TEXT NOT NULL DEFAULT 'subject',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (exam_id) REFERENCES imported_exams(id)
);

CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    subject_id TEXT,
    question_type TEXT NOT NULL,
    body TEXT NOT NULL,
    marks REAL NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (exam_id) REFERENCES imported_exams(id),
    FOREIGN KEY (subject_id) REFERENCES subjects(id)
);

CREATE TABLE IF NOT EXISTS question_options (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    option_label TEXT NOT NULL,
    body TEXT NOT NULL,
    is_correct INTEGER NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (question_id) REFERENCES questions(id)
);

CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    candidate_no TEXT NOT NULL,
    full_name TEXT NOT NULL,
    photo_url TEXT,
    access_code_hash TEXT NOT NULL,
    group_name TEXT,
    status TEXT NOT NULL DEFAULT 'not_started',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(exam_id, candidate_no),
    FOREIGN KEY (exam_id) REFERENCES imported_exams(id)
);

CREATE TABLE IF NOT EXISTS candidate_attempts (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    started_at TEXT,
    submitted_at TEXT,
    ip_address TEXT,
    device_fingerprint TEXT,
    attempt_token TEXT,
    status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'active', 'submitted', 'auto_submitted', 'disqualified')),
    score REAL,
    total_questions INTEGER NOT NULL DEFAULT 0,
    total_marks REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (exam_id) REFERENCES imported_exams(id),
    FOREIGN KEY (candidate_id) REFERENCES candidates(id)
);

CREATE TABLE IF NOT EXISTS candidate_papers (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    option_order_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(attempt_id, question_id),
    FOREIGN KEY (exam_id) REFERENCES imported_exams(id),
    FOREIGN KEY (candidate_id) REFERENCES candidates(id),
    FOREIGN KEY (attempt_id) REFERENCES candidate_attempts(id),
    FOREIGN KEY (question_id) REFERENCES questions(id)
);

CREATE TABLE IF NOT EXISTS candidate_answers (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    option_ids TEXT NOT NULL DEFAULT '[]',
    text_answer TEXT,
    is_correct INTEGER,
    marks_awarded REAL NOT NULL DEFAULT 0,
    saved_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(attempt_id, question_id),
    FOREIGN KEY (exam_id) REFERENCES imported_exams(id),
    FOREIGN KEY (candidate_id) REFERENCES candidates(id),
    FOREIGN KEY (attempt_id) REFERENCES candidate_attempts(id),
    FOREIGN KEY (question_id) REFERENCES questions(id)
);

CREATE TABLE IF NOT EXISTS exam_events (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    attempt_id TEXT,
    candidate_id TEXT,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (exam_id) REFERENCES imported_exams(id),
    FOREIGN KEY (attempt_id) REFERENCES candidate_attempts(id),
    FOREIGN KEY (candidate_id) REFERENCES candidates(id)
);

CREATE TABLE IF NOT EXISTS export_logs (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    exported_at TEXT NOT NULL,
    status TEXT NOT NULL,
    bundle_hash TEXT,
    file_path TEXT,
    message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (exam_id) REFERENCES imported_exams(id)
);

CREATE INDEX IF NOT EXISTS idx_imported_exams_exam_id ON imported_exams(exam_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_exams_package_id ON imported_exams(package_id);
CREATE INDEX IF NOT EXISTS idx_exam_sessions_exam_id ON exam_sessions(exam_id);
CREATE INDEX IF NOT EXISTS idx_subjects_exam_id ON subjects(exam_id);
CREATE INDEX IF NOT EXISTS idx_questions_exam_id ON questions(exam_id);
CREATE INDEX IF NOT EXISTS idx_question_options_question_id ON question_options(question_id);
CREATE INDEX IF NOT EXISTS idx_candidates_exam_id ON candidates(exam_id);
CREATE INDEX IF NOT EXISTS idx_candidate_attempts_exam_id ON candidate_attempts(exam_id);
CREATE INDEX IF NOT EXISTS idx_candidate_attempts_candidate_id ON candidate_attempts(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_papers_exam_id ON candidate_papers(exam_id);
CREATE INDEX IF NOT EXISTS idx_candidate_papers_candidate_id ON candidate_papers(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_papers_attempt_id ON candidate_papers(attempt_id);
CREATE INDEX IF NOT EXISTS idx_candidate_papers_question_id ON candidate_papers(question_id);
CREATE INDEX IF NOT EXISTS idx_candidate_answers_exam_id ON candidate_answers(exam_id);
CREATE INDEX IF NOT EXISTS idx_candidate_answers_candidate_id ON candidate_answers(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_answers_attempt_id ON candidate_answers(attempt_id);
CREATE INDEX IF NOT EXISTS idx_candidate_answers_question_id ON candidate_answers(question_id);
CREATE INDEX IF NOT EXISTS idx_exam_events_exam_id ON exam_events(exam_id);
CREATE INDEX IF NOT EXISTS idx_exam_events_candidate_id ON exam_events(candidate_id);
CREATE INDEX IF NOT EXISTS idx_exam_events_attempt_id ON exam_events(attempt_id);
CREATE INDEX IF NOT EXISTS idx_export_logs_exam_id ON export_logs(exam_id);
CREATE INDEX IF NOT EXISTS idx_local_users_email ON local_users(email);
CREATE INDEX IF NOT EXISTS idx_readiness_clients_drill_id ON readiness_clients(drill_id);
CREATE INDEX IF NOT EXISTS idx_readiness_attempts_drill_id ON readiness_attempts(drill_id);
CREATE INDEX IF NOT EXISTS idx_readiness_answers_attempt_id ON readiness_answers(readiness_attempt_id);
CREATE INDEX IF NOT EXISTS idx_license_activations_device_id ON license_activations(device_id);
CREATE INDEX IF NOT EXISTS idx_license_activations_status ON license_activations(status);
`;

export type CenterDatabase = {
    connection: SqliteDatabase;
    path: string;
    walEnabled: boolean;
};

export function createDatabase(storagePath: string): CenterDatabase {
    const resolvedPath = resolve(storagePath);
    mkdirSync(dirname(resolvedPath), { recursive: true });

    const connection = new Database(resolvedPath);
    const journalMode = connection.pragma('journal_mode = WAL', { simple: true });
    connection.pragma('foreign_keys = ON');
    connection.exec(schema);
    ensureLegacyReadinessDrillSchema(connection);
    ensureImportedExamColumns(connection);
    ensureReadinessColumns(connection);
    ensureActivationTables(connection);
    ensureNullableActivationExpiry(connection);

    return {
        connection,
        path: resolvedPath,
        walEnabled: String(journalMode).toLowerCase() === 'wal',
    };
}

function ensureActivationTables(connection: SqliteDatabase): void {
    connection.exec(`
        CREATE TABLE IF NOT EXISTS local_users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator')),
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
            last_login_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS license_activations (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            license_key TEXT NOT NULL,
            organization_name TEXT NOT NULL,
            center_name TEXT NOT NULL,
            center_id TEXT,
            status TEXT NOT NULL DEFAULT 'activated' CHECK (status IN ('activated', 'expired', 'revoked', 'maintenance')),
            activated_at TEXT NOT NULL,
            expires_at TEXT,
            raw_payload TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_local_users_email ON local_users(email);
        CREATE INDEX IF NOT EXISTS idx_license_activations_device_id ON license_activations(device_id);
        CREATE INDEX IF NOT EXISTS idx_license_activations_status ON license_activations(status);
    `);
}

function ensureNullableActivationExpiry(connection: SqliteDatabase): void {
    const columns = connection.pragma('table_info(license_activations)') as Array<{ name: string; notnull: number }>;
    if (!columns.some((column) => column.name === 'expires_at' && column.notnull === 1)) return;

    connection.transaction(() => {
        const definition = connection.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'license_activations'").get() as { sql: string };
        const indexes = connection.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'license_activations' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all() as Array<{ sql: string }>;
        const create = definition.sql
            .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|\[[^\]]+\]|[^\s(]+)/i, 'CREATE TABLE license_activations_rebuild')
            .replace(/(expires_at\s+TEXT)\s+NOT NULL/i, '$1');
        if (create === definition.sql || /expires_at\s+TEXT\s+NOT NULL/i.test(create)) {
            throw new Error('Unable to migrate license activation expiry.');
        }
        const names = columns.map((column) => `"${column.name.replace(/"/g, '""')}"`).join(', ');
        connection.exec(create);
        connection.exec(`INSERT INTO license_activations_rebuild (${names}) SELECT ${names} FROM license_activations`);
        connection.exec('DROP TABLE license_activations');
        connection.exec('ALTER TABLE license_activations_rebuild RENAME TO license_activations');
        for (const index of indexes) connection.exec(index.sql);
    })();
}

function ensureLegacyReadinessDrillSchema(connection: SqliteDatabase): void {
    const tableDefinition = connection.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'readiness_drills' LIMIT 1`).get() as { sql: string } | undefined;
    if (tableDefinition && !tableDefinition.sql.includes("'preflight'")) {
        connection.pragma('foreign_keys = OFF');
        try {
            connection.transaction(() => {
                connection.exec(`
                    CREATE TABLE readiness_drills_rebuild (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'preflight', 'ready', 'running', 'completed', 'failed')),
                        mode TEXT NOT NULL DEFAULT 'synthetic_full',
                        content_pack_version TEXT NOT NULL,
                        package_code TEXT,
                        package_version TEXT,
                        capacity_profile INTEGER,
                        backup_percent REAL NOT NULL DEFAULT 15,
                        autoboot_target_clients INTEGER,
                        duration_seconds INTEGER NOT NULL,
                        expected_clients INTEGER NOT NULL DEFAULT 1,
                        connected_clients_at_start INTEGER NOT NULL DEFAULT 0,
                        total_questions INTEGER NOT NULL DEFAULT 0,
                        started_at TEXT,
                        closed_at TEXT,
                        report_status TEXT NOT NULL DEFAULT 'not_created',
                        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                    );
                    INSERT INTO readiness_drills_rebuild (
                        id, name, status, mode, content_pack_version, package_code, package_version, capacity_profile,
                        backup_percent, autoboot_target_clients, duration_seconds, expected_clients,
                        connected_clients_at_start, total_questions, started_at, closed_at, report_status,
                        created_at, updated_at
                    )
                    SELECT
                        id, name, status, mode, content_pack_version, package_code, package_version, capacity_profile,
                        backup_percent, autoboot_target_clients, duration_seconds, expected_clients,
                        connected_clients_at_start, total_questions, started_at, closed_at, report_status,
                        created_at, updated_at
                    FROM readiness_drills;
                    DROP TABLE readiness_drills;
                    ALTER TABLE readiness_drills_rebuild RENAME TO readiness_drills;
                `);
            })();
        } finally {
            connection.pragma('foreign_keys = ON');
        }
    }

    repairLegacyReadinessDrillForeignKeys(connection);
}

function repairLegacyReadinessDrillForeignKeys(connection: SqliteDatabase): void {
    const affectedTables = connection.prepare(`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'table' AND sql LIKE '%readiness_drills_legacy%'
    `).all() as Array<{ name: string; sql: string }>;
    if (affectedTables.length === 0) return;

    connection.pragma('foreign_keys = OFF');
    try {
        for (const table of affectedTables) {
            const rebuildName = `${table.name}_fk_rebuild`;
            const indexesAndTriggers = connection.prepare(`
                SELECT sql FROM sqlite_master
                WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
            `).all(table.name) as Array<{ sql: string }>;
            const createTableSql = table.sql
                .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|\[[^\]]+\]|[^\s(]+)/i, `CREATE TABLE "${rebuildName}"`)
                .replace(/REFERENCES\s+(?:"readiness_drills_legacy"|\[readiness_drills_legacy\]|readiness_drills_legacy)\s*\(/gi, 'REFERENCES readiness_drills(');
            const columns = connection.pragma(`table_info("${table.name}")`) as Array<{ name: string }>;
            const columnList = columns.map((column) => `"${column.name.replace(/"/g, '""')}"`).join(', ');

            connection.exec(`DROP TABLE IF EXISTS "${rebuildName}"`);
            connection.exec(createTableSql);
            connection.exec(`INSERT INTO "${rebuildName}" (${columnList}) SELECT ${columnList} FROM "${table.name}"`);
            connection.exec(`DROP TABLE "${table.name}"`);
            connection.exec(`ALTER TABLE "${rebuildName}" RENAME TO "${table.name}"`);
            for (const item of indexesAndTriggers) connection.exec(item.sql);
        }
    } finally {
        connection.pragma('foreign_keys = ON');
    }
}

function ensureImportedExamColumns(connection: SqliteDatabase): void {
    ensureColumns(connection, 'imported_exams', [
        { name: 'package_id', sql: 'ALTER TABLE imported_exams ADD COLUMN package_id TEXT' },
        { name: 'exam_code', sql: "ALTER TABLE imported_exams ADD COLUMN exam_code TEXT NOT NULL DEFAULT ''" },
        { name: 'organization_name', sql: "ALTER TABLE imported_exams ADD COLUMN organization_name TEXT NOT NULL DEFAULT ''" },
        { name: 'institution_name', sql: 'ALTER TABLE imported_exams ADD COLUMN institution_name TEXT' },
        { name: 'institution_type', sql: "ALTER TABLE imported_exams ADD COLUMN institution_type TEXT NOT NULL DEFAULT 'cbt_center'" },
        { name: 'unit_label', sql: "ALTER TABLE imported_exams ADD COLUMN unit_label TEXT NOT NULL DEFAULT 'Subject'" },
        { name: 'actual_started_at', sql: 'ALTER TABLE imported_exams ADD COLUMN actual_started_at TEXT' },
        { name: 'actual_closed_at', sql: 'ALTER TABLE imported_exams ADD COLUMN actual_closed_at TEXT' },
    ]);

    connection.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_exams_package_id ON imported_exams(package_id)');

    ensureColumns(connection, 'exam_sessions', [
        { name: 'hall_name', sql: 'ALTER TABLE exam_sessions ADD COLUMN hall_name TEXT' },
        { name: 'server_id', sql: 'ALTER TABLE exam_sessions ADD COLUMN server_id TEXT' },
        { name: 'candidate_ids_json', sql: "ALTER TABLE exam_sessions ADD COLUMN candidate_ids_json TEXT NOT NULL DEFAULT '[]'" },
    ]);

    ensureColumns(connection, 'candidate_attempts', [
        { name: 'ip_address', sql: 'ALTER TABLE candidate_attempts ADD COLUMN ip_address TEXT' },
        { name: 'device_fingerprint', sql: 'ALTER TABLE candidate_attempts ADD COLUMN device_fingerprint TEXT' },
        { name: 'attempt_token', sql: 'ALTER TABLE candidate_attempts ADD COLUMN attempt_token TEXT' },
        { name: 'total_questions', sql: 'ALTER TABLE candidate_attempts ADD COLUMN total_questions INTEGER NOT NULL DEFAULT 0' },
        { name: 'total_marks', sql: 'ALTER TABLE candidate_attempts ADD COLUMN total_marks REAL NOT NULL DEFAULT 0' },
    ]);

    ensureColumns(connection, 'candidates', [
        { name: 'photo_url', sql: 'ALTER TABLE candidates ADD COLUMN photo_url TEXT' },
    ]);

    ensureColumns(connection, 'subjects', [
        { name: 'unit_type', sql: "ALTER TABLE subjects ADD COLUMN unit_type TEXT NOT NULL DEFAULT 'subject'" },
    ]);

    connection.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_attempts_attempt_token ON candidate_attempts(attempt_token)');

    ensureColumns(connection, 'candidate_papers', [
        { name: 'option_order_json', sql: "ALTER TABLE candidate_papers ADD COLUMN option_order_json TEXT NOT NULL DEFAULT '[]'" },
    ]);

    ensureColumns(connection, 'question_options', [
        { name: 'is_correct', sql: 'ALTER TABLE question_options ADD COLUMN is_correct INTEGER NOT NULL DEFAULT 0' },
    ]);

    ensureColumns(connection, 'candidate_answers', [
        { name: 'is_correct', sql: 'ALTER TABLE candidate_answers ADD COLUMN is_correct INTEGER' },
        { name: 'marks_awarded', sql: 'ALTER TABLE candidate_answers ADD COLUMN marks_awarded REAL NOT NULL DEFAULT 0' },
    ]);
}

function ensureReadinessColumns(connection: SqliteDatabase): void {
    ensureColumns(connection, 'readiness_drills', [
        { name: 'package_code', sql: 'ALTER TABLE readiness_drills ADD COLUMN package_code TEXT' },
        { name: 'package_version', sql: 'ALTER TABLE readiness_drills ADD COLUMN package_version TEXT' },
        { name: 'capacity_profile', sql: 'ALTER TABLE readiness_drills ADD COLUMN capacity_profile INTEGER' },
        { name: 'backup_percent', sql: 'ALTER TABLE readiness_drills ADD COLUMN backup_percent REAL NOT NULL DEFAULT 15' },
        { name: 'autoboot_target_clients', sql: 'ALTER TABLE readiness_drills ADD COLUMN autoboot_target_clients INTEGER' },
    ]);
    ensureColumns(connection, 'readiness_clients', [
        { name: 'updated_at', sql: 'ALTER TABLE readiness_clients ADD COLUMN updated_at TEXT' },
        { name: 'ip_address', sql: 'ALTER TABLE readiness_clients ADD COLUMN ip_address TEXT' },
        { name: 'user_agent', sql: 'ALTER TABLE readiness_clients ADD COLUMN user_agent TEXT' },
        { name: 'device_fingerprint', sql: "ALTER TABLE readiness_clients ADD COLUMN device_fingerprint TEXT NOT NULL DEFAULT ''" },
        { name: 'preflight_status', sql: "ALTER TABLE readiness_clients ADD COLUMN preflight_status TEXT NOT NULL DEFAULT 'pending'" },
        { name: 'preflight_checked_at', sql: 'ALTER TABLE readiness_clients ADD COLUMN preflight_checked_at TEXT' },
        { name: 'network_latency_ms', sql: 'ALTER TABLE readiness_clients ADD COLUMN network_latency_ms REAL NOT NULL DEFAULT 0' },
        { name: 'network_jitter_ms', sql: 'ALTER TABLE readiness_clients ADD COLUMN network_jitter_ms REAL NOT NULL DEFAULT 0' },
        { name: 'packet_loss_percent', sql: 'ALTER TABLE readiness_clients ADD COLUMN packet_loss_percent REAL NOT NULL DEFAULT 0' },
        { name: 'network_download_mbps', sql: 'ALTER TABLE readiness_clients ADD COLUMN network_download_mbps REAL NOT NULL DEFAULT 0' },
        { name: 'network_upload_mbps', sql: 'ALTER TABLE readiness_clients ADD COLUMN network_upload_mbps REAL NOT NULL DEFAULT 0' },
        { name: 'machine_memory_bytes', sql: 'ALTER TABLE readiness_clients ADD COLUMN machine_memory_bytes INTEGER NOT NULL DEFAULT 0' },
        { name: 'machine_cpu_percent', sql: 'ALTER TABLE readiness_clients ADD COLUMN machine_cpu_percent REAL NOT NULL DEFAULT 0' },
        { name: 'disk_free_gb', sql: 'ALTER TABLE readiness_clients ADD COLUMN disk_free_gb REAL NOT NULL DEFAULT 0' },
        { name: 'time_offset_ms', sql: 'ALTER TABLE readiness_clients ADD COLUMN time_offset_ms INTEGER NOT NULL DEFAULT 0' },
        { name: 'heartbeat_miss_count', sql: 'ALTER TABLE readiness_clients ADD COLUMN heartbeat_miss_count INTEGER NOT NULL DEFAULT 0' },
        { name: 'error_count', sql: 'ALTER TABLE readiness_clients ADD COLUMN error_count INTEGER NOT NULL DEFAULT 0' },
        { name: 'average_rtt_ms', sql: 'ALTER TABLE readiness_clients ADD COLUMN average_rtt_ms REAL NOT NULL DEFAULT 0' },
        { name: 'last_rtt_ms', sql: 'ALTER TABLE readiness_clients ADD COLUMN last_rtt_ms REAL NOT NULL DEFAULT 0' },
        { name: 'memory_rss_bytes', sql: 'ALTER TABLE readiness_clients ADD COLUMN memory_rss_bytes INTEGER NOT NULL DEFAULT 0' },
        { name: 'memory_private_bytes', sql: 'ALTER TABLE readiness_clients ADD COLUMN memory_private_bytes INTEGER NOT NULL DEFAULT 0' },
        { name: 'memory_sample_count', sql: 'ALTER TABLE readiness_clients ADD COLUMN memory_sample_count INTEGER NOT NULL DEFAULT 0' },
        { name: 'memory_rss_total_bytes', sql: 'ALTER TABLE readiness_clients ADD COLUMN memory_rss_total_bytes INTEGER NOT NULL DEFAULT 0' },
        { name: 'memory_rss_peak_bytes', sql: 'ALTER TABLE readiness_clients ADD COLUMN memory_rss_peak_bytes INTEGER NOT NULL DEFAULT 0' },
        { name: 'memory_private_total_bytes', sql: 'ALTER TABLE readiness_clients ADD COLUMN memory_private_total_bytes INTEGER NOT NULL DEFAULT 0' },
        { name: 'memory_private_peak_bytes', sql: 'ALTER TABLE readiness_clients ADD COLUMN memory_private_peak_bytes INTEGER NOT NULL DEFAULT 0' },
    ]);
    connection.exec(`UPDATE readiness_clients SET updated_at = COALESCE(last_heartbeat_at, connected_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL OR updated_at = ''`);
    connection.exec('CREATE INDEX IF NOT EXISTS idx_readiness_device_enrollments_drill ON readiness_device_enrollments(drill_id, status)');
}

function ensureColumns(connection: SqliteDatabase, table: string, columns: Array<{ name: string; sql: string }>): void {
    const existingColumns = connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const names = new Set(existingColumns.map((column) => column.name));

    for (const column of columns) {
        if (!names.has(column.name)) {
            connection.exec(column.sql);
        }
    }
}
