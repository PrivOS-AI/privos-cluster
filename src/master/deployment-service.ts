import crypto from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { z } from 'zod';
import type { MasterRepositories } from './repositories.js';
import type { AvailabilityTier, AppReplica, MasterApp, MasterNode, RuntimeResourceInventory } from './types.js';
import { AgentClient } from './agent-client.js';
import { IngressRouteProgrammer } from './ingress-route-programmer.js';
import { QuotaService } from './quota-service.js';
import { selectNodes, type NodeReservation, SchedulingError } from './scheduler.js';
import { SubdomainRegistry } from './subdomain-registry.js';
import { WorkspaceLock } from './workspace-lock.js';
import { KeyCipher } from './key-crypto.js';
import type { McpDeploymentGrantPayload } from './mcp-security.js';
import { canonicalJson, jwkThumbprint, sha256Base64Url } from '../security/artifacts.js';
import {
	McpProtocolV3Error,
	RuntimeResourceDescriptorV3Schema,
	type ClusterReconfigureCommandPayloadV3,
	type McpDeploymentGrantPayloadV3,
	type RuntimeResourceDescriptorV3,
} from './protocol-v3.js';
import {
	buildCapturingRuntimeResourceInventoryV3,
	finalizeRuntimeResourceInventoryV3,
	normalizeRuntimeResourcesV3,
} from './runtime-resource-inventory.js';

const DeploySchema = z.object({
	appId: z.string().min(1).max(128).optional(),
	listingId: z.string().min(1).max(128),
	versionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	image: z.string().min(1),
	digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	tag: z.string().default('latest'),
	port: z.number().int().min(1).max(65535).default(3001),
	resources: z.object({
		memoryMb: z.number().int().min(64).max(16384),
		cpus: z.number().min(0.1).max(16),
		tmpSizeMb: z.number().int().min(16).max(4096).default(64),
	}),
	envVars: z.record(z.string(), z.string()).default({}),
	volumes: z.array(z.object({
		name: z.literal('data'),
		mountPath: z.string().startsWith('/'),
		sizeMb: z.number().int().positive().optional(),
	})).max(1).default([]),
	availabilityTier: z.enum(['single', 'ha']).default('single'),
	stateless: z.boolean().default(false),
});

export class DeploymentService {
	constructor(private readonly deps: {
		repositories: MasterRepositories;
		agentClient: AgentClient;
		ingress: IngressRouteProgrammer;
		quota: QuotaService;
		subdomains: SubdomainRegistry;
		locks: WorkspaceLock;
		baseDomain: string;
		cipher: KeyCipher;
	}) {}

	async deploy(workspaceId: string, raw: unknown): Promise<MasterApp> {
		const input = DeploySchema.parse(raw);
		return this.deps.locks.run(workspaceId, async () => {
			if (input.appId) {
				const existing = await this.deps.repositories.apps.findOne({
					workspaceId,
					$or: [{ appId: input.appId }, { listingId: input.listingId }],
					state: { $ne: 'REMOVED' },
				});
				if (existing) return existing;
			}
			if (input.availabilityTier === 'ha' && !input.stateless) {
				const error: Error & { code?: string } = new Error('stateful apps cannot run in HA');
				error.code = 'HA_REQUIRES_STATELESS_APP';
				throw error;
			}
			const replicaCount = input.availabilityTier === 'ha' ? 2 : 1;
			await this.deps.quota.assertDeployAllowed(workspaceId, input.resources, replicaCount);
			const [nodes, existingApps] = await Promise.all([
				this.deps.repositories.nodes.find({ status: 'ACTIVE' }).toArray(),
				this.deps.repositories.apps.find({ state: 'RUNNING' }).toArray(),
			]);
			const reservations: NodeReservation[] = existingApps.flatMap((app) =>
				app.replicas.map((replica) => ({
					nodeId: replica.nodeId,
					memoryMb: app.resources.memoryMb,
					cpus: app.resources.cpus,
					diskBytes: (app as MasterApp & { storageBytes?: number }).storageBytes ?? 0,
				})),
			);
			const storageBytes = (input.volumes[0]?.sizeMb ?? 0) * 1024 * 1024;
			const selected = selectNodes({
				nodes,
				reservations,
				resources: input.resources,
				storageBytes,
				replicas: replicaCount,
			});
			return this.deployToNodes(workspaceId, input, selected);
		});
	}

	async deployMcp(
		workspaceId: string,
		grant: McpDeploymentGrantPayload,
		deploymentGrantHash: string,
		hubIdentity: { kid: string; publicJwk: JsonWebKey },
	): Promise<MasterApp> {
		const input = DeploySchema.parse({
			appId: grant.deployment.appId,
			listingId: grant.deployment.listingId,
			versionDigest: grant.deployment.versionDigest,
			image: grant.deployment.image,
			digest: grant.deployment.imageDigest,
			tag: 'latest',
			port: grant.deployment.port,
			resources: grant.deployment.resources,
			envVars: grant.deployment.envVars,
			volumes: grant.deployment.volumes,
			availabilityTier: grant.deployment.availabilityTier,
			stateless: grant.deployment.stateless,
		});
		return this.deps.locks.run(workspaceId, async () => {
			const existing = await this.deps.repositories.apps.findOne({
				workspaceId,
				mcpInstallationId: grant.installationId,
				state: { $ne: 'REMOVED' },
			});
			if (existing) {
				if (
					existing.imageDigest !== grant.deployment.imageDigest ||
					existing.manifestDigest !== grant.deployment.manifestDigest ||
					existing.receiptHash !== grant.receiptHash ||
					existing.grantEpoch !== grant.grantEpoch
				) {
					throw new Error('existing_mcp_installation_binding_mismatch');
				}
				return existing;
			}
			if (input.availabilityTier === 'ha' && !input.stateless) throw Object.assign(new Error('stateful apps cannot run in HA'), { code: 'HA_REQUIRES_STATELESS_APP' });
			const replicaCount = input.availabilityTier === 'ha' ? 2 : 1;
			await this.deps.quota.assertDeployAllowed(workspaceId, input.resources, replicaCount);
			const [nodes, existingApps] = await Promise.all([
				this.deps.repositories.nodes.find({ status: 'ACTIVE' }).toArray(),
				this.deps.repositories.apps.find({ state: 'RUNNING' }).toArray(),
			]);
			const reservations: NodeReservation[] = existingApps.flatMap((app) =>
				app.replicas.map((replica) => ({
					nodeId: replica.nodeId,
					memoryMb: app.resources.memoryMb,
					cpus: app.resources.cpus,
					diskBytes: app.storageBytes ?? 0,
				})),
			);
			const selected = selectNodes({
				nodes,
				reservations,
				resources: input.resources,
				storageBytes: (input.volumes[0]?.sizeMb ?? 0) * 1024 * 1024,
				replicas: replicaCount,
			});
			return this.deployMcpToNodes(workspaceId, input, grant, deploymentGrantHash, hubIdentity, selected);
		});
	}

