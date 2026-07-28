export class WorkspaceLock {
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
		const prior = this.tails.get(workspaceId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = prior.then(() => current);
		this.tails.set(workspaceId, tail);
		await prior;
		try {
			return await action();
		} finally {
			release();
			if (this.tails.get(workspaceId) === tail) this.tails.delete(workspaceId);
		}
	}
}
