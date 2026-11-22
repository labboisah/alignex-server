import { AlertTriangle, CheckCircle2, Loader2, LockKeyhole, MonitorCheck, Power, ServerCog, ShieldCheck, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/confirm-dialog';

const apiBaseUrl = 'http://127.0.0.1:4080';

type ApplicationState = 'not_configured' | 'activated' | 'expired' | 'revoked' | 'maintenance' | 'invalid';

type ActivationStatus = {
    state: ApplicationState;
    configured: boolean;
    device_id: string;
    organization_name: string | null;
    center_name: string | null;
    portal_url: string | null;
    admin_email: string | null;
    activated_at: string | null;
    expires_at: string | null;
    days_remaining: number | null;
    plan: {
        id: number | string | null;
        slug: string | null;
        name: string | null;
    };
    plan_features: Record<string, boolean>;
    message: string;
};

type ActivationGateControls = {
    logout: () => void;
    localAdminSessionToken: string;
};

export function ActivationGate({ children }: { children: ReactNode | ((controls: ActivationGateControls) => ReactNode) }) {
    const [status, setStatus] = useState<ActivationStatus | null>(null);
    const [authenticated, setAuthenticated] = useState(false);
    const [localAdminSessionToken, setLocalAdminSessionToken] = useState('');
    const [mode, setMode] = useState<'activation' | 'login'>('activation');
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void refreshState();
    }, []);

    async function refreshState() {
        setLoading(true);
        setError(null);

        try {
            const response = await fetch(`${apiBaseUrl}/api/app/state`);
            const data = (await response.json()) as { status: ActivationStatus };
            setStatus(data.status);
            setMode(data.status.state === 'activated' ? 'login' : 'activation');
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Unable to load application state.');
        } finally {
            setLoading(false);
        }
    }

    async function post(path: string, body: Record<string, string>) {
        setBusy(true);
        setError(null);

        try {
            const response = await fetch(`${apiBaseUrl}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = (await response.json()) as { status?: ActivationStatus; message?: string; success?: boolean; session_token?: string };

            if (!response.ok) {
                throw new Error(data.message ?? 'Request failed.');
            }

            if (data.status) {
                setStatus(data.status);
                setMode('login');
            }

            return data;
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Request failed.');
            return null;
        } finally {
            setBusy(false);
        }
    }

    async function handleLogin(body: Record<string, string>) {
        const result = await post('/api/app/login', body);

        if (result?.success) {
            setAuthenticated(true);
            if (typeof result.session_token === 'string') {
                setLocalAdminSessionToken(result.session_token);
            }
        }
    }

    async function handleDeactivate(password: string): Promise<boolean> {
        setBusy(true);
        setError(null);

        try {
            const response = await fetch(`${apiBaseUrl}/api/app/deactivate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });
            const data = (await response.json()) as { status?: ActivationStatus; message?: string };

            if (!response.ok) {
                throw new Error(data.message ?? 'Deactivation failed.');
            }

            setAuthenticated(false);
            setLocalAdminSessionToken('');
            setStatus(data.status ?? null);
            setMode('activation');
            return true;
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Deactivation failed.');
            return false;
        } finally {
            setBusy(false);
        }
    }

    if (loading) {
        return (
            <Centered>
                <Panel icon={<Loader2 className="h-7 w-7 animate-spin text-info" />} title="Starting AlignEx Center" description="Checking local configuration and license status." />
            </Centered>
        );
    }

    if (authenticated && status?.state === 'activated') {
        const logout = () => {
            setAuthenticated(false);
            setMode('login');
            setError(null);
        };

        return <>{typeof children === 'function' ? children({ logout, localAdminSessionToken }) : children}</>;
    }

    return (
        <Centered>
            <div className="center-access-shell">
                <section className="center-access-brand" aria-label="AlignEx Offline Server">
                    <ServerBrand />
                    <div className="center-access-rule" />
                    <h1>Reliable local exam delivery.</h1>
                    <p>Operate examinations from this center workstation with the local service, audit trail, and package controls kept on the private network.</p>
                    <div className="center-access-signals">
                        <span><ShieldCheck size={18} />Private center data</span>
                        <span><MonitorCheck size={18} />Local candidate delivery</span>
                        <span><ServerCog size={18} />Server-managed readiness</span>
                    </div>
                </section>
                <section className="center-access-workspace">
                    <div className="center-access-kicker"><LockKeyhole size={15} />Local administration</div>
                    <h2>{mode === 'activation' ? 'Activate this Center Server' : 'Sign in to Center Server'}</h2>
                    <p className="center-access-intro">{mode === 'activation' ? 'Link this workstation to the assigned organization before importing or delivering an examination.' : 'Use the local administrator account configured during activation.'}</p>

                    {error && (
                        <Alert className="mb-5 border-danger/30 bg-danger/5">
                            <AlertTriangle className="h-4 w-4 text-danger" />
                            <AlertTitle>Action failed</AlertTitle>
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    )}

                    {status && status.state !== 'not_configured' && (
                        <LicenseBanner status={status} busy={busy} onDeactivate={handleDeactivate} onRefresh={() => void refreshState()} />
                    )}

                    {mode === 'activation' && <ActivationForm busy={busy} onSubmit={(body) => void post('/api/app/activate', body)} />}
                    {mode === 'login' && <LocalLogin busy={busy} defaultEmail={status?.admin_email ?? ''} onSubmit={(body) => void handleLogin(body)} />}
                </section>
            </div>
        </Centered>
    );
}

