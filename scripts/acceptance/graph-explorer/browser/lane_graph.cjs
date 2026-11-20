// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Browser lane (production shell served by the real engine): Graph Explorer.
 * Chrome (installed) / Firefox / WebKit (Playwright builds), fresh context each.
 * Fixtures: start_fixtures.py (tools-only AGE / Neo4j / FalkorDB pipelines on the
 * acceptance graphs, allow_execute off). Every step records PASS/FAIL and a screenshot.
 * When falkordb is among the engines, the lane also runs the write console steps
 * (engine "falkordb-write") on the write-enabled FalkorDB fixture and its own graph
 * (WRITE_GRAPH): a CREATE asks first with the focus on Cancel, Cancel sends nothing,
 * Execute statement writes, each proved over the lane's own FalkorDB connection
 * (falkordb_resp.cjs), and the node it wrote is deleted again.
 * Usage: node lane_graph.cjs [base-url] [out-dir] [chrome|firefox|webkit|all] [age,neo4j,falkordb]
 * (base-url and out-dir default to ENGINE_URL and OUT_DIR).
 * Browsers: Chrome lanes use the installed Google Chrome (channel "chrome"); Firefox and
 * WebKit use Playwright builds (`npx playwright install firefox webkit`, optionally under
 * PLAYWRIGHT_BROWSERS_PATH).
 */
'use strict';
// page.evaluate() callbacks run in the browser.
/* global document */
const E = require('../env.cjs');
const R = require('../falkordb_resp.cjs');
const { chromium, firefox, webkit } = E.loadPlaywright();
const fs = require('fs');
const path = require('path');

const [, , base = E.ENGINE_URL, out = E.OUT_DIR, which = 'all', enginesArg = 'neo4j,falkordb,age'] = process.argv;
const ENGINES = { age: E.FIXTURES.age, neo4j: E.FIXTURES.neo4j, falkordb: E.FIXTURES.falkordb };
// What the drawer's Engine row must start with for each engine ("Neo4j 5.26.31 Community").
const ENGINE_ROW = { age: /^Apache AGE \d/, neo4j: /^Neo4j \d/, falkordb: /^FalkorDB \d/ };
const results = [];
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
// Label of the nodes the write console steps create in WRITE_GRAPH (each run adds its own `run` value).
const WRITE_LABEL = 'GxWrite';
// The sentence every write confirmation carries (apps/graph-ui/src/graph/writeConfirm.ts).
const TEXT_CHECK_SENTENCE = 'This is a text check, not a database safeguard.';

