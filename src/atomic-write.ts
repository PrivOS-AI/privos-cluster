import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** Temp file, fsync, rename, fsync of the directory: the file is either absent or complete after a crash. */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
	const temporaryPath = `${filePath}.next-${process.pid}-${crypto.randomUUID()}`;
	try {
		const handle = await fs.open(temporaryPath, 'wx', 0o600);
		try {
			await handle.writeFile(data);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporaryPath, filePath);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true });
		throw error;
	}
	const directory = await fs.open(path.dirname(filePath), 'r');
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}
