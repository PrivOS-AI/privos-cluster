import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
	Activity,
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	Box,
	ChevronRight,
	CircleDot,
	Container as ContainerIcon,
	Cpu,
	HeartPulse,
	Loader2,
	MemoryStick,
	Play,
	Plus,
	RefreshCw,
	Rocket,
	StopCircle,
	Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { cn, formatRelativeTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogBody } from '@/components/ui/dialog';
import { DeployForm, type DeployFormState } from '@/components/containers/DeployForm';
import {
	HEALTH_STYLES,
	STATE_DOT,
	STATE_STYLES,
	type ContainerRecord,
	type ClusterResourcesResponse,
} from '@/components/containers/types';

const defaultDeployForm: DeployFormState = {
	image: 'ghcr.io/example/app',
	tag: 'latest',
	port: '3001',
	appId: '',
	subdomain: '',
	domain: '',
	memoryMb: '256',
	cpus: '0.5',
	tmpSizeMb: '64',
	envJson: '{\n  "NODE_ENV": "production"\n}',
	volumeName: '',
	volumeMountPath: '',
	volumeSizeMb: '128',
};

function safeParseEnvJson(raw: string): Record<string, string> {
	if (!raw.trim()) return {};
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('env vars must be a JSON object');
	}
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (value === null || value === undefined) continue;
		result[key] = typeof value === 'string' ? value : JSON.stringify(value);
	}
	return result;
}

type SortKey = 'name' | 'image' | 'state' | 'created';
type SortDir = 'asc' | 'desc';

type FilterState = 'all' | 'running' | 'stopped' | 'error';

