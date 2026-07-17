import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Package, Search, Star } from 'lucide-react';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { ImageSearchResult } from '@/types/registry';

interface RealtimeTag {
	name: string;
	size: string;
	lastUpdated: string;
}

interface SearchResponse {
	registry: string;
	results: ImageSearchResult[];
	total: number;
}

interface TagsResponse {
	repository: string;
	registry: string;
	tags: RealtimeTag[];
	total: number;
}

interface Props {
	repository: string;
	tag: string;
	onChange: (next: { repository: string; tag: string }) => void;
}

function useDebounced<T>(value: T, delay = 200): T {
	const [v, setV] = useState(value);
	useEffect(() => {
		const id = window.setTimeout(() => setV(value), delay);
		return () => window.clearTimeout(id);
	}, [value, delay]);
	return v;
}

/**
 * Parses what the user has typed and decides how to autocomplete:
 *   - "nginx"            -> Docker Hub search
 *   - "owner/repo"       -> Docker Hub tags only (no search, treat as known repo)
 *   - "ghcr.io/o/r"      -> GHCR tags
 *   - "gcr.io/..."       -> no autocomplete (custom)
 *   - "<reg>/<rest>"     -> no autocomplete
 */
function parseInput(repo: string): {
	mode: 'dockerhub-search' | 'dockerhub-tags' | 'ghcr-tags' | 'none';
	registry: string;
	queryOrRepo: string;
} {
	const v = repo.trim();
	if (!v) return { mode: 'dockerhub-search', registry: 'docker.io', queryOrRepo: '' };

	if (v.startsWith('ghcr.io/')) {
		const rest = v.slice('ghcr.io/'.length);
		// need at least "owner/repo"
		const parts = rest.split('/').filter(Boolean);
		if (parts.length >= 2) {
			return { mode: 'ghcr-tags', registry: 'ghcr.io', queryOrRepo: parts.slice(0, 2).join('/') };
		}
		return { mode: 'none', registry: 'ghcr.io', queryOrRepo: '' };
	}

	// Other known registries — no autocomplete
	const otherRegistryPrefixes = ['gcr.io/', 'quay.io/', 'registry.gitlab.com/', 'mcr.microsoft.com/'];
	if (otherRegistryPrefixes.some((p) => v.startsWith(p))) {
		return { mode: 'none', registry: v.split('/')[0], queryOrRepo: '' };
	}

	// Has slash but no known registry — assume Docker Hub user/org repo
	if (v.includes('/')) {
		return { mode: 'dockerhub-tags', registry: 'docker.io', queryOrRepo: v };
	}

	// Bare word — Docker Hub search
	return { mode: 'dockerhub-search', registry: 'docker.io', queryOrRepo: v };
}

/**
 * Autocomplete combobox for the Pull Image form.
 *
 * - Bare names (`nginx`) → realtime Docker Hub search.
 * - Docker Hub user/org repos (`owner/repo`) → Docker Hub tags only.
 * - GHCR paths (`ghcr.io/owner/repo`) → GHCR tags via distribution API.
 * - Other registries → free-form, no suggestions.
 */