	async deployMcpV3(
		workspaceId: string,
		grant: McpDeploymentGrantPayloadV3,
		deploymentGrantHash: string,
		hubIdentity: { kid: string; publicJwk: JsonWebKey },
	): Promise<{ app: MasterApp; inventory: RuntimeResourceInventory & { runtimeResourceInventoryHash: string } }> {
		const input = DeploySchema.parse({
			appId: grant.deployment.clusterAppId,
			listingId: grant.deployment.listingId,
			versionDigest: grant.deployment.versionDigest,
			image: grant.deployment.image,
			digest: grant.deployment.imageDigest,
			tag: 'latest',
			port: grant.deployment.port,
			resources: grant.deployment.resources,
			envVars: grant.deployment.envVars,
			volumes: grant.deployment.volumes,
			availabilityTier: grant.deployment.availabilityTier,
			stateless: grant.deployment.stateless,
		});
		if (grant.deployment.domain !== null && grant.deployment.domain !== this.deps.baseDomain) {
			throw new Error('mcp_v3_deployment_domain_mismatch');
		}
		if (
			grant.deployment.subdomain !== null &&
			!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(grant.deployment.subdomain)
		) throw new Error('mcp_v3_deployment_subdomain_invalid');
		return this.deps.locks.run(workspaceId, async () => {
			let app: MasterApp | null = await this.deps.repositories.apps.findOne({
				workspaceId,
				kind: 'mcp-v3',
				mcpDeploymentId: grant.deploymentId,
				state: { $ne: 'REMOVED' },
			});
			if (app) this.assertMcpV3AppAffinity(app, grant, deploymentGrantHash);
			if (!app) {
				if (input.availabilityTier === 'ha' && !input.stateless) {
					throw Object.assign(new Error('stateful apps cannot run in HA'), { code: 'HA_REQUIRES_STATELESS_APP' });
				}
				const replicaCount = input.availabilityTier === 'ha' ? 2 : 1;
				await this.deps.quota.assertDeployAllowed(workspaceId, input.resources, replicaCount);
				const [nodes, existingApps] = await Promise.all([
					this.deps.repositories.nodes.find({ status: 'ACTIVE' }).toArray(),
					this.deps.repositories.apps.find({ state: 'RUNNING' }).toArray(),
				]);
				const reservations: NodeReservation[] = existingApps.flatMap((candidate) =>
					candidate.replicas.map((replica) => ({
						nodeId: replica.nodeId,
						memoryMb: candidate.resources.memoryMb,
						cpus: candidate.resources.cpus,
						diskBytes: candidate.storageBytes ?? 0,
					})),
				);
				const storageBytes = (input.volumes[0]?.sizeMb ?? 0) * 1024 * 1024;
				const selected = selectNodes({
					nodes,
					reservations,
					resources: input.resources,
					storageBytes,
					replicas: replicaCount,
				});
				const now = new Date();
				const subdomain = grant.deployment.subdomain ?? await this.deps.subdomains.allocate(input.listingId);
				// Operator secrets never rest in the clear in the master DB: only
				// the non-secret half is queryable, the rest is sealed with the
				// same master key that protects node and identity material.
				const sealed = this.sealOperatorEnv(input.envVars, grant.deployment.secretEnvKeys ?? []);
				app = {
					appId: grant.deployment.clusterAppId,
					workspaceId,
					listingId: input.listingId,
					versionDigest: input.versionDigest,
					image: input.image,
					imageDigest: input.digest,
					resources: input.resources,
					port: input.port,
					envVars: sealed.envVars,
					...(sealed.secretEnvVarsEnc ? { secretEnvVarsEnc: sealed.secretEnvVarsEnc } : {}),
					volumes: input.volumes,
					storageBytes,
					availabilityTier: input.availabilityTier as AvailabilityTier,
					stateless: input.stateless,
					subdomain,
					uiUrl: `https://${subdomain}.${this.deps.baseDomain}`,
					secretEnvKeys: sealed.secretEnvKeys,
					appliedConfigEpoch: grant.configEpoch ?? 1,
					appliedConfigAt: now,
					replicas: [],
					state: 'PROVISIONING',
					kind: 'mcp-v3',
					protocolVersion: 3,
					mcpDeploymentId: grant.deploymentId,
					mcpActiveDeploymentKey: grant.deploymentId,
					mcpGenerationId: grant.generationId,
					mcpGenerationNumber: grant.generationNumber,
					mcpRuntimeInstallationId: grant.runtimeInstallationId,
					mcpDeploymentGrantJti: grant.jti,
					mcpDeploymentGrantHash: deploymentGrantHash,
					mcpAppId: grant.mcpAppId,
					manifestDigest: grant.deployment.manifestDigest,
					resourceManifestHash: grant.deployment.resourceManifestHash,
					mcpApprovalReceiptHash: grant.approvalReceiptHash,
					mcpApprovedPermissionCeilingHash: grant.approvedPermissionCeilingHash,
					mcpAuthorizationEpoch: grant.authorizationEpoch,
					mcpProvisioningNodeIds: selected.map((node) => node.nodeId),
					mcpProvisioningReplicas: selected.map((node) => ({
						nodeId: node.nodeId,
						replicaId: crypto.randomUUID(),
						containerId: crypto.randomUUID(),
					})),
					mcpRoomBindingCount: 0,
					createdAt: now,
					updatedAt: now,
				};
				try {
					await this.deps.repositories.apps.insertOne(app);
				} catch (error: unknown) {
					if ((error as { code?: number }).code !== 11000) throw error;
					const concurrent = await this.deps.repositories.apps.findOne({
						workspaceId,
						kind: 'mcp-v3',
						mcpDeploymentId: grant.deploymentId,
						state: { $ne: 'REMOVED' },
					});
					if (!concurrent) throw error;
					this.assertMcpV3AppAffinity(concurrent, grant, deploymentGrantHash);
					app = concurrent;
				}
			}
			if (!app) throw new Error('mcp_v3_app_persistence_failed');

			const inventoryId = `inventory-${sha256Base64Url([
				workspaceId,
				grant.deploymentId,
				grant.generationId,
				grant.runtimeInstallationId,
			].join('\0'))}`;
			let inventory = await this.deps.repositories.runtimeResourceInventories.findOne({ inventoryId });
			if (!inventory) {
				const capturing = buildCapturingRuntimeResourceInventoryV3({
					inventoryId,
					affinity: {
						clusterId: grant.clusterId,
						workspaceId,
						deploymentId: grant.deploymentId,
						generationId: grant.generationId,
						generationNumber: grant.generationNumber,
						runtimeInstallationId: grant.runtimeInstallationId,
						clusterAppId: grant.deployment.clusterAppId,
						manifestDigest: grant.deployment.manifestDigest,
						resourceManifestHash: grant.deployment.resourceManifestHash,
					},
					createdAt: new Date(),
				});
				try {
					await this.deps.repositories.runtimeResourceInventories.insertOne(capturing);
					inventory = capturing;
				} catch (error: unknown) {
					if ((error as { code?: number }).code !== 11000) throw error;
					inventory = await this.deps.repositories.runtimeResourceInventories.findOne({ inventoryId });
					if (!inventory) throw error;
				}
			}
			this.assertMcpV3InventoryAffinity(inventory, grant);

			const plans = app.mcpProvisioningReplicas ?? [];
			const nodes = await this.deps.repositories.nodes.find({
				nodeId: { $in: plans.map((plan) => plan.nodeId) },
			}).toArray();
			if (nodes.length !== plans.length) throw new Error('mcp_v3_provisioning_node_missing');
			for (const plan of plans) {
				const node = nodes.find((candidate) => candidate.nodeId === plan.nodeId)!;
				let replica = app.replicas.find((candidate) => candidate.replicaId === plan.replicaId);
				if (replica && (replica.nodeId !== plan.nodeId || replica.containerId !== plan.containerId)) {
					throw new Error('persisted_mcp_v3_replica_plan_mismatch');
				}
				if (!replica?.mcpV3Resources) {
					const response = await this.deps.agentClient.request(
						node,
						workspaceId,
						'POST',
						'/api/v1/mcp/v3/apps/deploy',
						{
							...input,
							appId: grant.deployment.clusterAppId,
							workspaceId,
							subdomain: app.subdomain,
							domain: this.deps.baseDomain,
							platformEnvVars: this.platformEnvVarsV3(app.subdomain),
							secretEnvKeys: app.secretEnvKeys ?? [],
							mcpV3Binding: {
								protocolVersion: 3,
								clusterId: grant.clusterId,
								nodeId: node.nodeId,
								workspaceId,
								deploymentId: grant.deploymentId,
								generationId: grant.generationId,
								generationNumber: grant.generationNumber,
								runtimeInstallationId: grant.runtimeInstallationId,
								mcpAppId: grant.mcpAppId,
								replicaId: plan.replicaId,
								containerId: plan.containerId,
								imageDigest: grant.deployment.imageDigest,
								manifestDigest: grant.deployment.manifestDigest,
								approvalReceiptHash: grant.approvalReceiptHash,
								authorizationEpoch: grant.authorizationEpoch,
								deploymentGrantHash,
								resourceManifestHash: grant.deployment.resourceManifestHash,
								hubOrigin: grant.hubOrigin,
								hubKid: hubIdentity.kid,
								hubPublicJwk: hubIdentity.publicJwk,
							},
						},
					);
					if (response.status >= 300) throw new Error(`agent MCP v3 deploy failed: ${JSON.stringify(response.body)}`);
					replica = this.parseMcpV3ReplicaResponse(response.body, plan, node, {
						clusterAppId: grant.deployment.clusterAppId,
						workspaceId,
						listingId: grant.deployment.listingId,
						versionDigest: grant.deployment.versionDigest,
						imageDigest: grant.deployment.imageDigest,
					});
					await this.deps.repositories.runtimeResourceInventories.updateOne(
						{ inventoryId, state: 'CAPTURING' },
						{
							$addToSet: { expectedResources: { $each: replica.mcpV3Resources! } },
							$set: { updatedAt: new Date() },
						},
					);
					await this.deps.repositories.apps.updateOne(
						{ appId: app.appId, workspaceId, 'replicas.replicaId': { $ne: replica.replicaId } },
						{ $push: { replicas: replica }, $set: { updatedAt: new Date() } },
					);
					app = (await this.deps.repositories.apps.findOne({ appId: app.appId, workspaceId })) ?? app;
				} else if (inventory.state === 'CAPTURING') {
					await this.deps.repositories.runtimeResourceInventories.updateOne(
						{ inventoryId, state: 'CAPTURING' },
						{ $addToSet: { expectedResources: { $each: replica.mcpV3Resources } }, $set: { updatedAt: new Date() } },
					);
				}
			}

			app = (await this.deps.repositories.apps.findOne({ appId: app.appId, workspaceId })) ?? app;
			const ingressResource: RuntimeResourceDescriptorV3 = {
				kind: 'INGRESS',
				resourceId: `route-${sha256Base64Url(`${app.subdomain}.${this.deps.baseDomain}`)}`,
				ownershipScope: 'INSTALLATION_GENERATION',
				nodeId: null,
				replicaId: null,
				attributes: { host: `${app.subdomain}.${this.deps.baseDomain}` },
			};

			if (inventory.state === 'CAPTURING') {
				await this.deps.repositories.runtimeResourceInventories.updateOne(
					{ inventoryId, state: 'CAPTURING' },
					{ $addToSet: { expectedResources: ingressResource }, $set: { updatedAt: new Date() } },
				);
				inventory = (await this.deps.repositories.runtimeResourceInventories.findOne({ inventoryId }))!;
				const finalized = finalizeRuntimeResourceInventoryV3(
					inventory,
					normalizeRuntimeResourcesV3(inventory.expectedResources),
					new Date(),
				);
				const finalizedWrite = await this.deps.repositories.runtimeResourceInventories.updateOne(
					{ inventoryId, state: 'CAPTURING' },
					{
						$set: {
							expectedResources: finalized.expectedResources,
							runtimeResourceInventoryHash: finalized.runtimeResourceInventoryHash,
							state: 'READY',
							updatedAt: finalized.updatedAt,
						},
					},
				);
				inventory = finalizedWrite.matchedCount === 1
					? finalized
					: (await this.deps.repositories.runtimeResourceInventories.findOne({ inventoryId }))!;
			}
			if (inventory.state !== 'READY' || !inventory.runtimeResourceInventoryHash) {
				throw new Error('runtime_resource_inventory_not_ready');
			}
			const resourcesPersistedOnApp = normalizeRuntimeResourcesV3([
				...app.replicas.flatMap((replica) => replica.mcpV3Resources ?? []),
				ingressResource,
			]);
			if (
				app.replicas.length !== plans.length ||
				app.replicas.some((replica) => !replica.mcpV3Resources) ||
				canonicalJson(resourcesPersistedOnApp) !== canonicalJson(inventory.expectedResources)
			) throw new Error('runtime_resource_inventory_replica_record_mismatch');
			const readyInventory = finalizeRuntimeResourceInventoryV3(
				inventory,
				inventory.expectedResources,
				inventory.updatedAt,
			);
			for (const replica of app.replicas) {
				const node = nodes.find((candidate) => candidate.nodeId === replica.nodeId)!;
				const response = await this.deps.agentClient.request(
					node,
					workspaceId,
					'POST',
					`/api/v1/mcp/v3/apps/${replica.containerId}/finalize`,
					{ runtimeResourceInventoryHash: readyInventory.runtimeResourceInventoryHash },
				);
				if (response.status >= 300) throw new Error(`agent MCP v3 finalize failed: ${JSON.stringify(response.body)}`);
			}
			await this.deps.repositories.apps.updateOne(
				{ appId: app.appId, workspaceId, state: { $in: ['PROVISIONING', 'QUARANTINED'] } },
				{
					$set: {
						state: 'QUARANTINED',
						runtimeResourceInventoryId: inventoryId,
						runtimeResourceInventoryHash: readyInventory.runtimeResourceInventoryHash,
						updatedAt: new Date(),
					},
				},
			);
			app = (await this.deps.repositories.apps.findOne({ appId: app.appId, workspaceId })) ?? app;
			if (
				(app.state !== 'QUARANTINED' && app.state !== 'RUNNING') ||
				app.runtimeResourceInventoryId !== inventoryId ||
				app.runtimeResourceInventoryHash !== readyInventory.runtimeResourceInventoryHash
			) throw new Error('mcp_v3_quarantine_persistence_failed');
			return { app, inventory: readyInventory };
		});
	}

