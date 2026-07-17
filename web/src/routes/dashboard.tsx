import { useQuery } from '@tanstack/react-query';
import { Activity, Boxes, Container as ContainerIcon, Cpu, MemoryStick } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatBytes } from '@/lib/utils';

interface ClusterResourcesResponse {
	host: { totalMemoryMb: number; cpuCount: number };
	allocated: { memoryMb: number; cpus: number; containers: number };
	available: { memoryMb: number; cpus: number };
}

interface ContainerSummary {
	id: string;
	state: 'created' | 'running' | 'stopped' | 'error';
	image: string;
	tag: string;
}

interface ImageSummary {
	id: string;
	source: 'pulled' | 'built' | 'registered';
}

export function DashboardPage() {
	const resourcesQuery = useQuery({
		queryKey: ['cluster', 'resources'],
		queryFn: () => api.get<ClusterResourcesResponse>('/api/v1/cluster/resources').then((r) => r.data),
		refetchInterval: 5_000,
	});

	const containersQuery = useQuery({
		queryKey: ['containers'],
		queryFn: () => api.get<ContainerSummary[]>('/api/v1/apps').then((r) => r.data),
	});

	const imagesQuery = useQuery({
		queryKey: ['images'],
		queryFn: () => api.get<ImageSummary[]>('/api/v1/images').then((r) => r.data),
	});

	const running = containersQuery.data?.filter((c) => c.state === 'running').length ?? 0;
	const total = containersQuery.data?.length ?? 0;
	const imageCount = imagesQuery.data?.length ?? 0;
	const userBuilt = imagesQuery.data?.filter((i) => i.source === 'built').length ?? 0;

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
				<p className="text-sm text-muted-foreground">
					Overview of cluster capacity, containers, and images.
				</p>
			</div>

			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<StatCard
					icon={MemoryStick}
					label="Memory available"
					value={
						resourcesQuery.data
							? formatBytes(resourcesQuery.data.available.memoryMb * 1024 * 1024)
							: '—'
					}
					sub={
						resourcesQuery.data
							? `of ${formatBytes(resourcesQuery.data.host.totalMemoryMb * 1024 * 1024)} total`
							: 'loading'
					}
				/>
				<StatCard
					icon={Cpu}
					label="CPU available"
					value={resourcesQuery.data ? resourcesQuery.data.available.cpus.toFixed(2) : '—'}
					sub={resourcesQuery.data ? `of ${resourcesQuery.data.host.cpuCount} cores` : 'loading'}
				/>
				<StatCard
					icon={ContainerIcon}
					label="Containers"
					value={`${running}/${total}`}
					sub="running / total"
				/>
				<StatCard icon={Boxes} label="Images" value={String(imageCount)} sub={`${userBuilt} user-built`} />
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						<Activity className="h-4 w-4" />
						Cluster status
					</CardTitle>
					<CardDescription>
						The front end is now connected to live APIs for containers, images, and settings.
					</CardDescription>
				</CardHeader>
				<CardContent className="text-sm text-muted-foreground">
					Use the sidebar to move between the operational views. Container actions and image
					management now run against the backend instead of static placeholders.
				</CardContent>
			</Card>
		</div>
	);
}

function StatCard({
	icon: Icon,
	label,
	value,
	sub,
}: {
	icon: typeof Activity;
	label: string;
	value: string;
	sub: string;
}) {
	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
				<CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
				<Icon className="h-4 w-4 text-muted-foreground" />
			</CardHeader>
			<CardContent>
				<div className="text-2xl font-semibold">{value}</div>
				<p className="text-xs text-muted-foreground">{sub}</p>
			</CardContent>
		</Card>
	);
}
