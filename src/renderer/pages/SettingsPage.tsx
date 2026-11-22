import { AlertTriangle, CheckCircle2, Database, Download, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useServerStatus } from '../hooks/useServerStatus';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';

export function SettingsPage() {
    const { status, serverInfo, loading, error, refresh } = useServerStatus();
    const [activation, setActivation] = useState<ActivationStatus | null>(null);
    const [activationError, setActivationError] = useState<string | null>(null);
    const [updateState, setUpdateState] = useState<UpdateCheckResult | null>(null);
    const [updateBusy, setUpdateBusy] = useState<UpdateAction | null>(null);
    const [updateMessage, setUpdateMessage] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);
    const [uninstallOpen, setUninstallOpen] = useState(false);
    const [uninstallPassword, setUninstallPassword] = useState('');
    const [uninstallBusy, setUninstallBusy] = useState(false);

    useEffect(() => {
        void refreshActivation();
    }, []);

    async function refreshActivation() {
        try {
            const response = await fetch('http://127.0.0.1:4080/api/app/state');
            if (!response.ok) throw new Error(`License status returned ${response.status}.`);
            const data = await response.json() as { status: ActivationStatus };
            setActivation(data.status);
            setActivationError(null);
        } catch (caught) {
            setActivation(null);
            setActivationError(caught instanceof Error ? caught.message : 'Unable to load license status.');
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-semibold text-slateDark">Settings</h1>
                    <p className="mt-1 text-sm text-slate-500">
                        Local server configuration and database storage details for this center machine.
                    </p>
                </div>

                <Button onClick={() => { void refresh(); void refreshActivation(); }} variant="outline">
                    <RefreshCw className="h-4 w-4" />
                    Refresh
                </Button>
            </div>

            {loading && (
                <Panel tone="info" title="Loading database settings" body="Reading local server and SQLite status.">
                    <Loader2 className="h-5 w-5 animate-spin text-info" />
                </Panel>
            )}

            {error && !loading && (
                <Panel tone="danger" title="Database initialization failed" body={`The local database status could not be loaded. ${error}`}>
                    <AlertTriangle className="h-5 w-5 text-danger" />
                </Panel>
            )}

            {serverInfo && !loading && !error && (
                <div className="grid gap-6">
                    <section className="rounded-md border border-border bg-white p-5">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                            <div className="flex items-center gap-2">
                                <Download className="h-5 w-5 text-primary" />
                                <div>
                                    <h2 className="font-semibold text-slateDark">Update Center</h2>
                                    <p className="mt-1 text-sm text-slate-500">Check the AlignEx portal and stage verified updates on this server.</p>
                                </div>
                            </div>
                            <Button disabled={Boolean(updateBusy)} onClick={() => void checkUpdates()} variant="outline">
                                {updateBusy === 'check' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                                Check Updates
                            </Button>
                        </div>

                        {updateMessage && (
                            <div className={`mt-4 rounded-md border px-3 py-2 text-sm font-semibold ${updateMessageClass(updateMessage.tone)}`}>
                                {updateMessage.text}
                            </div>
                        )}

                        <div className="mt-5 grid gap-4 xl:grid-cols-2">
                            <UpdateCard
                                artifact="server"
                                busy={updateBusy === 'server'}
                                currentVersion={updateState?.current_versions.server ?? '0.1.4'}
                                update={updateState?.updates.server ?? null}
                                onDownload={() => void downloadArtifact('server')}
                            />
                            <UpdateCard
                                artifact="client_app"
                                busy={updateBusy === 'client_app'}
                                currentVersion={updateState?.current_versions.client_app ?? '0.1.3'}
                                update={updateState?.updates.client_app ?? null}
                                onDownload={() => void downloadArtifact('client_app')}
                            />
                        </div>
                    </section>

                    <section className="rounded-md border border-border bg-white p-5">
                        <div className="flex items-center gap-2">
                            <Database className="h-5 w-5 text-primary" />
                            <h2 className="font-semibold text-slateDark">License and Device</h2>
                        </div>

                        <div className="mt-5 grid gap-4">
                            {activationError && <p className="text-sm text-danger" role="alert">{activationError}</p>}
                            {activation && activation.state !== 'activated' && <p className="text-sm text-danger" role="alert">{activation.message}</p>}
                            <SettingRow label="Application State" value={activation?.state ?? 'Unavailable'} />
                            <SettingRow label="Subscription Plan" value={activation?.plan?.name ?? 'Unavailable'} />
                            <SettingRow label="Device ID" value={activation?.device_id ?? 'Unavailable'} mono />
                            <SettingRow label="Organization" value={activation?.organization_name ?? '-'} />
                            <SettingRow label="Center" value={activation?.center_name ?? '-'} />
                            <SettingRow label="Portal URL" value={activation?.portal_url ?? '-'} mono />
                            <SettingRow label="Expires At" value={activation?.expires_at ? new Date(activation.expires_at).toLocaleString() : '-'} />
                        </div>
                        <div className="mt-6">
                            <h3 className="font-semibold text-slateDark">Subscription entitlements</h3>
                            <p className="mt-1 text-sm text-slate-500">Verified KernelBridge grants and limits for this installation.</p>
                            {activation?.entitlements ? (
                                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                    {Object.entries(activation.entitlements).sort(([a], [b]) => a.localeCompare(b)).map(([key, grant]) => (
                                        <div key={key} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                                            <span className="text-slateDark">{formatEntitlementName(key)}</span>
                                            <span className={grant.enabled ? 'font-semibold text-success' : 'font-semibold text-slate-500'}>
                                                {formatEntitlementValue(grant)}
                                            </span>
                                        </div>
                                    ))}
                                    {Object.keys(activation.entitlements).length === 0 && <p className="text-sm text-slate-500">No entitlements were included in the verified snapshot.</p>}
                                </div>
                            ) : <p className="mt-3 text-sm text-slate-500">Verified subscription entitlements are unavailable.</p>}
                        </div>
                    </section>

                    <section className="rounded-md border border-border bg-white p-5">
                        <div className="flex items-center gap-2">
                            <Database className="h-5 w-5 text-primary" />
                            <h2 className="font-semibold text-slateDark">Database Status</h2>
                        </div>

                        <div className="mt-5 grid gap-4">
                            <SettingRow label="Connection" value={serverInfo.databaseConnected ? 'Connected' : 'Disconnected'} />
                            <SettingRow label="SQLite WAL Mode" value={status?.database.walEnabled ? 'Enabled' : 'Disabled'} />
                            <SettingRow label="Database File Path" value={serverInfo.databaseFilePath} mono />
                            <SettingRow label="Imported Exams" value={String(serverInfo.importedExamsCount)} />
                            <SettingRow label="Active Exams" value={String(serverInfo.activeExamCount)} />
                            <SettingRow label="Total Candidates" value={String(serverInfo.totalCandidatesCount)} />
                        </div>
                    </section>

                    <section className="rounded-md border border-danger/30 bg-danger/5 p-5">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                            <div className="flex items-start gap-3">
                                <Trash2 className="mt-0.5 h-5 w-5 text-danger" />
                                <div>
                                    <h2 className="font-semibold text-slateDark">Uninstall Local Server</h2>
                                    <p className="mt-1 max-w-2xl text-sm text-slate-600">
                                        Delete this server's local SQLite database, activation, configuration, exams, candidates, answers, and local audit data. Portal records and the installed application will not be deleted.
                                    </p>
                                </div>
                            </div>
                            <Button onClick={() => setUninstallOpen(true)} variant="danger">
                                <Trash2 className="h-4 w-4" />
                                Uninstall Server
                            </Button>
                        </div>
                    </section>
                </div>
            )}

            <ConfirmDialog
                open={uninstallOpen}
                title="Uninstall this local server?"
                message="This permanently deletes the local SQLite database, activation, exams, candidates, answers, and audit data. It cannot be undone. The installed application remains and will need activation again."
                confirmLabel="Uninstall Server"
                confirmTone="danger"
                loading={uninstallBusy}
                onOpenChange={(open) => {
                    setUninstallOpen(open);
                    if (!open) setUninstallPassword('');
                }}
                onConfirm={() => void uninstallLocalData()}
            >
                <label className="block space-y-2">
                    <span className="text-sm font-medium text-slateDark">Local admin password</span>
                    <input
                        autoFocus
                        className="h-11 w-full rounded-md border border-border bg-white px-3 text-sm text-slateDark outline-none focus:border-danger focus:ring-2 focus:ring-danger/20"
                        onChange={(event) => setUninstallPassword(event.target.value)}
                        placeholder="Enter password to confirm"
                        type="password"
                        value={uninstallPassword}
                    />
                </label>
            </ConfirmDialog>
        </div>
    );

    async function uninstallLocalData() {
        if (!uninstallPassword) {
            setUpdateMessage({ tone: 'danger', text: 'Enter the local administrator password to continue.' });
            return;
        }

        setUninstallBusy(true);
        const result = await window.alignex?.uninstallLocalData(uninstallPassword);

        if (!result?.success) {
            setUninstallBusy(false);
            setUpdateMessage({ tone: 'danger', text: result?.message ?? 'Unable to delete local server data.' });
            return;
        }

        setUpdateMessage({ tone: 'success', text: result.message ?? 'Local server data deleted.' });
    }

    async function checkUpdates() {
        setUpdateBusy('check');
        setUpdateMessage(null);

        try {
            const response = await fetch('http://127.0.0.1:4080/api/updates/check');
            const data = await response.json() as UpdateCheckResult & { message?: string };

            if (!response.ok) {
                throw new Error(data.message ?? `Update check failed with status ${response.status}.`);
            }

            setUpdateState(data);
            setUpdateMessage({ tone: 'success', text: hasAvailableUpdate(data) ? 'Update information loaded. Choose an update to download.' : 'Everything is up to date.' });
        } catch (caught) {
            setUpdateMessage({ tone: 'danger', text: caught instanceof Error ? caught.message : 'Unable to check updates.' });
        } finally {
            setUpdateBusy(null);
        }
    }

    async function downloadArtifact(artifact: UpdateArtifact) {
        setUpdateBusy(artifact);
        setUpdateMessage({ tone: 'info', text: 'Downloading and verifying update...' });

        try {
            const response = await fetch('http://127.0.0.1:4080/api/updates/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ artifact }),
            });
            const data = await response.json() as DownloadUpdateResult & { message?: string };

            if (!response.ok) {
                throw new Error(data.message ?? `Download failed with status ${response.status}.`);
            }

            setUpdateMessage({ tone: 'success', text: `${data.message} Saved to ${data.file_path}` });
            await refreshUpdateState();
        } catch (caught) {
            setUpdateMessage({ tone: 'danger', text: caught instanceof Error ? caught.message : 'Unable to download update.' });
        } finally {
            setUpdateBusy(null);
        }
    }

    async function refreshUpdateState() {
        const response = await fetch('http://127.0.0.1:4080/api/updates/check');
        const data = await response.json() as UpdateCheckResult & { message?: string };

        if (!response.ok) {
            throw new Error(data.message ?? `Update check failed with status ${response.status}.`);
        }

        setUpdateState(data);
    }
}

