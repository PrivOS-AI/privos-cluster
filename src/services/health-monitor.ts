import pino from 'pino';
import { config } from '../config.js';
import { containerManager } from '../docker/index.js';
import * as containersRepo from '../db/containers-repo.js';
import { eventFromContainer, sendEvent } from './webhook-sender.js';
import type { Container } from '../types/index.js';

const logger = pino({ level: config.LOG_LEVEL }).child({ component: 'health-monitor' });

const HEALTH_TIMEOUT = 5_000;
const MAX_FAIL_COUNT = 3;
const MAX_RESTART_COUNT = 5;
const BATCH_SIZE = 5;

export class HealthMonitor {
    private timer: NodeJS.Timeout | null = null;
    private busy = false;

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), config.HEALTH_CHECK_INTERVAL_MS);
        logger.info({ intervalMs: config.HEALTH_CHECK_INTERVAL_MS }, 'health monitor started');
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        logger.info('health monitor stopped');
    }

    private async tick(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        try {
            await this.checkAll();
        } finally {
            this.busy = false;
        }
    }

    private async checkAll(): Promise<void> {
        const running = containersRepo.findRunning();
        // Only check managed containers (appId is set)
        const managed = running.filter((c) => c.appId !== null);

        for (let i = 0; i < managed.length; i += BATCH_SIZE) {
            const batch = managed.slice(i, i + BATCH_SIZE);
            await Promise.allSettled(batch.map((c) => this.checkOne(c)));
        }
    }

    private async checkOne(c: Container): Promise<void> {
        try {
            const res = await fetch(`${c.internalUrl}/health`, {
                signal: AbortSignal.timeout(HEALTH_TIMEOUT),
            });
            if (res.ok) {
                await this.handleSuccess(c);
                return;
            }
            if (res.status === 404) {
                // /health not implemented — fall back to Docker inspect
                await this.checkViaDocker(c);
                return;
            }
            await this.handleFailure(c, `HTTP ${res.status} from /health`);
        } catch {
            // Network error or timeout — fall back to Docker inspect
            await this.checkViaDocker(c);
        }
    }

    private async checkViaDocker(c: Container): Promise<void> {
        try {
            const info = await containerManager.inspectContainer(c.dockerContainerId);
            const status = info.State?.Status as string | undefined;
            const running = info.State?.Running as boolean | undefined;

            if (status === 'running' && running) {
                await this.handleSuccess(c);
                return;
            }
            if (status === 'exited' || status === 'dead' || status === 'paused') {
                // External stop — respect it, do NOT auto-restart
                logger.info({ containerId: c.id, dockerState: status }, 'container stopped externally');
                containersRepo.updateState(c.id, 'stopped', { stoppedAt: Date.now() });
                containersRepo.updateHealthCheck(c.id, {
                    status: 'unknown',
                    lastCheck: Date.now(),
                });
                sendEvent(eventFromContainer(
                    { ...c, state: 'stopped', healthCheck: { ...c.healthCheck, status: 'unknown' } },
                    'stopped-externally',
                ));
                return;
            }
            // Docker running but something is off at the app level
            await this.handleFailure(c, `Docker state: ${status}`);
        } catch (err: any) {
            if (err.statusCode === 404 || err.message?.includes('404')) {
                // Container no longer exists in Docker
                logger.error({ containerId: c.id }, 'container not found in Docker — marking error');
                containersRepo.updateState(c.id, 'error');
                containersRepo.updateHealthCheck(c.id, {
                    status: 'unknown',
                    lastCheck: Date.now(),
                });
                sendEvent(eventFromContainer(
                    { ...c, state: 'error', healthCheck: { ...c.healthCheck, status: 'unknown' } },
                    'error',
                    { error: 'Container not found in Docker' },
                ));
                return;
            }
            // Docker daemon error — treat as transient failure
            await this.handleFailure(c, `Docker inspect error: ${err.message}`);
        }
    }

    private async handleSuccess(c: Container): Promise<void> {
        const wasUnhealthy = c.healthCheck.status !== 'healthy';
        const now = Date.now();

        containersRepo.updateHealthCheck(c.id, {
            status: 'healthy',
            failCount: 0,
            lastCheck: now,
        });

        if (wasUnhealthy) {
            logger.info({ containerId: c.id }, 'container recovered');
            sendEvent(eventFromContainer(
                { ...c, state: 'running', healthCheck: { ...c.healthCheck, status: 'healthy', failCount: 0, lastCheck: now } },
                'health-check',
            ));
        }
    }

    private async handleFailure(c: Container, reason: string): Promise<void> {
        const newFailCount = c.healthCheck.failCount + 1;
        const now = Date.now();

        logger.warn({ containerId: c.id, failCount: newFailCount, reason }, 'health check failed');

        containersRepo.updateHealthCheck(c.id, {
            status: 'unhealthy',
            failCount: newFailCount,
            lastCheck: now,
        });

        if (newFailCount < MAX_FAIL_COUNT) {
            // Not enough consecutive failures yet
            if (c.healthCheck.status === 'healthy') {
                // Transition healthy → unhealthy: fire webhook once
                sendEvent(eventFromContainer(
                    { ...c, state: 'running', healthCheck: { ...c.healthCheck, status: 'unhealthy', failCount: newFailCount, lastCheck: now } },
                    'health-check',
                ));
            }
            return;
        }

        // Threshold reached: decide restart or error
        if (c.healthCheck.restartCount >= MAX_RESTART_COUNT) {
            logger.error({ containerId: c.id, restartCount: c.healthCheck.restartCount }, 'max restarts reached — marking error');
            containersRepo.updateState(c.id, 'error');
            sendEvent(eventFromContainer(
                { ...c, state: 'error', healthCheck: { ...c.healthCheck, status: 'unhealthy', failCount: newFailCount, lastCheck: now } },
                'error',
                { error: `Health checks failed ${newFailCount} times; max restarts (${MAX_RESTART_COUNT}) exceeded` },
            ));
            return;
        }

        // Auto-restart
        logger.info({ containerId: c.id, restartCount: c.healthCheck.restartCount }, 'auto-restarting container');
        try {
            await containerManager.restartContainer(c.dockerContainerId);
            const newRestartCount = c.healthCheck.restartCount + 1;
            containersRepo.updateHealthCheck(c.id, {
                status: 'unknown',
                failCount: 0,
                restartCount: newRestartCount,
                lastCheck: Date.now(),
            });
            logger.info({ containerId: c.id, restartCount: newRestartCount }, 'auto-restart succeeded');
            sendEvent(eventFromContainer(
                {
                    ...c,
                    state: 'running',
                    healthCheck: { ...c.healthCheck, status: 'unknown', failCount: 0, restartCount: newRestartCount, lastCheck: Date.now() },
                },
                'auto-restarted',
            ));
        } catch (err: any) {
            logger.error({ containerId: c.id, err: err.message }, 'auto-restart failed — marking error');
            containersRepo.updateState(c.id, 'error');
            containersRepo.updateHealthCheck(c.id, {
                status: 'unhealthy',
                lastCheck: Date.now(),
            });
            sendEvent(eventFromContainer(
                { ...c, state: 'error', healthCheck: { ...c.healthCheck, status: 'unhealthy', failCount: newFailCount, lastCheck: Date.now() } },
                'error',
                { error: `Auto-restart failed: ${err.message}` },
            ));
        }
    }
}

export const healthMonitor = new HealthMonitor();
