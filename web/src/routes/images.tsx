import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	Boxes,
	ChevronRight,
	Download,
	Hammer,
	Loader2,
	Play,
	RefreshCw,
	Search,
	ShieldCheck,
	Trash2,
	X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, getStoredToken } from '@/lib/api';
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { BuildTab } from '@/components/image-build/BuildTab';
import { PullImageAutocomplete } from '@/components/image-pull/PullImageAutocomplete';
import { ImportTarballCard } from '@/components/image-pull/ImportTarballCard';

interface ImageRecord {
	id: string;
	dockerImageId: string;
	repository: string;
	tag: string;
	digest: string | null;
	sizeBytes: number;
	source: 'pulled' | 'built' | 'registered';
	builtBy: string | null;
	description: string | null;
	labels: Record<string, string>;
	createdAt: number;
	updatedAt: number;
}

type ImageFilter = 'all' | 'pulled' | 'built' | 'registered';
type ImageTab = 'manage' | 'build';

type SortKey = 'repository' | 'tag' | 'source' | 'sizeBytes' | 'updatedAt';
type SortDir = 'asc' | 'desc';

interface PullFormState {
	repository: string;
	tag: string;
	description: string;
}

interface RegisterFormState {
	repository: string;
	tag: string;
	description: string;
}

const defaultPullForm: PullFormState = {
	repository: '',
	tag: 'latest',
	description: '',
};

const defaultRegisterForm: RegisterFormState = {
	repository: 'ghcr.io/example/app',
	tag: 'latest',
	description: '',
};

const SOURCE_STYLES: Record<ImageRecord['source'], string> = {
	pulled: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
	built: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
	registered: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
};