type ActivationStatus = {
    state: string;
    message: string;
    device_id: string;
    organization_name: string | null;
    center_name: string | null;
    portal_url: string | null;
    expires_at: string | null;
    plan: { name: string | null };
    entitlements: Record<string, { enabled: boolean; limit: number | string | null }> | null;
};

function formatEntitlementName(key: string): string {
    return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatEntitlementValue(grant: { enabled: boolean; limit: number | string | null }): string {
    if (!grant.enabled) return 'Not included';
    if (grant.limit === null || grant.limit === 'enabled') return 'Included';
    if (grant.limit === 'unlimited') return 'Unlimited';
    return typeof grant.limit === 'number' || /^\d+(\.\d+)?$/.test(grant.limit)
        ? `Limit: ${grant.limit}`
        : grant.limit;
}

type UpdateArtifact = 'server' | 'client_app';
type UpdateAction = UpdateArtifact | 'check';

type UpdateMetadata = {
    artifact: UpdateArtifact;
    version: string;
    filename: string;
    size_bytes: number;
    sha256: string;
    download_url: string;
    updated_at: string;
    update_available: boolean;
};

type UpdateCheckResult = {
    current_versions: Record<UpdateArtifact, string>;
    updates: Record<UpdateArtifact, UpdateMetadata | null>;
    message?: string;
};

type DownloadUpdateResult = {
    success: true;
    artifact: UpdateArtifact;
    version: string;
    filename: string;
    file_path: string;
    size_bytes: number;
    sha256: string;
    message: string;
};

function UpdateCard({
    artifact,
    currentVersion,
    update,
    busy,
    onDownload,
}: {
    artifact: UpdateArtifact;
    currentVersion: string;
    update: UpdateMetadata | null;
    busy: boolean;
    onDownload: () => void;
}) {
    const title = artifact === 'server' ? 'Offline Server' : 'Client App';
    const available = Boolean(update?.update_available);

    return (
        <div className="rounded-md border border-border bg-lightBackground p-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <div className="font-semibold text-slateDark">{title}</div>
                    <div className="mt-1 text-sm text-slate-500">Current version: {currentVersion}</div>
                    <div className="mt-1 text-sm font-semibold text-slateDark">Latest version: {update?.version ?? 'Not checked'}</div>
                </div>
                {update && !available && <CheckCircle2 className="h-5 w-5 text-success" />}
            </div>

            {update && (
                <div className="mt-3 grid gap-1 text-xs font-semibold text-slate-500">
                    <span>{update.filename}</span>
                    <span>{formatSize(update.size_bytes)}</span>
                    <span className="break-all font-mono">SHA256: {update.sha256}</span>
                </div>
            )}

            <div className="mt-4">
                <Button disabled={!update || busy} onClick={onDownload} variant={available ? 'default' : 'secondary'}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    {available ? 'Get Update' : update ? 'Download Again' : 'Check First'}
                </Button>
            </div>
        </div>
    );
}

function hasAvailableUpdate(result: UpdateCheckResult): boolean {
    return Boolean(result.updates.server?.update_available || result.updates.client_app?.update_available);
}

function updateMessageClass(tone: 'success' | 'danger' | 'info'): string {
    if (tone === 'success') {
        return 'border-success/30 bg-success/10 text-success';
    }

    if (tone === 'danger') {
        return 'border-danger/30 bg-danger/10 text-danger';
    }

    return 'border-info/30 bg-info/10 text-info';
}

function formatSize(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function SettingRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
    return (
        <div className="grid gap-2 border-b border-border pb-4 last:border-b-0 last:pb-0 md:grid-cols-[180px_1fr]">
            <div className="text-sm font-medium text-slate-500">{label}</div>
            <div className={`min-w-0 break-words text-sm font-semibold text-slateDark ${mono ? 'font-mono' : ''}`}>{value}</div>
        </div>
    );
}

function Panel({ children, title, body, tone }: { children: ReactNode; title: string; body: string; tone: 'info' | 'danger' }) {
    return (
        <div className={`rounded-md border bg-white p-5 ${tone === 'danger' ? 'border-danger/30' : 'border-border'}`}>
            <div className="flex items-start gap-3">
                {children}
                <div>
                    <div className="font-semibold text-slateDark">{title}</div>
                    <div className="mt-1 text-sm text-slate-500">{body}</div>
                </div>
            </div>
        </div>
    );
}
