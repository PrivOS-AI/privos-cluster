/**
 * Minimal, streaming, offset-seeking OCI image-archive (`docker save`-shaped
 * tar) verifier. Partial TS port of
 * `infra/local-runtime-driver/privos_local_runtime_driver/artifact.py`'s
 * `OciArchiveVerifier._verify_oci_layout` — same outer-structure contract
 * (exactly one `oci-layout`+`index.json`, exactly one manifest, exact
 * digest/size match for every blob, exact "declared files == actual files"
 * set), same fail-closed member-name/size/count bounds.
 *
 * ponytail: this port skips `artifact.py`'s `_verify_layer` pass — the
 * decompressed-layer-internal tar-bomb/whiteout/symlink-escape hardening
 * that inspects every layer's OWN uncompressed contents. Every blob
 * (manifest, config, and every layer) is still digest/size-verified exactly
 * as `_verify_blob` does; what's skipped is re-parsing each layer's
 * decompressed tar structure before handing the outer archive to `docker
 * load`, which unpacks and validates layers itself as part of its own image
 * import. Upgrade path: port `_verify_layer` if a future artifact source is
 * less trusted than a Hub-staged, digest-pinned, ES256-signed marketplace
 * artifact.
 *
 * The outer archive must be a plain (uncompressed) USTAR tar — the same
 * requirement `artifact.py` enforces via `tarfile.open(path, mode="r:")`
 * (compressed-outer-archive is refused, matching the OCI image-archive
 * convention that only inner layer blobs may be gzip).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { ArtifactError } from './errors.js';

const BLOCK = 512;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 10_000;
const MAX_LAYER_DESCRIPTORS = 128;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

const OCI_LAYOUT_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const OCI_CONFIG_MEDIA_TYPE = 'application/vnd.oci.image.config.v1+json';
/** Every field the OCI image-spec allows on a descriptor. Real exporters (buildkit, containerd) always add `annotations`. */
const OCI_DESCRIPTOR_KEYS = new Set(['mediaType', 'digest', 'size', 'platform', 'annotations', 'urls', 'data', 'artifactType']);
const OCI_LAYER_MEDIA_TYPES = new Set([
	'application/vnd.oci.image.layer.v1.tar',
	'application/vnd.oci.image.layer.nondistributable.v1.tar',
	'application/vnd.oci.image.layer.v1.tar+gzip',
	'application/vnd.oci.image.layer.nondistributable.v1.tar+gzip',
]);

interface TarMember {
	name: string;
	size: number;
	isFile: boolean;
	isDir: boolean;
	dataOffset: number;
}

interface Descriptor {
	mediaType: string;
	digest: string;
	size: number;
}

export interface VerifiedOciArchive {
	artifactDigest: string;
	sizeBytes: number;
	manifestDigest: string;
	manifestSizeBytes: number;
	configDigest: string;
	/** Layer blob digests in manifest order — what a docker-archive `manifest.json` has to name. */
	layerDigests: string[];
	/** Byte offset of the tar end-of-archive marker: everything before it is member data, verbatim. */
	archiveDataEnd: number;
	/** The image config's `User`, when it declares one — the identity the image was built to run as. */
	imageUser: string | undefined;
}

function parseOctalField(buf: Buffer): number {
	// Handles both classic NUL/space-terminated octal and GNU base-256 (high
	// bit set in the first byte) — docker save's outer archive is plain
	// USTAR, but tolerate base-256 sizes defensively rather than misreading them.
	if ((buf[0]! & 0x80) !== 0) {
		let value = BigInt(buf[0]! & 0x7f);
		for (let i = 1; i < buf.length; i++) value = (value << 8n) | BigInt(buf[i]!);
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ArtifactError('oversized tar header field');
		return Number(value);
	}
	const str = buf.toString('ascii').replace(/\0.*$/, '').trim();
	if (str === '') return 0;
	if (!/^[0-7]*$/.test(str)) throw new ArtifactError('invalid tar header field');
	const value = parseInt(str, 8);
	if (!Number.isFinite(value) || value < 0) throw new ArtifactError('invalid tar header field');
	return value;
}

function fieldString(buf: Buffer): string {
	const zeroIndex = buf.indexOf(0);
	return (zeroIndex === -1 ? buf : buf.subarray(0, zeroIndex)).toString('utf8');
}

