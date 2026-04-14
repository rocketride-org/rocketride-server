/**
 * Port allocation for runtime instances.
 *
 * Scans from a base port upward to find the next available port.
 */

import { createConnection, createServer } from 'net';

const DEFAULT_PORT = 5565;

function isPortInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const conn = createConnection({ host: '127.0.0.1', port }, () => {
			conn.destroy();
			resolve(true);
		});
		conn.on('error', () => resolve(false));
		conn.setTimeout(100, () => {
			conn.destroy();
			resolve(false);
		});
	});
}

function canBind(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const srv = createServer();
		srv.once('error', () => resolve(false));
		srv.listen(port, '0.0.0.0', () => {
			srv.close(() => resolve(true));
		});
	});
}

export async function findAvailablePort(base: number = DEFAULT_PORT): Promise<number> {
	for (let offset = 0; offset < 100; offset++) {
		const port = base + offset;
		if (await isPortInUse(port)) continue;
		if (await canBind(port)) return port;
	}
	throw new Error(`No available port found in range ${base}-${base + 99}`);
}
