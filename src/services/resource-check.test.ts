import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveResourceBudget } from './resource-check.js';

const rule = { cpuReserved: 2, cpuOvercommit: 4, memoryFraction: 0.7 };

// App-node rule: CPU = (cores - 2) x 4 because --cpus is a ceiling on a shared
// core, not a dedicated core; RAM = 70% of the host at 1:1 because going over
// memory limits OOM-kills containers.
test('an app node without a configured quota gets the rule budget', () => {
	const budget = resolveResourceBudget({ hostCpus: 8, hostMemMb: 64_000, maxCpus: null, maxMemoryMb: null, ...rule });
	assert.deepEqual(budget, { cpus: 24, memoryMb: 44_800, cpuSource: 'rule', memorySource: 'rule' });
});

test('a configured quota wins over the rule, field by field', () => {
	const budget = resolveResourceBudget({ hostCpus: 8, hostMemMb: 64_000, maxCpus: 6, maxMemoryMb: null, ...rule });
	assert.deepEqual(budget, { cpus: 6, memoryMb: 44_800, cpuSource: 'configured', memorySource: 'rule' });
});

test('a host with no more cores than the reserve still keeps one allocatable core', () => {
	const budget = resolveResourceBudget({ hostCpus: 2, hostMemMb: 4_000, maxCpus: null, maxMemoryMb: null, ...rule });
	assert.equal(budget.cpus, 4);
	assert.equal(budget.memoryMb, 2_800);
});

test('overcommit and memory fraction are configurable', () => {
	const budget = resolveResourceBudget({
		hostCpus: 16, hostMemMb: 32_000, maxCpus: null, maxMemoryMb: null,
		cpuReserved: 4, cpuOvercommit: 2, memoryFraction: 0.5,
	});
	assert.deepEqual(budget, { cpus: 24, memoryMb: 16_000, cpuSource: 'rule', memorySource: 'rule' });
});
