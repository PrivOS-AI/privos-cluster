import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
	Activity,
	ArrowLeft,
	Box,
	Calendar,
	CircleDot,
	Copy,
	Cpu,
	Database,
	ExternalLink,
	Globe,
	Hash,
	HeartPulse,
	Loader2,
	MemoryStick,
	Network,
	Play,
	RefreshCw,
	RotateCw,
	StopCircle,
	Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { ContainerOpsPanel } from '@/components/containers/ContainerOpsPanel';
import {
	HEALTH_STYLES,
	STATE_STYLES,
	type ContainerAction,
	type ContainerRecord,
	type StatusResponse,
} from '@/components/containers/types';

export function ContainerDetailPage() {
	const { containerId } = useParams<{ containerId: string }>();
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const containerQuery = useQuery({
		queryKey: ['container', containerId],
		queryFn: () => api.get<ContainerRecord>(`/api/v1/apps/${containerId}`).then((r) => r.data),
		enabled: Boolean(containerId),
		refetchInterval: 5_000,
	});

	const container = containerQuery.data;

	const statusQuery = useQuery({
		queryKey: ['container', containerId, 'status'],
		queryFn: () => api.get<StatusResponse>(`/api/v1/apps/${containerId}/status`).then((r) => r.data),
		enabled: Boolean(containerId) && container?.state === 'running',
		refetchInterval: 5_000,
	});

	const actionMutation = useMutation({
		mutationFn: async (action: ContainerAction) => {
			if (action === 'delete') {
				await api.delete(`/api/v1/apps/${containerId}`, { timeout: 30_000 });
				return action;
			}
			const endpoint = action === 'redeploy' ? 'redeploy' : action;
			const payload = action === 'redeploy' ? { rolling: true } : undefined;
			const timeoutByAction = {
				start: 60_000,
				restart: 60_000,
				redeploy: 180_000,
				stop: 30_000,
			} as const;
			await api.post(`/api/v1/apps/${containerId}/${endpoint}`, payload, {
				timeout: timeoutByAction[action],
			});
			return action;
		},
		onSuccess: (action) => {
			toast.success(action === 'delete' ? 'Container deleted' : `${action[0].toUpperCase()}${action.slice(1)} complete`);
			void queryClient.invalidateQueries({ queryKey: ['containers'] });
			void queryClient.invalidateQueries({ queryKey: ['container', containerId] });
			if (action === 'delete') navigate('/containers');
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	useEffect(() => {
		document.title = container?.dockerContainerName
			? `${container.dockerContainerName} · PrivOS Cluster`
			: 'Container · PrivOS Cluster';
		return () => {
			document.title = 'PrivOS Cluster';
		};
	}, [container?.dockerContainerName]);

	if (containerQuery.isLoading) {
		return (
			<div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
				<Loader2 className="h-4 w-4 animate-spin" />
				Loading container...
			</div>
		);
	}

	if (containerQuery.isError || !container) {
		return (
			<div className="space-y-4 p-6">
				<Button variant="ghost" size="sm" onClick={() => navigate('/containers')}>
					<ArrowLeft className="h-4 w-4" />
					Back to containers
				</Button>
				<Card>
					<CardContent className="py-10 text-center text-sm text-muted-foreground">
						Container not found or no longer tracked.
					</CardContent>
				</Card>
			</div>
		);
	}

	const isRunning = container.state === 'running';
	const status = statusQuery.data;

	const copy = async (value: string, label: string) => {
		try {
			await navigator.clipboard.writeText(value);
			toast.success(`${label} copied`);
		} catch {
			toast.error('Failed to copy');
		}
	};

	const formatUptime = (seconds: number | null) => {
		if (seconds == null) return '—';
		if (seconds < 60) return `${seconds}s`;
		const m = Math.floor(seconds / 60);
		if (m < 60) return `${m}m ${seconds % 60}s`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ${m % 60}m`;
		const d = Math.floor(h / 24);
		return `${d}d ${h % 24}h`;
	};

	return (
		<div className="space-y-6">
			{/* Breadcrumb */}
			<div className="flex items-center justify-between">
				<button
					type="button"
					onClick={() => navigate('/containers')}
					className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
				>
					<ArrowLeft className="h-4 w-4" />
					<span>Containers</span>
					<span className="text-muted-foreground/50">/</span>
					<span className="text-foreground">{container.dockerContainerName}</span>
				</button>
			</div>

			{/* Hero */}
			<div className="rounded-xl border bg-gradient-to-br from-card via-card to-muted/30 p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="min-w-0 flex-1 space-y-3">
						<div className="flex items-center gap-3">
							<div className="flex h-12 w-12 items-center justify-center rounded-xl border bg-background shadow-sm">
								<Box className="h-6 w-6 text-primary" />
							</div>
							<div className="min-w-0">
								<h1 className="truncate text-2xl font-semibold tracking-tight">
									{container.dockerContainerName}
								</h1>
								<div className="flex flex-wrap items-center gap-2 text-sm">
									<Badge variant="outline" className={cn('uppercase tracking-wide', STATE_STYLES[container.state])}>
										<CircleDot className="mr-1 h-3 w-3" />
										{container.state}
									</Badge>
									<span className={cn('inline-flex items-center gap-1 text-xs', HEALTH_STYLES[container.healthCheck.status])}>
										<HeartPulse className="h-3 w-3" />
										{container.healthCheck.status}
									</span>
									{container.adopted && (
										<Badge variant="outline" className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
											adopted
										</Badge>
									)}
								</div>
							</div>
						</div>
						<div className="font-mono text-sm text-muted-foreground">
							{container.image}:{container.tag}
						</div>
					</div>

					{/* Lifecycle action buttons */}
					<div className="flex flex-wrap gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => actionMutation.mutate('start')}
							disabled={actionMutation.isPending || isRunning}
						>
							<Play className="h-4 w-4" />
							Start
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => actionMutation.mutate('stop')}
							disabled={actionMutation.isPending || !isRunning}
						>
							<StopCircle className="h-4 w-4" />
							Stop
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => actionMutation.mutate('restart')}
							disabled={actionMutation.isPending || !isRunning}
						>
							<RotateCw className="h-4 w-4" />
							Restart
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => actionMutation.mutate('redeploy')}
							disabled={actionMutation.isPending}
						>
							<RefreshCw className="h-4 w-4" />
							Redeploy
						</Button>
						<Button
							variant="destructive"
							size="sm"
							onClick={() => {
								if (
									window.confirm(
										`Delete ${container.dockerContainerName}? This removes the Docker container and its tracked metadata.`,
									)
								) {
									actionMutation.mutate('delete');
								}
							}}
							disabled={actionMutation.isPending}
						>
							<Trash2 className="h-4 w-4" />
							Delete
						</Button>
					</div>
				</div>

				<Separator className="my-5" />

				{/* Live stats */}
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					<StatBlock
						icon={Cpu}
						label="CPU"
						value={status ? `${status.cpuPercent.toFixed(1)}%` : '—'}
						bar={status ? Math.min(status.cpuPercent, 100) : 0}
						barTone="primary"
					/>
					<StatBlock
						icon={MemoryStick}
						label="Memory"
						value={status ? `${status.memoryUsageMb.toFixed(0)} / ${status.memoryLimitMb.toFixed(0)} MB` : '—'}
						bar={status ? status.memoryPercent : 0}
						barTone="emerald"
					/>
					<StatBlock
						icon={Activity}
						label="Uptime"
						value={status?.uptime != null ? formatUptime(status.uptime) : '—'}
					/>
					<StatBlock
						icon={RotateCw}
						label="Restarts"
						value={String(status?.restarts ?? container.healthCheck.restartCount)}
					/>
				</div>
			</div>

			{/* Config */}
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						<Network className="h-4 w-4" />
						Networking & resources
					</CardTitle>
				</CardHeader>
				<CardContent className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
					<InfoRow icon={Hash} label="Container ID" value={container.dockerContainerId.slice(0, 18)} onCopy={() => copy(container.dockerContainerId, 'Container ID')} />
					<InfoRow icon={ExternalLink} label="Internal URL" value={container.internalUrl} onCopy={() => copy(container.internalUrl, 'Internal URL')} />
					<InfoRow icon={Globe} label="Subdomain" value={container.subdomain ?? '—'} />
					<InfoRow icon={Network} label="Port" value={`${container.port} → host ${container.hostPort ?? '—'}`} />
					<InfoRow icon={MemoryStick} label="Resources" value={`${container.resources.memoryMb} MB · ${container.resources.cpus} CPU · tmp ${container.resources.tmpSizeMb} MB`} />
					<InfoRow icon={Calendar} label="Created" value={new Date(container.createdAt).toLocaleString()} />
				</CardContent>
			</Card>

			{/* Volumes */}
			{container.volumes.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-base">
							<Database className="h-4 w-4" />
							Volumes ({container.volumes.length})
						</CardTitle>
					</CardHeader>
					<CardContent className="grid gap-2 sm:grid-cols-2">
						{container.volumes.map((v) => (
							<div key={v.name} className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
								<div className="font-medium">{v.name}</div>
								<div className="font-mono text-xs text-muted-foreground">{v.mountPath}</div>
								<div className="text-xs text-muted-foreground">{v.sizeMb ? `${v.sizeMb} MB` : 'size unspecified'}</div>
							</div>
						))}
					</CardContent>
				</Card>
			)}

			{/* Ops tabs */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Operations</CardTitle>
					<CardDescription>Inspect logs, files, terminal, and dispatch JSON-RPC.</CardDescription>
				</CardHeader>
				<CardContent>
					<ContainerOpsPanel container={container} />
				</CardContent>
			</Card>
		</div>
	);
}

function StatBlock({
	icon: Icon,
	label,
	value,
	bar,
	barTone = 'primary',
}: {
	icon: typeof Cpu;
	label: string;
	value: string;
	bar?: number;
	barTone?: 'primary' | 'emerald';
}) {
	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
				<Icon className="h-3.5 w-3.5" />
				{label}
			</div>
			<div className="truncate text-base font-semibold">{value}</div>
			{bar !== undefined && (
				<div className="h-1.5 overflow-hidden rounded-full bg-muted">
					<div
						className={cn(
							'h-full rounded-full transition-all',
							barTone === 'primary' ? 'bg-primary' : 'bg-emerald-500',
						)}
						style={{ width: `${Math.max(0, Math.min(100, bar))}%` }}
					/>
				</div>
			)}
		</div>
	);
}

function InfoRow({
	icon: Icon,
	label,
	value,
	onCopy,
}: {
	icon: typeof Network;
	label: string;
	value: string;
	onCopy?: () => void;
}) {
	return (
		<div className="flex items-start gap-3 rounded-md border bg-muted/30 px-3 py-2.5">
			<Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1">
				<div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
				<div className="break-all text-sm">{value}</div>
			</div>
			{onCopy && (
				<Button variant="ghost" size="sm" onClick={onCopy} className="h-7 px-2">
					<Copy className="h-3.5 w-3.5" />
				</Button>
			)}
		</div>
	);
}
