// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * A minimal FalkorDB client (Redis protocol, RESP2) for the browser lanes' own
 * reads of database state: a connection of the lane's own, never through the
 * engine or the app under test. Local disposable containers only (README.md).
 * It reads and deletes the nodes of one lane run, found by label and a `run`
 * property; names are checked, never quoted, so nothing else can be reached.
 */
'use strict';

const net = require('net');

const LABEL = /^[A-Za-z][A-Za-z0-9_]*$/;
const RUN = /^[A-Za-z0-9_]+$/;

/** A RESP error reply (as opposed to a reply that is plain text). */
class RespError extends Error {}

/** A command as a RESP array of bulk strings. */
function encode(args) {
	const parts = [Buffer.from(`*${args.length}\r\n`)];
	for (const arg of args) {
		const bytes = Buffer.from(String(arg), 'utf8');
		parts.push(Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from('\r\n'));
	}
	return Buffer.concat(parts);
}

/**
 * Parse one RESP2 value starting at `at`.
 * @returns {[unknown, number] | null} The value and where the next one starts, or null when the buffer ends first.
 */
function parse(buf, at = 0) {
	const eol = buf.indexOf('\r\n', at);
	if (eol < 0) return null;
	const type = String.fromCharCode(buf[at]);
	const line = buf.toString('utf8', at + 1, eol);
	const next = eol + 2;
	if (type === '+') return [line, next];
	if (type === '-') return [new RespError(line), next];
	if (type === ':') return [Number(line), next];
	if (type === '$') {
		const n = Number(line);
		if (n < 0) return [null, next];
		if (buf.length < next + n + 2) return null;
		return [buf.toString('utf8', next, next + n), next + n + 2];
	}
	if (type === '*') {
		const n = Number(line);
		if (n < 0) return [null, next];
		const items = [];
		let pos = next;
		for (let i = 0; i < n; i++) {
			const item = parse(buf, pos);
			if (!item) return null;
			items.push(item[0]);
			pos = item[1];
		}
		return [items, pos];
	}
	throw new Error(`FalkorDB sent an unknown RESP type ${JSON.stringify(type)}`);
}

/**
 * Send one command on a new connection and return the reply.
 * @param {{ host: string, port: number }} server - The FalkorDB server.
 * @param {string[]} args - The command and its arguments.
 * @param {number} [timeoutMs] - How long to wait for the reply.
 */
function command(server, args, timeoutMs = 10000) {
	const where = `FalkorDB at ${server.host}:${server.port}`;
	return new Promise((resolve, reject) => {
		let settled = false;
		let buf = Buffer.alloc(0);
		const socket = net.createConnection({ host: server.host, port: server.port });
		const done = (error, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(value);
		};
		const timer = setTimeout(() => done(new Error(`${where} did not answer within ${timeoutMs} ms`)), timeoutMs);
		socket.on('connect', () => socket.write(encode(args)));
		socket.on('data', (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			let reply;
			try {
				reply = parse(buf);
			} catch (error) {
				return done(error);
			}
			if (!reply) return undefined;
			return reply[0] instanceof RespError
				? done(new Error(`${where}: ${reply[0].message}`))
				: done(null, reply[0]);
		});
		socket.on('error', (error) => done(new Error(`${where}: ${error.message}`)));
		socket.on('close', () => done(new Error(`${where} closed the connection before replying`)));
	});
}

/** The MATCH for one run's nodes, after checking that the names need no quoting. */
function runMatch(label, run) {
	if (!LABEL.test(String(label))) throw new Error(`label ${JSON.stringify(label)} must be letters, digits and _`);
	if (!RUN.test(String(run))) throw new Error(`run ${JSON.stringify(run)} must be letters, digits and _`);
	return `MATCH (n:${label} {run: '${run}'})`;
}

/** How many nodes with this label and `run` the graph holds (read-only query). */
async function countByRun(server, graph, label, run) {
	const match = runMatch(label, run);
	const reply = await command(server, ['GRAPH.RO_QUERY', graph, `${match} RETURN count(n)`]);
	const value =
		Array.isArray(reply) && Array.isArray(reply[1]) && Array.isArray(reply[1][0]) ? reply[1][0][0] : undefined;
	if (typeof value !== 'number') throw new Error(`FalkorDB answered the count with ${JSON.stringify(reply)}`);
	return value;
}

/** Delete the nodes with this label and `run` (and nothing else). */
async function deleteByRun(server, graph, label, run) {
	const match = runMatch(label, run);
	await command(server, ['GRAPH.QUERY', graph, `${match} DELETE n`]);
}

module.exports = { command, countByRun, deleteByRun, encode, parse };
