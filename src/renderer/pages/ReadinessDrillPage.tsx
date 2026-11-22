import { AlertTriangle, CheckCircle2, Download, Eye, FileCheck2, Loader2, Play, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

type Drill = {
    id: string;
    name: string;
    status: 'draft' | 'preflight' | 'ready' | 'running' | 'completed' | 'failed';
    mode: string;
    content_pack_version: string;
    duration_seconds: number;
    expected_clients: number;
    connected_clients_at_start: number;
    total_questions: number;
    started_at: string | null;
    closed_at: string | null;
    report_status: string;
    package_code?: string | null;
    capacity_profile?: number | null;
    autoboot_target_clients?: number | null;
};

type ReadinessPackage = { code: string; version: string; capacity_profile: number; autoboot_target_clients: number; question_count: number };
type MonitorClient = { client_id: string; client_key: string; candidate_label?: string; ip_address?: string | null; user_agent?: string | null; client_status: string; preflight_status?: 'pending' | 'ready' | 'failed'; preflight_checked_at?: string | null; network_latency_ms?: number; network_jitter_ms?: number; packet_loss_percent?: number; network_download_mbps?: number; network_upload_mbps?: number; machine_memory_bytes?: number; machine_cpu_percent?: number; disk_free_gb?: number; time_offset_ms?: number; connected_at: string; last_heartbeat_at: string; reconnect_count?: number; heartbeat_miss_count?: number; error_count?: number; average_rtt_ms?: number; last_rtt_ms?: number; memory_rss_bytes?: number; memory_private_bytes?: number; attempt_id?: string; attempt_status?: string; current_question_order?: number; answered_count?: number; total_questions?: number; remaining_questions?: number; deadline_at?: string | null; submitted_at?: string | null };
type Monitor = { drill: Drill; clients: MonitorClient[]; counts: Record<string, number>; metrics?: { process_rss_bytes: number; process_heap_used_bytes: number; database_size_bytes: number; wal_size_bytes: number; acknowledged_answer_count: number; readiness_event_count: number; sampled_at: string } };
type Visualization = { drill: Drill; attempt: { status: string; answered_count: number; total_questions: number; current_question_order: number; deadline_at: string | null }; answers: Array<{ question_id: string; question_order: number; option_label: string; sequence_number: number; acknowledged_at: string }>; manifest: { subjects: Array<{ name: string; questions: Array<{ id: string; body: string; options: Array<{ label: string; text: string }> }> }> } };

type Report = {
    status: 'ready' | 'incomplete';
    expected_clients: number;
    connected_clients: number;
    completed_clients: number;
    failed_clients: number;
    total_questions: number;
    total_answers: number;
    total_submissions: number;
    event_count: number;
    payload_hash: string;
    payload?: { assessment?: { outcome: string; overall_score: number; factors: { completion_rate: number; acknowledgement_rate: number; network_score: number; reliability_score: number; resource_score: number } } };
};
type ReportPreview = { report: Report; clients: Array<{ client_key: string; ip_address?: string | null; user_agent?: string | null; operating_system?: string; client_status: string; attempt_status?: string; answered_count?: number; total_questions?: number; submitted_at?: string | null; reconnect_count?: number; heartbeat_miss_count?: number; error_count?: number; average_rtt_ms?: number; memory_rss_bytes?: number; average_memory_rss_bytes?: number | null; memory_rss_peak_bytes?: number; memory_sample_count?: number }>; events: Array<{ event_type: string; severity: string; message: string; occurred_at: string }> };

type ReadinessClient = { client_id: string; connected_at: string; last_heartbeat_at: string; user_agent: string | null; paper_ready: boolean; preflight_status?: 'pending' | 'ready' | 'failed'; network_latency_ms?: number; network_jitter_ms?: number; packet_loss_percent?: number; network_download_mbps?: number; network_upload_mbps?: number; machine_memory_bytes?: number; machine_cpu_percent?: number; disk_free_gb?: number; time_offset_ms?: number };
type ReadinessDevice = { id: string; drill_id: string; device_fingerprint: string; device_label: string | null; status: string; enrolled_at: string };

const apiBaseUrl = 'http://127.0.0.1:4080';

export function ReadinessDrillPage({ localAdminSessionToken }: { localAdminSessionToken: string }) {
    const [drills, setDrills] = useState<Drill[]>([]);
    const [name, setName] = useState('Center Readiness Drill');
    const [expectedClients, setExpectedClients] = useState('1');
    const [durationSeconds, setDurationSeconds] = useState('300');
    const [singleClientSmokeTest, setSingleClientSmokeTest] = useState(true);
    const [busy, setBusy] = useState<'load' | 'create' | string | null>(null);
    const [message, setMessage] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);
    const [reports, setReports] = useState<Record<string, Report>>({});
    const [clients, setClients] = useState<Record<string, ReadinessClient[]>>({});
    const [currentTime, setCurrentTime] = useState(Date.now());
    const [packages, setPackages] = useState<ReadinessPackage[]>([]);
    const [packageCode, setPackageCode] = useState('');
    const [importCode, setImportCode] = useState('');
    const [adminPassword, setAdminPassword] = useState('');
    const [monitors, setMonitors] = useState<Record<string, Monitor>>({});
    const [visualization, setVisualization] = useState<Visualization | null>(null);
    const [reportPreview, setReportPreview] = useState<ReportPreview | null>(null);
    const [enrolledDevices, setEnrolledDevices] = useState<Record<string, ReadinessDevice[]>>({});
    const [deviceFingerprint, setDeviceFingerprint] = useState('');
    const [deviceLabel, setDeviceLabel] = useState('');

    useEffect(() => {
        void refresh();
    }, []);

    useEffect(() => {
        if (drills.some((drill) => drill.status === 'preflight' || drill.status === 'ready' || drill.status === 'running')) {
            const timer = window.setInterval(() => void refresh(), 3000);
            return () => window.clearInterval(timer);
        }
        return undefined;
    }, [drills]);

    useEffect(() => {
        const timer = window.setInterval(() => setCurrentTime(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    async function refresh() {
        setBusy('load');
        try {
            const response = await fetch(`${apiBaseUrl}/api/readiness/drills`, { headers: sessionHeaders(localAdminSessionToken) });
            const data = await readJson<{ drills?: Drill[]; message?: string }>(response, 'readiness drills');
            if (!response.ok) throw new Error(data.message ?? `Unable to load readiness drills (HTTP ${response.status}).`);
            setDrills(data.drills ?? []);
            const packageResponse = await fetch(`${apiBaseUrl}/api/readiness/packages`, { headers: sessionHeaders(localAdminSessionToken) });
            const packageData = await readJson<{ packages?: ReadinessPackage[]; message?: string }>(packageResponse, 'readiness packages');
            if (!packageResponse.ok) throw new Error(`Package list failed (${packageResponse.status}). ${JSON.stringify(packageData)}`);
            setPackages(packageData.packages ?? []);
            await Promise.all((data.drills ?? []).map(async (drill) => {
                const clientsResponse = await fetch(`${apiBaseUrl}/api/readiness/drills/${drill.id}/clients`, { headers: sessionHeaders(localAdminSessionToken) });
                const clientsData = await readJson<{ clients?: ReadinessClient[] }>(clientsResponse, `clients for drill ${drill.id}`);
                setClients((current) => ({ ...current, [drill.id]: clientsData.clients ?? [] }));
                const devicesResponse = await fetch(`${apiBaseUrl}/api/readiness/drills/${drill.id}/devices`, { headers: sessionHeaders(localAdminSessionToken) });
                const devicesData = await readJson<{ devices?: ReadinessDevice[] }>(devicesResponse, `enrolled devices for drill ${drill.id}`);
                if (devicesResponse.ok) setEnrolledDevices((current) => ({ ...current, [drill.id]: devicesData.devices ?? [] }));
                if (['preflight', 'ready', 'running', 'completed'].includes(drill.status)) {
                    const monitorResponse = await fetch(`${apiBaseUrl}/api/readiness/drills/${drill.id}/monitor`, { headers: sessionHeaders(localAdminSessionToken) });
                    if (monitorResponse.ok) {
                        const monitorData = await readJson<Monitor>(monitorResponse, `monitor for drill ${drill.id}`);
                        setMonitors((current) => ({ ...current, [drill.id]: monitorData }));
                    }
                }
            }));
        } catch (error) {
            setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Unable to load readiness drills.' });
        } finally {
            setBusy(null);
        }
    }

    async function create(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy('create');
        setMessage(null);
        try {
            const response = await fetch(`${apiBaseUrl}/api/readiness/drills`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...sessionHeaders(localAdminSessionToken) },
                body: JSON.stringify({ name, expected_clients: singleClientSmokeTest ? 1 : Number(expectedClients), duration_seconds: Number(durationSeconds), package_code: packageCode, mode: singleClientSmokeTest ? 'single_client_smoke' : 'synthetic_full' }),
            });
            const data = await readJson<{ drill?: Drill; message?: string }>(response, 'create readiness drill');
            if (!response.ok) throw new Error(data.message ?? 'Unable to create readiness drill.');
            setMessage({ tone: 'success', text: 'Readiness drill created. Connect the expected clients before starting.' });
            await refresh();
        } catch (error) {
            setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Unable to create readiness drill.' });
        } finally {
            setBusy(null);
        }
    }

    async function importPackage(event?: FormEvent<HTMLFormElement>) {
        event?.preventDefault();
        const requestedCode = importCode.trim();
        if (!requestedCode) {
            setMessage({ tone: 'danger', text: 'Enter an Autoboot package code first.' });
            return;
        }
        setBusy('import-package');
        setMessage({ tone: 'info', text: `Import request sent for ${requestedCode}...` });
        try {
            const response = await fetch(`${apiBaseUrl}/api/readiness/packages/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...sessionHeaders(localAdminSessionToken) },
                body: JSON.stringify({ code: requestedCode, admin_password: adminPassword }),
            });
            const data = await readJson<{ package?: ReadinessPackage; message?: string }>(response, 'Autoboot package import');
            if (!response.ok || !data.package) throw new Error(data.message ?? 'Unable to import Autoboot package. Use an active Autoboot package code, not an exam code.');
            setImportCode('');
            setPackages((current) => [data.package as ReadinessPackage, ...current.filter((item) => item.code !== data.package?.code)]);
            setMessage({ tone: 'success', text: `Autoboot package ${data.package.code} imported successfully.` });
        } catch (error) {
            setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Unable to import Autoboot package.' });
        } finally {
            setBusy(null);
        }
    }

    async function start(drill: Drill) {
        setBusy(drill.id);
        setMessage(null);
        try {
            const response = await fetch(`${apiBaseUrl}/api/readiness/drills/${drill.id}/start`, { method: 'POST', headers: sessionHeaders(localAdminSessionToken) });
            const data = await readJson<{ drill?: Drill; message?: string }>(response, 'start readiness drill');
            if (!response.ok) throw new Error(data.message ?? 'Unable to start readiness drill.');
            setMessage({ tone: 'success', text: 'Readiness drill started. Connected readiness clients are submitting synthetic answers automatically.' });
            await refresh();
        } catch (error) {
            setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Unable to start readiness drill.' });
        } finally {
            setBusy(null);
        }
    }

    async function enrollDevice(drill: Drill) {
        setBusy(`enroll-${drill.id}`);
        try {
            const response = await fetch(`${apiBaseUrl}/api/readiness/drills/${drill.id}/devices`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...sessionHeaders(localAdminSessionToken) },
                body: JSON.stringify({ device_fingerprint: deviceFingerprint, device_label: deviceLabel }),
            });
            const data = await readJson<{ message?: string }>(response, 'enroll readiness device');
            if (!response.ok) throw new Error(data.message ?? 'Unable to enroll the readiness device.');
            setDeviceFingerprint('');
            setDeviceLabel('');
            setMessage({ tone: 'success', text: 'Readiness device enrolled. It may now enable Autoboot for this drill.' });
            await refresh();
        } catch (error) {
            setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Unable to enroll the readiness device.' });
        } finally { setBusy(null); }
    }

    async function remove(drill: Drill) {
        if (!window.confirm(`Delete the readiness drill "${drill.name}" and its local report data?`)) return;
        setBusy(`delete-${drill.id}`);
        setMessage(null);
        try {
            const response = await fetch(`${apiBaseUrl}/api/readiness/drills/${drill.id}`, { method: 'DELETE', headers: sessionHeaders(localAdminSessionToken) });
            if (!response.ok) {
                const data = await response.json().catch(() => ({ message: `Center Server returned HTTP ${response.status}.` })) as { message?: string };
                throw new Error(data.message ?? `Unable to delete readiness drill (HTTP ${response.status}).`);
            }
            setMessage({ tone: 'success', text: 'Readiness drill deleted.' });
            await refresh();
        } catch (error) {
            setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Unable to delete readiness drill.' });
        } finally {
            setBusy(null);
        }
    }

    async function finalize(drill: Drill) {
        setBusy(`finalize-${drill.id}`);
        try {
            const response = await fetch(`${apiBaseUrl}/api/readiness/drills/${drill.id}/finalize`, { method: 'POST', headers: sessionHeaders(localAdminSessionToken) });
            const data = await readJson<{ report?: Report; message?: string }>(response, 'finalize readiness report');
            if (!response.ok || !data.report) throw new Error(data.message ?? 'Unable to finalize readiness report.');
            setReports((current) => ({ ...current, [drill.id]: data.report as Report }));
            setMessage({ tone: 'success', text: 'Readiness report finalized and stored locally.' });
            await refresh();
        } catch (error) {
            setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Unable to finalize readiness report.' });
        } finally {
            setBusy(null);
        }
    }

    async function upload(drill: Drill) {
        setBusy(`upload-${drill.id}`);
        try {
            const response = await fetch(`${apiBaseUrl}/api/readiness/drills/${drill.id}/report/upload`, { method: 'POST', headers: sessionHeaders(localAdminSessionToken) });
            const data = await readJson<{ status?: string; message?: string }>(response, 'upload readiness report');
            if (!response.ok) throw new Error(data.message ?? 'Unable to upload readiness report.');
            setMessage({ tone: 'success', text: `Readiness report ${data.status ?? 'accepted'} by the portal.` });
            await refresh();
        } catch (error) {
            setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Unable to upload readiness report.' });
        } finally {
            setBusy(null);
        }
    }

    async function previewReport(drill: Drill) {
        setBusy(`preview-${drill.id}`);
        try {
            const response = await fetch(`${apiBaseUrl}/api/readiness/drills/${drill.id}/report/preview`, { headers: sessionHeaders(localAdminSessionToken) });
            const data = await readJson<ReportPreview & { message?: string }>(response, 'readiness report preview');
            if (!response.ok) throw new Error(data.message ?? `Unable to load report preview (HTTP ${response.status}).`);
            setReportPreview(data);
        } catch (error) { setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Unable to load report preview.' }); }
        finally { setBusy(null); }
    }

    async function downloadEvidence(drill: Drill) {
        setBusy(`download-${drill.id}`);
        try {
            const response = await fetch(`${apiBaseUrl}/api/readiness/drills/${drill.id}/report/download`, { headers: sessionHeaders(localAdminSessionToken) });
            if (!response.ok) {
                const data = await readJson<{ message?: string }>(response, 'readiness evidence download');
                throw new Error(data.message ?? `Unable to download readiness evidence (HTTP ${response.status}).`);
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `alignex-readiness-evidence-${drill.id}.zip`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            setMessage({ tone: 'success', text: 'Server readiness evidence downloaded.' });
        } catch (error) {
            setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Unable to download readiness evidence.' });
        } finally {
            setBusy(null);
        }
    }

    function openClient(drill: Drill) {
        window.open(`${apiBaseUrl}/readiness.html?drill_id=${encodeURIComponent(drill.id)}`, '_blank', 'noopener,noreferrer');
    }

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-semibold text-slateDark">Autoboot Readiness</h1>
                    <p className="mt-1 text-sm text-slate-500">Run a synthetic center readiness drill before a real examination. This mode never creates official candidate results.</p>
                </div>
                <Button disabled={busy === 'load'} onClick={() => void refresh()} variant="outline">
                    {busy === 'load' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    Refresh
                </Button>
            </div>

            {message && <div className={`rounded-md border px-4 py-3 text-sm font-semibold ${message.tone === 'danger' ? 'border-danger/30 bg-danger/5 text-danger' : message.tone === 'success' ? 'border-success/30 bg-success/5 text-success' : 'border-info/30 bg-info/5 text-info'}`}>{message.text}</div>}

            <Card>
                <CardHeader>
                    <CardTitle>Create Readiness Drill</CardTitle>
                    <CardDescription>Each drill contains 25 questions in English, Mathematics, Chemistry, and Physics. Multiple drills can be prepared; only one can run at a time.</CardDescription>
                </CardHeader>
                <CardContent>
                    <form className="grid gap-4 md:grid-cols-5" onSubmit={create}>
                        <label className="space-y-2 md:col-span-2"><span className="text-sm font-medium text-slateDark">Drill name</span><input className="h-10 w-full rounded-md border border-border px-3 text-sm" onChange={(event) => setName(event.target.value)} value={name} /></label>
                        <label className="space-y-2"><span className="text-sm font-medium text-slateDark">Expected clients</span><input className="h-10 w-full rounded-md border border-border px-3 text-sm" disabled={singleClientSmokeTest} min="1" max="5000" onChange={(event) => setExpectedClients(event.target.value)} type="number" value={singleClientSmokeTest ? '1' : expectedClients} /></label>
                        <label className="space-y-2"><span className="text-sm font-medium text-slateDark">Duration (seconds)</span><input className="h-10 w-full rounded-md border border-border px-3 text-sm" min="30" onChange={(event) => setDurationSeconds(event.target.value)} type="number" value={durationSeconds} /></label>
                        <label className="space-y-2"><span className="text-sm font-medium text-slateDark">Capacity package</span><select className="h-10 w-full rounded-md border border-border px-3 text-sm" required value={packageCode} onChange={(event) => { const selected = packages.find((item) => item.code === event.target.value); setPackageCode(event.target.value); if (selected) setExpectedClients(String(selected.autoboot_target_clients)); }}><option value="">Select package</option>{packages.map((item) => <option key={`${item.code}:${item.version}`} value={item.code}>{item.code} · {item.capacity_profile} capacity · {item.question_count} questions</option>)}</select></label>
                        <label className="flex items-end gap-2 pb-2 text-sm font-medium text-slateDark"><input checked={singleClientSmokeTest} onChange={(event) => setSingleClientSmokeTest(event.target.checked)} type="checkbox" /> Single-client smoke test</label>
                        <div className="md:col-span-4"><Button disabled={busy !== null} type="submit">{busy === 'create' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}{singleClientSmokeTest ? 'Create Single-client Test' : 'Create Drill'}</Button><p className="mt-2 text-xs text-slate-500">{singleClientSmokeTest ? 'Smoke test only: one client is allowed. Use the full package target for capacity certification.' : 'Full readiness mode requires the package capacity-plus-backup client target.'}</p></div>
                    </form>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Import Autoboot Package</CardTitle>
                    <CardDescription>Import a Super Admin-approved active readiness package. This is separate from official exam package import.</CardDescription>
                </CardHeader>
                <CardContent>
                    <form className="flex flex-wrap gap-3" onSubmit={importPackage}>
                        <input className="h-10 min-w-80 flex-1 rounded-md border border-border px-3 text-sm" placeholder="Autoboot package code" value={importCode} onChange={(event) => setImportCode(event.target.value)} required />
                        <input className="h-10 min-w-64 flex-1 rounded-md border border-border px-3 text-sm" placeholder="Portal admin password (if requested)" type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} />
                        <Button disabled={busy === 'import-package'} type="button" onClick={() => void importPackage()}><FileCheck2 className="h-4 w-4" />{busy === 'import-package' ? 'Importing...' : 'Import Package'}</Button>
                    </form>
                </CardContent>
            </Card>

            <div className="grid gap-4">
                {drills.length === 0 && <div className="rounded-md border border-dashed border-border bg-white p-6 text-sm text-slate-500">No readiness drills created.</div>}
                {drills.map((drill) => {
                    const preparedClientCount = (clients[drill.id] ?? []).filter((client) => client.paper_ready).length;
                    const canStartDrill = drill.status === 'ready' && preparedClientCount >= drill.expected_clients;
                    const startDisabledReason = drill.status === 'preflight'
                        ? 'Waiting for all connected Autoboot clients to pass Phase 1 checks.'
                        : `Waiting for ${Math.max(0, drill.expected_clients - preparedClientCount)} prepared paper(s).`;
                    return (
                    <Card key={drill.id}>
                        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
                            <div>
                                <div className="flex items-center gap-2"><h2 className="font-semibold text-slateDark">{drill.name}</h2><span className="rounded-md bg-lightBackground px-2 py-1 text-xs font-semibold uppercase text-slate-600">{drill.status}</span></div>
                                <div className="mt-2 text-sm text-slate-500">{drill.content_pack_version} · {drill.total_questions} questions · {drill.expected_clients} expected clients</div>
                                <div className="mt-1 text-xs text-slate-500">English, Mathematics, Chemistry, Physics · 25 questions each</div>
                                <div className="mt-1 text-xs text-slate-500">Registered clients: {clients[drill.id]?.length ?? 0} / {drill.expected_clients} · Connected at start: {drill.connected_clients_at_start || 'Not started'}</div>
                                {(drill.status === 'preflight' || drill.status === 'ready') && <div className="mt-3 rounded-md border border-border bg-lightBackground p-3"><div className="text-xs font-semibold text-slateDark">Enrolled devices: {enrolledDevices[drill.id]?.length ?? 0} / {drill.expected_clients}</div><div className="mt-2 flex flex-wrap gap-2"><input className="h-9 min-w-72 flex-1 rounded-md border border-border px-2 font-mono text-xs" placeholder="Candidate device fingerprint" value={deviceFingerprint} onChange={(event) => setDeviceFingerprint(event.target.value)} /><input className="h-9 w-40 rounded-md border border-border px-2 text-xs" placeholder="Device label" value={deviceLabel} onChange={(event) => setDeviceLabel(event.target.value)} /><Button disabled={busy !== null || !deviceFingerprint} onClick={() => void enrollDevice(drill)} size="sm" variant="outline">Enroll device</Button></div><div className="mt-2 max-h-20 space-y-1 overflow-y-auto font-mono text-xs text-slate-500">{(enrolledDevices[drill.id] ?? []).map((device) => <div key={device.id}>{device.device_label ?? 'Unlabelled'} · {device.device_fingerprint}</div>)}</div></div>}
                                {(drill.status === 'preflight' || drill.status === 'ready') && <ClientRegistrationPanel clients={clients[drill.id] ?? []} expected={drill.expected_clients} />}
                                {monitors[drill.id] && <ReadinessEnvironmentSummary clients={monitors[drill.id].clients} />}
                                {drill.status === 'preflight' && <p className="mt-2 text-xs font-medium text-warning">Start Drill unlocks after Phase 1 passes and every expected Autoboot client has prepared its paper.</p>}
                                {drill.status === 'running' && <DrillExecutionSummary drill={drill} currentTime={currentTime} />}
                                {monitors[drill.id] && <MonitorSummary monitor={monitors[drill.id]} onSelect={async (attemptId) => { const response = await fetch(`${apiBaseUrl}/api/readiness/drills/${drill.id}/attempts/${attemptId}/visualization`, { headers: sessionHeaders(localAdminSessionToken) }); if (response.ok) setVisualization(await response.json() as Visualization); }} />}
                            </div>
                            {(drill.status === 'preflight' || drill.status === 'ready') && <Button disabled={busy !== null} onClick={() => openClient(drill)} variant="outline">Open Readiness Client</Button>}
                            {(drill.status === 'preflight' || drill.status === 'ready') && <Button disabled={busy !== null || !canStartDrill} title={canStartDrill ? 'Start Autoboot drill' : startDisabledReason} onClick={() => void start(drill)}>{busy === drill.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Start Drill</Button>}
                            {drill.status === 'running' && <div className="flex items-center gap-2 text-sm font-semibold text-success"><CheckCircle2 className="h-4 w-4" />Running</div>}
                            {drill.status === 'running' && hasEnded(drill, currentTime) && <Button disabled={busy !== null} onClick={() => void finalize(drill)} variant="secondary">{busy === `finalize-${drill.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Finalize Report</Button>}
                            {drill.status === 'completed' && <Button disabled={busy !== null} onClick={() => void previewReport(drill)} variant="secondary">{busy === `preview-${drill.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}View Report</Button>}
                            {drill.status === 'completed' && <Button disabled={busy !== null} onClick={() => void downloadEvidence(drill)} variant="outline">{busy === `download-${drill.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Download Evidence ZIP</Button>}
                            {drill.status === 'completed' && drill.report_status !== 'uploaded' && <Button disabled={busy !== null} onClick={() => void upload(drill)} variant="default">{busy === `upload-${drill.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}Upload Report</Button>}
                            {drill.report_status === 'uploaded' && <div className="flex items-center gap-2 text-sm font-semibold text-success"><CheckCircle2 className="h-4 w-4" />Uploaded</div>}
                            {drill.status !== 'running' && <Button aria-label={`Delete ${drill.name}`} disabled={busy !== null} onClick={() => void remove(drill)} size="icon" title="Delete drill" variant="outline">{busy === `delete-${drill.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}</Button>}
                            {reports[drill.id] && <div className="w-full rounded-md border border-border bg-lightBackground p-3 text-sm"><div className="font-semibold text-slateDark">Report: {reports[drill.id].status}</div><div className="mt-1 text-slate-600">Clients {reports[drill.id].completed_clients}/{reports[drill.id].expected_clients} · Answers {reports[drill.id].total_answers} · Events {reports[drill.id].event_count}</div><div className="mt-1 break-all font-mono text-xs text-slate-500">SHA256: {reports[drill.id].payload_hash}</div></div>}
                            {drill.status === 'failed' && <div className="flex items-center gap-2 text-sm font-semibold text-danger"><AlertTriangle className="h-4 w-4" />Needs attention</div>}
                        </CardContent>
                    </Card>
                    );
                })}
            </div>
            {visualization && <VisualizationPanel visualization={visualization} onClose={() => setVisualization(null)} />}
            {reportPreview && <ReadinessReportDialog preview={reportPreview} onClose={() => setReportPreview(null)} />}
        </div>
    );
}

async function readJson<T>(response: Response, operation: string): Promise<T> {
    const text = await response.text();
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(`${operation} returned HTTP ${response.status} with a non-JSON response.`);
    }
}

function MonitorSummary({ monitor, onSelect }: { monitor: Monitor; onSelect: (attemptId: string) => void }) {
    const active = monitor.clients.filter(client => ['active', 'prepared', 'autoboot_enabled'].includes(client.attempt_status ?? client.client_status)).length;
    const connected = monitor.clients.filter(client => client.client_status === 'autoboot_enabled').length;
    const disconnected = monitor.clients.filter(client => client.client_status === 'disconnected').length;
    return <div className="mt-4 w-full rounded-md border border-border bg-lightBackground p-4"><div className="grid gap-3 sm:grid-cols-5"><SummaryCard label="Active" value={active} /><SummaryCard label="Connected" value={connected} /><SummaryCard label="Submitted" value={monitor.counts.submitted ?? 0} /><SummaryCard label="Timed out" value={monitor.counts.timed_out ?? 0} /><SummaryCard label="Disconnected" value={disconnected} /></div>{monitor.metrics && <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-3"><span>Memory: {formatBytes(monitor.metrics.process_rss_bytes)}</span><span>Database: {formatBytes(monitor.metrics.database_size_bytes)}</span><span>WAL: {formatBytes(monitor.metrics.wal_size_bytes)}</span><span>Acknowledged: {monitor.metrics.acknowledged_answer_count}</span><span>Events: {monitor.metrics.readiness_event_count}</span><span>Sampled: {monitor.metrics.sampled_at}</span></div>}<div className="mt-3 overflow-x-auto"><table className="w-full min-w-[980px] text-left text-xs"><thead><tr className="text-slate-500"><th className="py-2">Candidate / Client</th><th>IP address</th><th>OS / client</th><th>Status</th><th>Answered</th><th>Remaining</th><th>Memory</th><th>RTT</th><th>Reconnects</th><th>Heartbeat</th><th /></tr></thead><tbody>{monitor.clients.map(client => <tr key={client.client_id} className="border-t border-border"><td className="py-2"><div className="font-semibold text-slateDark">{client.candidate_label ?? client.client_key}</div><div className="font-mono text-slate-500">{client.client_key}</div></td><td>{client.ip_address ?? 'Unavailable'}</td><td className="max-w-48 truncate" title={client.user_agent ?? undefined}>{client.user_agent ?? 'Unavailable'}</td><td>{client.attempt_status ?? client.client_status}</td><td>{client.answered_count ?? 0} / {client.total_questions ?? monitor.drill.total_questions}</td><td>{client.remaining_questions ?? Math.max((client.total_questions ?? monitor.drill.total_questions) - (client.answered_count ?? 0), 0)}</td><td>{formatBytes(client.memory_rss_bytes ?? 0)}</td><td>{Math.round(client.average_rtt_ms ?? 0)} ms</td><td>{client.reconnect_count ?? 0}</td><td>{client.last_heartbeat_at}</td><td>{client.attempt_id && <Button size="icon" variant="outline" title="View attempt" onClick={() => onSelect(client.attempt_id as string)}><Eye className="h-4 w-4" /></Button>}</td></tr>)}</tbody></table></div></div>;
}

function SummaryCard({ label, value }: { label: string; value: number }) { return <div className="rounded-md border border-border bg-white p-3"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-2xl font-bold text-slateDark">{value}</div></div>; }

function ReportPreviewPanel({ preview, onClose }: { preview: ReportPreview; onClose: () => void }) { return <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/40 p-4"><div className="mx-auto max-w-6xl rounded-md bg-white shadow-xl"><div className="flex items-center justify-between border-b border-border p-5"><div><h2 className="text-lg font-bold text-slateDark">Readiness Report Preview</h2><p className="text-sm text-slate-500">Review diagnostics before uploading.</p></div><Button size="icon" variant="outline" onClick={onClose}><X className="h-4 w-4" /></Button></div><div className="max-h-[75vh] space-y-5 overflow-y-auto p-5"><div className="grid gap-3 sm:grid-cols-4"><SummaryCard label="Status" value={preview.report.status === 'ready' ? 1 : 0} /><SummaryCard label="Completed" value={preview.report.completed_clients} /><SummaryCard label="Answers" value={preview.report.total_answers} /><SummaryCard label="Events" value={preview.report.event_count} /></div><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead><tr className="text-slate-500"><th className="py-2">Client</th><th>IP</th><th>Status</th><th>Progress</th><th>Memory</th><th>RTT</th><th>Reconnects</th><th>Errors</th></tr></thead><tbody>{preview.clients.map(client => <tr key={client.client_key} className="border-t border-border"><td className="py-2 font-mono">{client.client_key}</td><td>{client.ip_address ?? 'Unavailable'}</td><td>{client.attempt_status ?? client.client_status}</td><td>{client.answered_count ?? 0}/{client.total_questions ?? preview.report.total_questions}</td><td>{formatBytes(client.memory_rss_bytes ?? 0)}</td><td>{Math.round(client.average_rtt_ms ?? 0)} ms</td><td>{client.reconnect_count ?? 0}</td><td>{client.error_count ?? 0}</td></tr>)}</tbody></table></div><div><h3 className="font-semibold text-slateDark">Event timeline</h3><div className="mt-2 max-h-48 space-y-2 overflow-y-auto text-xs text-slate-600">{preview.events.map((event, index) => <div key={`${event.occurred_at}-${index}`} className="border-l-2 border-border pl-3"><strong>{event.event_type}</strong> · {event.occurred_at}<div>{event.message}</div></div>)}</div></div></div></div></div>; }

function ReadinessReportDialog({ preview, onClose }: { preview: ReportPreview; onClose: () => void }) {
    const assessment = preview.report.payload?.assessment;
    return <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/40 p-4"><div className="mx-auto max-w-6xl rounded-md bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-border p-5"><div><h2 className="text-lg font-bold text-slateDark">Readiness Report Preview</h2><p className="text-sm text-slate-500">Operational evidence retained with this report.</p></div><Button size="icon" variant="outline" onClick={onClose}><X className="h-4 w-4" /></Button></div>
        <div className="max-h-[75vh] space-y-5 overflow-y-auto p-5">
            {assessment && <section className="border border-border p-4"><div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-semibold text-slateDark">Operational assessment</h3><span className="text-lg font-bold text-primary">{assessment.overall_score}/100 · {assessment.outcome}</span></div><div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-5"><span>Completion {assessment.factors.completion_rate}%</span><span>Acknowledged {assessment.factors.acknowledgement_rate}%</span><span>Network {assessment.factors.network_score}</span><span>Reliability {assessment.factors.reliability_score}</span><span>Resources {assessment.factors.resource_score}</span></div></section>}
            <section className="overflow-x-auto"><h3 className="mb-2 font-semibold text-slateDark">Client environment evidence</h3><table className="w-full min-w-[950px] text-left text-xs"><thead><tr className="text-slate-500"><th className="py-2">Client</th><th>IP / OS client</th><th>Status</th><th>Progress</th><th>RAM avg / peak</th><th>Samples</th><th>RTT</th><th>Reconnects</th><th>Misses</th><th>Errors</th></tr></thead><tbody>{preview.clients.map(client => <tr key={client.client_key} className="border-t border-border"><td className="py-2 font-mono">{client.client_key}</td><td><div>{client.ip_address ?? 'Unavailable'} · {client.operating_system ?? 'Unavailable'}</div><div className="max-w-64 truncate text-slate-500" title={client.user_agent ?? undefined}>{client.user_agent ?? 'Unavailable'}</div></td><td>{client.attempt_status ?? client.client_status}</td><td>{client.answered_count ?? 0}/{client.total_questions ?? preview.report.total_questions}</td><td>{client.average_memory_rss_bytes == null ? 'No samples' : formatBytes(client.average_memory_rss_bytes)} / {formatBytes(client.memory_rss_peak_bytes ?? 0)}</td><td>{client.memory_sample_count ?? 0}</td><td>{Math.round(client.average_rtt_ms ?? 0)} ms</td><td>{client.reconnect_count ?? 0}</td><td>{client.heartbeat_miss_count ?? 0}</td><td>{client.error_count ?? 0}</td></tr>)}</tbody></table></section>
            <section><h3 className="font-semibold text-slateDark">Event timeline</h3><div className="mt-2 max-h-48 space-y-2 overflow-y-auto text-xs text-slate-600">{preview.events.map((event, index) => <div key={`${event.occurred_at}-${index}`} className="border-l-2 border-border pl-3"><strong>{event.event_type}</strong> · {event.occurred_at}<div>{event.message}</div></div>)}</div></section>
        </div>
    </div></div>;
}

function ReadinessEnvironmentSummary({ clients }: { clients: MonitorClient[] }) {
    return <section className="mt-4">
        <h3 className="mb-2 text-sm font-semibold text-slateDark">Network and device measurements</h3>
        {clients.length === 0 ? <p className="text-xs text-slate-500">No readiness devices have reported measurements yet.</p> : <div className="overflow-x-auto">
            <table className="w-full min-w-[1120px] text-left text-xs">
                <thead><tr className="text-slate-500"><th className="py-2">Device</th><th>IP / platform</th><th>Phase 1</th><th>Network quality</th><th>Link estimate</th><th>Machine estimates</th><th>Process memory</th><th>Last heartbeat</th></tr></thead>
                <tbody>{clients.map((client) => <tr key={client.client_id} className="border-t border-border align-top">
                    <td className="py-2"><div className="font-semibold text-slateDark">{client.candidate_label ?? client.client_key}</div><div className="font-mono text-slate-500" title={client.client_key} aria-label={`Client fingerprint ${client.client_key}`}>{shortenClientFingerprint(client.client_key)}</div></td>
                    <td><div>{client.ip_address ?? 'IP unavailable'}</div><div className="mt-1 max-w-56 truncate text-slate-500" title={client.user_agent ?? undefined}>{client.user_agent ?? 'Platform unavailable'}</div></td>
                    <td><div className="font-semibold">{client.preflight_status ?? 'pending'}</div><div className="mt-1 text-slate-500">{client.preflight_checked_at ? new Date(client.preflight_checked_at).toLocaleString() : 'Not checked'}</div></td>
                    <td><div>RTT {formatPreflightMetric(client.network_latency_ms, client.preflight_status, ' ms')}</div><div>Jitter {formatPreflightMetric(client.network_jitter_ms, client.preflight_status, ' ms')}</div><div>Loss {formatPreflightMetric(client.packet_loss_percent, client.preflight_status, '%')}</div></td>
                    <td><div>Down {formatPreflightMetric(client.network_download_mbps, client.preflight_status, ' Mbps')}</div><div>Up {formatPreflightMetric(client.network_upload_mbps, client.preflight_status, ' Mbps')}</div><div className="text-slate-500">Client estimate</div></td>
                    <td><div>RAM {client.preflight_status === 'pending' ? 'Pending' : client.machine_memory_bytes ? `${formatBytes(client.machine_memory_bytes)} est.` : 'Unavailable'}</div><div>CPU {formatPreflightMetric(client.machine_cpu_percent, client.preflight_status, '%')}</div><div>Disk {formatPreflightMetric(client.disk_free_gb, client.preflight_status, ' GB')} free</div><div>Clock {formatPreflightMetric(client.time_offset_ms, client.preflight_status, ' ms')}</div><div className="text-slate-500">Client estimates</div></td>
                    <td>{client.memory_rss_bytes ? formatBytes(client.memory_rss_bytes) : 'No sample'}</td>
                    <td>{new Date(client.last_heartbeat_at).toLocaleTimeString()}</td>
                </tr>)}</tbody>
            </table>
        </div>}
    </section>;
}

function formatPreflightMetric(value: number | undefined, status: string | undefined, suffix: string): string {
    if (status !== 'ready' && status !== 'failed') return 'Pending';
    return value == null ? 'Unavailable' : `${Number(value).toFixed(1)}${suffix}`;
}
function shortenClientFingerprint(value: string): string {
    return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}
function ClientRegistrationPanel({ clients, expected }: { clients: ReadinessClient[]; expected: number }) {
    const prepared = clients.filter((client) => client.paper_ready).length;
    const ready = prepared >= expected;
    return <div className={`mt-3 rounded-md border p-3 text-xs ${ready ? 'border-success/30 bg-success/5' : 'border-info/30 bg-info/5'}`}><div className="flex items-center justify-between gap-3 font-semibold"><span>{ready ? 'All required papers prepared' : `Waiting for ${expected - prepared} prepared paper(s)`}</span><span>{prepared}/{expected}</span></div><div className="mt-1 text-slate-600">Connected: {clients.length}/{expected}. Starting remains disabled until each connected client has prepared its paper.</div><div className="mt-2 max-h-32 space-y-2 overflow-y-auto text-slate-600">{clients.length === 0 ? <div>No Autoboot clients registered yet.</div> : clients.map(client => <div key={client.client_id} className="rounded-md border border-border bg-white p-2"><div className="flex items-center justify-between gap-2"><span className="font-mono">{client.client_id}</span><span className={`rounded-full px-2 py-0.5 font-semibold ${client.preflight_status === 'ready' ? 'bg-success/10 text-success' : client.preflight_status === 'failed' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'}`}>{client.preflight_status ?? 'pending'}</span></div><div className="mt-1 flex items-center justify-between gap-2"><span>{client.paper_ready ? 'paper ready' : 'preparing paper'}</span><span>{client.network_latency_ms != null ? `${Math.round(client.network_latency_ms)} ms RTT` : 'network pending'}</span></div></div>)}</div></div>;
}

function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / (1024 ** 2)).toFixed(1)} MB`; }

function VisualizationPanel({ visualization, onClose }: { visualization: Visualization; onClose: () => void }) {
    const answered = new Map(visualization.answers.map((answer) => [answer.question_id, answer]));
    return <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/40 p-4"><div className="mx-auto max-w-5xl rounded-md bg-white shadow-xl"><div className="flex items-center justify-between border-b border-border p-5"><div><h2 className="text-lg font-bold text-slateDark">Attempt visualization</h2><p className="text-sm text-slate-500">{visualization.attempt.status} · {visualization.attempt.answered_count}/{visualization.attempt.total_questions} acknowledged</p></div><Button size="icon" variant="outline" onClick={onClose}><X className="h-4 w-4" /></Button></div><div className="max-h-[75vh] space-y-5 overflow-y-auto p-5">{visualization.manifest.subjects.map(subject => <section key={subject.name}><h3 className="mb-3 font-semibold text-slateDark">{subject.name}</h3><div className="space-y-3">{subject.questions.map(question => { const answer = answered.get(question.id); return <article key={question.id} className="rounded-md border border-border p-4"><div className="flex gap-3"><span className="font-semibold text-primary">{question.id}</span><div className="flex-1"><p className="font-medium text-slateDark">{question.body}</p><div className="mt-2 grid gap-2 sm:grid-cols-2">{question.options.map(option => <span key={option.label} className={`rounded-md border px-3 py-2 text-sm ${answer?.option_label === option.label ? 'border-primary bg-green-50 font-semibold' : 'border-border bg-slate-50'}`}>{option.label}. {option.text}</span>)}</div><p className="mt-2 text-xs text-slate-500">{answer ? `Acknowledged · sequence ${answer.sequence_number} · ${answer.acknowledged_at}` : 'Not acknowledged'}</p></div></div></article>; })}</div></section>)}</div></div></div>;
}

function sessionHeaders(token: string): Record<string, string> {
    return { 'X-AlignEx-Local-Admin-Session': token };
}

function DrillExecutionSummary({ drill, currentTime }: { drill: Drill; currentTime: number }) {
    const deadline = new Date(drill.started_at ?? currentTime).getTime() + drill.duration_seconds * 1000;
    const remainingSeconds = Math.max(0, Math.ceil((deadline - currentTime) / 1000));
    const progress = Math.min(100, Math.max(0, (1 - remainingSeconds / drill.duration_seconds) * 100));
    const answered = Math.min(drill.total_questions, Math.floor(drill.total_questions * progress / 100));

    return <div className="mt-3 rounded-md border border-success/30 bg-success/5 p-3 text-sm"><div className="flex flex-wrap justify-between gap-2 font-semibold text-success"><span>Exam is running</span><span>{remainingSeconds > 0 ? `${formatRemaining(remainingSeconds)} remaining` : 'Time ended - finalize report'}</span></div><div className="mt-2 flex justify-between text-slate-600"><span>Expected client progress</span><span>{answered} answered · {drill.total_questions - answered} remaining · {Math.round(progress)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-white"><div className="h-full bg-success transition-all" style={{ width: `${progress}%` }} /></div></div>;
}

function hasEnded(drill: Drill, currentTime: number): boolean {
    return Boolean(drill.started_at) && new Date(drill.started_at as string).getTime() + drill.duration_seconds * 1000 <= currentTime;
}

function formatRemaining(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
