/**
 * Filesystem paths for the ~/.rocketride directory structure.
 *
 * Layout:
 *   ~/.rocketride/
 *     runtimes/{version}/engine(.exe)
 *     instances/state.db
 *     logs/{id}/stdout.log, stderr.log
 */

import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export function rocketrideHome(): string {
	return join(homedir(), '.rocketride');
}

export function runtimesDir(version: string): string {
	return join(rocketrideHome(), 'runtimes', version);
}

export function runtimeBinary(version: string): string {
	const name = process.platform === 'win32' ? 'engine.exe' : 'engine';
	return join(runtimesDir(version), name);
}

export function stateDbPath(): string {
	return join(rocketrideHome(), 'instances', 'state.db');
}

export function logsDir(instanceId: string): string {
	return join(rocketrideHome(), 'logs', instanceId);
}

export function ensureDirs(): void {
	const home = rocketrideHome();
	mkdirSync(join(home, 'runtimes'), { recursive: true });
	mkdirSync(join(home, 'instances'), { recursive: true });
	mkdirSync(join(home, 'logs'), { recursive: true });
}
