import { useEffect, useState, type ChangeEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
	ArrowLeft,
	Boxes,
	Calendar,
	Copy,
	Edit3,
	Fingerprint,
	HardDrive,
	Hash,
	Info,
	Layers,
	Loader2,
	Rocket,
	Tag as TagIcon,
	Trash2,
	User,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

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

interface ImageDetailResponse extends ImageRecord {
	live?: {
		dockerImageId: string;
		repoTag: string;
		repository: string;
		tag: string;
		digest: string | null;
		sizeBytes: number;
		labels: Record<string, string>;
		created: number;
	};
	inUse?: number;
}

const SOURCE_STYLES: Record<ImageRecord['source'], string> = {
	pulled: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
	built: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
	registered: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
};

export function ImageDetailPage() {
	const { imageId } = useParams<{ imageId: string }>();
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const detailQuery = useQuery({
		queryKey: ['image', imageId],
		queryFn: () => api.get<ImageDetailResponse>(`/api/v1/images/${imageId}`).then((r) => r.data),
		enabled: Boolean(imageId),
	});

	const image = detailQuery.data;

	const [description, setDescription] = useState('');
	const [labelsJson, setLabelsJson] = useState('{}');
	const [tagRepo, setTagRepo] = useState('');
	const [tagName, setTagName] = useState('');

	useEffect(() => {
		if (image) {
			setDescription(image.description ?? '');
			setLabelsJson(JSON.stringify(image.labels ?? {}, null, 2));
			setTagRepo(image.repository);
			setTagName(`${image.tag}-copy`);
		}
	}, [image?.id]); // eslint-disable-line react-hooks/exhaustive-deps

	const patchMutation = useMutation({
		mutationFn: async () => {
			const parsedLabels = labelsJson.trim() ? (JSON.parse(labelsJson) as Record<string, string>) : {};
			const res = await api.patch<ImageRecord>(`/api/v1/images/${imageId}`, {
				description: description.trim() || null,
				labels: parsedLabels,
			});
			return res.data;
		},
		onSuccess: () => {
			toast.success('Metadata updated');
			void queryClient.invalidateQueries({ queryKey: ['images'] });
			void queryClient.invalidateQueries({ queryKey: ['image', imageId] });
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	const tagMutation = useMutation({
		mutationFn: async () => {
			const res = await api.post<ImageRecord>(`/api/v1/images/${imageId}/tag`, {
				repository: tagRepo.trim(),
				tag: tagName.trim(),
			});
			return res.data;
		},
		onSuccess: () => {
			toast.success('Tag created');
			void queryClient.invalidateQueries({ queryKey: ['images'] });
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	const deleteMutation = useMutation({
		mutationFn: async () => {
			await api.delete(`/api/v1/images/${imageId}`, { params: { force: true } });
		},
		onSuccess: () => {
			toast.success('Image removed');
			void queryClient.invalidateQueries({ queryKey: ['images'] });
			navigate('/images');
		},
		onError: (err) => toast.error(errorMessage(err)),
	});

	if (detailQuery.isLoading) {
		return (
			<div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
				<Loader2 className="h-4 w-4 animate-spin" />
				Loading image...
			</div>
		);
	}

	if (detailQuery.isError || !image) {
		return (
			<div className="space-y-4 p-6">
				<Button variant="ghost" size="sm" onClick={() => navigate('/images')}>
					<ArrowLeft className="h-4 w-4" />
					Back to images
				</Button>
				<Card>
					<CardContent className="py-10 text-center text-sm text-muted-foreground">
						Image not found or no longer tracked.
					</CardContent>
				</Card>
			</div>
		);
	}

	const inUse = image.inUse ?? 0;

	const copyToClipboard = async (value: string, label: string) => {
		try {
			await navigator.clipboard.writeText(value);
			toast.success(`${label} copied`);
		} catch {
			toast.error('Failed to copy');
		}
	};

	return (
		<div className="space-y-6">
			{/* Breadcrumb / Back */}
			<div className="flex items-center justify-between">
				<button
					type="button"
					onClick={() => navigate('/images')}
					className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
				>
					<ArrowLeft className="h-4 w-4" />
					<span>Images</span>
					<span className="text-muted-foreground/50">/</span>
					<span className="text-foreground">{image.repository}</span>
				</button>
				<div className="flex items-center gap-2">
					<Button
						size="sm"
						onClick={() =>
							navigate(
								`/containers?image=${encodeURIComponent(image.repository)}&tag=${encodeURIComponent(image.tag)}`,
							)
						}
					>
						<Rocket className="h-4 w-4" />
						Deploy this image
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() => copyToClipboard(`${image.repository}:${image.tag}`, 'Image reference')}
					>
						<Copy className="h-4 w-4" />
						Copy reference
					</Button>
				</div>
			</div>

			{/* Hero header */}
			<div className="rounded-xl border bg-gradient-to-br from-card via-card to-muted/30 p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="min-w-0 flex-1 space-y-3">
						<div className="flex items-center gap-3">
							<div className="flex h-12 w-12 items-center justify-center rounded-xl border bg-background shadow-sm">
								<Boxes className="h-6 w-6 text-primary" />
							</div>
							<div className="min-w-0">
								<h1 className="truncate text-2xl font-semibold tracking-tight">
									{image.repository}
								</h1>
								<div className="flex flex-wrap items-center gap-2 text-sm">
									<span className="rounded-md border bg-background px-2 py-0.5 font-mono text-xs">
										{image.tag}
									</span>
									<Badge
										variant="outline"
										className={cn('uppercase tracking-wide', SOURCE_STYLES[image.source])}
									>
										{image.source}
									</Badge>
									{inUse > 0 ? (
										<Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
											{inUse} container{inUse === 1 ? '' : 's'} using
										</Badge>
									) : (
										<span className="text-xs text-muted-foreground">unused</span>
									)}
								</div>
							</div>
						</div>
						{image.description && (
							<p className="max-w-2xl text-sm text-muted-foreground">{image.description}</p>
						)}
					</div>
				</div>

				<Separator className="my-5" />

				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					<HeroStat icon={HardDrive} label="Size" value={formatBytes(image.sizeBytes)} />
					<HeroStat
						icon={Calendar}
						label="Updated"
						value={formatRelativeTime(image.updatedAt)}
					/>
					<HeroStat
						icon={User}
						label="Built by"
						value={image.builtBy ?? 'system'}
					/>
					<HeroStat
						icon={Layers}
						label="Labels"
						value={String(Object.keys(image.labels).length)}
					/>
				</div>
			</div>

			{/* Identity card */}
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						<Fingerprint className="h-4 w-4" />
						Identity
					</CardTitle>
					<CardDescription>Hashes Docker uses to identify this image.</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					<HashRow
						icon={Hash}
						label="Docker ID"
						value={image.dockerImageId}
						onCopy={() => copyToClipboard(image.dockerImageId, 'Docker ID')}
					/>
					<HashRow
						icon={Fingerprint}
						label="Digest"
						value={image.digest ?? '—'}
						onCopy={image.digest ? () => copyToClipboard(image.digest!, 'Digest') : undefined}
					/>
				</CardContent>
			</Card>

			<div className="grid gap-6 lg:grid-cols-2">
				{/* Metadata editor */}
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-base">
							<Edit3 className="h-4 w-4" />
							Metadata
						</CardTitle>
						<CardDescription>
							Description and labels are stored by the cluster, not in Docker itself.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="space-y-2">
							<Label>Description</Label>
							<Input
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="What is this image for?"
							/>
						</div>
						<div className="space-y-2">
							<Label>Labels JSON</Label>
							<Textarea
								value={labelsJson}
								onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setLabelsJson(e.target.value)}
								className="min-h-[160px] font-mono text-xs"
							/>
						</div>
						<Button onClick={() => patchMutation.mutate()} disabled={patchMutation.isPending}>
							{patchMutation.isPending ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<Edit3 className="h-4 w-4" />
							)}
							Save changes
						</Button>
					</CardContent>
				</Card>

				{/* Create tag */}
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-base">
							<TagIcon className="h-4 w-4" />
							Create another tag
						</CardTitle>
						<CardDescription>
							Copy this image under a new repo or tag (useful for version aliases).
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="space-y-2">
							<Label>New repository</Label>
							<Input value={tagRepo} onChange={(e) => setTagRepo(e.target.value)} />
						</div>
						<div className="space-y-2">
							<Label>New tag</Label>
							<Input value={tagName} onChange={(e) => setTagName(e.target.value)} />
						</div>
						<Button
							variant="secondary"
							onClick={() => tagMutation.mutate()}
							disabled={tagMutation.isPending || !tagRepo.trim() || !tagName.trim()}
						>
							{tagMutation.isPending ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<TagIcon className="h-4 w-4" />
							)}
							Create tag
						</Button>
					</CardContent>
				</Card>
			</div>

			{/* Labels list */}
			{Object.keys(image.labels).length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-base">
							<Info className="h-4 w-4" />
							Labels
						</CardTitle>
						<CardDescription>Read-only view of the labels editor above.</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="grid gap-2">
							{Object.entries(image.labels).map(([key, value]) => (
								<div
									key={key}
									className="flex flex-wrap items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs"
								>
									<span className="font-mono font-medium">{key}</span>
									<span className="text-muted-foreground">=</span>
									<span className="break-all font-mono text-muted-foreground">{value}</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Danger zone */}
			<Card className="border-destructive/40">
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base text-destructive">
						<Trash2 className="h-4 w-4" />
						Danger zone
					</CardTitle>
					<CardDescription>
						Deleting an image removes it from the cluster registry and tells Docker to drop it.
						{inUse > 0 && (
							<span className="mt-1 block font-medium text-amber-600 dark:text-amber-400">
								Warning: {inUse} container{inUse === 1 ? '' : 's'} still reference this image.
							</span>
						)}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Button
						variant="destructive"
						onClick={() => {
							if (
								window.confirm(
									`Delete ${image.repository}:${image.tag}? This action cannot be undone.`,
								)
							) {
								deleteMutation.mutate();
							}
						}}
						disabled={deleteMutation.isPending}
					>
						{deleteMutation.isPending ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<Trash2 className="h-4 w-4" />
						)}
						Delete image
					</Button>
				</CardContent>
			</Card>
		</div>
	);
}

function HeroStat({
	icon: Icon,
	label,
	value,
}: {
	icon: typeof Calendar;
	label: string;
	value: string;
}) {
	return (
		<div className="space-y-1">
			<div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
				<Icon className="h-3.5 w-3.5" />
				{label}
			</div>
			<div className="truncate text-base font-semibold">{value}</div>
		</div>
	);
}

function HashRow({
	icon: Icon,
	label,
	value,
	onCopy,
}: {
	icon: typeof Hash;
	label: string;
	value: string;
	onCopy?: () => void;
}) {
	return (
		<div className="flex items-start gap-3 rounded-md border bg-muted/30 px-3 py-2.5">
			<Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1">
				<div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
				<div className="break-all font-mono text-xs">{value}</div>
			</div>
			{onCopy && (
				<Button variant="ghost" size="sm" onClick={onCopy} className="h-7 px-2">
					<Copy className="h-3.5 w-3.5" />
				</Button>
			)}
		</div>
	);
}
