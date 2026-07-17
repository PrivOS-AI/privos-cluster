import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
	AlertTriangle,
	Boxes,
	Check,
	ChevronDown,
	ChevronUp,
	Cpu,
	Gauge,
	Globe,
	Loader2,
	MemoryStick,
	Package,
	Rocket,
	Search,
	ShieldCheck,
	Sparkles,
	X,
	Zap,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';

export interface DeployFormState {
	image: string;
	tag: string;
	port: string;
	appId: string;
	subdomain: string;
	domain: string;
	memoryMb: string;
	cpus: string;
	tmpSizeMb: string;
	envJson: string;
	volumeName: string;
	volumeMountPath: string;
	volumeSizeMb: string;
}

interface ClusterImage {
	id: string;
	repository: string;
	tag: string;
	source: 'pulled' | 'built' | 'registered';
	sizeBytes: number;
	updatedAt: number;
}

interface SubdomainCheck {
	available: boolean;
	host: string | null;
	reason?: string;
	reverseProxyEnabled?: boolean;
}

interface Settings {
	'reverse_proxy.enabled'?: boolean;
	'reverse_proxy.base_domain'?: string;
	'reverse_proxy.domains'?: string[];
}

interface Props {
	form: DeployFormState;
	setForm: React.Dispatch<React.SetStateAction<DeployFormState>>;
	subdomainCheck: SubdomainCheck | undefined;
	isPending: boolean;
	onDeploy: () => void;
}

interface ResourcePreset {
	id: 'nano' | 'small' | 'medium' | 'large';
	label: string;
	icon: typeof Zap;
	memoryMb: number;
	cpus: number;
	tmpSizeMb: number;
	desc: string;
}

const PRESETS: ResourcePreset[] = [
	{ id: 'nano', label: 'Nano', icon: Zap, memoryMb: 128, cpus: 0.25, tmpSizeMb: 32, desc: 'Static / scripts' },
	{ id: 'small', label: 'Small', icon: Sparkles, memoryMb: 256, cpus: 0.5, tmpSizeMb: 64, desc: 'Small API' },
	{ id: 'medium', label: 'Medium', icon: Gauge, memoryMb: 512, cpus: 1.0, tmpSizeMb: 128, desc: 'Typical web app' },
	{ id: 'large', label: 'Large', icon: Rocket, memoryMb: 1024, cpus: 2.0, tmpSizeMb: 256, desc: 'Heavy workload' },
];

function detectPreset(memoryMb: number, cpus: number, tmpSizeMb: number): ResourcePreset['id'] | 'custom' {
	const hit = PRESETS.find(
		(p) => p.memoryMb === memoryMb && p.cpus === cpus && p.tmpSizeMb === tmpSizeMb,
	);
	return hit ? hit.id : 'custom';
}

interface ValidationCheck {
	id: string;
	label: string;
	status: 'ok' | 'warn' | 'fail';
	message?: string;
}

interface ValidationResponse {
	ok: boolean;
	checks: ValidationCheck[];
}

/**
 * Build a deploy payload from form state. Used both by the validate endpoint
 * (preflight) and the actual deploy mutation in parent components so the wire
 * shape stays identical.
 */
export function buildDeployPayload(form: DeployFormState): Record<string, unknown> | { _error: string } {
	let envVars: Record<string, string> = {};
	try {
		if (form.envJson.trim()) {
			const parsed = JSON.parse(form.envJson) as Record<string, unknown>;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return { _error: 'env vars must be a JSON object' };
			}
			for (const [key, value] of Object.entries(parsed)) {
				if (value === null || value === undefined) continue;
				envVars[key] = typeof value === 'string' ? value : JSON.stringify(value);
			}
		}
	} catch (err) {
		return { _error: (err as Error).message };
	}

	return {
		image: form.image.trim(),
		tag: form.tag.trim() || 'latest',
		port: Number(form.port),
		appId: form.appId.trim() || undefined,
		subdomain: form.subdomain.trim() || undefined,
		domain: form.domain.trim() || undefined,
		resources: {
			memoryMb: Number(form.memoryMb),
			cpus: Number(form.cpus),
			tmpSizeMb: Number(form.tmpSizeMb),
		},
		envVars,
		volumes:
			form.volumeName.trim() && form.volumeMountPath.trim()
				? [
						{
							name: form.volumeName.trim(),
							mountPath: form.volumeMountPath.trim(),
							sizeMb: form.volumeSizeMb.trim() ? Number(form.volumeSizeMb) : undefined,
						},
				  ]
				: undefined,
	};
}

