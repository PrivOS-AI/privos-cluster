import { getDb } from './client.js';

// ---------------------------------------------------------------------------
// Row shape — mirrors webhook_events table
// ---------------------------------------------------------------------------
export interface WebhookRow {
	id: string;
	event_type: string;
	payload: string; // JSON string
	status: 'pending' | 'delivered' | 'failed';
	attempts: number;
	next_attempt_at: number; // unix ms
	last_error: string | null;
	created_at: number; // unix ms
	delivered_at: number | null; // unix ms
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function enqueue(row: {
	id: string;
	event_type: string;
	payload: string;
	next_attempt_at: number;
}): void {
	getDb()
		.prepare(
			`INSERT INTO webhook_events (id, event_type, payload, status, attempts, next_attempt_at, created_at)
       VALUES (@id, @event_type, @payload, 'pending', 0, @next_attempt_at, @created_at)`,
		)
		.run({ ...row, created_at: Date.now() });
}

export function dequeueDue(limit = 10): WebhookRow[] {
	return getDb()
		.prepare<[number, number], WebhookRow>(
			`SELECT * FROM webhook_events
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY created_at ASC
       LIMIT ?`,
		)
		.all(Date.now(), limit) as WebhookRow[];
}

export function markDelivered(id: string): void {
	getDb()
		.prepare(
			`UPDATE webhook_events
       SET status = 'delivered', delivered_at = @deliveredAt
       WHERE id = @id`,
		)
		.run({ id, deliveredAt: Date.now() });
}

export function markFailed(
	id: string,
	error: string,
	nextAttemptAt: number,
	attempts: number,
	status: 'pending' | 'failed',
): void {
	getDb()
		.prepare(
			`UPDATE webhook_events
       SET status = @status, last_error = @error, next_attempt_at = @nextAttemptAt, attempts = @attempts
       WHERE id = @id`,
		)
		.run({ id, status, error, nextAttemptAt, attempts });
}

/**
 * Delete delivered rows older than `olderThanMs` milliseconds ago.
 * Returns number of rows deleted.
 */
export function purgeDelivered(olderThanMs: number): number {
	const cutoff = Date.now() - olderThanMs;
	const result = getDb()
		.prepare<number>(
			`DELETE FROM webhook_events
       WHERE status = 'delivered' AND delivered_at < ?`,
		)
		.run(cutoff);
	return result.changes;
}
