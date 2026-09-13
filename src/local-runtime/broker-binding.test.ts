import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { writeStateFile, CLUSTER_ID_FILENAME } from '../state-dir.js';
import { LOCAL_RUNTIME_BROKER_LABELS, buildLocalRuntimeBinding, type LocalRuntimeBrokerContext } from './broker-binding.js';
import type { ActivateRequest, EnsureReadyRequest } from './abi-schema.js';

const tmpDirs: string[] = [];
function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-binding-test-'));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function context(stateDir: string): LocalRuntimeBrokerContext {
	return {
		stateDir,
		fallbackClusterId: 'privos-app-cluster',
		nodeId: 'local-node',
		hubOrigin: 'https://hub.example.com',
		networkName: 'privos-local-runtime',
	};
}

function ensureReadyRequest(): EnsureReadyRequest {
	return {
		protocol_version: 3,
		operation: 'ENSURE_READY',
		installation_id: 'installation-1',
		workspace_id: 'workspace-1',
		deployment_id: 'deployment-1',
		listing_id: 'listing-1',
		version_id: 'version-1',
		generation_id: 'generation-1',
		generation_number: 1,
		descriptor_artifact_hash: 'A'.repeat(43),
		resource_manifest_hash: 'B'.repeat(43),
		permission_contract_hash: 'C'.repeat(43),
		runtime_authorization: {
			security_mode: 'runtime-v3',
			hub_kid: 'hub-kid-1',
			hub_public_jwk: { kty: 'EC', crv: 'P-256', x: 'x-coord', y: 'y-coord' },
			mcp_app_id: 'mcp-app-1',
			manifest_digest: `sha256:${'a'.repeat(64)}`,
			allow_unsigned_preactivation_readiness: true,
		},
		artifact: { path: '/var/lib/privos/marketplace/apps/local-1.privos-app', digest: `sha256:${'d'.repeat(64)}`, size_bytes: 4096 },
		runtime_spec: {
			driver_abi: 'privos-local-runtime-driver-v1',
			artifact_format: 'oci-image-archive-v1',
			port: 3001,
			resources: { memory_mb: 512, cpus: 0.5, tmp_size_mb: 64 },
		},
	};
}

function activateRequest(request: EnsureReadyRequest): ActivateRequest {
	return {
		...request,
		operation: 'ACTIVATE',
		runtime_id: 'local-runtime-aaaa',
		artifact_digest: request.artifact.digest,
		ensure_ready_request_hash: 'ensure-ready-hash',
		runtime_resource_inventory_hash: 'I'.repeat(43),
		runtime_approval_receipt_hash: 'R'.repeat(43),
		runtime_authorization_epoch: 7,
	};
}

test('provisioning binding has no runtimeResourceInventoryHash and reads the paired cluster id', () => {
	const stateDir = tmpDir();
	writeStateFile(stateDir, CLUSTER_ID_FILENAME, 'hub-assigned-cluster-id');
	const request = ensureReadyRequest();
	const binding = buildLocalRuntimeBinding(context(stateDir), request, `sha256:${'e'.repeat(64)}`, 'local-runtime-aaaa', 'replica-provisional', 'docker-1', null);

	assert.equal(binding.clusterId, 'hub-assigned-cluster-id');
	assert.equal(binding.replicaId, 'replica-provisional');
	assert.equal(binding.runtimeResourceInventoryHash, undefined);
	assert.equal(binding.mcpAppId, 'mcp-app-1');
	assert.equal(binding.manifestDigest, request.runtime_authorization.manifest_digest);
	assert.equal(binding.deploymentGrantHash, request.descriptor_artifact_hash);
	assert.equal(binding.hubOrigin, 'https://hub.example.com');
});

test('before pairing, the binding falls back to the configured cluster id', () => {
	const stateDir = tmpDir(); // never paired — no cluster-id file
	const binding = buildLocalRuntimeBinding(context(stateDir), ensureReadyRequest(), `sha256:${'e'.repeat(64)}`, 'local-runtime-aaaa', 'replica-provisional', 'docker-1', null);
	assert.equal(binding.clusterId, 'privos-app-cluster');
});

test('finalized binding carries the real ACTIVATE approval/epoch/inventory values', () => {
	const stateDir = tmpDir();
	const request = ensureReadyRequest();
	const activation = activateRequest(request);
	const binding = buildLocalRuntimeBinding(context(stateDir), request, `sha256:${'e'.repeat(64)}`, activation.runtime_id, 'replica-final', 'docker-2', activation);

	assert.equal(binding.runtimeResourceInventoryHash, activation.runtime_resource_inventory_hash);
	assert.equal(binding.approvalReceiptHash, activation.runtime_approval_receipt_hash);
	assert.equal(binding.authorizationEpoch, activation.runtime_authorization_epoch);
});

test('the provisioning placeholder never leaks into the finalized binding', () => {
	const stateDir = tmpDir();
	const request = ensureReadyRequest();
	const activation = activateRequest(request);
	const provisioning = buildLocalRuntimeBinding(context(stateDir), request, `sha256:${'e'.repeat(64)}`, 'local-runtime-aaaa', 'replica-provisional', 'docker-1', null);
	const finalized = buildLocalRuntimeBinding(context(stateDir), request, `sha256:${'e'.repeat(64)}`, activation.runtime_id, 'replica-final', 'docker-2', activation);

	assert.notEqual(provisioning.approvalReceiptHash, finalized.approvalReceiptHash);
	assert.notEqual(provisioning.authorizationEpoch, finalized.authorizationEpoch);
});

test('LOCAL_RUNTIME_BROKER_LABELS carries every field the broker checks a container label against', () => {
	const stateDir = tmpDir();
	const request = ensureReadyRequest();
	const activation = activateRequest(request);
	const binding = buildLocalRuntimeBinding(context(stateDir), request, `sha256:${'e'.repeat(64)}`, activation.runtime_id, 'replica-final', 'docker-2', activation);
	const labels = LOCAL_RUNTIME_BROKER_LABELS(binding);

	assert.equal(labels['privos.mcp.schema'], '3');
	assert.equal(labels['privos.id'], binding.containerId);
	assert.equal(labels['privos.mcp.replica'], binding.replicaId);
	assert.equal(labels['privos.mcp.approval-receipt'], binding.approvalReceiptHash);
	assert.equal(labels['privos.mcp.authorization-epoch'], String(binding.authorizationEpoch));
	assert.equal(labels['privos.mcp.hub-kid'], binding.hubKid);
});
