import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface CapabilitiesResponse {
	service: string;
	version: string;
	protocol: string;
	type: 'docker' | 'k8s' | 'swarm' | 'custom';
	features: Record<string, boolean>;
	limits: {
		maxContainers: number;
		maxMemoryMb: number;
		maxCpus: number;
	};
}

export function CapabilitiesPage() {
	const capabilitiesQuery = useQuery({
		queryKey: ['capabilities'],
		queryFn: () => api.get<CapabilitiesResponse>('/api/v1/capabilities').then((r) => r.data),
	});

	const capabilities = capabilitiesQuery.data;

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">Capabilities</h1>
				<p className="text-sm text-muted-foreground">
					What this cluster backend can do right now, and what it says it supports.
				</p>
			</div>

			{capabilitiesQuery.isLoading && (
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" />
					Loading capabilities...
				</div>
			)}

			{capabilities && (
				<>
					<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
						<Metric label="Service" value={capabilities.service} />
						<Metric label="Version" value={capabilities.version} />
						<Metric label="Protocol" value={capabilities.protocol} />
						<Metric label="Type" value={capabilities.type} />
					</div>

					<div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2 text-base">
									<Sparkles className="h-4 w-4" />
									Features
								</CardTitle>
								<CardDescription>Features marked `true` are available in the backend.</CardDescription>
							</CardHeader>
							<CardContent className="grid gap-3 sm:grid-cols-2">
								{Object.entries(capabilities.features).map(([key, value]) => (
									<div
										key={key}
										className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
									>
										<span className="capitalize">{key}</span>
										<span className={value ? 'text-emerald-600' : 'text-muted-foreground'}>
											{value ? (
												<span className="inline-flex items-center gap-1">
													<CheckCircle2 className="h-4 w-4" />
													yes
												</span>
											) : (
												'no'
											)}
										</span>
									</div>
								))}
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2 text-base">
									<ShieldCheck className="h-4 w-4" />
									Limits
								</CardTitle>
								<CardDescription>Soft limits advertised by the backend.</CardDescription>
							</CardHeader>
							<CardContent className="space-y-3">
								<Line label="Max containers" value={String(capabilities.limits.maxContainers)} />
								<Line label="Max memory" value={`${capabilities.limits.maxMemoryMb} MB`} />
								<Line label="Max CPU" value={String(capabilities.limits.maxCpus)} />
							</CardContent>
						</Card>
					</div>
				</>
			)}
		</div>
	);
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
				<CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="text-xl font-semibold">{value}</div>
			</CardContent>
		</Card>
	);
}

function Line({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
			<span className="text-muted-foreground">{label}</span>
			<span className="font-medium">{value}</span>
		</div>
	);
}
