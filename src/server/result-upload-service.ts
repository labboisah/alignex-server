import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ExamPackage } from '../contracts/exam-package.js';
import { getLocalSyncConfig } from './activation-service.js';

type Attempt = { id: string; candidate_id: string; status: string; started_at: string | null; submitted_at: string | null; score: number | null };
type Exam = { id: string; package_id: string; status: string; raw_payload: string };
type Job = { attempt_id: string; candidate_no: string; payload: string; status: string; receipt: string | null; error: string | null; updated_at: string };
type Receipt = { id: string; upload_id: string; status: string; visibility: string; official_score: number | null; score_difference: number | null; result_url: string };
const running = new Set<string>();

export function initializeResultUploads(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS result_uploads (
        attempt_id TEXT PRIMARY KEY REFERENCES candidate_attempts(id),
        exam_id TEXT NOT NULL REFERENCES imported_exams(id),
        candidate_no TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', receipt TEXT, error TEXT,
        updated_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS result_uploads_exam ON result_uploads(exam_id);`);
}

export function sourceId(examId: string, type: string, localId: string): string {
    const prefix = `${examId}:${type}:`;
    if (!localId.startsWith(prefix) || localId.length === prefix.length) throw new Error('Unrecognized local ID; original portal identity cannot be recovered.');
    return localId.slice(prefix.length);
}

export function queueResultUploads(db: Database, examId: string): void {
    const exam = db.prepare('SELECT id, package_id, status, raw_payload FROM imported_exams WHERE id = ?').get(examId) as Exam | undefined;
    if (!exam || !['closed', 'exported'].includes(exam.status)) throw new Error('Close the exam before uploading its results.');
    const pkg = JSON.parse(exam.raw_payload) as ExamPackage;
    const attempts = db.prepare("SELECT id, candidate_id, status, started_at, submitted_at, score FROM candidate_attempts WHERE exam_id = ? AND status IN ('submitted','auto_submitted','disqualified')").all(examId) as Attempt[];
    db.transaction(() => {
        for (const attempt of attempts) {
            if (db.prepare("SELECT 1 FROM result_uploads WHERE attempt_id = ? AND payload != ''").get(attempt.id)) continue;
            try {
            const candidateId = sourceId(exam.id, 'candidate', attempt.candidate_id);
            const paper = pkg.papers.find(p => p.candidate_id === candidateId);
            const candidate = pkg.candidates.find(c => c.id === candidateId);
            if (!paper || !candidate) throw new Error('Original candidate paper is missing from the downloaded package.');
            const events = db.prepare('SELECT event_type, severity, message, occurred_at FROM exam_events WHERE exam_id = ? AND (attempt_id = ? OR (attempt_id IS NULL AND candidate_id = ?)) ORDER BY occurred_at, id')
                .all(examId, attempt.id, attempt.candidate_id) as { event_type: string; severity: string; message: string; occurred_at: string }[];
            // Disqualification can terminate an attempt without setting submitted_at.
            const terminalTime = attempt.submitted_at ?? events.filter(e => /disqualif/i.test(e.event_type)).at(-1)?.occurred_at;
            if (!attempt.started_at || !terminalTime) throw new Error(`Candidate ${candidate.candidate_no} has incomplete terminal timestamps; review the local attempt.`);
            const answers = db.prepare('SELECT question_id, option_ids, text_answer, saved_at FROM candidate_answers WHERE attempt_id = ? ORDER BY question_id').all(attempt.id) as {question_id: string; option_ids: string; text_answer: string | null; saved_at: string}[];
            const payload = {
                contract: 'alignex.offline-result.v1', upload_id: randomUUID(),
                exam_id: pkg.manifest.exam_id, package_id: pkg.manifest.package_id,
                candidate_id: candidateId, attempt_id: paper.attempt_id ?? null, upload_proof: paper.upload_proof ?? null,
                status: attempt.status, started_at: attempt.started_at, submitted_at: terminalTime, local_score: attempt.score,
                paper: paper.questions.map(p => {
                    const q = pkg.questions.find(q => q.id === p.question_id);
                    if (!q) throw new Error('Original question is missing.');
                    const options = pkg.options.filter(o => o.question_id === q.id);
                    return { question_id: q.id, marks: q.marks, option_ids: options.map(o => o.id).sort(), correct_option_ids: options.filter(o => o.is_correct).map(o => o.id).sort() };
                }),
                answers: answers.map(a => ({
                    question_id: sourceId(exam.id, 'question', a.question_id),
                    selected_option_ids: (JSON.parse(a.option_ids) as string[]).map(id => sourceId(exam.id, 'option', id)),
                    answer_text: a.text_answer, saved_at: a.saved_at,
                })),
                events: events.map(e => ({...e, severity: ['info','warning','high','critical'].includes(e.severity) ? e.severity : 'info'})),
            };
            db.prepare("INSERT INTO result_uploads (attempt_id, exam_id, candidate_no, payload, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET payload = excluded.payload, status = 'pending', error = NULL, updated_at = excluded.updated_at").run(attempt.id, examId, candidate.candidate_no, JSON.stringify(payload), new Date().toISOString());
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Local attempt requires review.';
                const candidate = db.prepare('SELECT candidate_no FROM candidates WHERE id = ?').get(attempt.candidate_id) as { candidate_no: string } | undefined;
                db.prepare("INSERT INTO result_uploads (attempt_id, exam_id, candidate_no, payload, status, error, updated_at) VALUES (?, ?, ?, '', 'blocked', ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET error = excluded.error, updated_at = excluded.updated_at").run(attempt.id, examId, candidate?.candidate_no ?? attempt.candidate_id, message, new Date().toISOString());
            }
        }
    })();
}

export function resultUploadStatus(db: Database, examId: string) {
    const jobs = db.prepare('SELECT attempt_id, candidate_no, status, receipt, error, updated_at FROM result_uploads WHERE exam_id = ? ORDER BY candidate_no').all(examId) as Job[];
    return jobs.map(j => ({ attempt_id: j.attempt_id, candidate_no: j.candidate_no, status: j.status, receipt: j.receipt ? JSON.parse(j.receipt) as Receipt : null, error: j.error, updated_at: j.updated_at }));
}

export async function uploadExamResults(db: Database, databasePath: string, examId: string, transport: typeof fetch = fetch) {
    if (running.has(examId)) throw new Error('An upload is already running for this exam.');
    running.add(examId);
    try {
        queueResultUploads(db, examId);
        const config = getLocalSyncConfig(db, databasePath);
        if (!config.portal_url || !config.sync_token || !config.device_id) throw new Error('Portal activation credentials are incomplete. Reactivate the server.');
        const base = new URL(config.portal_url);
        if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))) throw new Error('Result uploads require HTTPS (except local development).');
        const url = `${config.portal_url.replace(/\/$/, '')}/api/offline/results`;
        const jobs = db.prepare("SELECT * FROM result_uploads WHERE exam_id = ? AND status != 'accepted' AND payload != '' ORDER BY candidate_no").all(examId) as Job[];
        for (const job of jobs) {
            try {
                const response = await transport(url, {
                    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${config.sync_token}`, 'X-AlignEx-Device-Id': config.device_id },
                    body: job.payload,
                });
                const data = await response.json() as {receipt?: Receipt; message?: string};
                if (!response.ok) throw new Error(data.message ?? `Portal returned HTTP ${response.status}.`);
                if (!data.receipt?.id || data.receipt.status !== 'accepted' || data.receipt.upload_id !== JSON.parse(job.payload).upload_id) throw new Error('Portal did not acknowledge this upload.');
                db.prepare("UPDATE result_uploads SET status = 'accepted', receipt = ?, error = NULL, updated_at = ? WHERE attempt_id = ?").run(JSON.stringify(data.receipt), new Date().toISOString(), job.attempt_id);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Connection failed. Retry when the portal is reachable.';
                db.prepare("UPDATE result_uploads SET status = 'error', error = ?, updated_at = ? WHERE attempt_id = ?").run(message.slice(0, 2000), new Date().toISOString(), job.attempt_id);
            }
        }
        return resultUploadStatus(db, examId);
    } finally {
        running.delete(examId);
    }
}