	async activateMcpV3(workspaceId: string, input: {
		runtimeInstallationId: string;
		compact: string;
		artifactHash: string;
	}): Promise<MasterApp> {
		return this.deps.locks.run(workspaceId, async () => {
			const app = await this.deps.repositories.apps.findOne({
				workspaceId,
				kind: 'mcp-v3',
				mcpRuntimeInstallationId: input.runtimeInstallationId,
				state: { $ne: 'REMOVED' },
			});
			if (!app || !app.runtimeResourceInventoryId) {
				throw Object.assign(new Error('MCP v3 app not found'), { statusCode: 404 });
			}
			const inventory = await this.deps.repositories.runtimeResourceInventories.findOne({
				inventoryId: app.runtimeResourceInventoryId,
			});
			const attestation = inventory?.runtimeInventoryAttestation;
			if (
				!attestation ||
				sha256Base64Url(attestation.compact) !== attestation.artifactHash ||
				attestation.compact !== input.compact ||
				attestation.artifactHash !== input.artifactHash ||
				attestation.deploymentGrantJti !== app.mcpDeploymentGrantJti
			) throw new Error('runtime_inventory_attestation_establishment_mismatch');
			if (app.state === 'RUNNING' && app.mcpInventoryAttestationEstablishedAt) {
				await this.recordMcpV3StartedEvents(app, app.mcpInventoryAttestationEstablishedAt);
				return app;
			}
			if (app.state !== 'QUARANTINED') throw new Error('mcp_v3_app_not_quarantined');
			const nodes = await this.deps.repositories.nodes.find({
				nodeId: { $in: app.replicas.map((replica) => replica.nodeId) },
				status: 'ACTIVE',
			}).toArray();
			if (nodes.length !== app.replicas.length) throw new Error('mcp_replica_node_missing');
			await this.deps.ingress.upsert(app.subdomain, nodes);
			const establishedAt = new Date();
			const activated = await this.deps.repositories.apps.updateOne(
				{ appId: app.appId, workspaceId, state: 'QUARANTINED' },
				{ $set: { state: 'RUNNING', mcpInventoryAttestationEstablishedAt: establishedAt, updatedAt: establishedAt } },
			);
			if (activated.matchedCount !== 1) {
				const concurrent = await this.deps.repositories.apps.findOne({ appId: app.appId, workspaceId });
				if (concurrent?.state === 'RUNNING' && concurrent.mcpInventoryAttestationEstablishedAt) return concurrent;
				throw new Error('mcp_v3_activation_conflict');
			}
			await this.recordMcpV3StartedEvents(app, establishedAt);
			return { ...app, state: 'RUNNING', mcpInventoryAttestationEstablishedAt: establishedAt, updatedAt: establishedAt };
		});
	}

