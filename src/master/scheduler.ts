import type { MasterNode } from './types.js';
import type { ContainerResources } from '../types/index.js';

export interface NodeReservation {
	nodeId: string;
	memoryMb: number;
	cpus: number;
	diskBytes: number;
}

export class SchedulingError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

function remaining(
	node: MasterNode,
	reservations: NodeReservation[],
): { memoryMb: number; cpus: number; diskBytes: number } {
	const used = reservations
		.filter((reservation) => reservation.nodeId === node.nodeId)
		.reduce(
			(total, reservation) => ({
				memoryMb: total.memoryMb + reservation.memoryMb,
				cpus: total.cpus + reservation.cpus,
				diskBytes: total.diskBytes + reservation.diskBytes,
			}),
			{ memoryMb: 0, cpus: 0, diskBytes: 0 },
		);
	return {
		memoryMb: node.capacity.memoryMb - used.memoryMb,
		cpus: node.capacity.cpus - used.cpus,
		diskBytes: node.capacity.diskBytes - used.diskBytes,
	};
}

export function selectNodes(options: {
	nodes: MasterNode[];
	reservations: NodeReservation[];
	resources: ContainerResources;
	storageBytes: number;
	replicas: number;
}): MasterNode[] {
	const active = options.nodes.filter((node) => node.status === 'ACTIVE');
	const selected: MasterNode[] = [];
	for (let index = 0; index < options.replicas; index += 1) {
		const candidates = active
			.filter((node) => !selected.some((item) => item.nodeId === node.nodeId))
			.filter((node) => !selected.some((item) => item.failureDomain === node.failureDomain))
			.map((node) => ({ node, free: remaining(node, options.reservations) }))
			.filter(({ free }) =>
				free.memoryMb >= options.resources.memoryMb &&
				free.cpus >= options.resources.cpus &&
				free.diskBytes >= options.storageBytes,
			)
			.sort((a, b) =>
				b.free.memoryMb - a.free.memoryMb ||
				b.free.diskBytes - a.free.diskBytes,
			);
		const chosen = candidates[0]?.node;
		if (!chosen) {
			throw new SchedulingError(
				options.replicas > 1 ? 'HA_CAPACITY_UNAVAILABLE' : 'CAPACITY_UNAVAILABLE',
				options.replicas > 1
					? 'HA requires at least two active app nodes in distinct failure domains with capacity'
					: 'No active app node has enough reserved capacity',
			);
		}
		selected.push(chosen);
		options.reservations.push({
			nodeId: chosen.nodeId,
			memoryMb: options.resources.memoryMb,
			cpus: options.resources.cpus,
			diskBytes: options.storageBytes,
		});
	}
	return selected;
}
