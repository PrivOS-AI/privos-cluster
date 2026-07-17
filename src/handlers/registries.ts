/**
 * Registry management REST routes
 * All routes require JWT auth via fastify.authenticate preHandler
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

interface RegistryInfo {
	id: string;
	name: string;
	host: string;
	public: boolean;
	description: string;
	icon?: string;
}

interface ImageSearchResult {
	name: string;
	description: string;
	stars: number;
	pulls: string;
	official: boolean;
	tags: string[];
	size?: string;
	architecture?: string[];
}

interface ImageDetails {
	name: string;
	description: string;
	stars: number;
	pulls: string;
	size: string;
	architecture: string[];
	tags: Array<{
		name: string;
		size: string;
		lastUpdated: string;
	}>;
}

const REGISTRIES: Record<string, RegistryInfo> = {
	'docker.io': {
		id: 'docker.io',
		name: 'Docker Hub',
		host: 'registry-1.docker.io',
		public: true,
		description: 'World\'s largest container image registry',
		icon: '🐳',
	},
	'ghcr.io': {
		id: 'ghcr.io',
		name: 'GitHub Container Registry',
		host: 'ghcr.io',
		public: true,
		description: 'Container registry integrated with GitHub',
		icon: '🐙',
	},
	'gcr.io': {
		id: 'gcr.io',
		name: 'Google Container Registry',
		host: 'gcr.io',
		public: true,
		description: 'Google Cloud\'s container image registry',
		icon: '☁️',
	},
	'quay.io': {
		id: 'quay.io',
		name: 'Quay.io',
		host: 'quay.io',
		public: true,
		description: 'Secure container registry by Red Hat',
		icon: '🦅',
	},
};

const POPULAR_IMAGES: ImageSearchResult[] = [
	{
		name: 'nginx',
		description: 'High performance web server',
		stars: 15234,
		pulls: '10B+',
		official: true,
		tags: ['latest', 'alpine', '1.25-alpine', '1.24', 'slim'],
		size: '187MB',
		architecture: ['linux/amd64', 'linux/arm64'],
	},
	{
		name: 'node',
		description: 'JavaScript runtime built on Chrome\'s V8',
		stars: 12456,
		pulls: '8B+',
		official: true,
		tags: ['20', '18-alpine', 'current', 'lts', 'slim'],
		size: '180MB',
		architecture: ['linux/amd64', 'linux/arm64'],
	},
	{
		name: 'postgres',
		description: 'The world\'s most advanced open source database',
		stars: 8934,
		pulls: '2B+',
		official: true,
		tags: ['16', '15-alpine', 'latest', '14', '13'],
		size: '414MB',
		architecture: ['linux/amd64', 'linux/arm64'],
	},
	{
		name: 'redis',
		description: 'In-memory data structure store',
		stars: 7823,
		pulls: '3B+',
		official: true,
		tags: ['7-alpine', 'latest', '6', '5'],
		size: '117MB',
		architecture: ['linux/amd64', 'linux/arm64'],
	},
	{
		name: 'python',
		description: 'Programming language that lets you work quickly',
		stars: 9876,
		pulls: '5B+',
		official: true,
		tags: ['3.12-slim', '3.11-alpine', 'latest', '3.10'],
		size: '919MB',
		architecture: ['linux/amd64', 'linux/arm64'],
	},
	{
		name: 'mongodb',
		description: 'Document-oriented database program',
		stars: 6543,
		pulls: '2B+',
		official: true,
		tags: ['7', '6', 'latest', 'windowsservercore-ltsc2022'],
		size: '690MB',
		architecture: ['linux/amd64', 'linux/arm64'],
	},
	{
		name: 'ubuntu',
		description: 'Ubuntu is a Debian-based Linux operating system',
		stars: 15678,
		pulls: '10B+',
		official: true,
		tags: ['22.04', '20.04', '18.04', 'latest', 'jammy'],
		size: '77MB',
		architecture: ['linux/amd64', 'linux/arm64'],
	},
	{
		name: 'alpine',
		description: 'A minimal Docker image based on Alpine Linux',
		stars: 8765,
		pulls: '10B+',
		official: true,
		tags: ['3.19', '3.18', 'latest', 'edge'],
		size: '7MB',
		architecture: ['linux/amd64', 'linux/arm64'],
	},
];

const IMAGE_DETAILS_DB: Record<string, ImageDetails> = {
	'nginx': {
		name: 'nginx',
		description: 'High performance web server and reverse proxy server',
		stars: 15234,
		pulls: '10B+',
		size: '187MB',
		architecture: ['linux/amd64', 'linux/arm64', 'linux/arm/v7', 'linux/arm/v6', 'linux/386', 'linux/ppc64le', 'linux/s390x'],
		tags: [
			{ name: 'latest', size: '187MB', lastUpdated: '2024-01-15T10:30:00Z' },
			{ name: 'alpine', size: '40MB', lastUpdated: '2024-01-15T10:30:00Z' },
			{ name: '1.25-alpine', size: '40MB', lastUpdated: '2024-01-10T08:00:00Z' },
			{ name: '1.24', size: '142MB', lastUpdated: '2023-12-20T12:00:00Z' },
			{ name: 'slim', size: '187MB', lastUpdated: '2024-01-15T10:30:00Z' },
		],
	},
	'node': {
		name: 'node',
		description: 'Node.js is a JavaScript runtime built on Chrome\'s V8 JavaScript engine',
		stars: 12456,
		pulls: '8B+',
		size: '180MB',
		architecture: ['linux/amd64', 'linux/arm64', 'linux/arm/v7'],
		tags: [
			{ name: '20', size: '1GB', lastUpdated: '2024-01-20T08:00:00Z' },
			{ name: '18-alpine', size: '170MB', lastUpdated: '2024-01-18T06:00:00Z' },
			{ name: 'current', size: '1GB', lastUpdated: '2024-01-20T08:00:00Z' },
			{ name: 'lts', size: '1GB', lastUpdated: '2024-01-18T06:00:00Z' },
			{ name: 'slim', size: '250MB', lastUpdated: '2024-01-20T08:00:00Z' },
		],
	},
	'postgres': {
		name: 'postgres',
		description: 'The PostgreSQL object-relational database system provides reliability and data integrity.',
		stars: 8934,
		pulls: '2B+',
		size: '414MB',
		architecture: ['linux/amd64', 'linux/arm64', 'linux/arm/v7'],
		tags: [
			{ name: '16', size: '420MB', lastUpdated: '2024-01-10T10:00:00Z' },
			{ name: '15-alpine', size: '260MB', lastUpdated: '2023-12-15T08:00:00Z' },
			{ name: 'latest', size: '420MB', lastUpdated: '2024-01-10T10:00:00Z' },
			{ name: '14', size: '380MB', lastUpdated: '2023-11-20T12:00:00Z' },
			{ name: '13', size: '370MB', lastUpdated: '2023-10-15T14:00:00Z' },
		],
	},
	'redis': {
		name: 'redis',
		description: 'Redis is an open source key-value store that functions as a data structure server.',
		stars: 7823,
		pulls: '3B+',
		size: '117MB',
		architecture: ['linux/amd64', 'linux/arm64', 'linux/arm/v7'],
		tags: [
			{ name: '7-alpine', size: '32MB', lastUpdated: '2024-01-05T08:00:00Z' },
			{ name: 'latest', size: '117MB', lastUpdated: '2024-01-05T08:00:00Z' },
			{ name: '6', size: '110MB', lastUpdated: '2023-12-01T10:00:00Z' },
			{ name: '5', size: '100MB', lastUpdated: '2023-10-01T12:00:00Z' },
		],
	},
	'python': {
		name: 'python',
		description: 'Python is an interpreted, interactive, object-oriented, open-source programming language.',
		stars: 9876,
		pulls: '5B+',
		size: '919MB',
		architecture: ['linux/amd64', 'linux/arm64', 'linux/arm/v7'],
		tags: [
			{ name: '3.12-slim', size: '150MB', lastUpdated: '2024-01-12T08:00:00Z' },
			{ name: '3.11-alpine', size: '50MB', lastUpdated: '2024-01-10T10:00:00Z' },
			{ name: 'latest', size: '919MB', lastUpdated: '2024-01-12T08:00:00Z' },
			{ name: '3.10', size: '900MB', lastUpdated: '2023-12-01T12:00:00Z' },
		],
	},
	'mongodb': {
		name: 'mongodb',
		description: 'MongoDB is a document-oriented NoSQL database used for high volume data storage.',
		stars: 6543,
		pulls: '2B+',
		size: '690MB',
		architecture: ['linux/amd64', 'linux/arm64'],
		tags: [
			{ name: '7', size: '700MB', lastUpdated: '2024-01-08T08:00:00Z' },
			{ name: '6', size: '690MB', lastUpdated: '2023-12-15T10:00:00Z' },
			{ name: 'latest', size: '700MB', lastUpdated: '2024-01-08T08:00:00Z' },
			{ name: 'windowsservercore-ltsc2022', size: '5GB', lastUpdated: '2024-01-08T08:00:00Z' },
		],
	},
	'ubuntu': {
		name: 'ubuntu',
		description: 'Ubuntu is a Debian-based Linux operating system based on free software.',
		stars: 15678,
		pulls: '10B+',
		size: '77MB',
		architecture: ['linux/amd64', 'linux/arm64', 'linux/arm/v7', 'linux/ppc64le', 'linux/s390x', 'linux/riscv64'],
		tags: [
			{ name: '22.04', size: '77MB', lastUpdated: '2024-01-15T08:00:00Z' },
			{ name: '20.04', size: '72MB', lastUpdated: '2024-01-15T08:00:00Z' },
			{ name: '18.04', size: '64MB', lastUpdated: '2023-12-01T10:00:00Z' },
			{ name: 'latest', size: '77MB', lastUpdated: '2024-01-15T08:00:00Z' },
			{ name: 'jammy', size: '77MB', lastUpdated: '2024-01-15T08:00:00Z' },
		],
	},
	'alpine': {
		name: 'alpine',
		description: 'Alpine Linux is a Linux distribution built around musl libc and BusyBox.',
		stars: 8765,
		pulls: '10B+',
		size: '7MB',
		architecture: ['linux/amd64', 'linux/arm64', 'linux/arm/v7', 'linux/arm/v6', 'linux/ppc64le', 'linux/s390x', 'linux/riscv64'],
		tags: [
			{ name: '3.19', size: '7MB', lastUpdated: '2024-01-20T08:00:00Z' },
			{ name: '3.18', size: '7MB', lastUpdated: '2024-01-10T10:00:00Z' },
			{ name: 'latest', size: '7MB', lastUpdated: '2024-01-20T08:00:00Z' },
			{ name: 'edge', size: '7MB', lastUpdated: '2024-01-20T08:00:00Z' },
		],
	},
};

// ---------------------------------------------------------------------------
// Realtime registry adapters
// ---------------------------------------------------------------------------
// Simple in-memory TTL cache so we don't hammer Docker Hub on every keystroke.
const realtimeCache = new Map<string, { ts: number; data: unknown }>();
const REALTIME_CACHE_TTL_MS = 5 * 60 * 1000;
const REALTIME_TIMEOUT_MS = 8_000;

function getCached<T>(key: string): T | null {
	const entry = realtimeCache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.ts > REALTIME_CACHE_TTL_MS) {
		realtimeCache.delete(key);
		return null;
	}
	return entry.data as T;
}

function setCached(key: string, data: unknown): void {
	realtimeCache.set(key, { ts: Date.now(), data });
}

function formatPulls(n: number): string {
	if (!n || n < 0) return '0';
	if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B+`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M+`;
	if (n >= 1e3) return `${Math.floor(n / 1e3)}K+`;
	return String(n);
}

function formatRegistryBytes(b: number): string {
	if (!b || b < 0) return '?';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), sizes.length - 1);
	return `${(b / Math.pow(k, i)).toFixed(0)}${sizes[i]}`;
}

interface RealtimeTag {
	name: string;
	size: string;
	lastUpdated: string;
}

interface DockerHubSearchHit {
	repo_name: string;
	short_description?: string;
	star_count?: number;
	pull_count?: number;
	is_official?: boolean;
}

interface DockerHubTagHit {
	name: string;
	full_size?: number;
	last_updated?: string;
}

async function searchDockerHub(q: string): Promise<ImageSearchResult[]> {
	const cacheKey = `dockerhub:search:${q}`;
	const cached = getCached<ImageSearchResult[]>(cacheKey);
	if (cached) return cached;

	const url = `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(q)}&page_size=25`;
	const res = await fetch(url, { signal: AbortSignal.timeout(REALTIME_TIMEOUT_MS) });
	if (!res.ok) {
		throw new Error(`Docker Hub search returned ${res.status}`);
	}
	const body = (await res.json()) as { results?: DockerHubSearchHit[] };
	const hits = body.results ?? [];

	const results: ImageSearchResult[] = hits.map((r) => {
		// Strip "library/" prefix on official images so the field shows "nginx" not "library/nginx"
		const displayName = r.is_official && r.repo_name.startsWith('library/')
			? r.repo_name.slice('library/'.length)
			: r.repo_name;
		return {
			name: displayName,
			description: r.short_description ?? '',
			stars: r.star_count ?? 0,
			pulls: formatPulls(r.pull_count ?? 0),
			official: Boolean(r.is_official),
			tags: [], // lazy — fetched via /tags endpoint when user selects
		};
	});

	setCached(cacheKey, results);
	return results;
}

async function getDockerHubTags(repository: string): Promise<RealtimeTag[]> {
	const cacheKey = `dockerhub:tags:${repository}`;
	const cached = getCached<RealtimeTag[]>(cacheKey);
	if (cached) return cached;

	// Official images live under library/<name> on Docker Hub
	const repoPath = repository.includes('/') ? repository : `library/${repository}`;
	const url = `https://hub.docker.com/v2/repositories/${repoPath}/tags/?page_size=25`;
	const res = await fetch(url, { signal: AbortSignal.timeout(REALTIME_TIMEOUT_MS) });
	if (!res.ok) {
		if (res.status === 404) return [];
		throw new Error(`Docker Hub tags returned ${res.status}`);
	}
	const body = (await res.json()) as { results?: DockerHubTagHit[] };
	const tags: RealtimeTag[] = (body.results ?? []).map((t) => ({
		name: t.name,
		size: formatRegistryBytes(t.full_size ?? 0),
		lastUpdated: t.last_updated ?? '',
	}));

	setCached(cacheKey, tags);
	return tags;
}

async function getGhcrTags(ownerRepo: string): Promise<RealtimeTag[]> {
	// ownerRepo expected as "owner/repo"
	if (!ownerRepo.includes('/')) return [];
	const cacheKey = `ghcr:tags:${ownerRepo}`;
	const cached = getCached<RealtimeTag[]>(cacheKey);
	if (cached) return cached;

	// Step 1: fetch anonymous bearer token for pull scope
	const tokenUrl = `https://ghcr.io/token?scope=repository:${ownerRepo}:pull`;
	const tokenRes = await fetch(tokenUrl, { signal: AbortSignal.timeout(REALTIME_TIMEOUT_MS) });
	if (!tokenRes.ok) {
		if (tokenRes.status === 404 || tokenRes.status === 401) return [];
		throw new Error(`GHCR token request returned ${tokenRes.status}`);
	}
	const { token } = (await tokenRes.json()) as { token?: string };
	if (!token) return [];

	// Step 2: list tags using v2 distribution API
	const tagsRes = await fetch(`https://ghcr.io/v2/${ownerRepo}/tags/list`, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(REALTIME_TIMEOUT_MS),
	});
	if (!tagsRes.ok) {
		if (tagsRes.status === 404) return [];
		throw new Error(`GHCR tags returned ${tagsRes.status}`);
	}
	const body = (await tagsRes.json()) as { tags?: string[] };
	const tags: RealtimeTag[] = (body.tags ?? []).slice(0, 50).map((name) => ({
		name,
		size: '—', // distribution API does not expose size without per-manifest fetch
		lastUpdated: '',
	}));

	setCached(cacheKey, tags);
	return tags;
}

const registriesHandler: FastifyPluginAsync = async (fastify) => {
	// -----------------------------------------------------------------
	// Realtime search — proxies to Docker Hub public search API.
	// GET /api/v1/registries/search?q=&registry=docker.io
	// -----------------------------------------------------------------
	fastify.get('/api/v1/registries/search', { preHandler: fastify.authenticate }, async (req, reply) => {
		const { q, registry } = req.query as { q?: string; registry?: string };
		const reg = registry || 'docker.io';
		const query = (q ?? '').trim();
		if (query.length < 2) {
			return reply.send({ registry: reg, results: [], total: 0 });
		}

		try {
			let results: ImageSearchResult[] = [];
			if (reg === 'docker.io') {
				results = await searchDockerHub(query);
			} else {
				// GHCR / GCR / Quay don't expose anonymous search.
				// Return empty so the UI shows "type a full path" hint.
				results = [];
			}
			return reply.send({ registry: reg, results, total: results.length });
		} catch (err: any) {
			fastify.log.warn({ err, q: query, registry: reg }, 'realtime search failed');
			return reply.code(502).send({ error: 'registry_search_failed', reason: err.message });
		}
	});

	// -----------------------------------------------------------------
	// Realtime tags — proxies to Docker Hub or GHCR.
	// GET /api/v1/registries/tags?repository=&registry=docker.io|ghcr.io
	// -----------------------------------------------------------------
	fastify.get('/api/v1/registries/tags', { preHandler: fastify.authenticate }, async (req, reply) => {
		const { repository, registry } = req.query as { repository?: string; registry?: string };
		const reg = registry || 'docker.io';
		const repo = (repository ?? '').trim();
		if (!repo) {
			return reply.send({ repository: repo, registry: reg, tags: [], total: 0 });
		}

		try {
			let tags: RealtimeTag[] = [];
			if (reg === 'docker.io') {
				tags = await getDockerHubTags(repo);
			} else if (reg === 'ghcr.io') {
				tags = await getGhcrTags(repo);
			}
			return reply.send({ repository: repo, registry: reg, tags, total: tags.length });
		} catch (err: any) {
			fastify.log.warn({ err, repository: repo, registry: reg }, 'realtime tags failed');
			return reply.code(502).send({ error: 'registry_tags_failed', reason: err.message });
		}
	});

	// GET /api/v1/registries - List all registries
	fastify.get('/api/v1/registries', { preHandler: fastify.authenticate }, async (_req, reply) => {
		try {
			const registries = Object.values(REGISTRIES);
			return reply.send(registries);
		} catch (err: any) {
			fastify.log.error({ err }, 'list registries error');
			return reply.code(err.statusCode || 500).send({ error: err.message });
		}
	});

	// GET /api/v1/registries/:registryId/images - Search images in registry
	fastify.get('/api/v1/registries/:registryId/images', { preHandler: fastify.authenticate }, async (req, reply) => {
		try {
			const { registryId } = req.params as { registryId: string };
			const { q } = req.query as { q?: string };

			if (!REGISTRIES[registryId]) {
				return reply.code(404).send({ error: 'Registry not found' });
			}

			// Search in popular images
			let results = POPULAR_IMAGES;
			if (q) {
				const query = q.toLowerCase();
				results = POPULAR_IMAGES.filter(img =>
					img.name.toLowerCase().includes(query) ||
					img.description.toLowerCase().includes(query)
				);
			}

			return reply.send({
				registry: REGISTRIES[registryId],
				images: results,
				total: results.length,
			});
		} catch (err: any) {
			fastify.log.error({ err }, 'search images error');
			return reply.code(err.statusCode || 500).send({ error: err.message });
		}
	});

	// GET /api/v1/registries/:registryId/images/:imageName/details - Get image details
	fastify.get('/api/v1/registries/:registryId/images/:imageName/details', { preHandler: fastify.authenticate }, async (req, reply) => {
		try {
			const { registryId, imageName } = req.params as { registryId: string; imageName: string };

			if (!REGISTRIES[registryId]) {
				return reply.code(404).send({ error: 'Registry not found' });
			}

			const details = IMAGE_DETAILS_DB[imageName];
			if (!details) {
				return reply.code(404).send({ error: 'Image not found' });
			}

			return reply.send({
				registry: REGISTRIES[registryId],
				image: details,
			});
		} catch (err: any) {
			fastify.log.error({ err }, 'get image details error');
			return reply.code(err.statusCode || 500).send({ error: err.message });
		}
	});

	// GET /api/v1/registries/:registryId/images/:imageName/tags - Get image tags
	fastify.get('/api/v1/registries/:registryId/images/:imageName/tags', { preHandler: fastify.authenticate }, async (req, reply) => {
		try {
			const { registryId, imageName } = req.params as { registryId: string; imageName: string };

			if (!REGISTRIES[registryId]) {
				return reply.code(404).send({ error: 'Registry not found' });
			}

			const details = IMAGE_DETAILS_DB[imageName];
			if (!details) {
				return reply.code(404).send({ error: 'Image not found' });
			}

			return reply.send({
				image: imageName,
				tags: details.tags,
				total: details.tags.length,
			});
		} catch (err: any) {
			fastify.log.error({ err }, 'get image tags error');
			return reply.code(err.statusCode || 500).send({ error: err.message });
		}
	});

	// POST /api/v1/registries/:registryId/images/:imageName/tags/:tag/pull - Quick pull from registry
	fastify.post('/api/v1/registries/:registryId/images/:imageName/tags/:tag/pull', { preHandler: fastify.authenticate }, async (req, reply) => {
		try {
			const { registryId, imageName, tag } = req.params as { registryId: string; imageName: string; tag: string };
			const { description } = req.body as { description?: string };

			if (!REGISTRIES[registryId]) {
				return reply.code(404).send({ error: 'Registry not found' });
			}

			// Build full image path
			const repository = registryId === 'docker.io'
				? `library/${imageName}`
				: `${registryId}/${imageName}`;

			// Return instruction for SSE
			return reply.send({
				message: 'Pull initiated',
				repository,
				tag,
				sseEndpoint: '/api/v1/images/pull',
				description: description || `Pulled from ${REGISTRIES[registryId].name}`,
			});
		} catch (err: any) {
			fastify.log.error({ err }, 'quick pull error');
			return reply.code(err.statusCode || 500).send({ error: err.message });
		}
	});
};

export default fp(registriesHandler, { name: 'registries-handler' });
