import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Search, Star, Download, ExternalLink, Server, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, getStoredToken } from '@/lib/api';
import type { RegistryInfo, ImageSearchResult, ImageDetails } from '@/types/registry';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

export function RegistryExplorer() {
	const [selectedRegistry, setSelectedRegistry] = useState<string>('docker.io');
	const [searchQuery, setSearchQuery] = useState<string>('');
	const [selectedImage, setSelectedImage] = useState<ImageDetails | null>(null);
	const [selectedTag, setSelectedTag] = useState<string>('latest');

	interface RegistrySearchResponse {
		registry: RegistryInfo;
		images: ImageSearchResult[];
		total: number;
	}

	interface ImageDetailsResponse {
		registry: RegistryInfo;
		image: ImageDetails;
	}

	// Fetch registries
	const registriesQuery = useQuery({
		queryKey: ['registries'],
		queryFn: () => api.get<RegistryInfo[]>('/api/v1/registries').then((r) => r.data),
	});

	// Fetch images from registry
	const imagesQuery = useQuery({
		queryKey: ['registry-images', selectedRegistry, searchQuery],
		queryFn: () =>
			api
				.get<RegistrySearchResponse>(`/api/v1/registries/${selectedRegistry}/images`, {
					params: searchQuery ? { q: searchQuery } : undefined,
				})
				.then((r) => r.data),
		enabled: Boolean(selectedRegistry),
	});

	// Fetch image details
	const imageDetailsQuery = useQuery({
		queryKey: ['image-details', selectedRegistry, selectedImage?.name],
		queryFn: () =>
			api
				.get<ImageDetailsResponse>(`/api/v1/registries/${selectedRegistry}/images/${selectedImage?.name}/details`)
				.then((r) => r.data),
		enabled: Boolean(selectedImage?.name),
	});

	// Pull mutation
	const pullMutation = useMutation({
		mutationFn: async (imageName: string) => {
			const response = await fetch('/api/v1/images/pull', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${getStoredToken() ?? ''}`,
				},
				body: JSON.stringify({
					repository: selectedRegistry === 'docker.io' ? `library/${imageName}` : `${selectedRegistry}/${imageName}`,
					tag: selectedTag,
					description: `Pulled from ${registriesQuery.data?.find((r) => r.id === selectedRegistry)?.name}`,
				}),
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
			let finalImage: any = null;
			for (const block of text.split('\n\n')) {
				const line = block.trim();
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (!payload) continue;
				const parsed = JSON.parse(payload) as { error?: string; done?: boolean; image?: any };
				if (parsed.error) throw new Error(parsed.error);
				if (parsed.done && parsed.image) finalImage = parsed.image;
			}
			if (!finalImage) throw new Error('pull completed without returning an image');
			return finalImage;
		},
		onSuccess: () => {
			toast.success(`Pulled ${selectedImage?.name}:${selectedTag}`);
			setSelectedImage(null);
			setSelectedTag('latest');
		},
		onError: (err: Error) => toast.error(errorMessage(err)),
	});

	const handleImageClick = (image: ImageSearchResult) => {
		setSelectedImage(imageDetailsQuery.data?.image || (image as unknown as ImageDetails));
		setSelectedTag('latest');
	};

	const handlePull = () => {
		if (!selectedImage?.name) return;
		pullMutation.mutate(selectedImage.name);
	};

	return (
		<div className="space-y-6">
			<div>
				<h2 className="text-xl font-semibold">Pull from Registry</h2>
				<p className="text-sm text-muted-foreground">Browse and pull images from container registries</p>
			</div>

			{/* Registry Selector & Search */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Registry Explorer</CardTitle>
					<CardDescription>Search and browse container images from public registries</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label>Registry</Label>
							<div className="flex flex-wrap gap-2">
								{registriesQuery.data?.map((registry) => (
									<button
										key={registry.id}
										type="button"
										onClick={() => setSelectedRegistry(registry.id)}
										className={[
											'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
											selectedRegistry === registry.id
												? 'border-primary bg-accent/40'
												: 'hover:bg-accent/40',
										].join(' ')}
									>
										{registry.icon && <span className="text-lg">{registry.icon}</span>}
										<span className="font-medium">{registry.name}</span>
									</button>
								))}
							</div>
						</div>

						<div className="space-y-2">
							<Label>Search Images</Label>
							<div className="relative">
								<Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
								<Input
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
									placeholder="Search images... (e.g., nginx, node)"
									className="pl-9"
								/>
							</div>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* Image Results */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base flex items-center justify-between">
						<span>
							{registriesQuery.data?.find((r) => r.id === selectedRegistry)?.name} Images
						</span>
						<span className="text-sm font-normal text-muted-foreground">
							{imagesQuery.data?.total || 0} results
						</span>
					</CardTitle>
					<CardDescription>
						{searchQuery ? `Search results for "${searchQuery}"` : 'Popular images'}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					{imagesQuery.isLoading && (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" />
							Searching images...
						</div>
					)}

					{!imagesQuery.isLoading && imagesQuery.data?.images.length === 0 && (
						<div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground text-center">
							No images found. Try a different search term.
						</div>
					)}

					{imagesQuery.data?.images.map((image) => (
						<div
							key={image.name}
							className={[
								'rounded-lg border p-4 cursor-pointer transition-colors',
								selectedImage?.name === image.name ? 'border-primary bg-accent/40' : 'hover:bg-accent/40',
							].join(' ')}
							onClick={() => handleImageClick(image)}
						>
							<div className="flex flex-wrap items-start justify-between gap-3">
								<div className="space-y-1 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium text-base">{image.name}</span>
										{image.official && (
											<Badge variant="secondary" className="text-xs">
												official
											</Badge>
										)}
										<Badge variant="outline" className="text-xs">
											{image.tags.length} tags
										</Badge>
									</div>
									<p className="text-sm text-muted-foreground">{image.description}</p>
									<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground mt-2">
										<div className="flex items-center gap-1">
											<Star className="h-3 w-3 fill-amber-500 text-amber-500" />
											{image.stars.toLocaleString()} stars
										</div>
										<div className="flex items-center gap-1">
											<Download className="h-3 w-3" />
											{image.pulls} pulls
										</div>
										{image.size && <span>Size: {image.size}</span>}
										{image.architecture && (
											<span>{image.architecture.slice(0, 2).join(', ')} {image.architecture.length > 2 && '+more'}</span>
										)}
									</div>
								</div>
								<Button variant="outline" size="sm" onClick={(e) => e.stopPropagation()}>
									<ExternalLink className="h-4 w-4" />
									Details
								</Button>
							</div>

							{/* Tags preview */}
							<div className="flex flex-wrap gap-1 mt-3">
								{image.tags.slice(0, 5).map((tag) => (
									<Badge key={tag} variant="secondary" className="text-[10px]">
										{tag}
									</Badge>
								))}
								{image.tags.length > 5 && (
									<Badge variant="secondary" className="text-[10px]">
										+{image.tags.length - 5} more
									</Badge>
								)}
							</div>
						</div>
					))}
				</CardContent>
			</Card>

			{/* Image Details */}
			{selectedImage && imageDetailsQuery.data && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base flex items-center gap-2">
							<Server className="h-4 w-4" />
							{imageDetailsQuery.data.image.name}
						</CardTitle>
						<CardDescription>{imageDetailsQuery.data.image.description}</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="grid gap-4 sm:grid-cols-4">
							<div className="rounded-md border bg-muted/30 p-3">
								<div className="text-xs uppercase tracking-wide text-muted-foreground">Stars</div>
								<div className="flex items-center gap-1 mt-1">
									<Star className="h-3 w-3 fill-amber-500 text-amber-500" />
									<span className="font-medium">{imageDetailsQuery.data.image.stars.toLocaleString()}</span>
								</div>
							</div>
							<div className="rounded-md border bg-muted/30 p-3">
								<div className="text-xs uppercase tracking-wide text-muted-foreground">Pulls</div>
								<div className="font-medium mt-1">{imageDetailsQuery.data.image.pulls}</div>
							</div>
							<div className="rounded-md border bg-muted/30 p-3">
								<div className="text-xs uppercase tracking-wide text-muted-foreground">Size</div>
								<div className="font-medium mt-1">{imageDetailsQuery.data.image.size}</div>
							</div>
							<div className="rounded-md border bg-muted/30 p-3">
								<div className="text-xs uppercase tracking-wide text-muted-foreground">Architectures</div>
								<div className="font-medium mt-1 text-xs">{imageDetailsQuery.data.image.architecture.slice(0, 3).join(', ')}</div>
							</div>
						</div>

						<Separator />

						<div className="space-y-2">
							<Label>Select Tag</Label>
							<div className="flex flex-wrap gap-2">
								{imageDetailsQuery.data.image.tags.map((tag: { name: string; size: string }) => (
									<button
										key={tag.name}
										type="button"
										onClick={() => setSelectedTag(tag.name)}
										className={[
											'rounded-md border px-3 py-2 text-sm transition-colors',
											selectedTag === tag.name
												? 'border-primary bg-accent/40'
												: 'hover:bg-accent/40',
										].join(' ')}
									>
										<div className="font-medium">{tag.name}</div>
										<div className="text-xs text-muted-foreground">{tag.size}</div>
									</button>
								))}
							</div>
						</div>

						<div className="flex items-center gap-2">
							<Button onClick={handlePull} disabled={pullMutation.isPending} className="flex-1">
								{pullMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
								<Download className="h-4 w-4 mr-2" />
								Pull {selectedImage.name}:{selectedTag}
							</Button>
						</div>

						{selectedTag && (
							<div className="rounded-md bg-muted/50 p-3 text-xs">
								<strong>Selected:</strong>{' '}
								{selectedRegistry === 'docker.io' ? 'docker.io/library/' : selectedRegistry + '/'}
								{selectedImage.name}:{selectedTag}
							</div>
						)}
					</CardContent>
				</Card>
			)}
		</div>
	);
}