/** Reads the full member catalog of a plain USTAR tar via positioned reads — never buffers member data. */
export function catalogTarMembers(fd: number, fileSize: number, maxBytes: number): { members: TarMember[]; dataEnd: number } {
	const members: TarMember[] = [];
	let offset = 0;
	let sawEnd = false;
	const header = Buffer.alloc(BLOCK);
	while (offset < fileSize) {
		const read = fs.readSync(fd, header, 0, BLOCK, offset);
		if (read === 0) break;
		if (read !== BLOCK) throw new ArtifactError('truncated tar header block');
		offset += BLOCK;
		if (header.every((b) => b === 0)) {
			sawEnd = true;
			break;
		}
		const magic = header.subarray(257, 263).toString('ascii');
		if (!magic.startsWith('ustar')) throw new ArtifactError('unsupported tar format (not USTAR)');
		const typeflag = String.fromCharCode(header[156]!);
		if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K') {
			throw new ArtifactError('PAX/GNU long-name tar extensions are not supported for OCI archives');
		}
		const prefix = fieldString(header.subarray(345, 500));
		const rawName = fieldString(header.subarray(0, 100));
		const name = prefix ? `${prefix}/${rawName}` : rawName;
		const size = parseOctalField(header.subarray(124, 136));
		if (
			!name ||
			name.includes('\0') ||
			name.startsWith('/') ||
			name.includes('..') ||
			name.length > 1024 ||
			size < 0
		) {
			throw new ArtifactError('invalid tar member name or size');
		}
		if (members.length >= MAX_ARCHIVE_MEMBERS) throw new ArtifactError('tar archive has too many members');
		const isDir = typeflag === '5' || name.endsWith('/');
		const isFile = typeflag === '0' || typeflag === '\0' || typeflag === '';
		if (!isDir && !isFile) throw new ArtifactError('OCI archive members must be plain files or directories');
		if (isFile && size > maxBytes) throw new ArtifactError('tar member exceeds the artifact size ceiling');
		members.push({ name: name.replace(/\/+$/, '') || name, size, isFile, isDir, dataOffset: offset });
		const dataBlocks = Math.ceil(size / BLOCK);
		offset += dataBlocks * BLOCK;
	}
	if (!sawEnd) throw new ArtifactError('tar archive is missing its end-of-archive marker');
	// The loop advanced past the zero block it stopped on; the marker starts one block back.
	return { members, dataEnd: offset - BLOCK };
}

/** Reads a bounded member's full content into memory (only used for the small JSON metadata blobs — oci-layout, index.json, manifest, config). */
function readMemberBytes(fd: number, member: TarMember, limit: number): Buffer {
	if (member.size > limit) throw new ArtifactError('metadata member exceeds the safety limit');
	const buf = Buffer.alloc(member.size);
	if (member.size > 0) {
		const read = fs.readSync(fd, buf, 0, member.size, member.dataOffset);
		if (read !== member.size) throw new ArtifactError('truncated tar member data');
	}
	return buf;
}