function ActivationForm({ busy, onSubmit }: { busy: boolean; onSubmit: (body: Record<string, string>) => void }) {
    return (
        <FormCard title="Activation details" description="Use credentials issued for this center and its assigned organization.">
            <form
                className="space-y-4"
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    onSubmit(formData(event.currentTarget));
                }}
            >
                <Field name="portal_url" label="Portal URL" type="url" placeholder="http://192.168.1.20:8000" required />
                <Field name="activation_code" label="Activation Code" required />
                <Field name="admin_email" label="Admin Email" required />
                <Field name="admin_password" label="Admin Password" type="password" required />
                <div className="flex justify-end">
                    <Button type="submit" disabled={busy}>
                        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                        Activate
                    </Button>
                </div>
            </form>
        </FormCard>
    );
}

function LocalLogin({ busy, defaultEmail, onSubmit }: { busy: boolean; defaultEmail: string; onSubmit: (body: Record<string, string>) => void }) {
    return (
        <FormCard title="Local administrator" description="This sign-in does not leave the center workstation.">
            <form
                className="space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    onSubmit(formData(event.currentTarget));
                }}
            >
                <Field name="email" label="Admin Email" defaultValue={defaultEmail} required />
                <Field name="password" label="Password" type="password" required />
                <div className="flex justify-end">
                    <Button type="submit" disabled={busy}>
                        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                        Login
                    </Button>
                </div>
            </form>
        </FormCard>
    );
}

function LicenseBanner({ status, busy, onDeactivate, onRefresh }: { status: ActivationStatus; busy: boolean; onDeactivate: (password: string) => Promise<boolean>; onRefresh: () => void }) {
    const [dialogOpen, setDialogOpen] = useState(false);
    const [password, setPassword] = useState('');
    const tone = status.state === 'activated' ? 'border-success/30 bg-success/5' : 'border-warning/40 bg-warning/5';
    const Icon = status.state === 'maintenance' ? Wrench : status.state === 'activated' ? CheckCircle2 : AlertTriangle;

    return (
        <div className={`rounded-md border p-3 ${tone}`}>
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slateDark" />
                    <div>
                        <div className="text-sm font-semibold text-slateDark">{labelForState(status.state)}</div>
                        <div className="mt-1 text-xs text-slate-600">{status.message}</div>
                        <div className="mt-2 grid gap-1 text-xs text-slate-500">
                            <span className="truncate">Device: {status.device_id}</span>
                            <span>Expires: {formatDate(status.expires_at)}</span>
                        </div>
                    </div>
                </div>
                <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="outline" onClick={onRefresh}>Refresh</Button>
                    {status.state === 'activated' && (
                        <Button size="sm" variant="danger" onClick={() => setDialogOpen(true)}>
                            <Power className="h-4 w-4" />
                            Deactivate
                        </Button>
                    )}
                </div>
            </div>
            <ConfirmDialog
                open={dialogOpen}
                title="Deactivate this server?"
                message="Your local exam database will be preserved, but this server will stop using its current license. Reactivation will require the activation code again."
                confirmLabel="Deactivate Server"
                confirmTone="danger"
                loading={busy}
                onOpenChange={(open) => {
                    setDialogOpen(open);
                    if (!open) setPassword('');
                }}
                onConfirm={() => void onDeactivate(password).then((success) => {
                    if (success) {
                        setDialogOpen(false);
                        setPassword('');
                    }
                })}
            >
                <label className="block space-y-2">
                    <span className="text-sm font-medium text-slateDark">Local admin password</span>
                    <input
                        autoFocus
                        className="h-11 w-full rounded-md border border-border bg-white px-3 text-sm text-slateDark outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="Enter password to confirm"
                        type="password"
                        value={password}
                    />
                </label>
            </ConfirmDialog>
        </div>
    );
}

function FormCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent>{children}</CardContent>
        </Card>
    );
}

function Field({ name, label, type = 'text', placeholder, required, defaultValue }: { name: string; label: string; type?: string; placeholder?: string; required?: boolean; defaultValue?: string }) {
    return (
        <label className="block space-y-2">
            <span className="text-sm font-medium text-slateDark">{label}</span>
            <input
                className="h-11 w-full rounded-md border border-border bg-white px-3 text-sm text-slateDark outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                defaultValue={defaultValue}
                name={name}
                placeholder={placeholder}
                required={required}
                type={type}
            />
        </label>
    );
}

function Panel({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
    return (
        <Card className="w-full max-w-md">
            <CardContent className="flex items-start gap-3 p-5">
                {icon}
                <div>
                    <div className="font-semibold text-slateDark">{title}</div>
                    <div className="mt-1 text-sm text-slate-500">{description}</div>
                </div>
            </CardContent>
        </Card>
    );
}

function Centered({ children }: { children: ReactNode }) {
    return <main className="center-access-page">{children}</main>;
}

function ServerBrand() {
    return <div className="server-brand"><img src="./images/logo.png" alt="AlignEx Offline Server" /></div>;
}

function formData(form: HTMLFormElement): Record<string, string> {
    const data = new FormData(form);
    return Object.fromEntries(Array.from(data.entries()).map(([key, value]) => [key, String(value)]));
}

function labelForState(state: ApplicationState): string {
    return {
        not_configured: 'Setup Required',
        activated: 'Activated',
        expired: 'License Expired',
        revoked: 'License Revoked',
        maintenance: 'Maintenance Mode',
        invalid: 'Setup Recovery Required',
    }[state];
}

function formatDate(value: string | null): string {
    return value ? new Date(value).toLocaleString() : '-';
}