export function PullImageAutocomplete({ repository, tag, onChange }: Props) {
	const [repoOpen, setRepoOpen] = useState(false);
	const [tagOpen, setTagOpen] = useState(false);
	const [activeRepoIdx, setActiveRepoIdx] = useState(0);
	const [activeTagIdx, setActiveTagIdx] = useState(0);

	const debouncedRepo = useDebounced(repository, 220);
	const parsed = useMemo(() => parseInput(debouncedRepo), [debouncedRepo]);

	// --- Search (Docker Hub only, bare names) ---
	const suggestionsQuery = useQuery({
		queryKey: ['registry-search', parsed.registry, parsed.queryOrRepo],
		queryFn: () =>
			api
				.get<SearchResponse>('/api/v1/registries/search', {
					params: { q: parsed.queryOrRepo, registry: parsed.registry },
				})
				.then((r) => r.data.results),
		enabled: repoOpen && parsed.mode === 'dockerhub-search' && parsed.queryOrRepo.length >= 2,
		staleTime: 60_000,
	});

	// --- Tags (lazy, only when we know the repo) ---
	const tagsTarget = useMemo(() => {
		if (parsed.mode === 'dockerhub-tags') return { registry: 'docker.io', repo: parsed.queryOrRepo };
		if (parsed.mode === 'ghcr-tags') return { registry: 'ghcr.io', repo: parsed.queryOrRepo };
		if (parsed.mode === 'dockerhub-search') {
			// Tags only meaningful when the typed name exactly matches a search hit.
			const match = suggestionsQuery.data?.find((img) => img.name === parsed.queryOrRepo);
			if (match) return { registry: 'docker.io', repo: match.name };
		}
		return null;
	}, [parsed, suggestionsQuery.data]);

	const tagsQuery = useQuery({
		queryKey: ['registry-tags', tagsTarget?.registry, tagsTarget?.repo],
		queryFn: () =>
			api
				.get<TagsResponse>('/api/v1/registries/tags', {
					params: { repository: tagsTarget!.repo, registry: tagsTarget!.registry },
				})
				.then((r) => r.data.tags),
		enabled: Boolean(tagsTarget),
		staleTime: 60_000,
	});

	const filteredTags = useMemo(() => {
		const all = tagsQuery.data ?? [];
		const needle = tag.trim().toLowerCase();
		if (!needle) return all;
		return all.filter((t) => t.name.toLowerCase().includes(needle));
	}, [tagsQuery.data, tag]);

	useEffect(() => {
		setActiveRepoIdx(0);
	}, [parsed.queryOrRepo]);

	useEffect(() => {
		setActiveTagIdx(0);
	}, [tag, tagsQuery.data?.length]);

	const repoWrapRef = useRef<HTMLDivElement>(null);
	const tagWrapRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		function handleDocClick(e: MouseEvent) {
			if (repoWrapRef.current && !repoWrapRef.current.contains(e.target as Node)) {
				setRepoOpen(false);
			}
			if (tagWrapRef.current && !tagWrapRef.current.contains(e.target as Node)) {
				setTagOpen(false);
			}
		}
		document.addEventListener('mousedown', handleDocClick);
		return () => document.removeEventListener('mousedown', handleDocClick);
	}, []);

	const suggestions = suggestionsQuery.data ?? [];

	function pickImage(img: ImageSearchResult, withTag?: string) {
		onChange({
			repository: img.name,
			tag: withTag ?? 'latest',
		});
		setRepoOpen(false);
	}

	function pickTag(name: string) {
		onChange({ repository, tag: name });
		setTagOpen(false);
	}

	const showRepoDropdown = repoOpen && parsed.mode === 'dockerhub-search';
	const showTagDropdown = tagOpen && (filteredTags.length > 0 || tagsQuery.isFetching);

	return (
		<div className="space-y-4">
			{/* Repository combobox */}
			<div className="space-y-2" ref={repoWrapRef}>
				<Label className="flex items-center gap-2">
					Repository
					{suggestionsQuery.isFetching && parsed.mode === 'dockerhub-search' && (
						<Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
					)}
					<span className="ml-auto text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
						{parsed.registry}
					</span>
				</Label>
				<div className="relative">
					<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={repository}
						onChange={(e) => {
							onChange({ repository: e.target.value, tag });
							setRepoOpen(true);
						}}
						onFocus={() => setRepoOpen(true)}
						onKeyDown={(e) => {
							if (!showRepoDropdown || suggestions.length === 0) return;
							if (e.key === 'ArrowDown') {
								e.preventDefault();
								setActiveRepoIdx((i) => Math.min(i + 1, suggestions.length - 1));
							} else if (e.key === 'ArrowUp') {
								e.preventDefault();
								setActiveRepoIdx((i) => Math.max(i - 1, 0));
							} else if (e.key === 'Enter') {
								const pick = suggestions[activeRepoIdx];
								if (pick) {
									e.preventDefault();
									pickImage(pick);
								}
							} else if (e.key === 'Escape') {
								setRepoOpen(false);
							}
						}}
						placeholder="nginx, owner/repo, ghcr.io/owner/repo..."
						className="pl-9"
						autoComplete="off"
					/>
				</div>

				{showRepoDropdown && (
					<div className="relative">
						<div className="absolute left-0 right-0 top-1 z-30 max-h-[340px] overflow-auto rounded-md border bg-popover shadow-md">
							{suggestionsQuery.isLoading && (
								<div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
									<Loader2 className="h-4 w-4 animate-spin" />
									Searching Docker Hub...
								</div>
							)}

							{!suggestionsQuery.isLoading && parsed.queryOrRepo.length < 2 && (
								<div className="px-3 py-3 text-xs text-muted-foreground">
									Type at least 2 characters to search Docker Hub.
									<br />
									For GHCR, type the full path:{' '}
									<span className="font-mono text-foreground">ghcr.io/owner/repo</span>
								</div>
							)}

							{!suggestionsQuery.isLoading && suggestions.length === 0 && parsed.queryOrRepo.length >= 2 && (
								<div className="px-3 py-3 text-xs text-muted-foreground">
									No matches on Docker Hub for "{parsed.queryOrRepo}".
								</div>
							)}

							{suggestions.map((img, i) => (
								<button
									key={`${img.name}-${i}`}
									type="button"
									onMouseEnter={() => setActiveRepoIdx(i)}
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => pickImage(img)}
									className={cn(
										'flex w-full flex-col items-start gap-1.5 border-b px-3 py-2.5 text-left last:border-b-0',
										i === activeRepoIdx ? 'bg-accent' : 'hover:bg-accent/60',
									)}
								>
									<div className="flex w-full items-center gap-2">
										<Package className="h-4 w-4 shrink-0 text-muted-foreground" />
										<span className="font-medium">{img.name}</span>
										{img.official && (
											<span className="rounded-sm bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
												official
											</span>
										)}
										<span className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
											<span className="flex items-center gap-1">
												<Star className="h-3 w-3" />
												{img.stars.toLocaleString()}
											</span>
											<span>{img.pulls} pulls</span>
										</span>
									</div>
									{img.description && (
										<div className="line-clamp-1 pl-6 text-xs text-muted-foreground">
											{img.description}
										</div>
									)}
								</button>
							))}
						</div>
					</div>
				)}
			</div>

			{/* Tag combobox */}
			<div className="space-y-2" ref={tagWrapRef}>
				<Label className="flex items-center gap-2">
					Tag
					{tagsQuery.isFetching && (
						<Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
					)}
					{parsed.mode === 'ghcr-tags' && (
						<span className="ml-auto text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
							GHCR
						</span>
					)}
				</Label>
				<Input
					value={tag}
					onChange={(e) => {
						onChange({ repository, tag: e.target.value });
						setTagOpen(true);
					}}
					onFocus={() => setTagOpen(true)}
					onKeyDown={(e) => {
						if (!showTagDropdown || filteredTags.length === 0) return;
						if (e.key === 'ArrowDown') {
							e.preventDefault();
							setActiveTagIdx((i) => Math.min(i + 1, filteredTags.length - 1));
						} else if (e.key === 'ArrowUp') {
							e.preventDefault();
							setActiveTagIdx((i) => Math.max(i - 1, 0));
						} else if (e.key === 'Enter') {
							const pick = filteredTags[activeTagIdx];
							if (pick) {
								e.preventDefault();
								pickTag(pick.name);
							}
						} else if (e.key === 'Escape') {
							setTagOpen(false);
						}
					}}
					placeholder="latest"
					autoComplete="off"
				/>

				{showTagDropdown && (
					<div className="relative">
						<div className="absolute left-0 right-0 top-1 z-30 max-h-[260px] overflow-auto rounded-md border bg-popover shadow-md">
							{tagsQuery.isFetching && filteredTags.length === 0 && (
								<div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground">
									<Loader2 className="h-3.5 w-3.5 animate-spin" />
									Fetching tags...
								</div>
							)}
							{filteredTags.map((t, i) => (
								<button
									key={t.name}
									type="button"
									onMouseEnter={() => setActiveTagIdx(i)}
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => pickTag(t.name)}
									className={cn(
										'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm last:border-b-0',
										i === activeTagIdx ? 'bg-accent' : 'hover:bg-accent/60',
									)}
								>
									<span className="font-mono">{t.name}</span>
									<span className="text-xs text-muted-foreground">{t.size}</span>
								</button>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
