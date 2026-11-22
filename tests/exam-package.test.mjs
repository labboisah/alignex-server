import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDatabase } from '../dist/server/database.js';
import { importExamPackage, PackageValidationError } from '../dist/server/exam-import-service.js';

const sample = JSON.parse(readFileSync(new URL('./fixtures/traditional-package.json', import.meta.url), 'utf8'));
function database(t) {
    const dir = mkdtempSync(join(tmpdir(), 'alignex-package-test-'));
    const db = createDatabase(join(dir, 'test.sqlite'));
    t.after(() => { db.connection.close(); rmSync(dir, { recursive: true, force: true }); });
    return db.connection;
}

for (const context of ['organization', 'institution', 'professional_school', 'secondary_school', 'cbt_center']) {
    for (const legacy of [true, false]) {
        test(context + (legacy ? ' legacy' : ' versioned') + ' traditional package imports', t => {
            const connection = database(t);
            const pkg = structuredClone(sample);
            pkg.manifest.institution_type = context;
            pkg.manifest.exam_context = context;
            if (!legacy) Object.assign(pkg.manifest, { package_contract: 'alignex.fixed-paper.v1', exam_mode: 'traditional' });
            const result = importExamPackage(connection, pkg);
            assert.equal(result.exam_id, pkg.manifest.exam_id);
            assert.equal(result.institution_type, context);
            assert.equal(connection.prepare('SELECT count(*) AS count FROM candidate_papers').get().count,
                pkg.papers.reduce((count, paper) => count + paper.questions.length, 0));
            assert.equal(connection.prepare('SELECT count(*) AS count FROM imported_exams').get().count, 1);
            assert.equal(connection.prepare('SELECT count(*) AS count FROM candidates').get().count, pkg.candidates.length);
        });
    }
}
for (const fields of [
    { exam_mode: 'adaptive' }, { mode: 'adaptive' },
    { exam_mode: 'traditional', mode: 'adaptive' },
    { package_contract: 'alignex.adaptive.v1' },
    { package_contract: 'alignex.fixed-paper.v2' },
    { exam_mode: null }, { package_contract: null },
    { exam_mode: 'ADAPTIVE' }, { exam_mode: 'future-mode' },
]) {
    test('unsupported manifest rejected before SQLite access: ' + JSON.stringify(fields), () => {
        const pkg = structuredClone(sample);
        Object.assign(pkg.manifest, fields);
        const connection = new Proxy({}, { get() { assert.fail('Unsupported package accessed SQLite'); } });
        assert.throws(() => importExamPackage(connection, pkg), error =>
            error instanceof PackageValidationError && error.errors.some(value => value.includes('unsupported')));
    });
}
test('rejection leaves an existing traditional import untouched', t => {
    const connection = database(t);
    importExamPackage(connection, structuredClone(sample));
    const before = connection.prepare('SELECT * FROM imported_exams').all();
    const pkg = structuredClone(sample);
    pkg.manifest.exam_mode = 'adaptive';
    assert.throws(() => importExamPackage(connection, pkg), PackageValidationError);
    assert.deepEqual(connection.prepare('SELECT * FROM imported_exams').all(), before);
});

test('session-aware package imports with session records and keeps the flat flow as default', t => {
    const connection = database(t);
    const pkg = structuredClone(sample);
    pkg.sessions = [
        {
            id: 'session-hall-a',
            exam_id: pkg.manifest.exam_id,
            session_name: 'Hall A - Morning',
            hall_name: 'Hall A',
            server_id: 'server-hall-a',
            status: 'ready',
            candidate_ids: [pkg.candidates[0].id],
        },
        {
            id: 'session-hall-b',
            exam_id: pkg.manifest.exam_id,
            session_name: 'Hall B - Morning',
            hall_name: 'Hall B',
            server_id: 'server-hall-b',
            status: 'ready',
            candidate_ids: [pkg.candidates[1].id],
        },
    ];

    const result = importExamPackage(connection, pkg);
    assert.equal(result.exam_id, pkg.manifest.exam_id);
    assert.equal(connection.prepare('SELECT count(*) AS count FROM exam_sessions').get().count, 2);
    assert.deepEqual(
        connection.prepare('SELECT session_name, hall_name, server_id FROM exam_sessions ORDER BY session_name').all(),
        [
            { session_name: 'Hall A - Morning', hall_name: 'Hall A', server_id: 'server-hall-a' },
            { session_name: 'Hall B - Morning', hall_name: 'Hall B', server_id: 'server-hall-b' },
        ],
    );
});
