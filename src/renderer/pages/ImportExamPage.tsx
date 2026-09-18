import { CheckCircle2, CloudDownload, FileJson, Info, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

type ImportSummary = {
    exam_id: string;
    exam_code: string;
    title: string;
    organization_name: string;
    institution_name: string;
    institution_type: string;
    unit_label: string;
    candidate_count: number;
    question_count: number;
    duration_minutes: number;
    status: string;
};

type ToastState = {
    tone: 'success' | 'danger';
    message: string;
};

type ImportStage = 'idle' | 'validating' | 'importing' | 'success' | 'failed';

const apiBaseUrl = 'http://127.0.0.1:4080';

export function ImportExamPage({ onViewImportedExams }: { onViewImportedExams: () => void }) {
    const [stage, setStage] = useState<ImportStage>('idle');
    const [errors, setErrors] = useState<string[]>([]);
    const [summary, setSummary] = useState<ImportSummary | null>(null);
    const [toast, setToast] = useState<ToastState | null>(null);
    const [examCode, setExamCode] = useState('');

    const importing = stage === 'validating' || stage === 'importing';

    function showToast(nextToast: ToastState) {
        setToast(nextToast);
        window.setTimeout(() => setToast(null), 4200);
    }

    async function importPackageByCode() {
        if (!examCode.trim() || importing) {
            return;
        }

        try {
            setErrors([]);
            setSummary(null);
            setStage('validating');

            setStage('importing');
            const response = await fetch(`${apiBaseUrl}/api/exams/import-code`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    exam_code: examCode.trim(),
                }),
            });

            const data = await response.json() as { summary?: ImportSummary; message?: string; errors?: string[] };

            if (!response.ok) {
                throw new ImportError(data.errors ?? [data.message ?? `Import failed with status ${response.status}.`]);
            }

            setSummary(data.summary ?? null);
            setStage('success');
            showToast({ tone: 'success', message: 'Exam fetched successfully.' });
        } catch (caught) {
            const nextErrors = caught instanceof ImportError
                ? caught.errors
                : [caught instanceof Error ? caught.message : 'Exam fetch failed.'];

            setErrors(nextErrors);
            setStage('failed');
            showToast({ tone: 'danger', message: 'Exam fetch failed.' });
        }
    }

    return (
        <div className="space-y-6">
            {toast && <Toast tone={toast.tone} message={toast.message} />}

            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-semibold text-slateDark">Fetch Online Exam</h1>
                    <p className="mt-1 text-sm text-slate-500">
                        Bring an exam prepared on the AlignEx portal into this center server for offline delivery.
                    </p>
                </div>

                <Button onClick={onViewImportedExams} type="button" variant="secondary">
                    View Imported Exams
                </Button>
            </div>

            <Alert>
                <Info className="absolute left-4 top-4 h-4 w-4 text-info" />
                <div className="pl-6">
                    <AlertTitle>Online fetch is the source of truth</AlertTitle>
                    <AlertDescription>
                        Create and schedule exams on the portal, then fetch the approved exam here using its exam code.
                    </AlertDescription>
                </div>
            </Alert>

            <Card>
                <CardHeader>
                    <CardTitle>Fetch Exam Package</CardTitle>
                    <CardDescription>Enter the online exam code configured on the portal.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-4 rounded-md border border-border bg-lightBackground p-4">
                        <div>
                            <label className="text-sm font-semibold text-slateDark" htmlFor="exam-code">
                                Online exam code
                            </label>
                            <div className="relative mt-2">
                                <FileJson className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                                <input
                                    autoFocus
                                    className="h-11 w-full rounded-md border border-border bg-white pl-9 pr-3 text-sm font-medium uppercase text-slateDark outline-none transition-colors placeholder:normal-case placeholder:font-normal placeholder:text-slate-400 focus:border-primary focus:ring-2 focus:ring-primary/15"
                                    id="exam-code"
                                    onChange={(event) => setExamCode(event.target.value.toUpperCase())}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                            void importPackageByCode();
                                        }
                                    }}
                                    placeholder="Example: MTH-JSS3-001"
                                    value={examCode}
                                />
                            </div>
                        </div>

                        <div className="flex flex-wrap gap-3">
                            <Button disabled={!examCode.trim() || importing} onClick={() => void importPackageByCode()}>
                                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
                                Fetch Exam
                            </Button>
                        </div>
                    </div>

                    <ValidationProgress stage={stage} />

                    {errors.length > 0 && (
                        <Alert className="border-danger/30 bg-danger/5">
                            <XCircle className="absolute left-4 top-4 h-4 w-4 text-danger" />
                            <div className="pl-6">
                                <AlertTitle>Fetch failed</AlertTitle>
                                <AlertDescription>
                                    <ul className="mt-2 list-disc space-y-1 pl-4">
                                        {errors.map((error) => <li key={error}>{error}</li>)}
                                    </ul>
                                </AlertDescription>
                            </div>
                        </Alert>
                    )}
                </CardContent>
            </Card>

            {summary && <ImportSummaryCard summary={summary} onViewImportedExams={onViewImportedExams} />}
        </div>
    );
}

