// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Self-test for falkordb_resp.cjs, the lanes' own FalkorDB connection, against
 * a local stand-in server that answers with recorded replies (no database).
 * Run: node --test scripts/acceptance/graph-explorer/selftest/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const R = require('../falkordb_resp.cjs');

const bulk = (text) => `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
const array = (...items) => `*${items.length}\r\n${items.join('')}`;
// What FalkorDB answers to GRAPH.RO_QUERY ... RETURN count(n): header, one row, statistics.
const COUNT_REPLY = (n) =>
	array(
		array(bulk('count(n)')),
		array(array(`:${n}\r\n`)),
		array(bulk('Cached execution: 0'), bulk('Graph version: 1'))
	);
// ... and to a GRAPH.QUERY that returns nothing: statistics only.
const DELETE_REPLY = array(array(bulk('Nodes deleted: 1'), bulk('Graph version: 2')));

/** Serve one connection: record the command, answer with `reply` (in pieces when asked). */
async function withServer(reply, fn, { split = false } = {}) {
	const seen = [];
	const server = net.createServer((socket) => {
		socket.on('data', (chunk) => {
			seen.push(chunk.toString('utf8'));
			if (!split) return socket.write(reply);
			const half = Math.floor(reply.length / 2);
			socket.write(reply.slice(0, half));
			setTimeout(() => socket.write(reply.slice(half)), 20);
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		return await fn({ host: '127.0.0.1', port: server.address().port }, seen);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

test('falkordb_resp: counts the nodes of one run, read-only', async () => {
	await withServer(COUNT_REPLY(1), async (server, seen) => {
		assert.strictEqual(await R.countByRun(server, 'gx_accept_write', 'GxWrite', 'gxw_abc_1'), 1);
		const sent = seen.join('');
		assert.match(sent, /GRAPH\.RO_QUERY/);
		assert.match(sent, /gx_accept_write/);
		assert.match(sent, /MATCH \(n:GxWrite \{run: 'gxw_abc_1'\}\) RETURN count\(n\)/);
	});
});

test('falkordb_resp: reads a reply that arrives in pieces', async () => {
	await withServer(
		COUNT_REPLY(0),
		async (server) => assert.strictEqual(await R.countByRun(server, 'g', 'GxWrite', 'r1'), 0),
		{ split: true }
	);
});

test('falkordb_resp: deletes only the nodes of one run', async () => {
	await withServer(DELETE_REPLY, async (server, seen) => {
		await R.deleteByRun(server, 'gx_accept_write', 'GxWrite', 'gxw_abc_1');
		assert.match(seen.join(''), /MATCH \(n:GxWrite \{run: 'gxw_abc_1'\}\) DELETE n/);
	});
});

test('falkordb_resp: a server error is an error', async () => {
	await withServer('-ERR Invalid graph operation on empty key\r\n', async (server) => {
		await assert.rejects(R.countByRun(server, 'missing', 'GxWrite', 'r1'), /Invalid graph operation on empty key/);
	});
});

test('falkordb_resp: no server is an error, not a count', async () => {
	const server = net.createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	await assert.rejects(R.countByRun({ host: '127.0.0.1', port }, 'g', 'GxWrite', 'r1'), /FalkorDB at 127\.0\.0\.1/);
});

test('falkordb_resp: refuses names it would have to quote', async () => {
	await assert.rejects(
		R.countByRun({ host: '127.0.0.1', port: 9 }, 'g', 'GxWrite', "x'}) DETACH DELETE n //"),
		/run/
	);
	await assert.rejects(R.deleteByRun({ host: '127.0.0.1', port: 9 }, 'g', 'Gx Write', 'r1'), /label/);
});