	/** The public origin of a managed runtime; also what the app sees as PRIVOS_PUBLIC_URL. */
	publicUrlFor(subdomain: string): string {
		return `https://${subdomain}.${this.deps.baseDomain}`;
	}

	/**
	 * Platform-owned container environment.
	 *
	 * Injected here rather than carried in the Hub's grant on purpose: the
	 * PRIVOS_ namespace is refused on every grant-supplied env map, so a value
	 * bearing these names can only have come from the Cluster.
	 */
	private platformEnvVarsV3(subdomain: string): Record<string, string> {
		return {
			PRIVOS_PUBLIC_URL: this.publicUrlFor(subdomain),
			PRIVOS_ACCESS_MODE: 'managed-runtime',
		};
	}

	/**
	 * Apply a verified configuration epoch to a running v3 generation.
	 *
	 * Containers are recreated in place — same cluster container identity, same
	 * attested resource inventory — because the environment is only readable by
	 * a process at start. HA runs one replica at a time so the ingress always
	 * has a healthy upstream.
	 */
	async reconfigureMcpV3(
		workspaceId: string,
		command: ClusterReconfigureCommandPayloadV3,
	): Promise<{ app: MasterApp; appliedKeys: string[] }> {
		return this.deps.locks.run(workspaceId, async () => {
			const app = await this.deps.repositories.apps.findOne({
				workspaceId,
				kind: 'mcp-v3',
				mcpRuntimeInstallationId: command.runtimeInstallationId,
				state: { $ne: 'REMOVED' },
			});
			if (!app) throw new McpProtocolV3Error('RUNTIME_NOT_RECONFIGURABLE', 'app_not_found');
			if (app.state !== 'RUNNING') throw new McpProtocolV3Error('RUNTIME_NOT_RECONFIGURABLE', `state_${app.state}`);
			if (
				app.appId !== command.clusterAppId ||
				app.mcpDeploymentId !== command.deploymentId ||
				app.mcpGenerationId !== command.generationId ||
				app.mcpGenerationNumber !== command.generationNumber ||
				app.mcpAppId !== command.mcpAppId ||
				app.manifestDigest !== command.manifestDigest ||
				app.resourceManifestHash !== command.resourceManifestHash ||
				app.runtimeResourceInventoryHash !== command.runtimeResourceInventoryHash ||
				app.mcpAuthorizationEpoch !== command.authorizationEpoch
			) throw new McpProtocolV3Error('GENERATION_AFFINITY_MISMATCH');

			const applied = app.appliedConfigEpoch ?? 1;
			// A repeat of the epoch that is already running is idempotent only when
			// the environment is byte-identical; anything else — including an equal
			// epoch with different values — is a downgrade or a forgery attempt.
			if (command.configEpoch < applied) throw new McpProtocolV3Error('CONFIG_EPOCH_INVALID', 'epoch_downgrade');
			if (command.configEpoch === applied) {
				if (canonicalJson(this.operatorEnvOf(app)) !== canonicalJson(command.envVars)) {
					throw new McpProtocolV3Error('CONFIG_EPOCH_INVALID', 'epoch_reused');
				}
				return { app, appliedKeys: Object.keys(command.envVars).sort() };
			}

			const nodes = await this.deps.repositories.nodes.find({
				nodeId: { $in: [...new Set(app.replicas.map((replica) => replica.nodeId))] },
				status: 'ACTIVE',
			}).toArray();
			// Replicas may share a node, so require every replica's node to
			// resolve rather than comparing counts.
			if (app.replicas.some((replica) => !nodes.some((node) => node.nodeId === replica.nodeId))) {
				throw new Error('mcp_replica_node_missing');
			}

			const sealed = this.sealOperatorEnv(command.envVars, command.secretKeys);
			const secretKeys = sealed.secretEnvKeys;

			for (const replica of app.replicas) {
				const node = nodes.find((candidate) => candidate.nodeId === replica.nodeId)!;
				const response = await this.deps.agentClient.request(
					node,
					workspaceId,
					'POST',
					`/api/v1/mcp/v3/apps/${replica.containerId}/reconfigure`,
					{
						appId: app.appId,
						workspaceId,
						listingId: app.listingId,
						versionDigest: app.versionDigest,
						image: app.image,
						digest: app.imageDigest,
						tag: 'latest',
						port: app.port,
						resources: app.resources,
						envVars: command.envVars,
						platformEnvVars: this.platformEnvVarsV3(app.subdomain),
						secretEnvKeys: secretKeys,
						volumes: app.volumes,
						availabilityTier: app.availabilityTier,
						stateless: app.stateless,
						subdomain: app.subdomain,
						domain: this.deps.baseDomain,
						configEpoch: command.configEpoch,
						runtimeResourceInventoryHash: command.runtimeResourceInventoryHash,
						mcpV3Binding: {
							protocolVersion: 3,
							clusterId: command.clusterId,
							nodeId: node.nodeId,
							workspaceId,
							deploymentId: command.deploymentId,
							generationId: command.generationId,
							generationNumber: command.generationNumber,
							runtimeInstallationId: command.runtimeInstallationId,
							mcpAppId: command.mcpAppId,
							replicaId: replica.replicaId,
							containerId: replica.containerId,
							imageDigest: app.imageDigest,
							manifestDigest: command.manifestDigest,
							approvalReceiptHash: app.mcpApprovalReceiptHash,
							authorizationEpoch: command.authorizationEpoch,
							deploymentGrantHash: app.mcpDeploymentGrantHash,
							resourceManifestHash: command.resourceManifestHash,
						},
					},
				);
				if (response.status >= 300) {
					throw new Error(`agent MCP v3 reconfigure failed: ${JSON.stringify(response.body)}`);
				}
			}

			const appliedAt = new Date();
			const persisted = await this.deps.repositories.apps.updateOne(
				{ appId: app.appId, workspaceId, appliedConfigEpoch: { $lt: command.configEpoch } },
				{
					$set: {
						envVars: sealed.envVars,
						secretEnvKeys: sealed.secretEnvKeys,
						appliedConfigEpoch: command.configEpoch,
						appliedConfigAt: appliedAt,
						updatedAt: appliedAt,
						...(sealed.secretEnvVarsEnc ? { secretEnvVarsEnc: sealed.secretEnvVarsEnc } : {}),
					},
					// A removed secret must not leave its previous value behind.
					...(sealed.secretEnvVarsEnc ? {} : { $unset: { secretEnvVarsEnc: 1 as const } }),
				},
			);
			if (persisted.matchedCount !== 1) throw new Error('mcp_v3_reconfigure_persistence_conflict');
			const reconfigured = await this.deps.repositories.apps.findOne({ appId: app.appId, workspaceId });
			if (!reconfigured || reconfigured.appliedConfigEpoch !== command.configEpoch) {
				throw new Error('mcp_v3_reconfigure_persistence_conflict');
			}
			return { app: reconfigured, appliedKeys: Object.keys(command.envVars).sort() };
		});
	}