function useDebounced<T>(value: T, delay = 350): T {
	const [v, setV] = useState(value);
	useEffect(() => {
		const id = window.setTimeout(() => setV(value), delay);
		return () => window.clearTimeout(id);
	}, [value, delay]);
	return v;
}

export function DeployForm({ form, setForm, subdomainCheck, isPending, onDeploy }: Props) {
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [imagePickerOpen, setImagePickerOpen] = useState(false);
	const [imageQuery, setImageQuery] = useState('');
	const pickerRef = useRef<HTMLDivElement>(null);

	// --- Preflight validation ---
	const debouncedForm = useDebounced(form, 350);
	const payloadForValidation = useMemo(() => buildDeployPayload(debouncedForm), [debouncedForm]);
	const payloadError: string | null =
		'_error' in payloadForValidation && typeof payloadForValidation._error === 'string'
			? payloadForValidation._error
			: null;

	const validationQuery = useQuery<ValidationResponse>({
		queryKey: ['deploy-validate', JSON.stringify(payloadForValidation)],
		queryFn: () =>
			api
				.post<ValidationResponse>('/api/v1/apps/deploy/validate', payloadForValidation)
				.then((r) => r.data),
		enabled: !payloadError && Boolean(debouncedForm.image.trim()),
		staleTime: 0,
		retry: 0,
	});

	const failChecks = validationQuery.data?.checks.filter((c) => c.status === 'fail') ?? [];
	const canDeploy = !payloadError && validationQuery.data?.ok === true && !validationQuery.isFetching;

	const imagesQuery = useQuery({
		queryKey: ['images'],
		queryFn: () => api.get<ClusterImage[]>('/api/v1/images').then((r) => r.data),
		staleTime: 30_000,
	});

	const settingsQuery = useQuery({
		queryKey: ['settings'],
		queryFn: () => api.get<Settings>('/api/v1/settings').then((r) => r.data),
		staleTime: 60_000,
	});

	const proxyEnabled = Boolean(settingsQuery.data?.['reverse_proxy.enabled']);
	// Domains list (seed from legacy single base_domain if list is empty).
	const domains = useMemo(() => {
		const list = settingsQuery.data?.['reverse_proxy.domains'] ?? [];
		if (list.length > 0) return list;
		const legacy = (settingsQuery.data?.['reverse_proxy.base_domain'] ?? '').trim();
		return legacy ? [legacy] : [];
	}, [settingsQuery.data]);
	// The domain currently selected (defaults to the first configured one).
	const selectedDomain = form.domain.trim() || domains[0] || '';
	const baseDomain = selectedDomain;

	const activePreset = detectPreset(
		Number(form.memoryMb) || 0,
		Number(form.cpus) || 0,
		Number(form.tmpSizeMb) || 0,
	);

	const filteredImages = useMemo(() => {
		const list = imagesQuery.data ?? [];
		const q = imageQuery.trim().toLowerCase();
		if (!q) return list.slice(0, 30);
		return list
			.filter((img) => `${img.repository}:${img.tag}`.toLowerCase().includes(q))
			.slice(0, 30);
	}, [imagesQuery.data, imageQuery]);

	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
				setImagePickerOpen(false);
			}
		}
		document.addEventListener('mousedown', handleClick);
		return () => document.removeEventListener('mousedown', handleClick);
	}, []);

	function applyPreset(p: ResourcePreset) {
		setForm((prev) => ({
			...prev,
			memoryMb: String(p.memoryMb),
			cpus: String(p.cpus),
			tmpSizeMb: String(p.tmpSizeMb),
		}));
	}

	function pickImage(img: ClusterImage) {
		setForm((prev) => ({ ...prev, image: img.repository, tag: img.tag }));
		setImagePickerOpen(false);
		setImageQuery('');
	}

	const subdomainPreviewHost = useMemo(() => {
		const v = form.subdomain.trim();
		if (!v) return null;
		if (subdomainCheck?.host) return subdomainCheck.host;
		if (baseDomain) return `${v}.${baseDomain}`;
		return null;
	}, [form.subdomain, subdomainCheck?.host, baseDomain]);

	return (
		<div className="space-y-6">
			{/* ---------- Section: Image source ---------- */}
			<section className="space-y-3">
				<SectionHeading
					icon={Boxes}
					title="Image"
					subtitle="What runs inside the container"
					right={
						imagesQuery.data ? (
							<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
								{imagesQuery.data.length} in cluster
							</span>
						) : null
					}
				/>

				<div className="space-y-2" ref={pickerRef}>
					<div className="relative">
						<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={form.image}
							onFocus={() => setImagePickerOpen(true)}
							onChange={(e) => {
								setForm((prev) => ({ ...prev, image: e.target.value }));
								setImageQuery(e.target.value);
								setImagePickerOpen(true);
							}}
							placeholder="Choose from cluster or type ghcr.io/org/app..."
							className="pl-9"
							autoComplete="off"
						/>
					</div>
					{imagePickerOpen && (
						<div className="relative">
							<div className="absolute left-0 right-0 top-1 z-20 max-h-[280px] overflow-auto rounded-md border bg-popover shadow-md">
								{imagesQuery.isLoading && (
									<div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground">
										<Loader2 className="h-3.5 w-3.5 animate-spin" />
										Loading cluster images...
									</div>
								)}
								{!imagesQuery.isLoading && filteredImages.length === 0 && (
									<div className="px-3 py-2.5 text-xs text-muted-foreground">
										No cluster images match. Type a custom path (e.g.{' '}
										<span className="font-mono text-foreground">ghcr.io/org/app</span>) and we'll pull it.
									</div>
								)}
								{filteredImages.map((img) => (
									<button
										key={img.id}
										type="button"
										onMouseDown={(e) => e.preventDefault()}
										onClick={() => pickImage(img)}
										className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm hover:bg-accent last:border-b-0"
									>
										<Package className="h-3.5 w-3.5 text-muted-foreground" />
										<span className="font-medium">{img.repository}</span>
										<span className="rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]">
											{img.tag}
										</span>
										<span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
											{img.source}
										</span>
									</button>
								))}
							</div>
						</div>
					)}
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-2">
						<Label>Tag</Label>
						<Input
							value={form.tag}
							onChange={(e) => setForm((prev) => ({ ...prev, tag: e.target.value }))}
							placeholder="latest"
						/>
					</div>
					<div className="space-y-2">
						<Label>Port</Label>
						<Input
							value={form.port}
							onChange={(e) => setForm((prev) => ({ ...prev, port: e.target.value }))}
							inputMode="numeric"
							placeholder="3001"
						/>
					</div>
				</div>
			</section>

			{/* ---------- Section: Resources ---------- */}
			<section className="space-y-3">
				<SectionHeading
					icon={Gauge}
					title="Resources"
					subtitle="CPU + memory limits for the container"
					right={
						<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
							{activePreset === 'custom' ? 'Custom' : `Preset · ${activePreset}`}
						</span>
					}
				/>
				<div className="space-y-2">
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
						{PRESETS.map((preset) => {
							const Icon = preset.icon;
							const isActive = activePreset === preset.id;
							return (
								<button
									key={preset.id}
									type="button"
									onClick={() => applyPreset(preset)}
									className={cn(
										'flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left transition-colors',
										isActive
											? 'border-primary bg-primary/5'
											: 'border-border hover:border-primary/50 hover:bg-accent/40',
									)}
								>
									<div className="flex w-full items-center gap-1.5">
										<Icon className={cn('h-3.5 w-3.5', isActive ? 'text-primary' : 'text-muted-foreground')} />
										<span className="text-sm font-medium">{preset.label}</span>
									</div>
									<div className="text-[10px] text-muted-foreground">
										{preset.memoryMb} MB · {preset.cpus} CPU
									</div>
								</button>
							);
						})}
					</div>

					{/* Custom inputs (always visible, fine-tune above preset) */}
					<div className="grid gap-3 pt-1 sm:grid-cols-3">
						<MetricInput
							icon={MemoryStick}
							label="Memory MB"
							value={form.memoryMb}
							onChange={(v) => setForm((prev) => ({ ...prev, memoryMb: v }))}
						/>
						<MetricInput
							icon={Cpu}
							label="CPU cores"
							value={form.cpus}
							onChange={(v) => setForm((prev) => ({ ...prev, cpus: v }))}
							inputMode="decimal"
						/>
						<MetricInput
							icon={MemoryStick}
							label="Tmp MB"
							value={form.tmpSizeMb}
							onChange={(v) => setForm((prev) => ({ ...prev, tmpSizeMb: v }))}
						/>
					</div>
				</div>
			</section>

			{/* ---------- Section: Networking ---------- */}
			<section className="space-y-3">
				<SectionHeading
					icon={Globe}
					title="Networking"
					subtitle="Public subdomain — optional, requires Caddy reverse proxy"
				/>
				<div className="space-y-2">
					<div className="flex items-stretch overflow-hidden rounded-md border focus-within:ring-1 focus-within:ring-ring">
						<Input
							value={form.subdomain}
							onChange={(e) => setForm((prev) => ({ ...prev, subdomain: e.target.value }))}
							placeholder="my-app"
							className="border-0 focus-visible:ring-0"
						/>
						{domains.length > 1 ? (
							<select
								value={selectedDomain}
								onChange={(e) => setForm((prev) => ({ ...prev, domain: e.target.value }))}
								className="shrink-0 border-0 border-l bg-muted/50 px-3 font-mono text-xs text-muted-foreground focus:outline-none"
							>
								{domains.map((d) => (
									<option key={d} value={d}>
										.{d}
									</option>
								))}
							</select>
						) : (
							<div className="flex shrink-0 items-center bg-muted/50 px-3 font-mono text-xs text-muted-foreground">
								.{baseDomain || '<base-domain>'}
							</div>
						)}
					</div>

					{domains.length === 0 && proxyEnabled && (
						<p className="text-xs text-muted-foreground">
							No domains configured.{' '}
							<a href="/settings" className="underline">
								Add one in Settings
							</a>{' '}
							to publish under a domain.
						</p>
					)}

					{/* Subdomain status / preview */}
					{form.subdomain.trim() && subdomainCheck && (
						<div
							className={cn(
								'rounded-md border px-3 py-2 text-xs',
								subdomainCheck.available
									? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
									: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
							)}
						>
							{subdomainCheck.available ? (
								subdomainPreviewHost ? (
									<>
										Available — your app will be reachable at{' '}
										<span className="font-mono font-medium">https://{subdomainPreviewHost}</span>
									</>
								) : (
									<>Available</>
								)
							) : (
								subdomainCheck.reason ?? 'Unavailable'
							)}
						</div>
					)}

					{/* Reverse proxy warning */}
					{form.subdomain.trim() && settingsQuery.data && !proxyEnabled && (
						<div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
							<AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
							<div>
								Reverse proxy is <span className="font-medium">disabled</span> in cluster settings. The subdomain will be stored as metadata but{' '}
								<span className="font-medium">no traffic will route to your container</span> until you enable it.{' '}
								<a href="/settings" className="underline">
									Open Settings
								</a>
							</div>
						</div>
					)}
				</div>
			</section>

			{/* ---------- Section: Advanced (collapsible) ---------- */}
			<section>
				<button
					type="button"
					onClick={() => setAdvancedOpen((v) => !v)}
					className="flex w-full items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm transition-colors hover:bg-muted/50"
				>
					<span className="flex items-center gap-2 font-medium">
						<span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
							<Sparkles className="h-3.5 w-3.5" />
						</span>
						Advanced options
						<span className="text-xs font-normal text-muted-foreground">— App ID, env vars, volumes</span>
					</span>
					{advancedOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
				</button>

					{advancedOpen && (
						<div className="mt-3 space-y-4 rounded-md border bg-muted/20 p-4">
							<div className="space-y-2">
								<Label>App ID</Label>
								<Input
									value={form.appId}
									onChange={(e) => setForm((prev) => ({ ...prev, appId: e.target.value }))}
									placeholder="Optional metadata identifier"
								/>
							</div>

							<div className="space-y-2">
								<Label>Environment variables (JSON)</Label>
								<Textarea
									value={form.envJson}
									onChange={(e) => setForm((prev) => ({ ...prev, envJson: e.target.value }))}
									className="min-h-[100px] font-mono text-xs"
								/>
							</div>

							<Separator />

							<div className="space-y-3">
								<div className="text-sm font-medium">Volume (optional)</div>
								<div className="grid gap-3 sm:grid-cols-2">
									<div className="space-y-2">
										<Label>Volume name</Label>
										<Input
											value={form.volumeName}
											onChange={(e) => setForm((prev) => ({ ...prev, volumeName: e.target.value }))}
											placeholder="data"
										/>
									</div>
									<div className="space-y-2">
										<Label>Mount path</Label>
										<Input
											value={form.volumeMountPath}
											onChange={(e) =>
												setForm((prev) => ({ ...prev, volumeMountPath: e.target.value }))
											}
											placeholder="/app/data"
										/>
									</div>
								</div>
								<div className="space-y-2">
									<Label>Volume size MB</Label>
									<Input
										value={form.volumeSizeMb}
										onChange={(e) => setForm((prev) => ({ ...prev, volumeSizeMb: e.target.value }))}
										inputMode="numeric"
									/>
								</div>
							</div>
						</div>
					)}
			</section>

			{/* ---------- Footer: Preflight + Deploy ---------- */}
			<div className="-mx-6 -mb-5 mt-2 space-y-3 border-t bg-muted/20 px-6 py-4">
				<div className="space-y-2 rounded-lg border bg-card p-3">
					<div className="flex items-center gap-2 text-sm font-medium">
						<ShieldCheck className="h-4 w-4" />
						Preflight checks
						{validationQuery.isFetching && (
							<Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
						)}
						{validationQuery.data && (
							<span className="ml-auto text-xs text-muted-foreground">
								{validationQuery.data.ok ? 'all checks passed' : `${failChecks.length} blocking`}
							</span>
						)}
					</div>

					{payloadError ? (
						<CheckRow status="fail" label="Form payload" message={payloadError} />
					) : !form.image.trim() ? (
						<p className="text-xs text-muted-foreground">
							Fill in the image to run preflight checks.
						</p>
					) : validationQuery.isLoading ? (
						<p className="text-xs text-muted-foreground">Running checks...</p>
					) : validationQuery.isError ? (
						<CheckRow status="fail" label="Validation request" message="server returned an error" />
					) : validationQuery.data ? (
						<div className="space-y-1.5">
							{validationQuery.data.checks.map((c) => (
								<CheckRow key={c.id} status={c.status} label={c.label} message={c.message} />
							))}
						</div>
					) : null}
				</div>

				<Button
					size="lg"
					className="w-full text-base"
					onClick={onDeploy}
					disabled={isPending || !canDeploy}
					title={!canDeploy ? 'Fix preflight errors first' : undefined}
				>
					{isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Rocket className="h-5 w-5" />}
					{isPending ? 'Deploying...' : 'Deploy container'}
				</Button>
			</div>
		</div>
	);
}

