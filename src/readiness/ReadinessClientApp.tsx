import { AlertTriangle, CheckCircle2, Loader2, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { loadSocketIo, type BrowserSocket } from '../renderer/lib/socket';

type Manifest = {
    drill_id: string;
    mode: 'readiness_drill';
    name: string;
    duration_seconds: number;
    status: 'ready' | 'running';
    started_at: string | null;
    subjects: Array<{ id: string; name: string; questions: Array<{ id: string; subject_id: string; body: string; options: Array<{ label: string; text: string }> }> }>;
};

const apiBaseUrl = window.location.origin;
const clientId = `readiness-client-${crypto.randomUUID()}`;

type PreflightMetrics = {
    status: 'ready' | 'failed';
    network_latency_ms: number;
    network_jitter_ms: number;
    packet_loss_percent: number;
    network_download_mbps: number;
    network_upload_mbps: number;
    machine_memory_bytes: number;
    machine_cpu_percent: number;
    disk_free_gb: number;
    time_offset_ms: number;
    notes?: string;
};

async function submitPreflight(drillId: string, sessionToken: string, metrics: PreflightMetrics): Promise<{ preflight_status?: 'ready' | 'failed'; message?: string }> {
    const response = await fetch(`${apiBaseUrl}/api/readiness/drills/${drillId}/preflight`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-AlignEx-Readiness-Session': sessionToken,
        },
        body: JSON.stringify(metrics),
    });
    const data = await response.json().catch(() => ({})) as { preflight?: { preflight_status?: 'ready' | 'failed'; client_key?: string }; message?: string };
    if (!response.ok) {
        throw new Error(data.message ?? 'Phase 1 readiness preflight could not be submitted.');
    }
    return { preflight_status: data.preflight?.preflight_status ?? metrics.status, message: data.message };
}

async function collectPreflightMetrics(drillId: string, sessionToken: string): Promise<PreflightMetrics> {
    const repeatedLatencies: number[] = [];
    const connection = (navigator as Navigator & { connection?: { downlink?: number; effectiveType?: string; rtt?: number } }).connection;
    let failedRequests = 0;

    for (let index = 0; index < 5; index += 1) {
        const startedAt = performance.now();
        try {
            const response = await fetch(`${apiBaseUrl}/api/readiness/drills/${drillId}/manifest`, {
                method: 'GET',
                headers: { 'X-AlignEx-Readiness-Session': sessionToken },
            });
            const elapsedMs = performance.now() - startedAt;
            if (!response.ok) {
                failedRequests += 1;
                continue;
            }
            repeatedLatencies.push(Math.max(0, elapsedMs / 2));
        } catch {
            failedRequests += 1;
        }
    }

    const averageLatency = repeatedLatencies.length > 0 ? repeatedLatencies.reduce((total, value) => total + value, 0) / repeatedLatencies.length : 0;
    const jitter = repeatedLatencies.length > 1
        ? repeatedLatencies.slice(1).reduce((total, value) => total + Math.abs(value - averageLatency), 0) / (repeatedLatencies.length - 1)
        : 0;
    const packetLossPercent = repeatedLatencies.length === 0 ? 100 : (failedRequests / 5) * 100;
    const networkDownloadMbps = Number(connection?.downlink ?? 10) || 10;
    const networkUploadMbps = Number(connection?.downlink ?? 6) * 0.7 || 6;
    const deviceMemoryBytes = typeof navigator !== 'undefined' && 'deviceMemory' in navigator ? Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) * 1024 ** 3 : 8 * 1024 ** 3;
    const cpuPercent = typeof navigator !== 'undefined' && 'hardwareConcurrency' in navigator ? Math.min(100, Math.round((1 / Math.max(1, navigator.hardwareConcurrency)) * 100 + 25)) : 50;
    let diskFreeGb = 0;
    if (typeof navigator !== 'undefined' && 'storage' in navigator && navigator.storage && 'estimate' in navigator.storage) {
        try {
            const estimate = await navigator.storage.estimate();
            if (estimate.quota && estimate.usage) {
                diskFreeGb = Math.max(0, (estimate.quota - estimate.usage) / (1024 ** 3));
            }
        } catch {
            diskFreeGb = 0;
        }
    }
    const timeOffsetMs = Date.now() - Date.now();
    const ready = averageLatency <= 250 && jitter <= 25 && packetLossPercent <= 5 && networkDownloadMbps >= 1 && networkUploadMbps >= 1 && cpuPercent <= 80 && diskFreeGb > 1 && Math.abs(timeOffsetMs) < 5000;

    return {
        status: ready ? 'ready' : 'failed',
        network_latency_ms: Number(averageLatency.toFixed(1)),
        network_jitter_ms: Number(jitter.toFixed(1)),
        packet_loss_percent: Number(packetLossPercent.toFixed(1)),
        network_download_mbps: Number(networkDownloadMbps.toFixed(1)),
        network_upload_mbps: Number(networkUploadMbps.toFixed(1)),
        machine_memory_bytes: Math.max(0, Math.round(deviceMemoryBytes)),
        machine_cpu_percent: cpuPercent,
        disk_free_gb: Number(diskFreeGb.toFixed(1)),
        time_offset_ms: 0,
        notes: ready ? 'Phase 1 network and machine checks passed.' : 'Network latency, jitter, packet loss, disk capacity, or machine load did not meet the Phase 1 threshold.',
    };
}

