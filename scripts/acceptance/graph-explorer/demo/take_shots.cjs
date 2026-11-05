// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Product screenshots of Graph Explorer and SQL Explorer in the real served shell
 * (engine at ENGINE_URL, demo pipelines from start_demo.py). Installed Google
 * Chrome, 1600x1150 @2x.
 * Usage: node take_shots.cjs [out-dir]   (defaults to $OUT_DIR/shots)
 */
'use strict';
// page.evaluate() and addInitScript() callbacks run in the browser.
/* global document, getComputedStyle */
const fs = require('fs');
const path = require('path');
const E = require('../env.cjs');
const { chromium } = E.loadPlaywright();

const BASE = E.ENGINE_URL;
const OUT = process.argv[2] || path.join(E.OUT_DIR, 'shots');
const T = E.DEMO_SQL_PREFIX; // demo table prefix (seed_demo.sh)
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const log = [];
fs.mkdirSync(OUT, { recursive: true });

async function shot(page, name, note) {
	await page.waitForTimeout(400);
	await page.screenshot({ path: path.join(OUT, `${name}.png`) });
	const canvasScroll = await page.evaluate(() => {
		const f = document.querySelector('.graph-ui-canvas .react-flow');
		return f ? [f.scrollLeft, f.scrollTop] : null;
	});
	if (canvasScroll && (canvasScroll[0] || canvasScroll[1]))
		console.log(`WARNING ${name}: canvas container scrolled ${JSON.stringify(canvasScroll)}`);
	log.push({ name, note, ok: true, canvasScroll });
	console.log(`saved ${name}.png — ${note}`);
}

async function step(name, fn) {
	try {
		await fn();
	} catch (e) {
		log.push({ name, ok: false, error: e.message.split('\n')[0] });
		console.log(`FAILED ${name}: ${e.message.split('\n')[0]}`);
	}
}

async function home(page) {
	await page.goto(BASE + '/');
	await page
		.getByText(/connected/i)
		.first()
		.waitFor({ timeout: 20000 });
	const card = page.getByRole('button', { name: 'Open Graph Explorer' });
	if (!(await card.isVisible({ timeout: 4000 }).catch(() => false))) {
		await page
			.getByRole('button', { name: 'Go to home' })
			.first()
			.click()
			.catch(() => {});
		await card.waitFor({ timeout: 15000 });
	}
}