class ImportError extends Error {
    readonly errors: string[];

    constructor(errors: string[]) {
        super('Import failed.');
        this.errors = errors;
    }
}

function ValidationProgress({ stage }: { stage: ImportStage }) {
    const steps = [
        { id: 'validating', label: 'Verify code' },
        { id: 'importing', label: 'Fetch and save' },
    ] as const;

    return (
        <div className="grid gap-2 rounded-md border border-border bg-white p-3 sm:grid-cols-2">
            {steps.map((step) => {
                const active = stage === step.id;
                const complete = stage === 'success' || steps.findIndex((item) => item.id === stage) > steps.findIndex((item) => item.id === step.id);

                return (
                    <div key={step.id} className="flex items-center gap-2 text-sm">
                        {active ? (
                            <Loader2 className="h-4 w-4 animate-spin text-info" />
                        ) : complete ? (
                            <CheckCircle2 className="h-4 w-4 text-success" />
                        ) : (
                            <span className="h-4 w-4 rounded-full border border-border" />
                        )}
                        <span className={active || complete ? 'font-semibold text-slateDark' : 'text-slate-500'}>{step.label}</span>
                    </div>
                );
            })}
        </div>
    );
}

function ImportSummaryCard({ summary, onViewImportedExams }: { summary: ImportSummary; onViewImportedExams: () => void }) {
    const items = [
        ['Exam Title', summary.title],
        ['Exam Code', summary.exam_code],
        ['Organization', summary.organization_name],
        ['Institution', summary.institution_name],
        ['Context', formatContext(summary.institution_type)],
        ['Unit Label', summary.unit_label],
        ['Candidates', String(summary.candidate_count)],
        ['Questions', String(summary.question_count)],
        ['Duration', `${summary.duration_minutes} minutes`],
        ['Status', summary.status],
    ];

    return (
        <Card className="border-success/30">
            <CardHeader>
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <CardTitle className="flex items-center gap-2">
                            <CheckCircle2 className="h-5 w-5 text-success" />
                            Exam Fetched
                        </CardTitle>
                        <CardDescription>The exam is ready on this center server.</CardDescription>
                    </div>
                    <Button onClick={onViewImportedExams} variant="secondary">View Imported Exams</Button>
                </div>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-4">
                {items.map(([label, value]) => (
                    <div key={label} className="min-w-0">
                        <div className="text-xs font-medium uppercase text-slate-500">{label}</div>
                        <div className="mt-1 truncate font-semibold text-slateDark">{value}</div>
                    </div>
                ))}
            </CardContent>
        </Card>
    );
}

function formatContext(value: string): string {
    return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function Toast({ tone, message }: ToastState) {
    return (
        <div className="fixed right-6 top-6 z-50 rounded-md border border-border bg-white px-4 py-3 shadow-lg">
            <div className="flex items-center gap-3 text-sm font-semibold text-slateDark">
                {tone === 'success' ? <CheckCircle2 className="h-5 w-5 text-success" /> : <XCircle className="h-5 w-5 text-danger" />}
                {message}
            </div>
        </div>
    );
}
