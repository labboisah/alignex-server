import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDatabase } from '../dist/server/database.js';
import { importExamPackage } from '../dist/server/exam-import-service.js';
import { initializeResultUploads, queueResultUploads, resultUploadStatus, sourceId, uploadExamResults } from '../dist/server/result-upload-service.js';

const sample = JSON.parse(readFileSync(new URL('./fixtures/traditional-package.json', import.meta.url), 'utf8'));
function fixture(t) {
    // Keep test data in a known workspace path; no runtime examination database is touched.
    const dir = resolve('.test-artifacts', 'uploads-' + randomUUID());
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'test.sqlite');
    const db = createDatabase(path);
    t.after(() => { if (db.connection.open) db.connection.close(); });
    const pkg = structuredClone(sample);
    pkg.papers.forEach((paper, index) => { paper.attempt_id = 'portal-attempt-' + index; paper.upload_proof = 'signed-proof-' + index; });
    importExamPackage(db.connection, pkg);
    initializeResultUploads(db.connection);
    const examId = pkg.manifest.exam_id;
    db.connection.prepare("UPDATE imported_exams SET status = 'exported' WHERE id = ?").run(examId);
    db.connection.prepare("UPDATE candidate_attempts SET status = 'submitted', started_at = '2026-09-12T10:00:00Z', submitted_at = '2026-09-12T10:10:00Z', score = 9 WHERE exam_id = ?").run(examId);
    writeFileSync(join(dir, 'center-config.json'), JSON.stringify({ version: 1, portal_url: 'https://portal.example.test', admin_email: 'admin@example.test', admin_password: 'test-password', sync_token: 'test-token', device_id: 'test-device' }));
    return { db, path, pkg, examId };
}

test('ID conversion uses the exact exam prefix and retains source colons', () => {
    assert.equal(sourceId('exam:a', 'question', 'exam:a:question:source:b'), 'source:b');
    assert.throws(() => sourceId('exam:a', 'question', 'exam:b:question:source'));
});

test('exported exams queue portal IDs and signed proofs without local scoring authority', t => {
    const { db, pkg, examId } = fixture(t);
    queueResultUploads(db.connection, examId);
    const jobs = db.connection.prepare('SELECT * FROM result_uploads').all();
    assert.equal(jobs.length, pkg.papers.length);
    const payload = JSON.parse(jobs[0].payload);
    assert.equal(payload.exam_id, examId);
    assert.equal(payload.attempt_id, pkg.papers[0].attempt_id);
    assert.equal(payload.upload_proof, pkg.papers[0].upload_proof);
    assert.ok(pkg.candidates.some(c => c.id === payload.candidate_id));
    assert.ok(payload.paper.every(q => pkg.questions.some(source => source.id === q.question_id)));
    assert.equal('scores' in payload, false);
    queueResultUploads(db.connection, examId);
    assert.equal(db.connection.prepare('SELECT count(*) AS count FROM result_uploads').get().count, jobs.length);
});

test('lost acknowledgement survives restart and retries exactly the same payload', async t => {
    const { db, path, examId } = fixture(t);
    const bodies = new Map();
    await uploadExamResults(db.connection, path, examId, async (url, options) => {
        assert.equal(url, 'https://portal.example.test/api/offline/results');
        const body = JSON.parse(options.body);
        bodies.set(body.upload_id, options.body);
        throw new Error('Acknowledgement lost');
    });
    assert.ok(resultUploadStatus(db.connection, examId).every(row => row.status === 'error'));
    db.connection.close();
    const reopened = createDatabase(path);
    t.after(() => reopened.connection.close());
    initializeResultUploads(reopened.connection);
    const rows = await uploadExamResults(reopened.connection, path, examId, async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(options.body, bodies.get(body.upload_id));
        return new Response(JSON.stringify({ receipt: { id: 'receipt-' + body.upload_id, upload_id: body.upload_id, status: 'accepted', visibility: 'held', official_score: 5, score_difference: -4, result_url: 'https://portal.example.test/candidate-result' } }));
    });
    assert.ok(rows.every(row => row.status === 'accepted' && row.receipt.visibility === 'held'));
    await uploadExamResults(reopened.connection, path, examId, async () => assert.fail('Acknowledged results must not be resent'));
});

test('portal rejection or wrong acknowledgement cannot mark results uploaded', async t => {
    const { db, path, examId } = fixture(t);
    let rows = await uploadExamResults(db.connection, path, examId, async () => new Response(JSON.stringify({ message: 'Paper changed' }), { status: 409 }));
    assert.ok(rows.every(row => row.status === 'error' && row.error === 'Paper changed'));
    rows = await uploadExamResults(db.connection, path, examId, async () => new Response(JSON.stringify({ receipt: { id: 'wrong', upload_id: 'another-upload', status: 'accepted' } })));
    assert.ok(rows.every(row => row.status === 'error'));
});

test('active exams cannot be uploaded', t => {
    const { db, examId } = fixture(t);
    db.connection.prepare("UPDATE imported_exams SET status = 'active' WHERE id = ?").run(examId);
    assert.throws(() => queueResultUploads(db.connection, examId), /Close the exam/);
});


test('one incomplete local attempt does not prevent queuing other candidates', t => {
    const { db, examId, pkg } = fixture(t);
    assert.ok(pkg.candidates.length > 1, 'Fixture must contain multiple candidates');
    const first = db.connection.prepare('SELECT id FROM candidate_attempts ORDER BY id LIMIT 1').get();
    db.connection.prepare('UPDATE candidate_attempts SET submitted_at = NULL WHERE id = ?').run(first.id);
    queueResultUploads(db.connection, examId);
    const rows = resultUploadStatus(db.connection, examId);
    assert.equal(rows.filter(row => row.status === 'blocked').length, 1);
    assert.equal(rows.filter(row => row.status === 'pending').length, pkg.candidates.length - 1);
    db.connection.prepare("UPDATE candidate_attempts SET submitted_at = '2026-09-12T10:10:00Z' WHERE id = ?").run(first.id);
    queueResultUploads(db.connection, examId);
    assert.ok(resultUploadStatus(db.connection, examId).every(row => row.status === 'pending'));
});


test('local upload and receipt endpoints require an active administrator', async t => {
    const { startCenterServer } = await import('../dist/server/app.js');
    const { pbkdf2Sync } = await import('node:crypto');
    const dir = resolve('.test-artifacts', 'upload-auth-' + randomUUID());
    mkdirSync(dir, { recursive: true });
    const server = await startCenterServer({ port: 0, storagePath: join(dir, 'test.sqlite') });
    t.after(() => server.stop());
    const port = server.httpServer.address().port;
    const url = 'http://127.0.0.1:' + port;
    assert.equal((await fetch(url + '/api/results/uploads/test')).status, 401);
    assert.equal((await fetch(url + '/api/results/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exam_id: 'test' }) })).status, 401);
    const password = pbkdf2Sync('test-password', 'test-salt', 120000, 32, 'sha256').toString('hex');
    server.database.connection.prepare("INSERT INTO local_users (id, name, email, password_hash, password_salt, role, status) VALUES ('admin', 'Admin', 'admin@example.test', ?, 'test-salt', 'admin', 'active')").run(password);
    const headers = { 'X-AlignEx-Admin-Email': 'admin@example.test', 'X-AlignEx-Admin-Password': 'test-password' };
    assert.equal((await fetch(url + '/api/results/uploads/test', { headers })).status, 200);
    server.database.connection.prepare("UPDATE local_users SET status = 'disabled' WHERE id = 'admin'").run();
    assert.equal((await fetch(url + '/api/results/uploads/test', { headers })).status, 401);
});
