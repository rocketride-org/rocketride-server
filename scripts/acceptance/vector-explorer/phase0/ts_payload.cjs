// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================
// G0-8: round-trip large tool answers through the TypeScript client.
//
// Calls the receiver probe's `payload` tool once per size and prints one JSON
// line per call: { bytes, ms, count, values, json, sum }. Uses the CommonJS build of
// packages/client-typescript (dist/cjs). Settings come from the environment:
// ENGINE_URL, RR_TEST_APIKEY (a local label on an OSS engine), VX_TOKEN (the
// probe's Tools token) and VX_SIZES (comma-separated byte counts).

'use strict';

const path = require('path');

const repo = path.resolve(__dirname, '..', '..', '..', '..');
const { RocketRideClient } = require(
	path.join(repo, 'packages', 'client-typescript', 'dist', 'cjs', 'client', 'index.js')
);

async function main() {
	const token = process.env.VX_TOKEN;
	if (!token) throw new Error('VX_TOKEN is required');
	const sizes = (process.env.VX_SIZES || '1048576,4194304').split(',').map(Number);
	const client = new RocketRideClient({
		uri: process.env.ENGINE_URL || 'http://127.0.0.1:5590',
		auth: process.env.RR_TEST_APIKEY || 'local-acceptance-key',
	});
	await client.connect();
	try {
		for (const bytes of sizes) {
			const started = performance.now();
			const out = await client.tool({
				token,
				tool: 'payload',
				nodeId: 'receiver_1',
				input: { bytes },
				timeout: 120000,
			});
			const ms = performance.now() - started;
			const sum = out.values.reduce((total, value) => total + value, 0);
			console.log(
				JSON.stringify({
					bytes,
					ms: Math.round(ms),
					count: out.count,
					values: out.values.length,
					json: JSON.stringify(out).length,
					sum,
				})
			);
		}
	} finally {
		await client.disconnect();
	}
}

main().catch((error) => {
	console.error(String((error && error.stack) || error));
	process.exit(1);
});
