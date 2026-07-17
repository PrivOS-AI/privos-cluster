import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
	AlertCircle,
	Check,
	Cpu,
	Globe,
	HardDrive,
	Loader2,
	MemoryStick,
	Plus,
	RefreshCw,
	RotateCcw,
	Save,
	Shield,
	ShieldCheck,
	Sliders,
	X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';

interface DefaultResources {
	memoryMb: number;
	cpus: number;
	tmpSizeMb: number;
}

interface SettingsShape {
	'reverse_proxy.base_domain': string;
	'reverse_proxy.domains': string[];
	'reverse_proxy.enabled': boolean;
	'deploy.default_resources': DefaultResources;
	'quota.max_memory_mb_total': number | null;
	'quota.max_cpus_total': number | null;
	'images.registry_allowlist': string[];
}

interface NetworkingDraft {
	enabled: boolean;
}

interface QuotaDraft {
	maxMemoryMb: string; // empty = null (use host)
	maxCpus: string;
}

const POPULAR_REGISTRIES = ['docker.io', 'ghcr.io', 'gcr.io', 'quay.io', 'registry.gitlab.com', 'mcr.microsoft.com'];

export function SettingsPage() {
	const queryClient = useQueryClient();

	const settingsQuery = useQuery({
		queryKey: ['settings'],
		queryFn: () => api.get<SettingsShape>('/api/v1/settings').then((r) => r.data),
		refetchInterval: 30_000,
	});

	const settings = settingsQuery.data;

	// Per-section drafts so users can edit multiple fields before saving.
	const [networking, setNetworking] = useState<NetworkingDraft>({ enabled: false });
	const [quota, setQuota] = useState<QuotaDraft>({ maxMemoryMb: '', maxCpus: '' });
	const [defaults, setDefaults] = useState<DefaultResources>({ memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 });
	const [newRegistry, setNewRegistry] = useState('');
	const [newDomain, setNewDomain] = useState('');

	useEffect(() => {
		if (!settings) return;
		setNetworking({
			enabled: Boolean(settings['reverse_proxy.enabled']),
		});
		setQuota({
			maxMemoryMb: settings['quota.max_memory_mb_total'] == null ? '' : String(settings['quota.max_memory_mb_total']),
			maxCpus: settings['quota.max_cpus_total'] == null ? '' : String(settings['quota.max_cpus_total']),
		});
		setDefaults(settings['deploy.default_resources'] ?? { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 });
	}, [settings]);

	const bulkMutation = useMutation({
		mutationFn: async (payload: Record<string, unknown>) => {
			await api.patch('/api/v1/settings', payload);
		},
		onSuccess: (_, vars) => {
			toast.success(`Saved ${Object.keys(vars).length} setting${Object.keys(vars).length === 1 ? '' : 's'}`);
			void queryClient.invalidateQueries({ queryKey: ['settings'] });
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	const resetMutation = useMutation({
		mutationFn: async (key: string) => {
			await api.delete(`/api/v1/settings/${encodeURIComponent(key)}`);
		},
		onSuccess: () => {
			toast.success('Reset to default');
			void queryClient.invalidateQueries({ queryKey: ['settings'] });
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	// --- Dirty flags
	const networkingDirty = useMemo(() => {
		if (!settings) return false;
		return networking.enabled !== Boolean(settings['reverse_proxy.enabled']);
	}, [networking, settings]);

	const quotaDirty = useMemo(() => {
		if (!settings) return false;
		const memOriginal = settings['quota.max_memory_mb_total'] == null ? '' : String(settings['quota.max_memory_mb_total']);
		const cpuOriginal = settings['quota.max_cpus_total'] == null ? '' : String(settings['quota.max_cpus_total']);
		return quota.maxMemoryMb !== memOriginal || quota.maxCpus !== cpuOriginal;
	}, [quota, settings]);

	const defaultsDirty = useMemo(() => {
		if (!settings) return false;
		const o = settings['deploy.default_resources'];
		if (!o) return true;
		return o.memoryMb !== defaults.memoryMb || o.cpus !== defaults.cpus || o.tmpSizeMb !== defaults.tmpSizeMb;
	}, [defaults, settings]);

	const allowlist = settings?.['images.registry_allowlist'] ?? [];
	// Domains list: prefer the new list, fall back to seeding from the legacy single base_domain.
	const domains = useMemo(() => {
		const list = settings?.['reverse_proxy.domains'] ?? [];
		if (list.length > 0) return list;
		const legacy = (settings?.['reverse_proxy.base_domain'] ?? '').trim();
		return legacy ? [legacy] : [];
	}, [settings]);

	// --- Actions
	function saveNetworking() {
		bulkMutation.mutate({ 'reverse_proxy.enabled': networking.enabled });
	}

	function addDomain(value: string) {
		const v = value.trim().toLowerCase();
		if (!v || domains.includes(v)) return;
		bulkMutation.mutate({ 'reverse_proxy.domains': [...domains, v] });
		setNewDomain('');
	}

	function removeDomain(host: string) {
		bulkMutation.mutate({ 'reverse_proxy.domains': domains.filter((d) => d !== host) });
	}

	function saveQuota() {
		const payload: Record<string, unknown> = {
			'quota.max_memory_mb_total': quota.maxMemoryMb.trim() ? Number(quota.maxMemoryMb) : null,
			'quota.max_cpus_total': quota.maxCpus.trim() ? Number(quota.maxCpus) : null,
		};
		bulkMutation.mutate(payload);
	}

	function saveDefaults() {
		bulkMutation.mutate({ 'deploy.default_resources': defaults });
	}

	function addRegistry(value: string) {
		const v = value.trim().toLowerCase();
		if (!v || allowlist.includes(v)) return;
		bulkMutation.mutate({ 'images.registry_allowlist': [...allowlist, v] });
		setNewRegistry('');
	}

	function removeRegistry(host: string) {
		bulkMutation.mutate({ 'images.registry_allowlist': allowlist.filter((h) => h !== host) });
	}

	if (settingsQuery.isLoading) {
		return (
			<div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
				<Loader2 className="h-4 w-4 animate-spin" />
				Loading settings...
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
					<p className="text-sm text-muted-foreground">
						Cluster-wide configuration. Changes take effect immediately for new deployments.
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={() => window.location.reload()} title="Hard reload (same as F5)">
					<RefreshCw className="h-4 w-4" />
					Refresh
				</Button>
			</div>

			{/* Summary */}
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<SummaryCard
					icon={Globe}
					label="Reverse proxy"
					value={networking.enabled ? 'Enabled' : 'Disabled'}
					tone={networking.enabled ? 'success' : 'muted'}
				/>
				<SummaryCard
					icon={Globe}
					label="Domains"
					value={domains.length === 0 ? '—' : `${domains.length} domain${domains.length === 1 ? '' : 's'}`}
					tone={domains.length > 0 ? 'success' : 'muted'}
				/>
				<SummaryCard
					icon={Shield}
					label="Allowed registries"
					value={allowlist.length === 0 ? 'Any' : String(allowlist.length)}
					tone={allowlist.length === 0 ? 'warning' : 'success'}
				/>
				<SummaryCard
					icon={Sliders}
					label="Defaults"
					value={`${defaults.memoryMb} MB · ${defaults.cpus} CPU`}
					tone="muted"
				/>
			</div>

			{/* ---------------- Networking ---------------- */}
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Globe className="h-5 w-5" />
						Networking
					</CardTitle>
					<CardDescription>
						How public subdomains route to containers. Requires an external Caddy reverse proxy reading container labels.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					<ToggleRow
						label="Reverse proxy"
						description="When enabled, deployed containers receive Caddy labels so traffic to <subdomain>.<domain> is routed to them."
						checked={networking.enabled}
						onChange={(v) => setNetworking((prev) => ({ ...prev, enabled: v }))}
					/>

					<SectionActions
						dirty={networkingDirty}
						onSave={saveNetworking}
						onReset={() => resetMutation.mutate('reverse_proxy.enabled')}
						isPending={bulkMutation.isPending}
					/>

					<Separator />

					{/* Domains list */}
					<div className="space-y-3">
						<div>
							<h3 className="text-sm font-medium">Base domains</h3>
							<p className="text-xs text-muted-foreground">
								Apps can be published under any of these. Each needs a wildcard DNS record
								(<span className="font-mono">*.domain → server IP</span>). Saved instantly.
							</p>
						</div>

						{domains.length > 0 ? (
							<div className="flex flex-wrap gap-2">
								{domains.map((d) => (
									<span
										key={d}
										className="group inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 py-1 pl-3 pr-1 text-xs text-primary"
									>
										<Globe className="h-3 w-3" />
										<span className="font-mono">{d}</span>
										<button
											type="button"
											onClick={() => removeDomain(d)}
											className="flex h-5 w-5 items-center justify-center rounded-full text-primary/70 transition-colors hover:bg-primary/20 hover:text-primary"
											aria-label={`Remove ${d}`}
										>
											<X className="h-3 w-3" />
										</button>
									</span>
								))}
							</div>
						) : (
							<div className="rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-3 text-xs text-amber-700 dark:text-amber-300">
								<div className="flex items-start gap-2">
									<AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
									<div>
										No domains yet. {networking.enabled ? 'Reverse proxy is on but ' : ''}
										subdomains won't resolve until you add at least one domain.
									</div>
								</div>
							</div>
						)}

						<form
							onSubmit={(e) => {
								e.preventDefault();
								addDomain(newDomain);
							}}
							className="flex gap-2"
						>
							<Input
								value={newDomain}
								onChange={(e) => setNewDomain(e.target.value)}
								placeholder="app.example.com"
								className="flex-1 font-mono"
							/>
							<Button type="submit" variant="outline" disabled={!newDomain.trim() || bulkMutation.isPending}>
								<Plus className="h-4 w-4" />
								Add domain
							</Button>
						</form>

						{newDomain.trim() && (
							<p className="text-xs text-muted-foreground">
								Apps will be reachable at{' '}
								<span className="font-mono text-foreground">https://my-app.{newDomain.trim()}</span>
							</p>
						)}
					</div>
				</CardContent>
			</Card>

			{/* ---------------- Resources & Quotas ---------------- */}
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Sliders className="h-5 w-5" />
						Resources & Quotas
					</CardTitle>
					<CardDescription>
						Cluster-wide ceilings and the defaults pre-filled into the Deploy form.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6">
					{/* Quotas */}
					<div className="space-y-3">
						<div>
							<h3 className="text-sm font-medium">Cluster ceiling</h3>
							<p className="text-xs text-muted-foreground">
								Hard limit across all containers. Leave blank to use the Docker host's full capacity.
							</p>
						</div>
						<div className="grid gap-4 sm:grid-cols-2">
							<QuotaInput
								icon={MemoryStick}
								label="Memory"
								unit="MB"
								value={quota.maxMemoryMb}
								onChange={(v) => setQuota((prev) => ({ ...prev, maxMemoryMb: v }))}
							/>
							<QuotaInput
								icon={Cpu}
								label="CPU"
								unit="cores"
								value={quota.maxCpus}
								onChange={(v) => setQuota((prev) => ({ ...prev, maxCpus: v }))}
							/>
						</div>
						<SectionActions
							dirty={quotaDirty}
							onSave={saveQuota}
							onReset={() => {
								resetMutation.mutate('quota.max_memory_mb_total');
								resetMutation.mutate('quota.max_cpus_total');
							}}
							isPending={bulkMutation.isPending}
						/>
					</div>

					<Separator />

					{/* Default resources */}
					<div className="space-y-3">
						<div>
							<h3 className="text-sm font-medium">Deploy defaults</h3>
							<p className="text-xs text-muted-foreground">
								Pre-filled values when a Deploy form is opened. Users can still override per-deploy.
							</p>
						</div>
						<div className="grid gap-4 sm:grid-cols-3">
							<NumberRow
								icon={MemoryStick}
								label="Memory MB"
								value={defaults.memoryMb}
								onChange={(v) => setDefaults((prev) => ({ ...prev, memoryMb: v }))}
								step={64}
							/>
							<NumberRow
								icon={Cpu}
								label="CPU cores"
								value={defaults.cpus}
								onChange={(v) => setDefaults((prev) => ({ ...prev, cpus: v }))}
								step={0.25}
							/>
							<NumberRow
								icon={HardDrive}
								label="Tmp MB"
								value={defaults.tmpSizeMb}
								onChange={(v) => setDefaults((prev) => ({ ...prev, tmpSizeMb: v }))}
								step={32}
							/>
						</div>
						<SectionActions
							dirty={defaultsDirty}
							onSave={saveDefaults}
							onReset={() => resetMutation.mutate('deploy.default_resources')}
							isPending={bulkMutation.isPending}
						/>
					</div>
				</CardContent>
			</Card>

			{/* ---------------- Image Registry Allowlist ---------------- */}
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Shield className="h-5 w-5" />
						Image registry security
					</CardTitle>
					<CardDescription>
						Which registries this cluster is allowed to pull images from. Empty list means any registry is allowed.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{/* Current chips */}
					{allowlist.length > 0 ? (
						<div className="flex flex-wrap gap-2">
							{allowlist.map((host) => (
								<span
									key={host}
									className="group inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 py-1 pl-3 pr-1 text-xs text-emerald-700 dark:text-emerald-300"
								>
									<ShieldCheck className="h-3 w-3" />
									<span className="font-mono">{host}</span>
									<button
										type="button"
										onClick={() => removeRegistry(host)}
										className="flex h-5 w-5 items-center justify-center rounded-full text-emerald-700/70 transition-colors hover:bg-emerald-500/20 hover:text-emerald-700 dark:text-emerald-300/70 dark:hover:text-emerald-300"
										aria-label={`Remove ${host}`}
									>
										<X className="h-3 w-3" />
									</button>
								</span>
							))}
						</div>
					) : (
						<div className="rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-3 text-xs text-amber-700 dark:text-amber-300">
							<div className="flex items-start gap-2">
								<AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
								<div>
									Allowlist is empty — <span className="font-medium">any registry is currently allowed</span>.
									Add hostnames below to restrict.
								</div>
							</div>
						</div>
					)}

					{/* Add input */}
					<form
						onSubmit={(e) => {
							e.preventDefault();
							addRegistry(newRegistry);
						}}
						className="flex gap-2"
					>
						<Input
							value={newRegistry}
							onChange={(e) => setNewRegistry(e.target.value)}
							placeholder="ghcr.io"
							className="flex-1 font-mono"
						/>
						<Button type="submit" variant="outline" disabled={!newRegistry.trim() || bulkMutation.isPending}>
							<Plus className="h-4 w-4" />
							Add
						</Button>
					</form>

					{/* Popular suggestions */}
					<div>
						<div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Quick add</div>
						<div className="flex flex-wrap gap-1.5">
							{POPULAR_REGISTRIES.filter((r) => !allowlist.includes(r)).map((host) => (
								<button
									key={host}
									type="button"
									onClick={() => addRegistry(host)}
									className="rounded-full border bg-card px-2.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
								>
									+ {host}
								</button>
							))}
						</div>
					</div>

					{allowlist.length > 0 && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => bulkMutation.mutate({ 'images.registry_allowlist': [] })}
							className="text-xs text-muted-foreground hover:text-destructive"
						>
							<RotateCcw className="h-3 w-3" />
							Clear allowlist (allow any)
						</Button>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

// ---------- Subcomponents ----------

function SummaryCard({
	icon: Icon,
	label,
	value,
	tone,
}: {
	icon: typeof Globe;
	label: string;
	value: string;
	tone: 'success' | 'warning' | 'muted';
}) {
	const toneClass =
		tone === 'success'
			? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
			: tone === 'warning'
				? 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300'
				: 'border-border bg-card text-foreground';
	return (
		<div className={cn('rounded-lg border px-3 py-3', toneClass)}>
			<div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide opacity-70">
				<Icon className="h-3 w-3" />
				{label}
			</div>
			<div className="mt-1 truncate text-base font-semibold">{value}</div>
		</div>
	);
}

function ToggleRow({
	label,
	description,
	checked,
	onChange,
}: {
	label: string;
	description: string;
	checked: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<div className="flex items-start justify-between gap-4">
			<div className="min-w-0 flex-1">
				<div className="text-sm font-medium">{label}</div>
				<p className="text-xs text-muted-foreground">{description}</p>
			</div>
			<button
				type="button"
				onClick={() => onChange(!checked)}
				className={cn(
					'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors',
					checked ? 'border-primary bg-primary' : 'border-border bg-muted',
				)}
				aria-pressed={checked}
				aria-label={label}
			>
				<span
					className={cn(
						'inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform',
						checked ? 'translate-x-6' : 'translate-x-1',
					)}
				/>
			</button>
		</div>
	);
}

function QuotaInput({
	icon: Icon,
	label,
	unit,
	value,
	onChange,
}: {
	icon: typeof MemoryStick;
	label: string;
	unit: string;
	value: string;
	onChange: (v: string) => void;
}) {
	return (
		<div className="space-y-1.5">
			<Label className="flex items-center gap-1.5 text-xs">
				<Icon className="h-3 w-3" />
				{label}
				<span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
					{value.trim() ? `${unit} limit` : `Host max`}
				</span>
			</Label>
			<div className="relative">
				<Input
					value={value}
					onChange={(e) => onChange(e.target.value)}
					inputMode="numeric"
					placeholder="Unlimited"
					className="pr-14"
				/>
				<div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
					{unit}
				</div>
			</div>
		</div>
	);
}

function NumberRow({
	icon: Icon,
	label,
	value,
	onChange,
	step = 1,
}: {
	icon: typeof MemoryStick;
	label: string;
	value: number;
	onChange: (v: number) => void;
	step?: number;
}) {
	return (
		<div className="space-y-1.5">
			<Label className="flex items-center gap-1.5 text-xs">
				<Icon className="h-3 w-3" />
				{label}
			</Label>
			<Input
				type="number"
				min={0}
				step={step}
				value={Number.isFinite(value) ? value : 0}
				onChange={(e) => {
					const v = parseFloat(e.target.value);
					onChange(Number.isFinite(v) ? v : 0);
				}}
				className="text-sm"
			/>
		</div>
	);
}

function SectionActions({
	dirty,
	onSave,
	onReset,
	isPending,
}: {
	dirty: boolean;
	onSave: () => void;
	onReset: () => void;
	isPending: boolean;
}) {
	return (
		<div className="flex items-center justify-between border-t pt-3 text-xs">
			<div className="text-muted-foreground">
				{dirty ? (
					<span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
						<AlertCircle className="h-3 w-3" />
						Unsaved changes
					</span>
				) : (
					<span className="inline-flex items-center gap-1 text-muted-foreground">
						<Check className="h-3 w-3" />
						In sync
					</span>
				)}
			</div>
			<div className="flex items-center gap-2">
				<Button variant="ghost" size="sm" onClick={onReset} disabled={isPending} className="h-8">
					<RotateCcw className="h-3.5 w-3.5" />
					Reset
				</Button>
				<Button size="sm" onClick={onSave} disabled={!dirty || isPending} className="h-8">
					{isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
					Save
				</Button>
			</div>
		</div>
	);
}