export function ImagesPage() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [activeTab, setActiveTab] = useState<ImageTab>('manage');
	const [filter, setFilter] = useState<ImageFilter>('all');
	const [mineOnly, setMineOnly] = useState(false);
	const [q, setQ] = useState('');
	const [sortKey, setSortKey] = useState<SortKey>('updatedAt');
	const [sortDir, setSortDir] = useState<SortDir>('desc');
	const [pullForm, setPullForm] = useState<PullFormState>(defaultPullForm);
	const [registerForm, setRegisterForm] = useState<RegisterFormState>(defaultRegisterForm);

	const imagesQuery = useQuery({
		queryKey: ['images', filter, mineOnly, q],
		queryFn: () =>
			api
				.get<ImageRecord[]>('/api/v1/images', {
					params: {
						source: filter === 'all' ? undefined : filter,
						mine: mineOnly || undefined,
						q: q.trim() || undefined,
					},
				})
				.then((r) => r.data),
		refetchInterval: 10_000,
	});

	const pullAbortRef = useRef<AbortController | null>(null);
	const pullMutation = useMutation({
		mutationFn: async () => {
			const controller = new AbortController();
			pullAbortRef.current = controller;

			const response = await fetch('/api/v1/images/pull', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${getStoredToken() ?? ''}`,
				},
				body: JSON.stringify({
					repository: pullForm.repository.trim(),
					tag: pullForm.tag.trim() || 'latest',
					description: pullForm.description.trim() || undefined,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				let message = `Pull failed (${response.status})`;
				try {
					const body = (await response.json()) as { error?: string; reason?: string };
					message = body.reason ? `${body.error}: ${body.reason}` : body.error ?? message;
				} catch {
					// fall back to generic text
				}
				throw new Error(message);
			}

			const text = await response.text();
			let finalImage: ImageRecord | null = null;
			for (const block of text.split('\n\n')) {
				const line = block.trim();
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (!payload) continue;
				const parsed = JSON.parse(payload) as {
					error?: string;
					done?: boolean;
					cancelled?: boolean;
					image?: ImageRecord;
				};
				if (parsed.cancelled) {
					throw new DOMException('Pull cancelled', 'AbortError');
				}
				if (parsed.error) throw new Error(parsed.error);
				if (parsed.done && parsed.image) finalImage = parsed.image;
			}
			if (!finalImage) throw new Error('pull completed without returning an image');
			return finalImage;
		},
		onSuccess: (image) => {
			toast.success(`Pulled ${image.repository}:${image.tag}`);
			setPullForm(defaultPullForm);
			void queryClient.invalidateQueries({ queryKey: ['images'] });
		},
		onError: (err) => {
			if (err instanceof DOMException && err.name === 'AbortError') {
				toast.info('Pull cancelled');
			} else {
				toast.error(errorMessage(err));
			}
		},
		onSettled: () => {
			pullAbortRef.current = null;
		},
	});

	function cancelPull() {
		pullAbortRef.current?.abort();
	}

	const registerMutation = useMutation({
		mutationFn: async () => {
			const res = await api.post<ImageRecord>('/api/v1/images/register', {
				repository: registerForm.repository.trim(),
				tag: registerForm.tag.trim() || 'latest',
				description: registerForm.description.trim() || undefined,
			});
			return res.data;
		},
		onSuccess: (image) => {
			toast.success(`Registered ${image.repository}:${image.tag}`);
			setRegisterForm(defaultRegisterForm);
			void queryClient.invalidateQueries({ queryKey: ['images'] });
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	const deleteMutation = useMutation({
		mutationFn: async (image: ImageRecord) => {
			await api.delete(`/api/v1/images/${image.id}`, { params: { force: true } });
			return image;
		},
		onSuccess: (image) => {
			toast.success(`Removed ${image.repository}:${image.tag}`);
			void queryClient.invalidateQueries({ queryKey: ['images'] });
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	const quickRunMutation = useMutation({
		mutationFn: async (image: ImageRecord) => {
			// Deploy can take 30-90s (pull + create + health check). Override the
			// 15s default to give the backend room to finish.
			const res = await api.post<{
				container: { id: string; dockerContainerName: string };
				detectedPort: number;
			}>(`/api/v1/images/${image.id}/run`, undefined, { timeout: 120_000 });
			return { ...res.data, image };
		},
		onSuccess: ({ container, detectedPort, image }) => {
			toast.success(`Running ${image.repository}:${image.tag} as ${container.dockerContainerName} (port ${detectedPort})`);
			void queryClient.invalidateQueries({ queryKey: ['containers'] });
			navigate('/containers');
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	const pruneMutation = useMutation({
		mutationFn: async () => api.post('/api/v1/images/prune'),
		onSuccess: () => {
			toast.success('Pruned dangling images');
			void queryClient.invalidateQueries({ queryKey: ['images'] });
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	const images = imagesQuery.data ?? [];

	const sortedImages = useMemo(() => {
		const copy = [...images];
		copy.sort((a, b) => {
			let cmp = 0;
			switch (sortKey) {
				case 'repository':
					cmp = a.repository.localeCompare(b.repository);
					break;
				case 'tag':
					cmp = a.tag.localeCompare(b.tag);
					break;
				case 'source':
					cmp = a.source.localeCompare(b.source);
					break;
				case 'sizeBytes':
					cmp = a.sizeBytes - b.sizeBytes;
					break;
				case 'updatedAt':
					cmp = a.updatedAt - b.updatedAt;
					break;
			}
			return sortDir === 'asc' ? cmp : -cmp;
		});
		return copy;
	}, [images, sortKey, sortDir]);

	const totalSize = images.reduce((sum, image) => sum + image.sizeBytes, 0);

	function toggleSort(key: SortKey) {
		if (sortKey === key) {
			setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
		} else {
			setSortKey(key);
			setSortDir(key === 'repository' || key === 'tag' || key === 'source' ? 'asc' : 'desc');
		}
	}

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Images</h1>
					<p className="text-sm text-muted-foreground">
						Pull, build, register, tag, and prune Docker images used by the cluster.
					</p>
				</div>
				{activeTab === 'manage' && (
					<div className="flex items-center gap-2">
						<Button variant="outline" size="sm" onClick={() => window.location.reload()} title="Hard reload (same as F5)">
							<RefreshCw className="h-4 w-4" />
							Refresh
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => pruneMutation.mutate()}
							disabled={pruneMutation.isPending}
						>
							<Trash2 className="h-4 w-4" />
							Prune
						</Button>
					</div>
				)}
			</div>

			{/* Tab Navigation */}
			<div className="inline-flex items-center gap-1 rounded-lg border bg-card p-1">
				<Button
					variant={activeTab === 'manage' ? 'secondary' : 'ghost'}
					size="sm"
					onClick={() => setActiveTab('manage')}
					className="gap-2"
				>
					<ShieldCheck className="h-4 w-4" />
					Manage Images
				</Button>
				<Button
					variant={activeTab === 'build' ? 'secondary' : 'ghost'}
					size="sm"
					onClick={() => setActiveTab('build')}
					className="gap-2"
				>
					<Hammer className="h-4 w-4" />
					Build Images
				</Button>
			</div>

			{activeTab === 'manage' ? (
				<>
					<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
						<MiniStat label="Images" value={String(images.length)} />
						<MiniStat label="Total size" value={formatBytes(totalSize)} />
						<MiniStat
							label="Pulled"
							value={String(images.filter((image) => image.source === 'pulled').length)}
						/>
						<MiniStat
							label="Built"
							value={String(images.filter((image) => image.source === 'built').length)}
						/>
					</div>

					<div className="grid gap-6 xl:grid-cols-[1.4fr_0.6fr]">
						{/* LEFT: Image Library (sortable table) */}
						<Card>
							<CardHeader>
								<div className="flex flex-wrap items-start justify-between gap-3">
									<div>
										<CardTitle>Image library</CardTitle>
										<CardDescription>
											Click any row to open its detail page.
										</CardDescription>
									</div>
								</div>

								<div className="flex flex-wrap items-center gap-2 pt-2">
									<div className="relative max-w-xs flex-1">
										<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
										<Input
											value={q}
											onChange={(event) => setQ(event.target.value)}
											placeholder="Search repository or tag"
											className="pl-9"
										/>
									</div>
									<div className="flex items-center gap-1 rounded-md border bg-card p-1">
										{(['all', 'pulled', 'built', 'registered'] as const).map((item) => (
											<Button
												key={item}
												variant={filter === item ? 'secondary' : 'ghost'}
												size="sm"
												onClick={() => setFilter(item)}
												className="h-7 px-2.5 text-xs capitalize"
											>
												{item}
											</Button>
										))}
									</div>
									<label className="flex items-center gap-2 text-xs text-muted-foreground">
										<input
											type="checkbox"
											checked={mineOnly}
											onChange={(event) => setMineOnly(event.target.checked)}
										/>
										Mine only
									</label>
								</div>
							</CardHeader>
							<CardContent className="p-0">
								<div className="overflow-x-auto">
									<table className="w-full text-sm">
										<thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
											<tr>
												<SortableTh
													label="Repository"
													active={sortKey === 'repository'}
													dir={sortDir}
													onClick={() => toggleSort('repository')}
												/>
												<SortableTh
													label="Tag"
													active={sortKey === 'tag'}
													dir={sortDir}
													onClick={() => toggleSort('tag')}
												/>
												<SortableTh
													label="Source"
													active={sortKey === 'source'}
													dir={sortDir}
													onClick={() => toggleSort('source')}
												/>
												<SortableTh
													label="Size"
													active={sortKey === 'sizeBytes'}
													dir={sortDir}
													onClick={() => toggleSort('sizeBytes')}
													align="right"
												/>
												<SortableTh
													label="Updated"
													active={sortKey === 'updatedAt'}
													dir={sortDir}
													onClick={() => toggleSort('updatedAt')}
												/>
												<th className="px-4 py-2.5 text-right font-medium">Actions</th>
											</tr>
										</thead>
										<tbody>
											{imagesQuery.isLoading && (
												<tr>
													<td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
														<div className="inline-flex items-center gap-2">
															<Loader2 className="h-4 w-4 animate-spin" />
															Loading images...
														</div>
													</td>
												</tr>
											)}
											{!imagesQuery.isLoading && sortedImages.length === 0 && (
												<tr>
													<td colSpan={6} className="px-4 py-12 text-center text-sm text-muted-foreground">
														<Boxes className="mx-auto mb-2 h-8 w-8 opacity-40" />
														No images match the current filters.
													</td>
												</tr>
											)}
											{sortedImages.map((image) => (
												<tr
													key={image.id}
													onClick={() => navigate(`/images/${image.id}`)}
													className="group cursor-pointer border-b transition-colors last:border-b-0 hover:bg-accent/40"
												>
													<td className="px-4 py-3">
														<div className="flex items-center gap-2">
															<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background">
																<Boxes className="h-4 w-4 text-muted-foreground" />
															</div>
															<div className="min-w-0">
																<div className="truncate font-medium">{image.repository}</div>
																{image.description && (
																	<div className="truncate text-xs text-muted-foreground">
																		{image.description}
																	</div>
																)}
															</div>
														</div>
													</td>
													<td className="px-4 py-3">
														<span className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs">
															{image.tag}
														</span>
													</td>
													<td className="px-4 py-3">
														<Badge
															variant="outline"
															className={cn('text-[10px] uppercase tracking-wide', SOURCE_STYLES[image.source])}
														>
															{image.source}
														</Badge>
													</td>
													<td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
														{formatBytes(image.sizeBytes)}
													</td>
													<td className="px-4 py-3 text-xs text-muted-foreground">
														{formatRelativeTime(image.updatedAt)}
													</td>
													<td className="px-4 py-3 text-right">
														<div className="inline-flex items-center gap-1">
															<Button
																variant="ghost"
																size="sm"
																className="h-7 px-2 text-emerald-600 opacity-0 transition-opacity hover:bg-emerald-500/10 group-hover:opacity-100 dark:text-emerald-400"
																onClick={(e) => {
																	e.stopPropagation();
																	if (
																		window.confirm(
																			`Run ${image.repository}:${image.tag} now?\n\nA new container will be created with default resources from Settings. Port is auto-detected from the image (fallback: 3001).`,
																		)
																	) {
																		quickRunMutation.mutate(image);
																	}
																}}
																disabled={quickRunMutation.isPending}
																title="Quick run"
															>
																{quickRunMutation.isPending && quickRunMutation.variables?.id === image.id ? (
																	<Loader2 className="h-3.5 w-3.5 animate-spin" />
																) : (
																	<Play className="h-3.5 w-3.5" />
																)}
															</Button>
															<Button
																variant="ghost"
																size="sm"
																className="h-7 px-2 text-destructive opacity-0 transition-opacity hover:bg-destructive/10 group-hover:opacity-100"
																onClick={(e) => {
																	e.stopPropagation();
																	if (
																		window.confirm(
																			`Delete ${image.repository}:${image.tag}?`,
																		)
																	) {
																		deleteMutation.mutate(image);
																	}
																}}
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

						{/* RIGHT: Pull + Register forms */}
						<div className="space-y-6">
							<Card>
								<CardHeader>
									<CardTitle>Pull image</CardTitle>
									<CardDescription>
										Pull from a registry and track the resulting image in the cluster.
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-4">
									<PullImageAutocomplete
										repository={pullForm.repository}
										tag={pullForm.tag}
										onChange={({ repository, tag }) =>
											setPullForm((prev) => ({ ...prev, repository, tag }))
										}
									/>
									<div className="space-y-2">
										<Label>Description</Label>
										<Input
											value={pullForm.description}
											onChange={(event) =>
												setPullForm((prev) => ({ ...prev, description: event.target.value }))
											}
											placeholder="Optional note"
										/>
									</div>
									{pullMutation.isPending ? (
										<div className="flex gap-2">
											<Button className="flex-1" disabled>
												<Loader2 className="h-4 w-4 animate-spin" />
												Pulling {pullForm.repository}:{pullForm.tag || 'latest'}...
											</Button>
											<Button
												variant="destructive"
												onClick={cancelPull}
												title="Cancel pull"
											>
												<X className="h-4 w-4" />
												Cancel
											</Button>
										</div>
									) : (
										<Button
											className="w-full"
											onClick={() => pullMutation.mutate()}
											disabled={!pullForm.repository.trim()}
										>
											<Download className="h-4 w-4" />
											Pull image
										</Button>
									)}
								</CardContent>
							</Card>

							<Card>
								<CardHeader>
									<CardTitle>Register image</CardTitle>
									<CardDescription>
										Track an image that already exists on the Docker host.
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-4">
									<Field
										label="Repository"
										value={registerForm.repository}
										onChange={(value) => setRegisterForm((prev) => ({ ...prev, repository: value }))}
										placeholder="ghcr.io/org/app"
									/>
									<div className="grid gap-4 sm:grid-cols-2">
										<Field
											label="Tag"
											value={registerForm.tag}
											onChange={(value) => setRegisterForm((prev) => ({ ...prev, tag: value }))}
											placeholder="latest"
										/>
										<div className="space-y-2">
											<Label>Description</Label>
											<Input
												value={registerForm.description}
												onChange={(event) =>
													setRegisterForm((prev) => ({ ...prev, description: event.target.value }))
												}
												placeholder="Optional note"
											/>
										</div>
									</div>
									<Button
										variant="outline"
										className="w-full"
										onClick={() => registerMutation.mutate()}
										disabled={registerMutation.isPending}
									>
										<Download className="h-4 w-4" />
										Register image
									</Button>
								</CardContent>
							</Card>

							<ImportTarballCard />
						</div>
					</div>
				</>
			) : (
				<BuildTab
					onBuildSuccess={(imageName, tag) => {
						toast.success(`Built ${imageName}:${tag}`);
						setActiveTab('manage');
						void queryClient.invalidateQueries({ queryKey: ['images'] });
					}}
				/>
			)}
		</div>
	);
}

function SortableTh({
	label,
	active,
	dir,
	onClick,
	align = 'left',
}: {
	label: string;
	active: boolean;
	dir: SortDir;
	onClick: () => void;
	align?: 'left' | 'right';
}) {
	return (
		<th className={cn('px-4 py-2.5 font-medium', align === 'right' && 'text-right')}>
			<button
				type="button"
				onClick={onClick}
				className={cn(
					'inline-flex items-center gap-1 transition-colors hover:text-foreground',
					active && 'text-foreground',
				)}
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

function Field({
	label,
	value,
	onChange,
	placeholder,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	return (
		<div className="space-y-2">
			<Label>{label}</Label>
			<Input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
		</div>
	);
}

function MiniStat({ label, value }: { label: string; value: string }) {
	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
				<CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
				<ShieldCheck className="h-4 w-4 text-muted-foreground" />
			</CardHeader>
			<CardContent>
				<div className="text-2xl font-semibold">{value}</div>
			</CardContent>
		</Card>
	);
}