function CheckRow({
	status,
	label,
	message,
}: {
	status: 'ok' | 'warn' | 'fail';
	label: string;
	message?: string;
}) {
	const toneClass =
		status === 'ok'
			? 'text-emerald-600 dark:text-emerald-400'
			: status === 'warn'
				? 'text-amber-600 dark:text-amber-400'
				: 'text-rose-600 dark:text-rose-400';
	const Icon = status === 'ok' ? Check : status === 'warn' ? AlertTriangle : X;
	return (
		<div className="flex items-start gap-2 text-xs">
			<Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', toneClass)} />
			<div className="min-w-0 flex-1">
				<span className="font-medium">{label}</span>
				{message && <span className="text-muted-foreground"> — {message}</span>}
			</div>
		</div>
	);
}

function SectionHeading({
	icon: Icon,
	title,
	subtitle,
	right,
}: {
	icon: typeof Cpu;
	title: string;
	subtitle?: string;
	right?: React.ReactNode;
}) {
	return (
		<div className="flex items-end justify-between gap-3 border-b pb-2">
			<div className="flex items-center gap-2">
				<div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
					<Icon className="h-3.5 w-3.5" />
				</div>
				<div className="space-y-0.5">
					<div className="text-sm font-semibold leading-none">{title}</div>
					{subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
				</div>
			</div>
			{right && <div className="shrink-0">{right}</div>}
		</div>
	);
}

function MetricInput({
	icon: Icon,
	label,
	value,
	onChange,
	inputMode = 'numeric',
}: {
	icon: typeof Cpu;
	label: string;
	value: string;
	onChange: (v: string) => void;
	inputMode?: 'numeric' | 'decimal';
}) {
	return (
		<div className="space-y-1.5">
			<Label className="flex items-center gap-1.5 text-xs">
				<Icon className="h-3 w-3" />
				{label}
			</Label>
			<Input
				value={value}
				onChange={(e) => onChange(e.target.value)}
				inputMode={inputMode}
				className="h-9 text-sm"
			/>
		</div>
	);
}