export function ContainersPage() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const [deployOpen, setDeployOpen] = useState(false);
	const [deployForm, setDeployForm] = useState<DeployFormState>(defaultDeployForm);
	const [filter, setFilter] = useState<FilterState>('all');
	const [q, setQ] = useState('');
	const [sortKey, setSortKey] = useState<SortKey>('created');
	const [sortDir, setSortDir] = useState<SortDir>('desc');

	const containersQuery = useQuery({
		queryKey: ['containers'],
		queryFn: () => api.get<ContainerRecord[]>('/api/v1/apps').then((r) => r.data),
		refetchInterval: 5_000,
	});

	const resourcesQuery = useQuery({
		queryKey: ['cluster', 'resources'],
		queryFn: () => api.get<ClusterResourcesResponse>('/api/v1/cluster/resources').then((r) => r.data),
		refetchInterval: 5_000,
	});

	const subdomainCheckQuery = useQuery({
		queryKey: ['cluster', 'subdomain-check', deployForm.subdomain, deployForm.domain],
		queryFn: () =>
			api
				.get<{ available: boolean; host: string | null; reason?: string }>(
					'/api/v1/cluster/subdomain-check',
					{ params: { value: deployForm.subdomain, domain: deployForm.domain || undefined } },
				)
				.then((r) => r.data),
		enabled: deployForm.subdomain.trim().length > 0 && deployOpen,
	});

	// Pre-fill the deploy form when navigated to with ?image=&tag= (e.g. from /images/:id).
	// Also auto-open the dialog.
	useEffect(() => {
		const image = searchParams.get('image');
		const tag = searchParams.get('tag');
		if (!image && !tag) return;
		setDeployForm((prev) => ({
			...prev,
			image: image ?? prev.image,
			tag: tag ?? prev.tag,
		}));
		setDeployOpen(true);
		const next = new URLSearchParams(searchParams);
		next.delete('image');
		next.delete('tag');
		setSearchParams(next, { replace: true });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const deployMutation = useMutation({
		mutationFn: async () => {
			const payload = {
				image: deployForm.image.trim(),
				tag: deployForm.tag.trim() || 'latest',
				port: Number(deployForm.port),
				appId: deployForm.appId.trim() || undefined,
				subdomain: deployForm.subdomain.trim() || undefined,
				domain: deployForm.domain.trim() || undefined,
				resources: {
					memoryMb: Number(deployForm.memoryMb),
					cpus: Number(deployForm.cpus),
					tmpSizeMb: Number(deployForm.tmpSizeMb),
				},
				envVars: safeParseEnvJson(deployForm.envJson),
				volumes:
					deployForm.volumeName.trim() && deployForm.volumeMountPath.trim()
						? [
								{
									name: deployForm.volumeName.trim(),
									mountPath: deployForm.volumeMountPath.trim(),
									sizeMb: deployForm.volumeSizeMb.trim()
										? Number(deployForm.volumeSizeMb)
										: undefined,
								},
						  ]
						: undefined,
			};
			const res = await api.post<ContainerRecord>('/api/v1/apps/deploy', payload, {
				timeout: 120_000,
			});
			return res.data;
		},
		onSuccess: (container) => {
			toast.success(`Deployed ${container.dockerContainerName}`);
			setDeployForm(defaultDeployForm);
			setDeployOpen(false);
			void queryClient.invalidateQueries({ queryKey: ['containers'] });
			void queryClient.invalidateQueries({ queryKey: ['cluster', 'resources'] });
			navigate(`/containers/${container.id}`);
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	const quickActionMutation = useMutation({
		mutationFn: async (args: { id: string; action: 'start' | 'stop' }) => {
			const timeout = args.action === 'start' ? 60_000 : 30_000;
			await api.post(`/api/v1/apps/${args.id}/${args.action}`, undefined, { timeout });
			return args;
		},
		onSuccess: ({ action }) => {
			toast.success(`${action[0].toUpperCase()}${action.slice(1)} complete`);
			void queryClient.invalidateQueries({ queryKey: ['containers'] });
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	const deleteMutation = useMutation({
		mutationFn: async (id: string) => {
			await api.delete(`/api/v1/apps/${id}`, { timeout: 30_000 });
		},
		onSuccess: () => {
			toast.success('Container deleted');
			void queryClient.invalidateQueries({ queryKey: ['containers'] });
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	const containers = containersQuery.data ?? [];

	const filtered = useMemo(() => {
		const needle = q.trim().toLowerCase();
		return containers.filter((c) => {
			if (filter !== 'all' && c.state !== filter) return false;
			if (!needle) return true;
			return (
				c.dockerContainerName.toLowerCase().includes(needle) ||
				c.image.toLowerCase().includes(needle) ||
				(c.subdomain ?? '').toLowerCase().includes(needle)
			);
		});
	}, [containers, filter, q]);

	const sorted = useMemo(() => {
		const copy = [...filtered];
		copy.sort((a, b) => {
			let cmp = 0;
			switch (sortKey) {
				case 'name':
					cmp = a.dockerContainerName.localeCompare(b.dockerContainerName);
					break;
				case 'image':
					cmp = `${a.image}:${a.tag}`.localeCompare(`${b.image}:${b.tag}`);
					break;
				case 'state':
					cmp = a.state.localeCompare(b.state);
					break;
				case 'created':
					cmp = a.createdAt - b.createdAt;
					break;
			}
			return sortDir === 'asc' ? cmp : -cmp;
		});
		return copy;
	}, [filtered, sortKey, sortDir]);

	function toggleSort(key: SortKey) {
		if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
		else {
			setSortKey(key);
			setSortDir(key === 'created' ? 'desc' : 'asc');
		}
	}

	const runningCount = containers.filter((c) => c.state === 'running').length;
	const healthyCount = containers.filter((c) => c.healthCheck.status === 'healthy').length;
	const errorCount = containers.filter((c) => c.state === 'error').length;
	const allocatedMem = resourcesQuery.data?.allocated.memoryMb ?? 0;
	const totalMem = resourcesQuery.data?.host.totalMemoryMb ?? 1;
	const memPercent = Math.min(100, Math.round((allocatedMem / totalMem) * 100));

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Containers</h1>
					<p className="text-sm text-muted-foreground">
						Live state of all containers managed by this cluster.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Button variant="outline" size="sm" onClick={() => window.location.reload()} title="Hard reload (same as F5)">
						<RefreshCw className="h-4 w-4" />
						Refresh
					</Button>
					<Button
						onClick={() => setDeployOpen(true)}
						className="group gap-2 bg-gradient-to-r from-primary via-primary to-primary/90 px-4 shadow-sm hover:shadow-md"
					>
						<span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-foreground/15 transition-transform group-hover:rotate-90">
							<Plus className="h-3.5 w-3.5" />
						</span>
						Deploy app
					</Button>
				</div>
			</div>

			{/* Stats */}
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<StatCard
					icon={ContainerIcon}
					label="Containers"
					value={`${runningCount} / ${containers.length}`}
					sub="running / total"
					tone="primary"
				/>
				<StatCard
					icon={HeartPulse}
					label="Healthy"
					value={`${healthyCount} / ${containers.length}`}
					sub={errorCount > 0 ? `${errorCount} error` : 'all good'}
					tone={errorCount > 0 ? 'warning' : 'success'}
				/>
				<StatCard
					icon={MemoryStick}
					label="Memory allocated"
					value={`${allocatedMem.toLocaleString()} MB`}
					sub={`of ${totalMem.toLocaleString()} MB host`}
					bar={memPercent}
				/>
				<StatCard
					icon={Cpu}
					label="CPU allocated"
					value={`${(resourcesQuery.data?.allocated.cpus ?? 0).toFixed(2)} cores`}
					sub={`of ${resourcesQuery.data?.host.cpuCount ?? '—'} cores`}
				/>
			</div>

			{/* Filters */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex flex-wrap items-center gap-3">
						<CardTitle className="text-base">Managed containers</CardTitle>
						<div className="ml-auto flex flex-wrap items-center gap-2">
							<input
								value={q}
								onChange={(e) => setQ(e.target.value)}
								placeholder="Search name, image, subdomain..."
								className="h-8 w-64 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
							/>
							<div className="inline-flex rounded-md border bg-card p-0.5">
								{(['all', 'running', 'stopped', 'error'] as const).map((s) => (
									<button
										key={s}
										type="button"
										onClick={() => setFilter(s)}
										className={cn(
											'rounded px-2.5 py-1 text-xs capitalize transition-colors',
											filter === s
												? 'bg-secondary text-secondary-foreground shadow-sm'
												: 'text-muted-foreground hover:text-foreground',
										)}
									>
										{s}
									</button>
								))}
							</div>
						</div>
					</div>
				</CardHeader>
				<CardContent className="p-0">
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<colgroup>
								<col className="w-[26%]" />
								<col className="w-[22%]" />
								<col className="w-[18%]" />
								<col className="w-[10%]" />
								<col className="w-[10%]" />
								<col className="w-[14%]" />
							</colgroup>
							<thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
								<tr>
									<SortableTh
										label="Name"
										active={sortKey === 'name'}
										dir={sortDir}
										onClick={() => toggleSort('name')}
										className="pl-[34px]"
									/>
									<SortableTh label="Image" active={sortKey === 'image'} dir={sortDir} onClick={() => toggleSort('image')} />
									<SortableTh label="State" active={sortKey === 'state'} dir={sortDir} onClick={() => toggleSort('state')} />
									<th className="px-4 py-2.5 font-medium">Ports</th>
									<SortableTh label="Created" active={sortKey === 'created'} dir={sortDir} onClick={() => toggleSort('created')} />
									<th className="px-4 py-2.5 pr-9 text-right font-medium">Actions</th>
								</tr>
							</thead>
							<tbody>
								{containersQuery.isLoading && (
									<tr>
										<td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
											<div className="inline-flex items-center gap-2">
												<Loader2 className="h-4 w-4 animate-spin" />
												Loading containers...
											</div>
										</td>
									</tr>
								)}
								{!containersQuery.isLoading && sorted.length === 0 && (
									<tr>
										<td colSpan={6} className="px-4 py-12 text-center text-sm text-muted-foreground">
											<Box className="mx-auto mb-2 h-8 w-8 opacity-40" />
											{containers.length === 0
												? 'No containers yet. Click "Deploy app" to launch one.'
												: 'No containers match the current filters.'}
										</td>
									</tr>
								)}
								{sorted.map((c) => (
									<tr
										key={c.id}
										onClick={() => navigate(`/containers/${c.id}`)}
										className="group h-12 cursor-pointer border-b transition-colors last:border-b-0 hover:bg-accent/40"
									>
										<td className="px-4 align-middle">
											<div className="flex min-w-0 items-center gap-2.5">
												<span className={cn('h-2 w-2 shrink-0 rounded-full', STATE_DOT[c.state])} aria-hidden />
												<div className="min-w-0 flex-1">
													<div className="truncate text-sm font-medium leading-5">{c.dockerContainerName}</div>
													{c.subdomain && (
														<div className="truncate text-xs leading-4 text-muted-foreground">{c.subdomain}</div>
													)}
												</div>
												{c.adopted && (
													<Badge variant="outline" className="shrink-0 border-sky-500/30 bg-sky-500/10 text-[10px] text-sky-700 dark:text-sky-300">
														adopted
													</Badge>
												)}
											</div>
										</td>
										<td className="px-4 align-middle">
											<div className="truncate font-mono text-xs">
												<span>{c.image}</span>
												<span className="text-muted-foreground">:{c.tag}</span>
											</div>
										</td>
										<td className="px-4 align-middle">
											<div className="inline-flex items-center gap-2">
												<Badge variant="outline" className={cn('text-[10px] uppercase tracking-wide', STATE_STYLES[c.state])}>
													<CircleDot className="mr-1 h-2.5 w-2.5" />
													{c.state}
												</Badge>
												<span
													className={cn('inline-flex items-center gap-1 text-[10px]', HEALTH_STYLES[c.healthCheck.status])}
													title={`Health: ${c.healthCheck.status}`}
												>
													<HeartPulse className="h-2.5 w-2.5" />
													{c.healthCheck.status}
												</span>
											</div>
										</td>
										<td className="px-4 align-middle font-mono text-xs text-muted-foreground">
											{c.port}
											{c.hostPort ? ` → ${c.hostPort}` : ''}
										</td>
										<td className="px-4 align-middle text-xs text-muted-foreground">
											{formatRelativeTime(c.createdAt)}
										</td>
										<td className="px-4 pr-9 align-middle text-right">
											<div className="inline-flex items-center gap-1">
												{c.state === 'running' ? (
													<Button
														variant="ghost"
														size="sm"
														className="h-7 px-2 text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
														onClick={(e) => {
															e.stopPropagation();
															quickActionMutation.mutate({ id: c.id, action: 'stop' });
														}}
														disabled={quickActionMutation.isPending}
														title="Stop"
													>
														<StopCircle className="h-3.5 w-3.5" />
													</Button>
												) : (
													<Button
														variant="ghost"
														size="sm"
														className="h-7 px-2 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
														onClick={(e) => {
															e.stopPropagation();
															quickActionMutation.mutate({ id: c.id, action: 'start' });
														}}
														disabled={quickActionMutation.isPending}
														title="Start"
													>
														<Play className="h-3.5 w-3.5" />
													</Button>
												)}
												<Button
													variant="ghost"
													size="sm"
													className="h-7 px-2 text-destructive hover:bg-destructive/10"
													onClick={(e) => {
														e.stopPropagation();
														if (window.confirm(`Delete ${c.dockerContainerName}?`)) {
															deleteMutation.mutate(c.id);
														}
													}}
													title="Delete"
												>
													<Trash2 className="h-3.5 w-3.5" />
												</Button>
												<ChevronRight className="h-4 w-4 text-muted-foreground" />
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</CardContent>
			</Card>

			{/* Deploy modal */}
			<Dialog open={deployOpen} onOpenChange={setDeployOpen} size="xl">
				{/* Hero header */}
				<div className="relative overflow-hidden rounded-t-xl border-b bg-gradient-to-br from-primary/20 via-primary/5 to-transparent px-6 py-6">
					<div className="absolute -right-12 -top-12 h-44 w-44 rounded-full bg-primary/10 blur-3xl" />
					<div className="relative flex items-center gap-4">
						<div className="flex h-12 w-12 items-center justify-center rounded-xl border bg-background shadow-sm">
							<Rocket className="h-6 w-6 text-primary" />
						</div>
						<div className="min-w-0">
							<h2 className="text-xl font-semibold tracking-tight">Deploy a new app</h2>
							<p className="text-sm text-muted-foreground">
								Spin up a container from an image — resource limits, subdomain, env vars in one place.
							</p>
						</div>
					</div>
				</div>
				<DialogBody>
					<DeployForm
						form={deployForm}
						setForm={setDeployForm}
						subdomainCheck={subdomainCheckQuery.data}
						isPending={deployMutation.isPending}
						onDeploy={() => deployMutation.mutate()}
					/>
				</DialogBody>
			</Dialog>
		</div>
	);
}

function StatCard({
	icon: Icon,
	label,
	value,
	sub,
	tone = 'muted',
	bar,
}: {
	icon: typeof Activity;
	label: string;
	value: string;
	sub: string;
	tone?: 'primary' | 'success' | 'warning' | 'muted';
	bar?: number;
}) {
	const toneClass =
		tone === 'success'
			? 'text-emerald-600 dark:text-emerald-400'
			: tone === 'warning'
				? 'text-amber-600 dark:text-amber-400'
				: tone === 'primary'
					? 'text-primary'
					: 'text-muted-foreground';

	return (
		<div className="rounded-xl border bg-card p-4">
			<div className="flex items-center justify-between">
				<span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
				<Icon className={cn('h-4 w-4', toneClass)} />
			</div>
			<div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
			<div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
			{bar !== undefined && (
				<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
					<div
						className="h-full rounded-full bg-primary transition-all"
						style={{ width: `${Math.max(0, Math.min(100, bar))}%` }}
					/>
				</div>
			)}
		</div>
	);
}

function SortableTh({
	label,
	active,
	dir,
	onClick,
	className,
}: {
	label: string;
	active: boolean;
	dir: SortDir;
	onClick: () => void;
	className?: string;
}) {
	return (
		<th className={cn('px-4 py-2.5 font-medium', className)}>
			<button
				type="button"
				onClick={onClick}
				className={cn('inline-flex items-center gap-1 transition-colors hover:text-foreground', active && 'text-foreground')}
			>
				{label}
				{active ? (
					dir === 'asc' ? (
						<ArrowUp className="h-3 w-3" />
					) : (
						<ArrowDown className="h-3 w-3" />
					)
				) : (
					<ArrowUpDown className="h-3 w-3 opacity-40" />
				)}
			</button>
		</th>
	);
}