	/** Reassemble the operator environment the app currently runs on. */
	private operatorEnvOf(app: MasterApp): Record<string, string> {
		if (!app.secretEnvVarsEnc) return app.envVars;
		return { ...app.envVars, ...(JSON.parse(this.deps.cipher.decrypt(app.secretEnvVarsEnc)) as Record<string, string>) };
	}

	/** Split an operator environment into its queryable and sealed halves. */
	private sealOperatorEnv(
		envVars: Record<string, string>,
		declaredSecretKeys: string[],
	): { envVars: Record<string, string>; secretEnvKeys: string[]; secretEnvVarsEnc?: string } {
		const secretEnvKeys = [...new Set(declaredSecretKeys.filter((key) => key in envVars))].sort();
		if (!secretEnvKeys.length) return { envVars, secretEnvKeys };
		const entries = Object.entries(envVars);
		return {
			envVars: Object.fromEntries(entries.filter(([key]) => !secretEnvKeys.includes(key))),
			secretEnvKeys,
			secretEnvVarsEnc: this.deps.cipher.encrypt(
				canonicalJson(Object.fromEntries(entries.filter(([key]) => secretEnvKeys.includes(key)))),
			),
		};
	}

	private async recordMcpV3StartedEvents(app: MasterApp, establishedAt: Date): Promise<void> {
		for (const replica of app.replicas) {
			try {
				await this.deps.repositories.lifecycleEvents.insertOne({
					eventId: `mcp-v3-start:${replica.replicaId}`,
					workspaceId: app.workspaceId,
					appId: app.appId,
					replicaId: replica.replicaId,
					type: 'STARTED',
					resources: app.resources,
					storageBytes: app.storageBytes,
					at: establishedAt,
				});
			} catch (error: unknown) {
				if ((error as { code?: number }).code !== 11000) throw error;
			}
		}
	}

