import crypto from 'crypto';
import pino from 'pino';
import { config } from '../config.js';
import { signToken } from '../auth/jwt.js';
import * as webhookQueueRepo from '../db/webhook-queue-repo.js';
import type {
    Container,
    Image,
    ImageWebhookEvent,
    WebhookEvent,
    WebhookEventType,
} from '../types/index.js';

const logger = pino({ level: config.LOG_LEVEL }).child({ component: 'webhook' });

const BACKOFFS = [1_000, 5_000, 30_000, 5 * 60_000, 30 * 60_000];
const MAX_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 1_000;
const PURGE_INTERVAL_MS = 60 * 60_000; // 1 hour
const PURGE_OLDER_THAN_MS = 7 * 24 * 60 * 60_000; // 7 days

let pollTimer: NodeJS.Timeout | null = null;
let purgeTimer: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Build a WebhookEvent (minus nonce) from a Container row plus an event type.
 * Optionally merge extra fields (e.g. error).
 */
export function eventFromContainer(
    c: Container,
    event: WebhookEventType,
    extra: Partial<WebhookEvent> = {},
): Omit<WebhookEvent, 'nonce'> {
    return {
        event,
        containerId: c.id,
        dockerContainerId: c.dockerContainerId,
        appId: c.appId,
        state: c.state,
        healthStatus: c.healthCheck.status,
        internalUrl: c.internalUrl,
        hostPort: c.hostPort,
        ts: Date.now(),
        ...extra,
    };
}

/**
 * Enqueue a webhook event for async delivery. Never blocks the caller.
 */
export function sendEvent(event: Omit<WebhookEvent, 'nonce'>): void {
    const id = crypto.randomUUID();
    const fullEvent: WebhookEvent = { ...event, nonce: id };
    webhookQueueRepo.enqueue({
        id,
        event_type: event.event,
        payload: JSON.stringify(fullEvent),
        next_attempt_at: Date.now(),
    });
    logger.debug({ id, event: event.event, containerId: event.containerId }, 'webhook enqueued');
}

/**
 * Enqueue an image lifecycle webhook event. Mirrors sendEvent but for image
 * payloads (which have no container fields).
 */
export function sendImageEvent(event: Omit<ImageWebhookEvent, 'nonce'>): void {
    const id = crypto.randomUUID();
    const fullEvent: ImageWebhookEvent = { ...event, nonce: id };
    webhookQueueRepo.enqueue({
        id,
        event_type: event.event,
        payload: JSON.stringify(fullEvent),
        next_attempt_at: Date.now(),
    });
    logger.debug({ id, event: event.event, imageId: event.imageId }, 'image webhook enqueued');
}

/**
 * Build an ImageWebhookEvent (minus nonce) from a stored Image row.
 */
export function imageEventFromImage(
    img: Image,
    event: ImageWebhookEvent['event'],
    extra: Partial<ImageWebhookEvent> = {},
): Omit<ImageWebhookEvent, 'nonce'> {
    return {
        event,
        imageId: img.id,
        dockerImageId: img.dockerImageId,
        repository: img.repository,
        tag: img.tag,
        source: img.source,
        builtBy: img.builtBy,
        ts: Date.now(),
        ...extra,
    };
}

// ---------------------------------------------------------------------------
// Background worker internals
// ---------------------------------------------------------------------------

async function processOne(row: webhookQueueRepo.WebhookRow): Promise<void> {
    try {
        const res = await fetch(config.PRIVOS_CHAT_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${signToken('privos-cluster', 'webhook')}`,
            },
            body: row.payload,
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        webhookQueueRepo.markDelivered(row.id);
        logger.info({ id: row.id, event: row.event_type, attempts: row.attempts + 1 }, 'webhook delivered');
    } catch (err: any) {
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
            webhookQueueRepo.markFailed(row.id, err.message, 0, attempts, 'failed');
            logger.error({ id: row.id, attempts, err: err.message }, 'webhook gave up');
            return;
        }
        const backoff = BACKOFFS[Math.min(attempts - 1, BACKOFFS.length - 1)];
        const jitter = backoff * (0.8 + Math.random() * 0.4);
        const nextAttemptAt = Date.now() + jitter;
        webhookQueueRepo.markFailed(row.id, err.message, nextAttemptAt, attempts, 'pending');
        logger.warn({ id: row.id, attempts, backoffMs: Math.round(jitter), err: err.message }, 'webhook retry scheduled');
    }
}

async function tick(): Promise<void> {
    try {
        const due = webhookQueueRepo.dequeueDue(10);
        if (due.length > 0) {
            await Promise.allSettled(due.map(processOne));
        }
    } catch (err: any) {
        logger.error({ err: err.message }, 'webhook tick error');
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startWorker(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    purgeTimer = setInterval(() => {
        try {
            const purged = webhookQueueRepo.purgeDelivered(PURGE_OLDER_THAN_MS);
            if (purged > 0) logger.info({ purged }, 'webhook events purged');
        } catch (err: any) {
            logger.error({ err: err.message }, 'webhook purge error');
        }
    }, PURGE_INTERVAL_MS);
    logger.info('webhook worker started');
}

export function stopWorker(): void {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    if (purgeTimer) {
        clearInterval(purgeTimer);
        purgeTimer = null;
    }
    logger.info('webhook worker stopped');
}
