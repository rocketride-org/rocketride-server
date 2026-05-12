/**
 * Server lifecycle wrapper.
 *
 * Wraps scripts/lib/server.js (startServer/stopServer) so the harness can
 * spawn rocketride-server with ROCKETRIDE_MOCK=1 and tear it down cleanly.
 */

import { resolve } from 'path';

import type { HarnessConfig } from '../config';

export type ServerHandle = {
	mode: 'spawn' | 'external';
	url: string;
	port: number;
	stop: () => Promise<void>;
};

type ServerLib = {
	startServer: (options: {
		script: string;
		basePort?: number;
		env?: Record<string, string>;
		onOutput?: (text: string) => void;
	}) => Promise<{ server: unknown; port: number }>;
	stopServer: (serverObj: { server: unknown }) => Promise<void>;
};

function loadServerLib(): ServerLib {
	const projectRoot = resolve(__dirname, '..', '..', '..', '..');
	const libPath = resolve(projectRoot, 'scripts', 'lib');
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require(libPath) as ServerLib;
}

export async function startHarnessServer(config: HarnessConfig): Promise<ServerHandle> {
	if (config.serverMode === 'external') {
		const port = Number.parseInt(new URL(config.serverUrl).port || '5565', 10);
		return {
			mode: 'external',
			url: config.serverUrl,
			port,
			stop: async () => {
				// Nothing to stop — server is owned by the user
			},
		};
	}

	const lib = loadServerLib();
	const env: Record<string, string> = {};
	if (config.mockLlm) {
		env.ROCKETRIDE_MOCK = '1';
	}

	const onOutput = (text: string) => {
		process.stdout.write(`[server] ${text}`);
	};

	const result = await lib.startServer({
		script: 'ai/eaas.py',
		basePort: 50000,
		env,
		onOutput,
	});

	return {
		mode: 'spawn',
		url: `http://localhost:${result.port}`,
		port: result.port,
		stop: async () => {
			await lib.stopServer({ server: result.server });
		},
	};
}
