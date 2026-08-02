#!/usr/bin/env node
import process from 'node:process';

import { rotateNodeIdentityFile } from '../security/node-identity.js';

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const filePath = argument('--path');
const nodeId = argument('--node-id');
if (!filePath || !nodeId || !process.argv.includes('--confirm')) {
	throw new Error('usage: rotate-mcp-node-identity --path <absolute-path> --node-id <id> --confirm');
}

const result = await rotateNodeIdentityFile(filePath, nodeId);
process.stdout.write(`${JSON.stringify({ nodeId, ...result })}\n`);