	private assertMcpV3AppAffinity(
		app: MasterApp,
		grant: McpDeploymentGrantPayloadV3,
		deploymentGrantHash: string,
	): void {
		if (
			app.appId !== grant.deployment.clusterAppId ||
			app.mcpActiveDeploymentKey !== grant.deploymentId ||
			app.mcpGenerationId !== grant.generationId ||
			app.mcpGenerationNumber !== grant.generationNumber ||
			app.mcpRuntimeInstallationId !== grant.runtimeInstallationId ||
			app.mcpDeploymentGrantJti !== grant.jti ||
			app.mcpDeploymentGrantHash !== deploymentGrantHash ||
			app.resourceManifestHash !== grant.deployment.resourceManifestHash ||
			app.manifestDigest !== grant.deployment.manifestDigest ||
			app.mcpApprovalReceiptHash !== grant.approvalReceiptHash ||
			app.mcpApprovedPermissionCeilingHash !== grant.approvedPermissionCeilingHash ||
			app.mcpAuthorizationEpoch !== grant.authorizationEpoch ||
			app.mcpRoomBindingCount !== 0
		) throw new Error('existing_mcp_v3_generation_binding_mismatch');
	}

	private assertMcpV3InventoryAffinity(
		inventory: RuntimeResourceInventory,
		grant: McpDeploymentGrantPayloadV3,
	): void {
		if (
			inventory.clusterId !== grant.clusterId ||
			inventory.workspaceId !== grant.workspaceId ||
			inventory.deploymentId !== grant.deploymentId ||
			inventory.generationId !== grant.generationId ||
			inventory.generationNumber !== grant.generationNumber ||
			inventory.runtimeInstallationId !== grant.runtimeInstallationId ||
			inventory.clusterAppId !== grant.deployment.clusterAppId ||
			inventory.manifestDigest !== grant.deployment.manifestDigest ||
			inventory.resourceManifestHash !== grant.deployment.resourceManifestHash
		) throw new Error('runtime_resource_inventory_affinity_mismatch');
	}

	private parseMcpV3ReplicaResponse(
		body: unknown,
		plan: { nodeId: string; replicaId: string; containerId: string },
		node: MasterNode,
		expected: {
			clusterAppId: string;
			workspaceId: string;
			listingId: string;
			versionDigest: string;
			imageDigest: string;
		},
	): AppReplica {
		const response = body as {
			id?: unknown;
			appId?: unknown;
			workspaceId?: unknown;
			listingId?: unknown;
			versionDigest?: unknown;
			imageDigest?: unknown;
			state?: unknown;
			replicaId?: unknown;
			nodeIdentity?: { nodeId?: unknown; kid?: unknown; publicJwk?: unknown };
			expectedResources?: unknown;
		};
		if (
			response.id !== plan.containerId ||
			response.appId !== expected.clusterAppId ||
			response.workspaceId !== expected.workspaceId ||
			response.listingId !== expected.listingId ||
			response.versionDigest !== expected.versionDigest ||
			response.imageDigest !== expected.imageDigest ||
			response.replicaId !== plan.replicaId ||
			response.state !== 'running' ||
			response.nodeIdentity?.nodeId !== node.nodeId ||
			typeof response.nodeIdentity.kid !== 'string' ||
			!response.nodeIdentity.publicJwk ||
			jwkThumbprint(response.nodeIdentity.publicJwk as JsonWebKey) !== response.nodeIdentity.kid
		) throw new Error('agent_mcp_v3_resource_response_invalid');
		const resources = RuntimeResourceDescriptorV3Schema.array().min(2).parse(response.expectedResources);
		if (resources.some((resource) =>
			resource.ownershipScope !== 'INSTALLATION_GENERATION' ||
			resource.nodeId !== node.nodeId ||
			resource.replicaId !== plan.replicaId
		)) throw new Error('agent_mcp_v3_resource_affinity_invalid');
		if (!resources.some((resource) =>
			resource.kind === 'REPLICA' &&
			resource.resourceId === plan.replicaId &&
			resource.attributes.nodeIdentityKid === response.nodeIdentity!.kid) ||
			!resources.some((resource) =>
				resource.kind === 'CONTAINER' &&
				resource.resourceId === plan.containerId &&
				resource.attributes.nodeIdentityKid === response.nodeIdentity!.kid)) {
			throw new Error('agent_mcp_v3_resource_response_incomplete');
		}
		return {
			replicaId: plan.replicaId,
			nodeId: node.nodeId,
			containerId: plan.containerId,
			state: response.state,
			mcpNodeIdentity: {
				kid: response.nodeIdentity.kid,
				publicJwk: response.nodeIdentity.publicJwk as JsonWebKey,
			},
			mcpV3Resources: normalizeRuntimeResourcesV3(resources),
		};
	}