async function setTheme(page, mode) {
	const now = await page.evaluate(() =>
		getComputedStyle(document.documentElement).getPropertyValue('--rr-palette-mode').replace(/['"]/g, '').trim()
	);
	if (now !== mode) {
		await page
			.getByRole('switch', { name: mode === 'dark' ? 'Switch to dark mode' : 'Switch to light mode' })
			.click();
		await page.waitForTimeout(1200);
	}
}

async function openGraph(page, connection) {
	await home(page);
	await page.getByRole('button', { name: 'Open Graph Explorer' }).click();
	await page.getByText(connection, { exact: true }).first().waitFor({ timeout: 45000 });
	await page.getByText(connection, { exact: true }).first().click();
	await page.getByRole('button', { name: 'Open workbench' }).waitFor({ timeout: 30000 });
}

async function openWorkbench(page) {
	await page.getByRole('button', { name: 'Open workbench' }).click();
	await page.locator('.monaco-editor .view-lines').filter({ visible: true }).first().waitFor({ timeout: 45000 });
	await page.waitForTimeout(800);
}

async function typeQuery(page, text) {
	const editor = page.locator('.monaco-editor .view-lines').filter({ visible: true }).first();
	await editor.click();
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.press('Delete');
	await page.keyboard.type(text);
	await page.keyboard.press('Escape'); // close any suggestion widget
}

async function runQuery(page, text, { graph = true } = {}) {
	await typeQuery(page, text);
	await page.keyboard.press(`${MOD}+Enter`);
	if (graph) {
		await page.locator('.react-flow__node').first().waitFor({ timeout: 60000 });
		let last = -1;
		for (let i = 0; i < 40; i++) {
			const c = await page.locator('.react-flow__node').count();
			if (c === last) break;
			last = c;
			await page.waitForTimeout(400);
		}
		await page.waitForTimeout(1500); // fit animation
	} else {
		await page.waitForTimeout(3000);
	}
}

const node = (page, caption) => page.locator(`.react-flow__node[aria-label^="${caption}"]`).first();

// Focus a node as the app's own keyboard model does (focus without scrolling); Space then selects it.
async function focusNode(page, caption) {
	await node(page, caption).evaluate((el) => {
		if (!el.hasAttribute('tabindex')) el.tabIndex = -1;
		el.focus({ preventScroll: true });
	});
	await page.waitForTimeout(300);
}

(async () => {
	const browser = await chromium.launch({ channel: 'chrome' });
	const context = await browser.newContext({ viewport: { width: 1600, height: 1150 }, deviceScaleFactor: 2 });
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e)));

	await E.signIn(page, BASE);
	await page.waitForTimeout(1500);
	await setTheme(page, 'light');

	await step('01-home', async () => {
		await home(page);
		await shot(page, '01-home', 'Shell home: Graph Explorer and SQL Explorer are registered apps');
	});

	// ── Graph Explorer ──────────────────────────────────────────────────────
	await step('02-graph-connections', async () => {
		await page.getByRole('button', { name: 'Open Graph Explorer' }).click();
		await page.getByText('Team graph (FalkorDB)', { exact: true }).first().waitFor({ timeout: 45000 });
		await page.waitForTimeout(1500);
		await shot(
			page,
			'02-graph-connections',
			'Graph Explorer landing: graph tool nodes found in running pipelines (AGE, Neo4j, FalkorDB)'
		);
	});

	await step('03-graph-connection-details', async () => {
		await page.getByText('Team graph (FalkorDB)', { exact: true }).first().click();
		await page.getByRole('button', { name: 'Open workbench' }).waitFor({ timeout: 30000 });
		await page.waitForTimeout(1200);
		await shot(page, '03-graph-connection-details', 'Connection drawer: engine identity, read boundary, tools');
	});

	await step('04-graph-workbench', async () => {
		await openWorkbench(page);
		await shot(page, '04-graph-workbench', 'Workbench: Cypher editor, Ask bar, schema sidebar');
	});

	await step('05-graph-schema-sidebar', async () => {
		const labels = page.getByText('Node labels', { exact: true }).first();
		await labels.click();
		await page.waitForTimeout(800);
		const types = page.getByText(/Relationship types/i).first();
		if (await types.isVisible().catch(() => false)) await types.click().catch(() => {});
		await page.waitForTimeout(800);
		await shot(
			page,
			'05-graph-schema-sidebar',
			'Schema sidebar: node labels and relationship types from the schema snapshot'
		);
	});

	await step('06-graph-canvas', async () => {
		await runQuery(page, 'MATCH (a)-[r]->(b) RETURN a, r, b');
		await shot(
			page,
			'06-graph-canvas',
			'Graph view: the whole demo graph (16 nodes, 35 relationships), coloured by label with a legend'
		);
	});

	await step('06b-graph-people-work', async () => {
		await runQuery(page, 'MATCH (p:Person)-[r:WORKS_AT|CONTRIBUTES_TO]->(x) RETURN p, r, x');
		await shot(page, '06b-graph-people-work', 'Who works where and on what: people, companies and projects');
		await runQuery(page, 'MATCH (a)-[r]->(b) RETURN a, r, b');
	});

	await step('07-graph-node-selected', async () => {
		await focusNode(page, 'Maya Chen');
		await page.keyboard.press('Space');
		await page.waitForTimeout(700);
		await shot(
			page,
			'07-graph-node-selected',
			'A selected node: its relationships are highlighted and the graph actions apply to it'
		);
	});

	await step('08-graph-inspector', async () => {
		await page.getByRole('button', { name: 'Inspect' }).first().click();
		await page.getByRole('button', { name: 'Copy JSON' }).first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(900);
		await shot(page, '08-graph-inspector', 'Inspector: labels, identity, properties and relationships of one node');
		await page.keyboard.press('Escape');
		await page.waitForTimeout(700);
	});

	await step('09-graph-path', async () => {
		// Start from no selection (the node clicked earlier is still selected): Find path needs exactly two.
		const clear = page.getByRole('button', { name: /Clear selection/ }).first();
		if (await clear.isVisible().catch(() => false)) await clear.click();
		await page.waitForTimeout(300);
		for (const caption of ['Sofia Rossi', 'Pune']) {
			await focusNode(page, caption);
			await page.keyboard.press('Space');
			await page.waitForTimeout(250);
		}
		await page.getByRole('button', { name: 'Find path' }).first().click();
		await page.waitForTimeout(3500);
		await shot(
			page,
			'09-graph-path',
			'Find path between two selected nodes (Sofia Rossi to Pune), highlighted on the canvas'
		);
	});

	await step('10-graph-table', async () => {
		await page.getByRole('tab', { name: /Table/ }).first().click();
		await page.waitForTimeout(800);
		await shot(page, '10-graph-table', 'Table view of the same result');
	});

	await step('11-graph-raw', async () => {
		await page.getByRole('tab', { name: /Raw/ }).first().click();
		await page.waitForTimeout(800);
		await shot(page, '11-graph-raw', 'Raw view: the tagged JSON the node returned (@kind node/relationship)');
		await page.getByRole('tab', { name: /Graph/ }).first().click();
		await page.waitForTimeout(800);
	});

	await step('12-graph-expand', async () => {
		await runQuery(page, "MATCH (p:Person {name: 'Maya Chen'}) RETURN p");
		await focusNode(page, 'Maya Chen');
		await page.getByRole('button', { name: 'Expand' }).first().click();
		await page.waitForTimeout(4500);
		await shot(page, '12-graph-expand', 'Expand: one node expanded to its neighbours, with the outcome announced');
	});

	await step('13-graph-history', async () => {
		await page.getByRole('button', { name: 'History' }).first().click();
		await page.waitForTimeout(1200);
		await shot(
			page,
			'13-graph-history',
			'History: every statement run on this connection, with outcome and timing'
		);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(600);
	});

	await step('14-graph-read-only-refusal', async () => {
		await typeQuery(page, "CREATE (:Person {name: 'New hire'})");
		await page.keyboard.press(`${MOD}+Enter`);
		await page.waitForTimeout(2500);
		await shot(
			page,
			'14-graph-read-only-refusal',
			'The browse editor refuses a write; writes only go through the write console'
		);
	});

	await step('15-graph-ask-unavailable', async () => {
		const ask = page.getByRole('textbox', { name: 'Ask a question about this graph' });
		await ask.click();
		await ask.fill('Who works at Northwind Labs?');
		await page.getByRole('button', { name: 'Ask', exact: true }).click();
		await page.waitForTimeout(3000);
		await shot(
			page,
			'15-graph-ask-unavailable',
			'Ask: with no LLM attached to the pipeline, the app says Ask is unavailable and runs nothing'
		);
	});

	await step('16-graph-age', async () => {
		await openGraph(page, 'Team graph (Apache AGE)');
		await page.waitForTimeout(1000);
		await shot(
			page,
			'16a-graph-age-connection',
			'Apache AGE connection: identity and read boundary (read-only transaction)'
		);
		await openWorkbench(page);
		await runQuery(page, 'MATCH (a)-[r]->(b) RETURN a, r, b');
		await shot(page, '16b-graph-age-canvas', 'The same demo graph served by Apache AGE');
	});

	await step('17-graph-neo4j', async () => {
		await openGraph(page, 'Team graph (Neo4j)');
		await page.waitForTimeout(1000);
		await shot(page, '17a-graph-neo4j-connection', 'Neo4j connection: identity and read boundary');
		await openWorkbench(page);
		await runQuery(page, 'MATCH (a {demo: true})-[r]->(b) RETURN a, r, b');
		await shot(page, '17b-graph-neo4j-canvas', 'The same demo graph served by Neo4j');
	});

	await step('18-graph-large', async () => {
		await openGraph(page, 'Large graph, 300 nodes (FalkorDB)');
		await openWorkbench(page);
		await runQuery(
			page,
			'MATCH (n:P) WITH collect(n) AS ns OPTIONAL MATCH (:P)-[r:R]->(:P) RETURN ns, collect(r) AS rs'
		);
		await page.waitForTimeout(1500);
		await shot(page, '18-graph-300-nodes', 'A 300-node, 600-relationship result drawn on the canvas');
	});

	await step('19-graph-write-console', async () => {
		await openGraph(page, 'Team graph admin (FalkorDB, writes allowed)');
		await openWorkbench(page);
		await page.getByRole('button', { name: 'Write console' }).click();
		await page.locator('.monaco-editor .view-lines').filter({ visible: true }).first().waitFor({ timeout: 45000 });
		await page.waitForTimeout(1000);
		await typeQuery(page, "CREATE (:Person {name: 'New hire', role: 'Intern'})");
		await shot(
			page,
			'19a-graph-write-console',
			'Write console: only on nodes that allow execution; nothing is sent before confirmation'
		);
		await page.getByRole('button', { name: 'Execute', exact: true }).click();
		await page.getByRole('dialog').first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(800);
		await shot(
			page,
			'19b-graph-write-confirm',
			'Write confirmation: the statement, a text-check warning and no rollback; Cancel sends nothing'
		);
		await page.getByRole('button', { name: 'Cancel' }).first().click();
		await page.waitForTimeout(600);
	});

	// ── Dark theme ──────────────────────────────────────────────────────────
	await step('20-graph-dark', async () => {
		await home(page);
		await setTheme(page, 'dark');
		await openGraph(page, 'Team graph (FalkorDB)');
		await openWorkbench(page);
		await runQuery(page, 'MATCH (a)-[r]->(b) RETURN a, r, b');
		await shot(page, '20a-graph-canvas-dark', 'Graph view in RocketRide Dark');
		await focusNode(page, 'Northwind Labs');
		await page.getByRole('button', { name: 'Inspect' }).first().click();
		await page.getByRole('button', { name: 'Copy JSON' }).first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(900);
		await shot(page, '20b-graph-inspector-dark', 'Inspector in RocketRide Dark');
		await page.keyboard.press('Escape');
		await home(page);
		await setTheme(page, 'light');
	});

	// ── SQL Explorer ────────────────────────────────────────────────────────
	await step('21-sql-connections', async () => {
		await home(page);
		await page.getByRole('button', { name: 'Open SQL Explorer' }).click();
		await page.getByText('Sales DB (Postgres)', { exact: true }).first().waitFor({ timeout: 45000 });
		await page.waitForTimeout(1500);
		await shot(
			page,
			'21-sql-connections',
			'SQL Explorer on the shared landing: Postgres, Supabase and RocketRide SQL nodes'
		);
	});

	await step('22-sql-connection', async () => {
		await page.getByText('Sales DB admin (Postgres, writes allowed)', { exact: true }).first().click();
		await page.waitForTimeout(2500);
		await shot(
			page,
			'22-sql-connection',
			'SQL connection drawer: pipeline, node, dialect and what the node allows'
		);
	});

	await step('23-sql-query', async () => {
		await page.getByRole('button', { name: 'New Query' }).first().click();
		await page.locator('.monaco-editor .view-lines').filter({ visible: true }).first().waitFor({ timeout: 45000 });
		await runQuery(
			page,
			'SELECT c.name AS customer, p.name AS product, o.quantity, p.price * o.quantity AS total, o.ordered_at ' +
				`FROM ${T}orders o JOIN ${T}customers c ON c.id = o.customer_id ` +
				`JOIN ${T}products p ON p.id = o.product_id ORDER BY o.ordered_at DESC`,
			{ graph: false }
		);
		await shot(
			page,
			'23-sql-query-result',
			'SQL query result (orders joined to customers and products) through the shared statement runner'
		);
	});

	await step('24-sql-write-confirm', async () => {
		// Harmless even if it ran: it sets every price to itself. Without a WHERE it triggers the pattern check.
		await typeQuery(page, `UPDATE ${T}products SET price = price`);
		await page.keyboard.press(`${MOD}+Enter`);
		await page.getByRole('dialog').first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(800);
		await shot(
			page,
			'24-sql-pattern-confirm',
			'SQL Explorer asks before an UPDATE or DELETE without WHERE; Cancel sends nothing'
		);
		const cancel = page.getByRole('button', { name: 'Cancel' }).first();
		if (await cancel.isVisible().catch(() => false)) await cancel.click();
		await page.waitForTimeout(600);
	});

	await step('25-sql-read-only-node', async () => {
		await home(page);
		await page.getByRole('button', { name: 'Open SQL Explorer' }).click();
		await page.getByText('Sales DB (Postgres)', { exact: true }).first().waitFor({ timeout: 45000 });
		await page.getByText('Sales DB (Postgres)', { exact: true }).first().click();
		await page.waitForTimeout(1500);
		await page.getByRole('button', { name: 'New Query' }).first().click();
		await page.locator('.monaco-editor .view-lines').filter({ visible: true }).first().waitFor({ timeout: 45000 });
		await runQuery(page, `SELECT * FROM ${T}orders LIMIT 10`, { graph: false });
		await shot(
			page,
			'25-sql-read-only-node',
			'A SQL node without allow_execute: schema browsing works, statements are refused by the node'
		);
	});

	fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify({ log, pageErrors: errors }, null, 1));
	const saved = log.filter((l) => l.ok).length;
	console.log(`\n${saved} saved, ${log.length - saved} failed, page errors: ${errors.length}`);
	await browser.close();
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