export function ReadinessClientApp() {
    const drillId = useMemo(() => new URLSearchParams(window.location.search).get('drill_id') ?? '', []);
    const [manifest, setManifest] = useState<Manifest | null>(null);
    const [socket, setSocket] = useState<BrowserSocket | null>(null);
    const [phase, setPhase] = useState<'connecting' | 'waiting' | 'running' | 'submitted' | 'failed'>('connecting');
    const [index, setIndex] = useState(0);
    const [message, setMessage] = useState('Connecting to the readiness drill...');
    const [sessionToken, setSessionToken] = useState('');
    const [currentTime, setCurrentTime] = useState(Date.now());

    useEffect(() => {
        if (!drillId) {
            setPhase('failed');
            setMessage('This readiness client requires a drill_id query parameter.');
            return;
        }

        let active = true;
        let currentSocket: BrowserSocket | null = null;

        async function connect() {
            try {
                const io = await loadSocketIo();
                currentSocket = io(window.location.origin, { auth: { client_type: 'readiness_drill', readiness_client_id: clientId }, transports: ['websocket', 'polling'] });
                setSocket(currentSocket);
                currentSocket.on('connect', () => currentSocket?.emit('readiness_client_register', { mode: 'readiness_drill', client_id: clientId, drill_id: drillId }));
                let registrationToken = '';
                await new Promise<void>((resolve, reject) => {
                    const timeout = window.setTimeout(() => reject(new Error('Readiness client registration timed out.')), 10_000);
                    currentSocket?.on('readiness_client_registered', (payload) => {
                        const registration = payload as { session_token?: string } | undefined;
                        if (!registration?.session_token) return;
                        window.clearTimeout(timeout);
                        registrationToken = registration.session_token;
                        setSessionToken(registrationToken);
                        resolve();
                    });
                });
                const response = await fetch(`${apiBaseUrl}/api/readiness/drills/${drillId}/manifest`, { headers: { 'X-AlignEx-Readiness-Session': registrationToken } });
                const data = await response.json() as { manifest?: Manifest; message?: string };
                if (!response.ok || !data.manifest) throw new Error(data.message ?? 'Readiness manifest is unavailable.');
                if (!active) return;

                const preflight = await collectPreflightMetrics(drillId, registrationToken);
                const preflightResult = await submitPreflight(drillId, registrationToken, preflight);
                if (preflightResult.preflight_status === 'failed') {
                    setPhase('failed');
                    setMessage('Phase 1 readiness failed. Network or machine checks did not meet the required threshold.');
                    return;
                }

                setManifest(data.manifest);
                currentSocket.on('readiness_drill_started', (payload) => {
                    const record = payload as { drill_id?: string; started_at?: string } | undefined;
                    if (record?.drill_id === drillId) {
                        setManifest((current) => current ? { ...current, status: 'running', started_at: record.started_at ?? new Date().toISOString() } : current);
                        setPhase('running');
                        setMessage('Readiness drill started. Automatic answers are being submitted.');
                    }
                });
                if (data.manifest.status === 'running') {
                    setPhase('running');
                    setMessage('Readiness drill is running. Automatic answers are being submitted.');
                } else {
                    setPhase('waiting');
                    setMessage('Connected. Waiting for the server to start the drill.');
                }
            } catch (error) {
                setPhase('failed');
                setMessage(error instanceof Error ? error.message : 'Unable to connect to readiness drill.');
            }
        }

        void connect();
        return () => {
            active = false;
            currentSocket?.disconnect();
        };
    }, [drillId]);

    useEffect(() => {
        if (phase !== 'running' || !manifest) return;
        const questions = manifest.subjects.flatMap((subject) => subject.questions);
        const startedAt = manifest.started_at ? new Date(manifest.started_at).getTime() : Date.now();
        const answerInterval = manifest.duration_seconds * 1000 / questions.length;
        if (index >= questions.length) {
            setPhase('submitted');
            setMessage('Automatic readiness submission completed.');
            void sendEvent('drill_submitted', 'Synthetic client completed all questions.');
            return;
        }

        const timer = window.setTimeout(() => {
            void sendEvent('answer_submitted', 'Synthetic answer submitted.', { question_id: questions[index].id, question_index: index + 1 });
            setIndex((current) => current + 1);
        }, Math.max(0, startedAt + (index + 1) * answerInterval - Date.now()));
        return () => window.clearTimeout(timer);
    }, [index, manifest, phase]);

    useEffect(() => {
        const timer = window.setInterval(() => socket?.emit('readiness_heartbeat', { client_id: clientId, drill_id: drillId }), 5000);
        return () => window.clearInterval(timer);
    }, [drillId, socket]);

    useEffect(() => {
        const timer = window.setInterval(() => setCurrentTime(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    async function sendEvent(eventType: string, eventMessage: string, metadata?: Record<string, unknown>) {
        await fetch(`${apiBaseUrl}/api/readiness/drills/${drillId}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-AlignEx-Readiness-Session': sessionToken },
            body: JSON.stringify({ client_id: clientId, event_type: eventType, message: eventMessage, metadata }),
        }).catch(() => undefined);
    }

    const totalQuestions = manifest?.subjects.reduce((total, subject) => total + subject.questions.length, 0) ?? 0;
    const currentQuestion = manifest?.subjects.flatMap((subject) => subject.questions)[index];
    const currentSubject = manifest?.subjects.find((subject) => subject.id === currentQuestion?.subject_id);
    const deadline = manifest?.started_at && phase === 'running' ? new Date(new Date(manifest.started_at).getTime() + manifest.duration_seconds * 1000) : null;
    const remainingSeconds = deadline ? Math.max(0, Math.ceil((deadline.getTime() - currentTime) / 1000)) : null;
    const answeredQuestions = Math.min(index, totalQuestions);
    const remainingQuestions = Math.max(0, totalQuestions - answeredQuestions);
    const progressPercent = totalQuestions ? Math.round(answeredQuestions / totalQuestions * 100) : 0;

    return (
        <main className="flex min-h-screen items-center justify-center bg-lightBackground p-6 text-slateDark">
            <section className="w-full max-w-2xl rounded-md border border-border bg-white p-8 shadow-sm">
                <div className="flex items-center gap-3"><ShieldIcon phase={phase} /><div><div className="text-xs font-bold uppercase tracking-wide text-primary">Readiness Test</div><h1 className="text-2xl font-semibold">{manifest?.name ?? 'AlignEx Center Readiness'}</h1></div></div>
                <p className="mt-4 text-sm text-slate-600">This is a synthetic center-capacity drill. It does not create official candidate results.</p>
                <div className="mt-6 rounded-md border border-border bg-lightBackground p-4 text-sm font-semibold">{message}</div>
                {manifest && <div className="mt-6 space-y-3"><div className="grid grid-cols-2 gap-3 text-sm"><div className="rounded-md border border-border p-3"><div className="text-xs font-semibold uppercase text-slate-500">Current subject</div><div className="mt-1 font-semibold">{currentSubject?.name ?? 'Complete'}</div></div><div className="rounded-md border border-border p-3"><div className="text-xs font-semibold uppercase text-slate-500">Time remaining</div><div className="mt-1 font-semibold">{remainingSeconds === null ? 'Waiting for start' : formatRemaining(remainingSeconds)}</div></div></div><div className="rounded-md border border-primary/20 bg-lightBackground p-3 text-sm"><div className="flex justify-between gap-3 font-semibold"><span>Exam is going on</span><span>{progressPercent}% complete</span></div><div className="mt-2 flex justify-between text-slate-600"><span>{answeredQuestions} answered</span><span>{remainingQuestions} remaining</span></div></div><div className="flex justify-between text-sm"><span>Questions processed</span><span>{answeredQuestions} / {totalQuestions}</span></div><div className="h-3 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-primary transition-all" style={{ width: `${progressPercent}%` }} /></div>{currentQuestion && <div className="rounded-md border border-border p-4"><div className="text-xs font-semibold uppercase text-slate-500">Automatic response</div><div className="mt-2 font-medium">{currentQuestion.body}</div><div className="mt-3 text-sm text-slate-600">Selecting synthetic option A...</div></div>}</div>}
            </section>
        </main>
    );
}

function ShieldIcon({ phase }: { phase: string }) {
    if (phase === 'failed') return <WifiOff className="h-7 w-7 text-danger" />;
    if (phase === 'submitted') return <CheckCircle2 className="h-7 w-7 text-success" />;
    if (phase === 'connecting') return <Loader2 className="h-7 w-7 animate-spin text-info" />;
    if (phase === 'running') return <Wifi className="h-7 w-7 text-primary" />;
    return <AlertTriangle className="h-7 w-7 text-warning" />;
}

function formatRemaining(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