	private async deployMcpToNodes(
		workspaceId: string,
		input: z.infer<typeof DeploySchema>,
		grant: McpDeploymentGrantPayload,
		deploymentGrantHash: string,
		hubIdentity: { kid: string; publicJwk: JsonWebKey },
		nodes: MasterNode[],
	): Promise<MasterApp> {
		const appId = input.appId!;
		const storageBytes = (input.volumes[0]?.sizeMb ?? 0) * 1024 * 1024;
		const subdomain = grant.deployment.subdomain ?? await this.deps.subdomains.allocate(input.listingId);
		const replicas = [];
		try {
			for (const node of nodes) {
				const replicaId = crypto.randomUUID();
				const response = await this.deps.agentClient.request(node, workspaceId, 'POST', '/api/v1/mcp/apps/deploy', {
					...input,
					appId,
					workspaceId,
					subdomain,
					domain: this.deps.baseDomain,
					mcpBinding: {
						clusterId: grant.clusterId,
						nodeId: node.nodeId,
						workspaceId,
						installationId: grant.installationId,
						mcpAppId: grant.mcpAppId,
						replicaId,
						imageDigest: grant.deployment.imageDigest,
						manifestDigest: grant.deployment.manifestDigest,
						receiptHash: grant.receiptHash,
						grantEpoch: grant.grantEpoch,
						deploymentGrantHash,
						hubOrigin: grant.hubOrigin,
						hubKid: hubIdentity.kid,
						hubPublicJwk: hubIdentity.publicJwk,
					},
				});
				if (response.status >= 300) throw new Error(`agent MCP deploy failed: ${JSON.stringify(response.body)}`);
				const container = response.body as {
					id: string;
					state: string;
					nodeIdentity: { nodeId: string; kid: string; publicJwk: JsonWebKey };
				};
				if (
					container.nodeIdentity?.nodeId !== node.nodeId ||
					jwkThumbprint(container.nodeIdentity.publicJwk) !== container.nodeIdentity.kid
				) {
					throw new Error('agent_node_identity_invalid');
				}
				await this.deps.repositories.nodes.updateOne(
					{ nodeId: node.nodeId },
					{ $set: { mcpIdentityKid: container.nodeIdentity.kid, mcpIdentityPublicJwk: container.nodeIdentity.publicJwk, updatedAt: new Date() } },
				);
				replicas.push({
					replicaId,
					nodeId: node.nodeId,
					containerId: container.id,
					state: container.state,
					mcpNodeIdentity: { kid: container.nodeIdentity.kid, publicJwk: container.nodeIdentity.publicJwk },
				});
			}
		} catch (error) {
			await Promise.allSettled(replicas.map((replica) => {
				const node = nodes.find((candidate) => candidate.nodeId === replica.nodeId)!;
				return this.deps.agentClient.request(node, workspaceId, 'DELETE', `/api/v1/apps/${replica.containerId}`);
			}));
			throw error;
		}
		const now = new Date();
		const app: MasterApp = {
			appId,
			workspaceId,
			listingId: input.listingId,
			versionDigest: input.versionDigest,
			image: input.image,
			imageDigest: input.digest,
			resources: input.resources,
			port: input.port,
			envVars: input.envVars,
			volumes: input.volumes,
			storageBytes,
			availabilityTier: input.availabilityTier as AvailabilityTier,
			stateless: input.stateless,
			subdomain,
			uiUrl: `https://${subdomain}.${this.deps.baseDomain}`,
			replicas,
			state: 'QUARANTINED',
			kind: 'mcp-v2',
			mcpInstallationId: grant.installationId,
			mcpAppId: grant.mcpAppId,
			manifestDigest: grant.deployment.manifestDigest,
			receiptHash: grant.receiptHash,
			grantEpoch: grant.grantEpoch,
			createdAt: now,
			updatedAt: now,
		};
		await this.deps.repositories.apps.insertOne(app);
		await this.deps.repositories.lifecycleEvents.insertMany(replicas.map((replica) => ({
			eventId: crypto.randomUUID(), workspaceId, appId, replicaId: replica.replicaId,
			type: 'STARTED' as const, resources: input.resources, storageBytes, at: now,
		})));
		return app;
	}

	async activateMcp(workspaceId: string, input: {
		installationId: string;
		receiptHash: string;
		grantEpoch: number;
	}): Promise<MasterApp> {
		return this.deps.locks.run(workspaceId, async () => {
			const app = await this.deps.repositories.apps.findOne({ workspaceId, mcpInstallationId: input.installationId, kind: 'mcp-v2' });
			if (!app) throw Object.assign(new Error('MCP app not found'), { statusCode: 404 });
			if (app.receiptHash !== input.receiptHash || app.grantEpoch !== input.grantEpoch) throw new Error('mcp_activation_binding_mismatch');
			if (app.state === 'RUNNING') return app;
			if (app.state !== 'QUARANTINED') throw new Error('mcp_app_not_quarantined');
			const nodes = await this.deps.repositories.nodes.find({ nodeId: { $in: app.replicas.map((replica) => replica.nodeId) } }).toArray();
			if (nodes.length !== app.replicas.length) throw new Error('mcp_replica_node_missing');
			await this.deps.ingress.upsert(app.subdomain, nodes);
			await this.deps.repositories.apps.updateOne(
				{ appId: app.appId, state: 'QUARANTINED' },
				{ $set: { state: 'RUNNING', updatedAt: new Date() } },
			);
			return { ...app, state: 'RUNNING', updatedAt: new Date() };
		});
	}

	private async deployToNodes(
		workspaceId: string,
		input: z.infer<typeof DeploySchema>,
		nodes: MasterNode[],
	): Promise<MasterApp> {
		const appId = input.appId ?? crypto.randomUUID();
		const storageBytes = (input.volumes[0]?.sizeMb ?? 0) * 1024 * 1024;
		const subdomain = await this.deps.subdomains.allocate(input.listingId);
		const replicas = [];
		try {
			for (const node of nodes) {
				const response = await this.deps.agentClient.request(
					node,
					workspaceId,
					'POST',
					'/api/v1/apps/deploy',
					{
						...input,
						appId,
						workspaceId,
						subdomain,
						domain: this.deps.baseDomain,
					},
				);
				if (response.status >= 300) throw new Error(`agent deploy failed: ${JSON.stringify(response.body)}`);
				const container = response.body as { id: string; state: string };
				replicas.push({
					replicaId: crypto.randomUUID(),
					nodeId: node.nodeId,
					containerId: container.id,
					state: container.state,
				});
			}
			await this.deps.ingress.upsert(subdomain, nodes);
		} catch (error) {
			await Promise.allSettled(replicas.map((replica) => {
				const node = nodes.find((candidate) => candidate.nodeId === replica.nodeId)!;
				return this.deps.agentClient.request(
					node,
					workspaceId,
					'DELETE',
					`/api/v1/apps/${replica.containerId}`,
				);
			}));
			throw error;
		}
		const now = new Date();
		const app: MasterApp = {
			appId,
			workspaceId,
			listingId: input.listingId,
			versionDigest: input.versionDigest,
			image: input.image,
			imageDigest: input.digest,
			resources: input.resources,
			port: input.port,
			envVars: input.envVars,
			volumes: input.volumes,
			storageBytes,
			availabilityTier: input.availabilityTier as AvailabilityTier,
			stateless: input.stateless,
			subdomain,
			uiUrl: `https://${subdomain}.${this.deps.baseDomain}`,
			replicas,
			state: 'RUNNING',
			createdAt: now,
			updatedAt: now,
		};
		await this.deps.repositories.apps.insertOne(app);
		await this.deps.repositories.lifecycleEvents.insertMany(replicas.map((replica) => ({
			eventId: crypto.randomUUID(),
			workspaceId,
			appId,
			replicaId: replica.replicaId,
			type: 'STARTED' as const,
			resources: input.resources,
			storageBytes,
			at: now,
		})));
		return app;
	}

