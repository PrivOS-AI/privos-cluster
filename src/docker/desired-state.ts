import fs from 'node:fs/promises';
import path from 'node:path';

import pino from 'pino';

import { writeFileAtomic } from '../atomic-write.js';
import { config } from '../config.js';

/**
 * Durable record of which managed containers the platform wants running.
 *
 * Containers are created with `RestartPolicy: no`, so after a host reboot Docker
 * cannot tell a container that was stopped on purpose (stop, suspend, quarantine)
 * from one that was running. This file is the deliberate exception to "Docker is the
 * only source of truth": it is written only by the lifecycle methods of the fleet
 * agent and read only once after a host boot (see desired-state-recovery.ts).
 *
 * Every operation is best-effort: a failed write is logged and never propagates into
 * a lifecycle call. Outside fleet mode the store does nothing.
 */
export type DesiredContainerState = 'running' | 'stopped';

export interface DesiredStateFile {
	bootId: string;
	containers: Record<string, DesiredContainerState>;
}

const logger = pino({ level: config.LOG_LEVEL }).child({ component: 'desired-state' });

function isDesiredStateFile(value: unknown): value is DesiredStateFile {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<DesiredStateFile>;
	if (typeof candidate.bootId !== 'string') return false;
	if (!candidate.containers || typeof candidate.containers !== 'object' || Array.isArray(candidate.containers)) return false;
	return Object.values(candidate.containers).every((state) => state === 'running' || state === 'stopped');
}

export class DesiredStateStore {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly filePath: () => string,
		private readonly enabled: () => boolean,
	) {}

	isEnabled(): boolean {
		return this.enabled();
	}

	/** Runs `work` after every earlier operation; a failure is logged, never thrown. */
	private enqueue<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
		const run = this.queue.then(work, work).catch((err: unknown) => {
			logger.error({ err, op: label }, 'desired-state operation failed');
			return undefined;
		});
		this.queue = run;
		return run;
	}

	/** Parse the file. A file that does not parse is moved aside (kept for inspection) and treated as absent. */
	private async load(): Promise<DesiredStateFile | null> {
		const file = this.filePath();
		let raw: string;
		try {
			raw = await fs.readFile(file, 'utf8');
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw err;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (isDesiredStateFile(parsed)) return parsed;
		} catch {
			// falls through to quarantine below
		}
		const aside = `${file}.corrupt-${Date.now()}`;
		await fs.rename(file, aside);
		logger.error({ file, aside }, 'desired-state file is corrupt and was moved aside');
		return null;
	}

	private async save(next: DesiredStateFile): Promise<void> {
		const file = this.filePath();
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await writeFileAtomic(file, `${JSON.stringify(next)}\n`);
	}

	private change(label: string, mutate: (state: DesiredStateFile) => boolean): Promise<void> {
		if (!this.enabled()) return Promise.resolve();
		return this.enqueue(label, async () => {
			const state = (await this.load()) ?? { bootId: '', containers: {} };
			if (mutate(state)) await this.save(state);
		}).then(() => undefined);
	}

	mark(dockerId: string, desired: DesiredContainerState): Promise<void> {
		return this.change('mark', (state) => {
			if (state.containers[dockerId] === desired) return false;
			state.containers[dockerId] = desired;
			return true;
		});
	}

	remove(dockerId: string): Promise<void> {
		return this.change('remove', (state) => {
			if (!(dockerId in state.containers)) return false;
			delete state.containers[dockerId];
			return true;
		});
	}

	/** Record `running` for containers that have no entry yet, and stamp the current host boot. */
	seedAndStamp(runningIds: readonly string[], bootId: string): Promise<void> {
		return this.change('seed', (state) => {
			let changed = state.bootId !== bootId;
			state.bootId = bootId;
			for (const id of runningIds) {
				if (state.containers[id] === undefined) {
					state.containers[id] = 'running';
					changed = true;
				}
			}
			return changed;
		});
	}

	/** Current file contents (null when absent, corrupt or on error). Serialized with writes. */
	async read(): Promise<DesiredStateFile | null> {
		if (!this.enabled()) return null;
		return (await this.enqueue('read', () => this.load())) ?? null;
	}

	async get(dockerId: string): Promise<DesiredContainerState | undefined> {
		return (await this.read())?.containers[dockerId];
	}
}

export const desiredState = new DesiredStateStore(() => config.AGENT_DESIRED_STATE_PATH, () => config.FLEET_MODE);
