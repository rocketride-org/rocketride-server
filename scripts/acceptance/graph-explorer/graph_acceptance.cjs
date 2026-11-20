// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Graph Explorer acceptance, TypeScript SDK side: the same wire path the app
 * uses (client.getTasks + client.tool), parsed by the SDK's own JSON.parse.
 * The Python script proves database state; this one proves what a browser-side
 * client receives: precision, tags, positional rows, typed errors.
 *
 * Usage: node graph_acceptance.cjs [age|neo4j|falkordb|all]
 * Env: ENGINE_URL, CLIENT_TS_DIR (a built packages/client-typescript: run
 * `./builder client-typescript:build` first), plus the database settings in env.cjs.
 * Requires the ACCEPT_GRAPH graphs seeded by graph_acceptance.py (run it first).
 */
'use strict';

const path = require('path');
const { randomUUID } = require('crypto');
const E = require('./env.cjs');

const [, , which = 'all'] = process.argv;
const uri = E.ENGINE_URL;
const { RocketRideClient, DAPException } = require(path.join(E.CLIENT_TS_DIR, 'dist/cjs/client/index.js'));

const NODES = {
	age: ['rocketride_graph', { graph: E.ACCEPT_GRAPH, allow_execute: false }],
	neo4j: ['graph_neo4j', { uri: E.NEO4J.uri, user: E.NEO4J.user, password: E.NEO4J.password, allow_execute: false }],
	falkordb: [
		'graph_falkordb',
		{ host: E.FALKORDB.host, port: E.FALKORDB.port, graph: E.ACCEPT_GRAPH, allow_execute: false },
	],
};
const rows = [];
function check(engine, name, ok, detail) {
	rows.push({ engine, check: name, status: ok ? 'PASS' : 'FAIL', detail });
	const suffix = !ok && detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 300)}` : '';
	console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${engine}: ${name}${suffix}`);
}
function tagged(v, kind, out = []) {
	if (Array.isArray(v)) v.forEach((x) => tagged(x, kind, out));
	else if (v && typeof v === 'object') {
		if (v['@kind'] === kind) out.push(v);
		Object.values(v).forEach((x) => tagged(x, kind, out));
	}
	return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runEngine(client, engine) {
	const [provider, cfg] = NODES[engine];
	const nodeId = `${provider}_1`;
	const projectId = randomUUID();
	const pipeline = {
		project_id: projectId,
		components: [
			{
				id: 'tools_1',
				provider: 'tools',
				name: 'Tools',
				config: { mode: 'Source', type: 'tools', name: 'Tools', parameters: {} },
			},
			{
				id: nodeId,
				provider,
				name: 'Graph',
				config: { profile: 'default', default: cfg, name: 'Graph' },
				control: [{ classType: 'tool', from: 'tools_1' }],
			},
		],
	};
	const started = await client.use({ pipeline, source: 'tools_1' });
	try {
		let task;
		for (let i = 0; i < 90 && !task; i++) {
			const tasks = await client.getTasks();
			task = tasks.find(
				(t) =>
					t.pipeline &&
					t.pipeline.project_id === projectId &&
					t.source === 'tools_1' &&
					t.ownerKind === 'user'
			);
			if (!task) await sleep(1000);
		}
		check(engine, 'getTasks lists the run by project+source+owner', !!task);
		if (!task) return;
		const token = task.token;
		const tool = (name, input = {}) => client.tool({ token, tool: name, nodeId, input, timeout: 40000 });

		const d = await tool('dialect');
		check(engine, 'dialect', d.dialect === engine, d);
		check(engine, 'capabilities.read_query', !!(d.capabilities && d.capabilities.read_query), d.capabilities);

		let r;
		if (engine === 'age') {
			r = await tool('read_query', { cypher: 'RETURN 1 AS a, 2 AS a', limit: 10 });
			check(
				engine,
				'duplicate columns survive JSON.parse',
				JSON.stringify(r.columns) === '["a","a"]' && JSON.stringify(r.rows) === '[[1,2]]',
				r
			);
		} else {
			try {
				await tool('read_query', { cypher: 'RETURN 1 AS a, 2 AS a', limit: 10 });
				check(engine, 'server refuses duplicate columns', false, 'accepted');
			} catch (e) {
				check(
					engine,
					'server refusal arrives as DAPException headline + detail',
					e instanceof DAPException && String(e.message).includes('\n'),
					String(e.message).slice(0, 120)
				);
			}
		}

		r = await tool('read_query', {
			cypher: engine === 'neo4j' ? `MATCH (n:${E.RUN_LABEL}) RETURN n` : 'MATCH (n) RETURN n',
			limit: 100,
		});
		const nodes = tagged(r.rows, 'node');
		check(
			engine,
			'node ids arrive as strings',
			nodes.length > 0 && nodes.every((n) => typeof n.id === 'string'),
			nodes.slice(0, 2)
		);
		if (engine === 'age') {
			check(
				engine,
				'AGE ids > 2^53 keep every digit through JSON.parse',
				nodes.some((n) => BigInt(n.id) > BigInt(Number.MAX_SAFE_INTEGER)),
				nodes.slice(0, 2).map((n) => n.id)
			);
		}
		const big =
			engine === 'neo4j'
				? 'RETURN 9007199254740993 AS big, 1.5 AS f'
				: 'RETURN 9007199254740993 AS big, 1.5 AS f';
		r = await tool('read_query', { cypher: big, limit: 1 });
		const cell = r.rows && r.rows[0] && r.rows[0][0];
		check(
			engine,
			'unsafe integer arrives as a number tag with exact text',
			!!cell && cell['@kind'] === 'number' && cell.value === '9007199254740993',
			r.rows
		);
		check(engine, 'safe float stays a JSON number', r.rows && r.rows[0] && r.rows[0][1] === 1.5, r.rows);

		r = await tool('read_query', { cypher: "RETURN {`@kind`: 'node', `@@x`: 1, plain: 2} AS m", limit: 1 });
		const m = r.rows && r.rows[0] && r.rows[0][0];
		check(
			engine,
			'user @-keys are escaped, never a tag',
			!!m && m['@kind'] === undefined && m['@@kind'] === 'node' && m['@@@x'] === 1 && m.plain === 2,
			m
		);

		// On the shared Neo4j database the write probes carry the run label (see graph_acceptance.py).
		const scope = engine === 'neo4j' ? `:${E.RUN_LABEL}` : '';
		try {
			await tool('read_query', { cypher: `CREATE (:Intruder${scope})`, limit: 1 });
			check(engine, 'write on read path rejects', false, 'not refused');
		} catch (e) {
			check(
				engine,
				'write on read path rejects with a DAPException',
				e instanceof DAPException && e instanceof Error,
				{ name: e && e.name, msg: String(e && e.message).slice(0, 120) }
			);
			check(
				engine,
				'refusal headline is first line',
				/^(Refused|Not supported|Invalid)/.test(String(e.message)),
				String(e.message).split('\n')[0]
			);
		}
		try {
			await tool('execute', { query: `CREATE (:Intruder${scope})` });
			check(engine, 'execute refused (allow_execute off)', false, 'not refused');
		} catch (e) {
			check(
				engine,
				'execute refused (allow_execute off)',
				e instanceof DAPException && /allow_execute/.test(e.message),
				e.message
			);
		}
	} finally {
		await client.terminate(started.token);
	}
}

(async () => {
	const engines = which === 'all' ? ['age', 'neo4j', 'falkordb'] : [which];
	const client = new RocketRideClient({ uri, auth: E.API_KEY, env: {} });
	await client.connect();
	for (const engine of engines) {
		console.log(`== ${engine}`);
		try {
			await runEngine(client, engine);
		} catch (e) {
			check(engine, 'run completed', false, `${e && e.name}: ${e && e.message}`);
		}
	}
	await client.disconnect();
	const failed = rows.filter((r) => r.status !== 'PASS');
	console.log(`== ${rows.length - failed.length} passed, ${failed.length} failed`);
	process.exit(failed.length ? 1 : 0);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
