/**
 * The master probes `GET /api/v1/apps/:id/status?light=1` before every v3
 * dispatch and reads only state and health, so the light answer must skip the
 * slow `docker stats` sample and the inspect. Without `light` the full status
 * (CPU, memory, uptime) stays exactly as before.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fastify from 'fastify';

import { config } from '../config.js';
import { containerManager } from '../docker/index.js';
import appsHandler from './apps.js';

const entry = {
	Id: 'docker-1', Names: ['/app-1'], Image: 'img:1', State: 'running', Created: 1,
	Labels: { 'privos.managed': 'true', 'privos.id': '22222222-2222-4222-8222-222222222222' },
};

async function build(t: import('node:test').TestContext) {
	const manager = containerManager as unknown as Record<'listContainers' | 'getContainerStats' | 'inspectContainer', unknown>;
	const saved = {
		listContainers: manager.listContainers, getContainerStats: manager.getContainerStats,
		inspectContainer: manager.inspectContainer, fleet: config.FLEET_MODE,
	};
	const calls = { stats: 0, inspect: 0 };
	manager.listContainers = async () => [entry];
	manager.getContainerStats = async () => {
		calls.stats += 1;
		return { cpuPercent: 12.5, memoryUsageMb: 100, memoryLimitMb: 256, memoryPercent: 39 };
	};
	manager.inspectContainer = async () => {
		calls.inspect += 1;
		return { State: { StartedAt: new Date(Date.now() - 60_000).toISOString() } };
	};
	(config as any).FLEET_MODE = false;
	const app = fastify();
	app.decorate('authenticate', async () => undefined);
	await app.register(appsHandler);
	await app.ready();
	t.after(async () => {
		manager.listContainers = saved.listContainers;
		manager.getContainerStats = saved.getContainerStats;
		manager.inspectContainer = saved.inspectContainer;
		(config as any).FLEET_MODE = saved.fleet;
		await app.close();
	});
	return { app, calls };
}

test('light status answers state, health and restarts without docker stats or inspect', async (t) => {
	const { app, calls } = await build(t);
	const response = await app.inject({ method: 'GET', url: '/api/v1/apps/22222222-2222-4222-8222-222222222222/status?light=1' });
	assert.equal(response.statusCode, 200);
	assert.deepEqual(response.json(), { state: 'running', healthStatus: 'unknown', restarts: 0 });
	assert.deepEqual(calls, { stats: 0, inspect: 0 });
});

test('full status still samples stats and uptime when light is absent', async (t) => {
	const { app, calls } = await build(t);
	const response = await app.inject({ method: 'GET', url: '/api/v1/apps/22222222-2222-4222-8222-222222222222/status' });
	assert.equal(response.statusCode, 200);
	const body = response.json();
	assert.ok(body.uptime >= 59 && body.uptime <= 61, `uptime ${body.uptime}`);
	assert.deepEqual({ ...body, uptime: 60 }, {
		state: 'running', cpuPercent: 12.5, memoryUsageMb: 100, memoryLimitMb: 256, memoryPercent: 39,
		uptime: 60, restarts: 0, healthStatus: 'unknown',
	});
	assert.deepEqual(calls, { stats: 1, inspect: 1 });
});

test('light status of an unknown container is still a 404', async (t) => {
	const { app } = await build(t);
	(containerManager as unknown as { listContainers: unknown }).listContainers = async () => [];
	const response = await app.inject({ method: 'GET', url: '/api/v1/apps/22222222-2222-4222-8222-222222222222/status?light=1' });
	assert.equal(response.statusCode, 404);
});