	async changeAvailabilityTier(workspaceId: string, appId: string, availabilityTier: AvailabilityTier): Promise<MasterApp> {
		return this.deps.locks.run(workspaceId, async () => {
			const app = await this.deps.repositories.apps.findOne({ workspaceId, appId, state: { $ne: 'REMOVED' } });
			if (!app) {
				const error: Error & { statusCode?: number } = new Error('app not found');
				error.statusCode = 404;
				throw error;
			}
			if (app.kind === 'mcp-v2' || app.kind === 'mcp-v3') {
				throw Object.assign(new Error('MCP availability changes require a new signed deployment grant'), {
					code: 'MCP_SIGNED_REDEPLOYMENT_REQUIRED',
				});
			}
			if (app.availabilityTier === availabilityTier) return app;
			if (app.state !== 'RUNNING') {
				const error: Error & { code?: string } = new Error('app must be running before changing availability tier');
				error.code = 'APP_NOT_RUNNING';
				throw error;
			}
			if (availabilityTier === 'ha') {
				if (!app.stateless) {
					const error: Error & { code?: string } = new Error('stateful apps cannot run in HA');
					error.code = 'HA_REQUIRES_STATELESS_APP';
					throw error;
				}
				await this.deps.quota.assertAdditionalReplicaAllowed(workspaceId, app.resources);
				const [nodes, runningApps] = await Promise.all([
					this.deps.repositories.nodes.find({ status: 'ACTIVE' }).toArray(),
					this.deps.repositories.apps.find({ state: 'RUNNING' }).toArray(),
				]);
				const occupiedNodes = new Set(app.replicas.map((replica) => replica.nodeId));
				const occupiedDomains = new Set(
					nodes.filter((node) => occupiedNodes.has(node.nodeId)).map((node) => node.failureDomain),
				);
				const reservations: NodeReservation[] = runningApps.flatMap((candidate) =>
					candidate.replicas.map((replica) => ({
						nodeId: replica.nodeId,
						memoryMb: candidate.resources.memoryMb,
						cpus: candidate.resources.cpus,
						diskBytes: 0,
					})),
				);
				let node: MasterNode;
				try {
					[node] = selectNodes({
						nodes: nodes.filter((candidate) => !occupiedNodes.has(candidate.nodeId) && !occupiedDomains.has(candidate.failureDomain)),
						reservations,
						resources: app.resources,
						storageBytes: 0,
						replicas: 1,
					});
				} catch {
					const error: Error & { code?: string } = new Error('HA requires a second active app node in a distinct failure domain with capacity');
					error.code = 'HA_CAPACITY_UNAVAILABLE';
					throw error;
				}
				const response = await this.deps.agentClient.request(node, workspaceId, 'POST', '/api/v1/apps/deploy', {
					appId,
					listingId: app.listingId,
					versionDigest: app.versionDigest,
					image: app.image,
					digest: app.imageDigest,
					port: app.port ?? 3001,
					resources: app.resources,
					envVars: app.envVars ?? {},
					volumes: [],
					workspaceId,
					subdomain: app.subdomain,
					domain: this.deps.baseDomain,
				});
				if (response.status >= 300) throw new Error(`agent deploy failed: ${JSON.stringify(response.body)}`);
				const container = response.body as { id: string; state: string };
				const replica = { replicaId: crypto.randomUUID(), nodeId: node.nodeId, containerId: container.id, state: container.state };
				const now = new Date();
				await this.deps.ingress.upsert(app.subdomain, [
					...nodes.filter((candidate) => occupiedNodes.has(candidate.nodeId)),
					node,
				]);
				await this.deps.repositories.apps.updateOne(
					{ workspaceId, appId },
					{ $set: { availabilityTier: 'ha', updatedAt: now }, $push: { replicas: replica } },
				);
				await this.deps.repositories.lifecycleEvents.insertOne({
					eventId: crypto.randomUUID(), workspaceId, appId, replicaId: replica.replicaId,
					type: 'STARTED', resources: app.resources, at: now,
				});
			} else {
				const [keep, ...remove] = app.replicas;
				if (!keep) throw new Error('app has no replicas');
				const nodes = await this.deps.repositories.nodes.find({ nodeId: { $in: app.replicas.map((replica) => replica.nodeId) } }).toArray();
				for (const replica of remove) {
					const node = nodes.find((candidate) => candidate.nodeId === replica.nodeId);
					if (!node) throw new Error(`node not found: ${replica.nodeId}`);
					const response = await this.deps.agentClient.request(node, workspaceId, 'DELETE', `/api/v1/apps/${replica.containerId}`);
					if (response.status >= 300 && response.status !== 404) throw new Error(`agent remove failed: ${JSON.stringify(response.body)}`);
				}
				const now = new Date();
				await this.deps.ingress.upsert(app.subdomain, nodes.filter((node) => node.nodeId === keep.nodeId));
				await this.deps.repositories.apps.updateOne(
					{ workspaceId, appId },
					{ $set: { availabilityTier: 'single', replicas: [keep], updatedAt: now } },
				);
				if (remove.length) {
					await this.deps.repositories.lifecycleEvents.insertMany(remove.map((replica) => ({
						eventId: crypto.randomUUID(), workspaceId, appId, replicaId: replica.replicaId,
						type: 'REMOVED' as const, resources: app.resources, at: now,
					})));
				}
			}
			return this.deps.repositories.apps.findOne({ workspaceId, appId }) as Promise<MasterApp>;
		});
	}
}

export { SchedulingError };