function rec(browser, engine, name, ok, detail) {
	results.push({ browser, engine, name, status: ok ? 'PASS' : 'FAIL', detail });
	const suffix = !ok && detail ? ` -- ${String(detail).slice(0, 220)}` : '';
	console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${browser}/${engine}: ${name}${suffix}`);
}

async function step(ctx, name, fn) {
	try {
		// Only an explicit `true` passes: a step that could not check what it names
		// returns false or throws, and anything else is a FAIL too.
		const detail = await fn();
		rec(
			ctx.browser,
			ctx.engine,
			name,
			detail === true,
			detail === true ? undefined : `returned ${JSON.stringify(detail)}`
		);
	} catch (e) {
		rec(ctx.browser, ctx.engine, name, false, e.message.split('\n')[0]);
	}
	await ctx.page
		.screenshot({
			path: path.join(
				out,
				`graph-${ctx.browser}-${ctx.engine}-${name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.png`
			),
		})
		.catch(() => {});
}

/** The value under a label ("Engine", "Writes") in a drawer's text, or null when the drawer has no such row. */
function rowOf(text, label) {
	const lines = String(text)
		.split('\n')
		.map((line) => line.trim());
	const at = lines.findIndex((line) => line.toLowerCase() === label.toLowerCase());
	return at >= 0 && at + 1 < lines.length ? lines[at + 1] : null;
}

async function typeAndRun(page, text) {
	const editor = page.locator('.monaco-editor .view-lines').first();
	if (await editor.isVisible().catch(() => false)) {
		await editor.click();
		await page.keyboard.press(`${MOD}+a`);
		await page.keyboard.press('Delete');
		await page.keyboard.type(text);
	} else {
		const ta = page.getByRole('textbox').first();
		await ta.fill(text);
	}
	await page.keyboard.press(`${MOD}+Enter`);
}

async function runEngine(browserName, launcher, opts, engine) {
	const browser = await launcher.launch(opts);
	const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	const ctx = { browser: browserName, engine, page };
	try {
		await E.signIn(page, base);
		await step(ctx, 'open Graph Explorer, connections listed', async () => {
			await page.getByRole('button', { name: 'Open Graph Explorer' }).click();
			await page.getByText(ENGINES[engine]).first().waitFor({ timeout: 45000 });
			const body = await page.locator('body').innerText();
			return Object.values(ENGINES).every((n) => body.includes(n)) && !/db_postgres|db_supabase/.test(body);
		});
		await step(ctx, 'drawer shows engine identity and opens the workbench', async () => {
			await page.getByText(ENGINES[engine]).first().click();
			const openWorkbench = page.getByRole('button', { name: 'Open workbench' });
			await openWorkbench.waitFor({ timeout: 30000 });
			// Read the drawer's own Engine row (filled from the node's dialect answer). The
			// landing behind the drawer names every engine, in its subtitle and on the cards.
			const drawer = page.locator('[role="dialog"]').filter({ has: openWorkbench }).first();
			await drawer
				.getByText(ENGINE_ROW[engine])
				.first()
				.waitFor({ timeout: 30000 })
				.catch(() => {});
			const row = rowOf(await drawer.innerText(), 'Engine');
			await openWorkbench.click();
			await page.locator('.monaco-editor .view-lines, textarea').first().waitFor({ timeout: 45000 });
			return row !== null && ENGINE_ROW[engine].test(row) ? true : `Engine row: ${JSON.stringify(row)}`;
		});
		await step(ctx, 'Cmd/Ctrl+Enter path query draws nodes on the canvas', async () => {
			await typeAndRun(page, "MATCH p = (a:Person {name: 'Ada GX'})-[:KNOWS*2]->(c) RETURN p");
			await page.locator('.react-flow__node').nth(2).waitFor({ timeout: 60000 });
			return (await page.locator('.react-flow__node').count()) >= 3;
		});
		await step(ctx, 'Table tab shows the path row', async () => {
			await page.getByRole('tab', { name: 'Table' }).click();
			await page.waitForTimeout(500);
			return /Ada GX|path|Charles GX/i.test(await page.locator('body').innerText());
		});
		await step(ctx, 'Raw tab shows tagged JSON', async () => {
			await page.getByRole('tab', { name: 'Raw' }).click();
			await page.waitForTimeout(500);
			return (await page.locator('body').innerText()).includes('@kind');
		});
		await step(ctx, 'inspector opens on a node with labels and Copy JSON', async () => {
			await page.getByRole('tab', { name: 'Graph' }).click();
			await page.locator('.react-flow__node').first().waitFor({ timeout: 20000 });
			// A click selects (toolbar shows "Focused: …"); Inspect (or Enter) opens the inspector.
			await page.locator('.react-flow__node').first().click();
			await page.getByRole('button', { name: 'Inspect' }).first().click();
			await page.getByRole('button', { name: 'Copy JSON' }).first().waitFor({ timeout: 15000 });
			await page.waitForTimeout(700); // drawer slide-in
			const text = await page.locator('body').innerText();
			const ok = /identity/i.test(text) && /labels/i.test(text) && /propert/i.test(text);
			await page.screenshot({ path: path.join(out, `graph-${ctx.browser}-${ctx.engine}-inspector-open.png`) });
			return ok;
		});
		await step(ctx, 'Escape closes the inspector (modal dialog)', async () => {
			const dialog = page.locator('[role="dialog"][aria-modal="true"]').first();
			// Escape can only be shown to close the inspector if the inspector was open.
			if (!(await dialog.isVisible().catch(() => false)))
				throw new Error('inspector dialog not open before Escape');
			await page.keyboard.press('Escape');
			await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
			if (await dialog.isVisible().catch(() => false)) {
				// Close it with its Close button so the rest of the lane can continue.
				await page.getByRole('button', { name: 'Close' }).last().click();
				await page.waitForTimeout(900);
				return false;
			}
			return true;
		});
		await step(ctx, 'Expand runs and reports an outcome', async () => {
			const before = await page.locator('.react-flow__node').count();
			await page.getByRole('button', { name: 'Expand' }).first().click();
			await page.waitForTimeout(4000);
			const after = await page.locator('.react-flow__node').count();
			const text = await page.locator('body').innerText();
			return after >= before && /neighbour|added|No new/i.test(text);
		});
		await step(ctx, 'schema Refresh reports freshness', async () => {
			await page.getByRole('button', { name: 'Refresh' }).first().click();
			await page
				.getByText(/refreshed|just now/i)
				.first()
				.waitFor({ timeout: 90000 });
			return true;
		});
		await step(ctx, 'History lists the statement', async () => {
			await page.getByRole('button', { name: 'History' }).first().click();
			await page.waitForTimeout(1000);
			return (await page.locator('body').innerText()).includes("name: 'Ada GX'");
		});
		await step(ctx, 'browse editor refuses a write with the text-check sentence', async () => {
			await page.keyboard.press('Escape');
			await typeAndRun(page, 'CREATE (:Intruder {x: 1})');
			await page
				.getByText(/text check, not a database safeguard/i)
				.first()
				.waitFor({ timeout: 20000 });
			return true;
		});
		await step(ctx, 'Ask without an LLM shows an unavailable note, not an error', async () => {
			const ask = page.getByLabel('Ask a question about this graph');
			if (!(await ask.isVisible().catch(() => false))) throw new Error('ask bar not visible');
			await ask.fill('who knows Ada?');
			await ask.press('Enter');
			await page.waitForTimeout(6000);
			const text = await page.locator('body').innerText();
			return /unavailable|language model|LLM/i.test(text);
		});
		rec(browserName, engine, 'no uncaught page errors', errors.length === 0, errors.join(' | '));
	} catch (e) {
		rec(browserName, engine, 'lane completed', false, e.message.split('\n')[0]);
	} finally {
		await browser.close();
	}
}

// The write console of the write-enabled FalkorDB fixture. The app sends every statement
// as an `execute` tool call; the lane counts those on the page's WebSocket by count only
// (frames carry task tokens, so none is kept) and reads the database over its own
// connection, never through the engine.
async function runWriteConsole(browserName, launcher, opts) {
	const browser = await launcher.launch(opts);
	const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	const ctx = { browser: browserName, engine: 'falkordb-write', page };
	const run = `gxw_${browserName}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	const statement = `CREATE (:${WRITE_LABEL} {run: '${run}'})`;
	const sent = { frames: 0, executes: 0 };
	page.on('websocket', (ws) =>
		ws.on('framesent', (frame) => {
			sent.frames += 1;
			const text = typeof frame.payload === 'string' ? frame.payload : '';
			if (/"tool"\s*:\s*"execute"/.test(text) && text.includes(run)) sent.executes += 1;
		})
	);
	const inDatabase = () => R.countByRun(E.FALKORDB, E.WRITE_GRAPH, WRITE_LABEL, run);
	const confirmation = page.locator('[role="dialog"]').filter({ hasText: TEXT_CHECK_SENTENCE }).first();
	const editor = page.locator('.monaco-editor .view-lines').filter({ visible: true }).first();
	try {
		await E.signIn(page, base);
		await step(ctx, 'write console opens on the write-enabled connection', async () => {
			await page.getByRole('button', { name: 'Open Graph Explorer' }).click();
			await page.getByText(E.FIXTURES.falkordbWrite).first().click();
			const openWorkbench = page.getByRole('button', { name: 'Open workbench' });
			await openWorkbench.waitFor({ timeout: 30000 });
			const drawer = page.locator('[role="dialog"]').filter({ has: openWorkbench }).first();
			await drawer
				.getByText(/^Allowed/)
				.first()
				.waitFor({ timeout: 30000 })
				.catch(() => {});
			const writes = rowOf(await drawer.innerText(), 'Writes');
			await openWorkbench.click();
			await page.getByRole('button', { name: 'Write console' }).click();
			await page.getByRole('button', { name: 'Execute', exact: true }).waitFor({ timeout: 45000 });
			await editor.waitFor({ state: 'visible', timeout: 45000 });
			return /^Allowed/.test(writes || '') ? true : `Writes row: ${JSON.stringify(writes)}`;
		});
		await step(ctx, 'a CREATE opens the confirmation with focus on Cancel', async () => {
			await editor.click();
			await page.keyboard.press(`${MOD}+a`);
			await page.keyboard.press('Delete');
			await page.keyboard.type(statement);
			await page.keyboard.press(`${MOD}+Enter`);
			await confirmation.waitFor({ timeout: 15000 });
			await page.waitForTimeout(300); // the dialog moves the focus to Cancel when it mounts
			// The focused control must be inside the confirmation itself: the drawer
			// is a dialog too, so a Cancel focused anywhere else must not pass.
			const focus = await confirmation.evaluate(function focusedControl(dialog) {
				const el = document.activeElement;
				return el
					? { tag: el.tagName, text: (el.textContent || '').trim(), inConfirmation: dialog.contains(el) }
					: null;
			});
			const listed = (await confirmation.innerText()).includes(run);
			const ok = !!focus && focus.tag === 'BUTTON' && focus.text === 'Cancel' && focus.inConfirmation && listed;
			return ok ? true : `focus ${JSON.stringify(focus)}; statement listed ${listed}`;
		});
		await step(ctx, 'Cancel sends nothing', async () => {
			if (!(await confirmation.isVisible().catch(() => false)))
				throw new Error('confirmation not open before Cancel');
			await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
			await page.waitForTimeout(2000);
			const closed = !(await confirmation.isVisible().catch(() => false));
			const nodes = await inDatabase();
			// frames > 0 shows the lane sees the socket the app sends its tool calls on.
			const ok = closed && sent.frames > 0 && sent.executes === 0 && nodes === 0;
			return ok
				? true
				: `dialog closed ${closed}; frames seen ${sent.frames}; execute calls ${sent.executes}; ` +
						`nodes in the database ${nodes}`;
		});
		await step(ctx, 'Execute statement writes it to the database', async () => {
			await page.getByRole('button', { name: 'Execute', exact: true }).click();
			await confirmation.waitFor({ timeout: 15000 });
			await confirmation.getByRole('button', { name: 'Execute statement', exact: true }).click();
			let nodes = await inDatabase();
			for (let i = 0; i < 30 && nodes < 1; i++) {
				await page.waitForTimeout(500);
				nodes = await inDatabase();
			}
			await page.waitForTimeout(1000); // a retried write would be a second call
			return sent.executes === 1 && nodes === 1
				? true
				: `execute calls ${sent.executes}; nodes in the database ${nodes}`;
		});
		rec(browserName, ctx.engine, 'no uncaught page errors', errors.length === 0, errors.join(' | '));
	} catch (e) {
		rec(browserName, ctx.engine, 'lane completed', false, e.message.split('\n')[0]);
	} finally {
		await step(ctx, 'clean-up removes the written node', async () => {
			await R.deleteByRun(E.FALKORDB, E.WRITE_GRAPH, WRITE_LABEL, run);
			const left = await inDatabase();
			return left === 0 ? true : `nodes left ${left}`;
		});
		await browser.close();
	}
}

(async () => {
	fs.mkdirSync(out, { recursive: true });
	const lanes = { chrome: [chromium, { channel: 'chrome' }], firefox: [firefox, {}], webkit: [webkit, {}] };
	for (const [name, [launcher, opts]] of Object.entries(lanes)) {
		if (which !== 'all' && which !== name) continue;
		for (const engine of enginesArg.split(',')) {
			console.log(`== ${name} / ${engine}`);
			await runEngine(name, launcher, opts, engine);
		}
		if (enginesArg.split(',').includes('falkordb')) {
			console.log(`== ${name} / falkordb-write`);
			await runWriteConsole(name, launcher, opts);
		}
	}
	fs.writeFileSync(path.join(out, 'lane_graph.json'), JSON.stringify(results, null, 1));
	const failed = results.filter((r) => r.status !== 'PASS').length;
	console.log(`== ${results.length - failed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
