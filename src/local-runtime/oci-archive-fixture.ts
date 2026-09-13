/**
 * Test-only helper: builds a minimal, valid OCI image-archive tar (the shape
 * `oci-archive.ts` verifies and `docker load` accepts) entirely in memory, so
 * `artifact-store.test.ts` / `runtime-service.test.ts` never depend on a real
 * `docker save` output or a live Docker engine to exercise the verifier.
 */
import { createHash } from 'node:crypto';

const BLOCK = 512;

function sha256(buf: Buffer): string {
	return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

function ustarHeader(name: string, size: number): Buffer {
	const header = Buffer.alloc(BLOCK);
	header.write(name, 0, 'utf8');
	header.write('0000644\0', 100, 'ascii'); // mode
	header.write('0000000\0', 108, 'ascii'); // uid
	header.write('0000000\0', 116, 'ascii'); // gid
	header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii'); // size (octal)
	header.write('00000000000\0', 136, 'ascii'); // mtime
	header.write('        ', 148, 'ascii'); // chksum placeholder (spaces while computing)
	header.write('0', 156, 'ascii'); // typeflag: regular file
	header.write('ustar\0', 257, 'ascii');
	header.write('00', 263, 'ascii');
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
	return header;
}

function padToBlock(buf: Buffer): Buffer {
	const remainder = buf.length % BLOCK;
	if (remainder === 0) return buf;
	return Buffer.concat([buf, Buffer.alloc(BLOCK - remainder)]);
}

function tarEntry(name: string, content: Buffer): Buffer {
	return Buffer.concat([ustarHeader(name, content.length), padToBlock(content)]);
}

export interface OciFixture {
	tar: Buffer;
	digest: string;
	manifestDigest: string;
	manifestSizeBytes: number;
	configDigest: string;
}

/** Builds a single-layer OCI archive; `configEnv` lets tests vary the image config to change `configDigest`/`manifestDigest` (and therefore `artifactDigest`) deterministically. */
export interface OciFixtureOptions {
	/** Emit the descriptor annotations (and index `platform`) buildkit/containerd always write — the shape every real pipeline artifact has. */
	annotations?: boolean;
	/** The image config's `User`. */
	user?: string;
}

export function buildOciArchiveFixture(configEnv: string[] = [], options: OciFixtureOptions = {}): OciFixture {
	const layerContent = Buffer.from('hello-from-fixture-layer\n');
	const layerDigest = sha256(layerContent);

	const config = {
		architecture: 'amd64',
		os: 'linux',
		config: { Env: configEnv, ...(options.user ? { User: options.user } : {}) },
		rootfs: { type: 'layers', diff_ids: [layerDigest] },
	};
	const configBytes = Buffer.from(JSON.stringify(config));
	const configDigest = sha256(configBytes);

	const manifest = {
		schemaVersion: 2,
		mediaType: 'application/vnd.oci.image.manifest.v1+json',
		config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: configBytes.length },
		layers: [
			{
				mediaType: 'application/vnd.oci.image.layer.v1.tar',
				digest: layerDigest,
				size: layerContent.length,
				...(options.annotations ? { annotations: { 'buildkit/rewritten-timestamp': '0' } } : {}),
			},
		],
	};
	const manifestBytes = Buffer.from(JSON.stringify(manifest));
	const manifestDigest = sha256(manifestBytes);

	const index = {
		schemaVersion: 2,
		manifests: [
			{
				mediaType: 'application/vnd.oci.image.manifest.v1+json',
				digest: manifestDigest,
				size: manifestBytes.length,
				...(options.annotations
					? {
							annotations: { 'io.containerd.image.name': 'docker.io/library/privos-build-job:fixture', 'org.opencontainers.image.ref.name': 'fixture' },
							platform: { architecture: 'amd64', os: 'linux' },
						}
					: {}),
			},
		],
	};
	const indexBytes = Buffer.from(JSON.stringify(index));
	const layoutBytes = Buffer.from(JSON.stringify({ imageLayoutVersion: '1.0.0' }));

	const entries = [
		tarEntry('oci-layout', layoutBytes),
		tarEntry('index.json', indexBytes),
		tarEntry(`blobs/sha256/${manifestDigest.slice(7)}`, manifestBytes),
		tarEntry(`blobs/sha256/${configDigest.slice(7)}`, configBytes),
		tarEntry(`blobs/sha256/${layerDigest.slice(7)}`, layerContent),
	];
	const tar = Buffer.concat([...entries, Buffer.alloc(BLOCK * 2)]);
	return { tar, digest: sha256(tar), manifestDigest, manifestSizeBytes: manifestBytes.length, configDigest };
}