function sha256Hex(buf: Buffer): string {
	return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

/** Streams a member's raw bytes through sha256 without buffering the whole blob — used for layer/manifest/config digest proof. */
async function verifyMemberDigest(filePath: string, member: TarMember, descriptor: Descriptor): Promise<void> {
	if (member.size !== descriptor.size) throw new ArtifactError('blob size does not match its OCI descriptor');
	const hash = createHash('sha256');
	await new Promise<void>((resolve, reject) => {
		if (member.size === 0) {
			resolve();
			return;
		}
		const stream = fs.createReadStream(filePath, { start: member.dataOffset, end: member.dataOffset + member.size - 1 });
		stream.on('data', (chunk) => hash.update(chunk as Buffer));
		stream.on('end', resolve);
		stream.on('error', reject);
	});
	const digest = `sha256:${hash.digest('hex')}`;
	if (digest !== descriptor.digest) throw new ArtifactError('blob digest does not match its OCI descriptor');
}

function blobMemberName(digest: string): string {
	return `blobs/sha256/${digest.slice('sha256:'.length)}`;
}

function parseStrictJson(buf: Buffer): unknown {
	try {
		return JSON.parse(buf.toString('utf8'));
	} catch {
		throw new ArtifactError('malformed JSON metadata in OCI archive');
	}
}

function assertDescriptor(value: unknown, allowedMediaTypes: Set<string>): Descriptor {
	if (typeof value !== 'object' || value === null) throw new ArtifactError('invalid OCI descriptor');
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (!keys.every((k) => OCI_DESCRIPTOR_KEYS.has(k))) {
		throw new ArtifactError('invalid OCI descriptor');
	}
	if (typeof record.mediaType !== 'string' || !allowedMediaTypes.has(record.mediaType)) {
		throw new ArtifactError('invalid OCI descriptor media type');
	}
	if (typeof record.digest !== 'string' || !SHA256_RE.test(record.digest)) {
		throw new ArtifactError('invalid OCI descriptor digest');
	}
	if (typeof record.size !== 'number' || !Number.isInteger(record.size) || record.size < 0) {
		throw new ArtifactError('invalid OCI descriptor size');
	}
	return { mediaType: record.mediaType, digest: record.digest, size: record.size };
}

/**
 * Verifies `path` is a well-formed, digest-consistent OCI image archive
 * whose whole-file sha256/size equal `expectedDigest`/`expectedSizeBytes`.
 * Returns the manifest and config content addresses `docker load` must be
 * pinned against. Throws `ArtifactError` on any structural or digest
 * mismatch — never partially trusts the archive.
 */
export async function verifyOciArchive(
	filePath: string,
	expectedDigest: string,
	expectedSizeBytes: number,
	maxArtifactBytes: number,
): Promise<VerifiedOciArchive> {
	const stat = fs.statSync(filePath);
	if (!stat.isFile() || stat.size !== expectedSizeBytes || stat.size > maxArtifactBytes) {
		throw new ArtifactError('staged artifact size does not match the declared size');
	}
	const wholeFileDigest = await new Promise<string>((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = fs.createReadStream(filePath);
		stream.on('data', (chunk) => hash.update(chunk as Buffer));
		stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`));
		stream.on('error', reject);
	});
	if (wholeFileDigest !== expectedDigest) throw new ArtifactError('staged artifact digest does not match the declared digest');

	const fd = fs.openSync(filePath, 'r');
	let members: TarMember[];
	try {
		let dataEnd: number;
		({ members, dataEnd } = catalogTarMembers(fd, stat.size, maxArtifactBytes));
		const byName = new Map<string, TarMember>();
		for (const member of members) {
			if (byName.has(member.name)) throw new ArtifactError('duplicate tar member name');
			byName.set(member.name, member);
		}

		const layoutMember = byName.get('oci-layout');
		const indexMember = byName.get('index.json');
		if (!layoutMember?.isFile || !indexMember?.isFile) throw new ArtifactError('OCI archive is missing oci-layout or index.json');
		const layout = parseStrictJson(readMemberBytes(fd, layoutMember, MAX_METADATA_BYTES));
		if (typeof layout !== 'object' || layout === null || JSON.stringify(layout) !== JSON.stringify({ imageLayoutVersion: '1.0.0' })) {
			throw new ArtifactError('invalid oci-layout contents');
		}
		const index = parseStrictJson(readMemberBytes(fd, indexMember, MAX_METADATA_BYTES)) as Record<string, unknown>;
		if (
			typeof index !== 'object' ||
			index === null ||
			!('schemaVersion' in index) ||
			!('manifests' in index) ||
			!Object.keys(index).every((k) => k === 'schemaVersion' || k === 'mediaType' || k === 'manifests')
		) {
			throw new ArtifactError('invalid index.json shape');
		}
		if (index.schemaVersion !== 2 || !Array.isArray(index.manifests) || index.manifests.length !== 1) {
			throw new ArtifactError('invalid index.json manifests list');
		}
		if (index.mediaType !== undefined && index.mediaType !== OCI_LAYOUT_MEDIA_TYPE) {
			throw new ArtifactError('invalid index.json mediaType');
		}
		const manifestDescriptor = assertDescriptor(index.manifests[0], new Set([OCI_MANIFEST_MEDIA_TYPE]));
		const manifestMember = byName.get(blobMemberName(manifestDescriptor.digest));
		if (!manifestMember?.isFile) throw new ArtifactError('index.json references a missing manifest blob');
		await verifyMemberDigest(filePath, manifestMember, manifestDescriptor);
		const manifest = parseStrictJson(readMemberBytes(fd, manifestMember, MAX_METADATA_BYTES)) as Record<string, unknown>;
		const manifestKeys = new Set(Object.keys(manifest));
		if (
			!manifestKeys.has('schemaVersion') ||
			!manifestKeys.has('config') ||
			!manifestKeys.has('layers') ||
			![...manifestKeys].every((k) => ['schemaVersion', 'mediaType', 'config', 'layers'].includes(k))
		) {
			throw new ArtifactError('invalid OCI manifest shape');
		}
		if (manifest.schemaVersion !== 2 || (manifest.mediaType !== undefined && manifest.mediaType !== OCI_MANIFEST_MEDIA_TYPE)) {
			throw new ArtifactError('invalid OCI manifest mediaType/schemaVersion');
		}
		if (!Array.isArray(manifest.layers) || manifest.layers.length > MAX_LAYER_DESCRIPTORS) {
			throw new ArtifactError('invalid OCI manifest layers list');
		}
		const configDescriptor = assertDescriptor(manifest.config, new Set([OCI_CONFIG_MEDIA_TYPE]));
		const layerDescriptors = manifest.layers.map((layer) => assertDescriptor(layer, OCI_LAYER_MEDIA_TYPES));
		if (new Set(layerDescriptors.map((l) => l.digest)).size !== layerDescriptors.length) {
			throw new ArtifactError('duplicate layer digest in OCI manifest');
		}

		const configMember = byName.get(blobMemberName(configDescriptor.digest));
		if (!configMember?.isFile) throw new ArtifactError('manifest references a missing config blob');
		await verifyMemberDigest(filePath, configMember, configDescriptor);
		const imageConfig = parseStrictJson(readMemberBytes(fd, configMember, MAX_METADATA_BYTES)) as { config?: { User?: unknown } };
		const declaredUser = imageConfig?.config?.User;
		const imageUser = typeof declaredUser === 'string' && declaredUser.trim() !== '' ? declaredUser.trim() : undefined;

		for (const layer of layerDescriptors) {
			const layerMember = byName.get(blobMemberName(layer.digest));
			if (!layerMember?.isFile) throw new ArtifactError('manifest references a missing layer blob');
			await verifyMemberDigest(filePath, layerMember, layer);
		}

		const expectedFiles = new Set([
			'oci-layout',
			'index.json',
			blobMemberName(manifestDescriptor.digest),
			blobMemberName(configDescriptor.digest),
			...layerDescriptors.map((l) => blobMemberName(l.digest)),
		]);
		const actualFiles = new Set([...byName.values()].filter((m) => m.isFile).map((m) => m.name));
		if (actualFiles.size !== expectedFiles.size || [...expectedFiles].some((f) => !actualFiles.has(f))) {
			throw new ArtifactError('OCI archive contains unexpected files');
		}

		return {
			artifactDigest: wholeFileDigest,
			sizeBytes: stat.size,
			manifestDigest: manifestDescriptor.digest,
			manifestSizeBytes: manifestDescriptor.size,
			configDigest: configDescriptor.digest,
			layerDigests: layerDescriptors.map((l) => l.digest),
			archiveDataEnd: dataEnd,
			imageUser,
		};
	} finally {
		fs.closeSync(fd);
	}
}

/** Minimal USTAR header for one regular file member. */
export function ustarFileHeader(name: string, size: number): Buffer {
	const header = Buffer.alloc(BLOCK);
	header.write(name, 0, 'utf8');
	header.write('0000644\0', 100, 'ascii');
	header.write('0000000\0', 108, 'ascii');
	header.write('0000000\0', 116, 'ascii');
	header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
	header.write('00000000000\0', 136, 'ascii');
	header.write('        ', 148, 'ascii');
	header.write('0', 156, 'ascii');
	header.write('ustar\0', 257, 'ascii');
	header.write('00', 263, 'ascii');
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
	return header;
}

/**
 * The bytes that turn a verified OCI layout into something Docker's classic
 * (graphdriver) image store can load: a docker-archive `manifest.json` naming
 * the SAME config and layer blobs at their existing paths, then the tar
 * end-of-archive marker. Appended after `archiveDataEnd`, so every verified
 * member stays byte-identical and the loaded image ID is the config digest.
 *
 * Only the containerd image store understands an OCI layout on `docker load`;
 * a stock Docker install does not, and a customer's machine is a stock install.
 */
export function dockerArchiveTrailer(verified: Pick<VerifiedOciArchive, 'configDigest' | 'layerDigests'>): Buffer {
	const manifest = Buffer.from(
		JSON.stringify([
			{
				Config: blobMemberName(verified.configDigest),
				RepoTags: [],
				Layers: verified.layerDigests.map(blobMemberName),
			},
		]),
	);
	const padding = Buffer.alloc((BLOCK - (manifest.length % BLOCK)) % BLOCK);
	return Buffer.concat([ustarFileHeader('manifest.json', manifest.length), manifest, padding, Buffer.alloc(2 * BLOCK)]);
}
