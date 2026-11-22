import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { Candidate, CandidatePaper, ExamManifest, ExamPackage, ExamUnit, Question, QuestionOption } from '../contracts/exam-package.js';

export type ImportSummary = {
    exam_id: string;
    exam_code: string;
    title: string;
    organization_name: string;
    candidate_count: number;
    question_count: number;
    duration_minutes: number;
    institution_name: string;
    institution_type: string;
    unit_label: string;
    status: 'ready';
};

export class PackageValidationError extends Error {
    readonly errors: string[];

    constructor(errors: string[]) {
        super('Exam package validation failed.');
        this.errors = errors;
    }
}

export class DuplicatePackageError extends Error {
    constructor(packageId: string) {
        super(`Package ${packageId} has already been imported.`);
    }
}

export class ImportCodeError extends Error {
    readonly code: string;
    readonly statusCode: number;

    constructor(message: string, code: string, statusCode = 400) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}

export type ImportCodeOptions = {
    syncBaseUrl: string | null;
    syncToken: string | null;
    centerId: string | null;
    deviceId?: string | null;
    syncAdminEmail: string | null;
    syncAdminPassword: string | null;
};

export function importExamPackage(connection: Database, payload: unknown): ImportSummary {
    const pkg = validateExamPackage(payload);
    const examUnits = getPackageUnits(pkg);
    const duplicate = connection
        .prepare('SELECT id FROM imported_exams WHERE package_id = ?')
        .get(pkg.manifest.package_id) as { id: string } | undefined;

    if (duplicate) {
        throw new DuplicatePackageError(pkg.manifest.package_id);
    }

    const importTransaction = connection.transaction((examPackage: ExamPackage, units: ExamUnit[]) => {
        const now = new Date().toISOString();
        const manifest = examPackage.manifest;
        const importedExamId = manifest.exam_id;
        const institutionType = normalizeInstitutionType(manifest.institution_type ?? manifest.exam_context);
        const institutionName = normalizeInstitutionName(manifest);
        const unitLabel = normalizeUnitLabel(manifest.unit_label, institutionType);
        const subjectIdMap = new Map(units.map((unit) => [unit.id, localImportId(importedExamId, 'subject', unit.id)]));
        const questionIdMap = new Map(examPackage.questions.map((question) => [question.id, localImportId(importedExamId, 'question', question.id)]));
        const candidateIdMap = new Map(examPackage.candidates.map((candidate) => [candidate.id, localImportId(importedExamId, 'candidate', candidate.id)]));
        const optionIdMap = new Map(examPackage.options.map((option) => [option.id, localImportId(importedExamId, 'option', option.id)]));

        connection.prepare(`
            INSERT INTO imported_exams (
                id, package_id, exam_id, exam_code, title, organization_name,
                institution_name, institution_type, unit_label, exam_type,
                center_id, organization_id, imported_at, starts_at, ends_at,
                duration_minutes, status, raw_payload, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            importedExamId,
            manifest.package_id,
            manifest.exam_id,
            manifest.exam_code,
            manifest.title,
            manifest.organization_name,
            institutionName,
            institutionType,
            unitLabel,
            'exam',
            manifest.center_id,
            manifest.organization_name,
            now,
            manifest.start_at,
            manifest.end_at,
            manifest.duration_minutes,
            'ready',
            JSON.stringify(examPackage),
            now,
            now,
        );

        const insertUnit = connection.prepare(`
            INSERT INTO subjects (id, exam_id, name, code, unit_type, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const unit of units) {
            insertUnit.run(subjectIdMap.get(unit.id), importedExamId, unit.name, unit.code, normalizeUnitType(unit.unit_type ?? unitLabel, institutionType), now, now);
        }

        const insertQuestion = connection.prepare(`
            INSERT INTO questions (id, exam_id, subject_id, question_type, body, marks, display_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const question of examPackage.questions) {
            insertQuestion.run(
                questionIdMap.get(question.id),
                importedExamId,
                subjectIdMap.get(getQuestionUnitId(question)) ?? null,
                question.question_type,
                question.body,
                question.marks,
                question.display_order,
                now,
                now,
            );
        }

        const insertOption = connection.prepare(`
            INSERT INTO question_options (id, question_id, option_label, body, is_correct, display_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const option of examPackage.options) {
            insertOption.run(
                optionIdMap.get(option.id),
                questionIdMap.get(option.question_id),
                option.option_label,
                option.body,
                isCorrectOption(option) ? 1 : 0,
                option.display_order,
                now,
                now,
            );
        }

        const insertCandidate = connection.prepare(`
            INSERT INTO candidates (id, exam_id, candidate_no, full_name, photo_url, access_code_hash, group_name, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const candidate of examPackage.candidates) {
            insertCandidate.run(
                candidateIdMap.get(candidate.id),
                importedExamId,
                candidate.candidate_no,
                candidate.full_name,
                candidate.photo_url,
                candidate.access_code_hash,
                candidate.group_name,
                'not_started',
                now,
                now,
            );
        }

        const insertSession = connection.prepare(`
            INSERT INTO exam_sessions (
                id, exam_id, session_name, hall_name, server_id, status,
                opened_at, closed_at, candidate_ids_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const session of examPackage.sessions ?? []) {
            insertSession.run(
                session.id,
                importedExamId,
                session.session_name,
                session.hall_name ?? null,
                session.server_id ?? null,
                session.status ?? 'ready',
                session.opened_at ?? null,
                session.closed_at ?? null,
                JSON.stringify(session.candidate_ids ?? []),
                now,
                now,
            );
        }

        const insertAttempt = connection.prepare(`
            INSERT INTO candidate_attempts (
                id, exam_id, candidate_id, started_at, submitted_at, ip_address,
                device_fingerprint, attempt_token, status, score, total_questions,
                total_marks, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertPaper = connection.prepare(`
            INSERT INTO candidate_papers (
                id, exam_id, candidate_id, attempt_id, question_id,
                display_order, option_order_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const marksByQuestionId = new Map(examPackage.questions.map((question) => [question.id, question.marks]));

        for (const paper of examPackage.papers) {
            const localCandidateId = candidateIdMap.get(paper.candidate_id);

            if (!localCandidateId) {
                continue;
            }

            const attemptId = localImportId(importedExamId, 'attempt', paper.candidate_id);
            const totalMarks = paper.questions.reduce((sum, paperQuestion) => sum + (marksByQuestionId.get(paperQuestion.question_id) ?? 0), 0);

            insertAttempt.run(
                attemptId,
                importedExamId,
                localCandidateId,
                null,
                null,
                null,
                null,
                null,
                'not_started',
                null,
                paper.questions.length,
                totalMarks,
                now,
                now,
            );

            for (const paperQuestion of paper.questions) {
                insertPaper.run(
                    randomUUID(),
                    importedExamId,
                    localCandidateId,
                    attemptId,
                    questionIdMap.get(paperQuestion.question_id),
                    paperQuestion.display_order,
                    JSON.stringify(paperQuestion.option_order.map((optionId) => optionIdMap.get(optionId)).filter((optionId): optionId is string => Boolean(optionId))),
                    now,
                    now,
                );
            }
        }

        connection.prepare(`
            INSERT INTO exam_events (
                id, exam_id, attempt_id, candidate_id, event_type, severity,
                message, metadata, occurred_at, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            randomUUID(),
            importedExamId,
            null,
            null,
            'exam_imported',
            'info',
            `Exam package ${manifest.package_id} imported.`,
            JSON.stringify({
                package_id: manifest.package_id,
                exam_code: manifest.exam_code,
                unit_label: unitLabel,
                units: units.length,
                questions: examPackage.questions.length,
                candidates: examPackage.candidates.length,
            }),
            now,
            now,
            now,
        );

        return createSummary(examPackage);
    });

    return importTransaction(pkg, examUnits);
}

export async function importExamPackageByCode(connection: Database, importCode: string, examCode: string, options: ImportCodeOptions): Promise<ImportSummary> {
    const normalizedExamCode = normalizeImportCode(examCode);

    if (!normalizedExamCode) {
        throw new ImportCodeError('Online exam code is required.', 'invalid_exam_code', 422);
    }

    if (!options.syncBaseUrl) {
        throw new ImportCodeError('Portal sync URL is not configured for this center server.', 'sync_not_configured', 503);
    }

    const url = new URL(`/api/offline/exam-packages/${encodeURIComponent(normalizedExamCode)}`, options.syncBaseUrl);

    if (options.centerId) {
        url.searchParams.set('center_id', options.centerId);
    }

    const normalizedImportCode = normalizeImportCode(importCode);
    if (normalizedImportCode) {
        url.searchParams.set('import_code', normalizedImportCode);
    }

    const headers: Record<string, string> = {
        Accept: 'application/json',
    };

    if (options.syncToken) {
        headers.Authorization = `Bearer ${options.syncToken}`;
    }

    if (options.deviceId) {
        headers['X-AlignEx-Device-Id'] = options.deviceId;
    }

    if (options.syncAdminEmail) {
        headers['X-AlignEx-Admin-Email'] = options.syncAdminEmail;
    }

    if (options.syncAdminPassword) {
        headers['X-AlignEx-Admin-Password'] = options.syncAdminPassword;
    }

    const response = await fetch(url, { headers });
    const payload = await readJson(response);

    if (response.status === 404) {
        throw new ImportCodeError('No exam package was found for this exam code.', 'exam_code_not_found', 404);
    }

    if (!response.ok) {
        const message = isRecord(payload) && typeof payload.message === 'string'
            ? payload.message
            : 'Unable to retrieve exam package for this exam code.';

        throw new ImportCodeError(message, 'exam_code_lookup_failed', response.status);
    }

    return importExamPackage(connection, extractPackagePayload(payload));
}

function createSummary(pkg: ExamPackage): ImportSummary {
    const institutionType = normalizeInstitutionType(pkg.manifest.institution_type ?? pkg.manifest.exam_context);

    return {
        exam_id: pkg.manifest.exam_id,
        exam_code: pkg.manifest.exam_code,
        title: pkg.manifest.title,
        organization_name: pkg.manifest.organization_name,
        candidate_count: pkg.candidates.length,
        question_count: pkg.questions.length,
        duration_minutes: pkg.manifest.duration_minutes,
        institution_name: normalizeInstitutionName(pkg.manifest),
        institution_type: institutionType,
        unit_label: normalizeUnitLabel(pkg.manifest.unit_label, institutionType),
        status: 'ready',
    };
}

function normalizeImportCode(importCode: string): string {
    return importCode.trim().toUpperCase();
}

function localImportId(examId: string, entityType: 'subject' | 'question' | 'option' | 'candidate' | 'attempt', sourceId: string): string {
    return `${examId}:${entityType}:${sourceId}`;
}

function getPackageUnits(pkg: ExamPackage): ExamUnit[] {
    return (Array.isArray(pkg.units) && pkg.units.length > 0 ? pkg.units : pkg.subjects ?? []).map((unit) => ({
        ...unit,
        unit_type: unit.unit_type ?? normalizeUnitType(pkg.manifest.unit_label, normalizeInstitutionType(pkg.manifest.institution_type ?? pkg.manifest.exam_context)),
    }));
}

function getQuestionUnitId(question: Question): string {
    return String(question.unit_id ?? question.subject_id ?? '');
}

function normalizeInstitutionType(value: unknown): string {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';

    if (['professional', 'professional_school', 'course', 'courses'].includes(normalized)) {
        return 'professional_school';
    }

    if (['secondary', 'secondary_school', 'school'].includes(normalized)) {
        return 'secondary_school';
    }

    if (['organization', 'organisation', 'corporate'].includes(normalized)) {
        return 'organization';
    }

    if (['cbt_center', 'center', 'centre', 'cbt'].includes(normalized)) {
        return 'cbt_center';
    }

    return normalized || 'cbt_center';
}

function normalizeInstitutionName(manifest: ExamManifest): string {
    const institutionName = typeof manifest.institution_name === 'string' ? manifest.institution_name.trim() : '';
    return institutionName || manifest.organization_name;
}

function normalizeUnitLabel(value: unknown, institutionType: string): string {
    const label = typeof value === 'string' ? value.trim() : '';

    if (label) {
        return label;
    }

    if (institutionType === 'professional_school') {
        return 'Course';
    }

    if (institutionType === 'organization') {
        return 'Section';
    }

    return 'Subject';
}

function normalizeUnitType(value: unknown, institutionType: string): string {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';

    if (['course', 'courses'].includes(normalized) || institutionType === 'professional_school') {
        return 'course';
    }

    if (['section', 'sections'].includes(normalized)) {
        return 'section';
    }

    if (['competency', 'competencies', 'competence'].includes(normalized)) {
        return 'competency';
    }

    return 'subject';
}

async function readJson(response: Response): Promise<unknown> {
    try {
        return await response.json() as unknown;
    } catch {
        return null;
    }
}

function extractPackagePayload(payload: unknown): unknown {
    if (!isRecord(payload)) {
        return payload;
    }

    if ('package' in payload) {
        return payload.package;
    }

    if ('exam_package' in payload) {
        return payload.exam_package;
    }

    if ('data' in payload) {
        return payload.data;
    }

    return payload;
}

function validateExamPackage(payload: unknown): ExamPackage {
    const errors: string[] = [];

    if (!isRecord(payload)) {
        throw new PackageValidationError(['Package must be a JSON object.']);
    }

    const manifest = payload.manifest;
    const subjects = payload.subjects;
    const units = payload.units;
    const questions = payload.questions;
    const options = payload.options;
    const candidates = payload.candidates;
    const papers = payload.papers;
    const sessions = payload.sessions;

    if (!isRecord(manifest)) {
        errors.push('manifest is required and must be an object.');
    } else {
        validateManifest(manifest, errors);
    }

    if (!Array.isArray(subjects) && !Array.isArray(units)) {
        errors.push('subjects or units is required and must be an array.');
    }
    if (sessions !== undefined && !Array.isArray(sessions)) {
        errors.push('sessions must be an array when provided.');
    }
    validateArray('questions', questions, errors);
    validateArray('options', options, errors);
    validateArray('candidates', candidates, errors);
    validateArray('papers', papers, errors);

    if (errors.length > 0) {
        throw new PackageValidationError(errors);
    }

    const typedPackage = payload as ExamPackage;
    const packageUnits = getPackageUnits(typedPackage);
    validateUnits(packageUnits, typedPackage.manifest.exam_id, errors);
    validateQuestions(typedPackage.questions, packageUnits, typedPackage.manifest.exam_id, errors);
    validateOptions(typedPackage.options, typedPackage.questions, errors);
    validateCandidates(typedPackage.candidates, typedPackage.manifest.exam_id, errors);
    validatePapers(typedPackage.papers, typedPackage.candidates, typedPackage.questions, typedPackage.options, errors);
    if (Array.isArray(typedPackage.sessions)) {
        validateSessions(typedPackage.sessions, typedPackage.candidates, typedPackage.manifest.exam_id, errors);
    }

    if (typedPackage.manifest.total_questions !== typedPackage.questions.length) {
        errors.push('manifest.total_questions must match questions.length.');
    }

    if (typedPackage.manifest.candidate_count !== typedPackage.candidates.length) {
        errors.push('manifest.candidate_count must match candidates.length.');
    }

    if (typedPackage.papers.length !== typedPackage.candidates.length) {
        errors.push('papers.length must match candidates.length.');
    }

    if (errors.length > 0) {
        throw new PackageValidationError(errors);
    }

    return typedPackage;
}

function validateManifest(manifest: Record<string, unknown>, errors: string[]): asserts manifest is ExamManifest {
    // Missing fields preserve legacy fixed-paper compatibility. Explicit unknown
    // capabilities must never be silently downgraded to traditional delivery.
    if ('package_contract' in manifest && manifest.package_contract !== 'alignex.fixed-paper.v1') {
        errors.push('manifest.package_contract is unsupported by this offline server.');
    }
    for (const field of ['exam_mode', 'mode']) {
        if (field in manifest && manifest[field] !== 'traditional') {
            errors.push(`manifest.${field} is unsupported: offline delivery supports traditional fixed-paper exams only.`);
        }
    }
    const stringFields = [
        'package_id',
        'exam_id',
        'exam_code',
        'title',
        'organization_name',
        'center_id',
        'start_at',
        'end_at',
    ];

    for (const field of stringFields) {
        if (!isNonEmptyString(manifest[field])) {
            errors.push(`manifest.${field} is required.`);
        }
    }

    if (!isPositiveNumber(manifest.duration_minutes)) {
        errors.push('manifest.duration_minutes must be a positive number.');
    }

    if (!isNonNegativeInteger(manifest.total_questions)) {
        errors.push('manifest.total_questions must be a non-negative integer.');
    }

    if (!isNonNegativeInteger(manifest.candidate_count)) {
        errors.push('manifest.candidate_count must be a non-negative integer.');
    }

    if (typeof manifest.shuffle_questions !== 'boolean') {
        errors.push('manifest.shuffle_questions must be a boolean.');
    }

    if (typeof manifest.shuffle_options !== 'boolean') {
        errors.push('manifest.shuffle_options must be a boolean.');
    }
}

function validateUnits(units: ExamUnit[], examId: string, errors: string[]): void {
    const ids = new Set<string>();

    if (units.length === 0) {
        errors.push('subjects or units must include at least one item.');
    }

    units.forEach((unit, index) => {
        if (!isNonEmptyString(unit.id)) errors.push(`units[${index}].id is required.`);
        if (unit.exam_id !== examId) errors.push(`units[${index}].exam_id must match manifest.exam_id.`);
        if (!isNonEmptyString(unit.name)) errors.push(`units[${index}].name is required.`);
        if (unit.code !== null && typeof unit.code !== 'string') errors.push(`units[${index}].code must be string or null.`);
        if (unit.unit_type !== null && unit.unit_type !== undefined && typeof unit.unit_type !== 'string') errors.push(`units[${index}].unit_type must be string or null.`);
        if (isNonEmptyString(unit.id)) {
            if (ids.has(unit.id)) {
                errors.push(`units[${index}].id is duplicated.`);
            }

            ids.add(unit.id);
        }
    });
}

function validateQuestions(questions: Question[], units: ExamUnit[], examId: string, errors: string[]): void {
    const unitIds = new Set(units.map((unit) => unit.id));
    const questionTypes = new Set(['single_choice', 'multiple_choice', 'short_answer', 'essay']);

    questions.forEach((question, index) => {
        const unitId = getQuestionUnitId(question);

        if (!isNonEmptyString(question.id)) errors.push(`questions[${index}].id is required.`);
        if (question.exam_id !== examId) errors.push(`questions[${index}].exam_id must match manifest.exam_id.`);
        if (!unitIds.has(unitId)) errors.push(`questions[${index}].subject_id or unit_id must reference a unit.`);
        if (!questionTypes.has(question.question_type)) errors.push(`questions[${index}].question_type is invalid.`);
        if (!isNonEmptyString(question.body)) errors.push(`questions[${index}].body is required.`);
        if (!isPositiveNumber(question.marks)) errors.push(`questions[${index}].marks must be a positive number.`);
        if (!Number.isInteger(question.display_order)) errors.push(`questions[${index}].display_order must be an integer.`);
    });
}

function validateOptions(options: QuestionOption[], questions: Question[], errors: string[]): void {
    const questionIds = new Set(questions.map((question) => question.id));

    options.forEach((option, index) => {
        if (!isNonEmptyString(option.id)) errors.push(`options[${index}].id is required.`);
        if (!questionIds.has(option.question_id)) errors.push(`options[${index}].question_id must reference a question.`);
        if (!isNonEmptyString(option.option_label)) errors.push(`options[${index}].option_label is required.`);
        if (!isNonEmptyString(option.body)) errors.push(`options[${index}].body is required.`);
        if (!Number.isInteger(option.display_order)) errors.push(`options[${index}].display_order must be an integer.`);
    });
}

function isCorrectOption(option: QuestionOption): boolean {
    const candidate = option as QuestionOption & { is_correct?: unknown; correct?: unknown };
    return candidate.is_correct === true || candidate.correct === true;
}

function validateCandidates(candidates: Candidate[], examId: string, errors: string[]): void {
    candidates.forEach((candidate, index) => {
        if (!isNonEmptyString(candidate.id)) errors.push(`candidates[${index}].id is required.`);
        if (candidate.exam_id !== examId) errors.push(`candidates[${index}].exam_id must match manifest.exam_id.`);
        if (!isNonEmptyString(candidate.candidate_no)) errors.push(`candidates[${index}].candidate_no is required.`);
        if (!isNonEmptyString(candidate.full_name)) errors.push(`candidates[${index}].full_name is required.`);
        if (candidate.photo_url !== null && typeof candidate.photo_url !== 'string') {
            errors.push(`candidates[${index}].photo_url must be string or null.`);
        }
        if (!isNonEmptyString(candidate.access_code_hash)) errors.push(`candidates[${index}].access_code_hash is required.`);
        if (candidate.group_name !== null && typeof candidate.group_name !== 'string') {
            errors.push(`candidates[${index}].group_name must be string or null.`);
        }
    });
}

function validateSessions(sessions: Array<{ id: string; exam_id: string; session_name: string; hall_name?: string | null; server_id?: string | null; status?: string | null; opened_at?: string | null; closed_at?: string | null; candidate_ids?: string[] }>, candidates: Candidate[], examId: string, errors: string[]): void {
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));

    sessions.forEach((session, index) => {
        if (!isNonEmptyString(session.id)) {
            errors.push(`sessions[${index}].id is required.`);
        }
        if (session.exam_id !== examId) {
            errors.push(`sessions[${index}].exam_id must match manifest.exam_id.`);
        }
        if (!isNonEmptyString(session.session_name)) {
            errors.push(`sessions[${index}].session_name is required.`);
        }
        if (session.hall_name !== undefined && session.hall_name !== null && typeof session.hall_name !== 'string') {
            errors.push(`sessions[${index}].hall_name must be string or null.`);
        }
        if (session.server_id !== undefined && session.server_id !== null && typeof session.server_id !== 'string') {
            errors.push(`sessions[${index}].server_id must be string or null.`);
        }
        if (session.candidate_ids !== undefined && !Array.isArray(session.candidate_ids)) {
            errors.push(`sessions[${index}].candidate_ids must be an array when provided.`);
        }
        if (Array.isArray(session.candidate_ids)) {
            for (const candidateId of session.candidate_ids) {
                if (!candidateIds.has(candidateId)) {
                    errors.push(`sessions[${index}].candidate_ids contains an unknown candidate id: ${candidateId}.`);
                }
            }
        }
    });
}

function validatePapers(papers: CandidatePaper[], candidates: Candidate[], questions: Question[], options: QuestionOption[], errors: string[]): void {
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const questionIds = new Set(questions.map((question) => question.id));
    const optionIdsByQuestion = new Map<string, Set<string>>();
    const paperCandidateIds = new Set<string>();

    for (const option of options) {
        const current = optionIdsByQuestion.get(option.question_id) ?? new Set<string>();
        current.add(option.id);
        optionIdsByQuestion.set(option.question_id, current);
    }

    papers.forEach((paper, paperIndex) => {
        if (!candidateIds.has(paper.candidate_id)) {
            errors.push(`papers[${paperIndex}].candidate_id must reference a candidate.`);
        }

        if (paperCandidateIds.has(paper.candidate_id)) {
            errors.push(`papers[${paperIndex}].candidate_id is duplicated.`);
        }

        paperCandidateIds.add(paper.candidate_id);

        if (!Array.isArray(paper.questions) || paper.questions.length === 0) {
            errors.push(`papers[${paperIndex}].questions must include at least one question.`);
            return;
        }

        const seenQuestionIds = new Set<string>();

        paper.questions.forEach((paperQuestion, questionIndex) => {
            if (!questionIds.has(paperQuestion.question_id)) {
                errors.push(`papers[${paperIndex}].questions[${questionIndex}].question_id must reference a question.`);
            }

            if (seenQuestionIds.has(paperQuestion.question_id)) {
                errors.push(`papers[${paperIndex}].questions[${questionIndex}].question_id is duplicated in this paper.`);
            }

            seenQuestionIds.add(paperQuestion.question_id);

            if (!Number.isInteger(paperQuestion.display_order) || paperQuestion.display_order < 1) {
                errors.push(`papers[${paperIndex}].questions[${questionIndex}].display_order must be a positive integer.`);
            }

            if (!Array.isArray(paperQuestion.option_order)) {
                errors.push(`papers[${paperIndex}].questions[${questionIndex}].option_order must be an array.`);
                return;
            }

            const validOptionIds = optionIdsByQuestion.get(paperQuestion.question_id) ?? new Set<string>();

            for (const optionId of paperQuestion.option_order) {
                if (!validOptionIds.has(optionId)) {
                    errors.push(`papers[${paperIndex}].questions[${questionIndex}].option_order contains an invalid option id.`);
                }
            }
        });
    });

    for (const candidate of candidates) {
        if (!paperCandidateIds.has(candidate.id)) {
            errors.push(`papers must include a paper for candidate ${candidate.candidate_no}.`);
        }
    }
}

function validateArray(field: string, value: unknown, errors: string[]): void {
    if (!Array.isArray(value)) {
        errors.push(`${field} is required and must be an array.`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
