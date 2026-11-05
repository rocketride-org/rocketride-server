// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Browser lane (production shell served by the real engine): Vector Explorer's
 * Map tab, gate G4. Chrome (installed, channel "chrome"), one fresh context.
 *
 * Fixtures: start_fixtures.py with demo/seed_demo.sh (the demo corpus in the
 * Qdrant fixture, argument, default qdrant) and --pager (qdrant_pager, 1,500
 * one-chunk documents, for the steps that need more than 1,000 points). The
 * lane only reads; it never adds or removes a document.
 *
 * Steps (each records PASS/FAIL, what it measured, and a screenshot; only an
 * explicit `true` passes). "The page's answer" is the tool answer the page
 * received, read from its WebSocket frames; "the store" is read through the
 * TypeScript client with the fixture's Tools token, never through the page.
 *   detailed: the canvas draws sample.n points (the page's sample answer),
 *     n = min(requested, the store's chunks), with snippets
 *   light: after choosing a light size, the canvas draws the light answer's
 *     n points and the answer carries no text
 *   hover: a tooltip names the document of a sampled point
 *   click: the inspector lists the point's 12 nearest chunks (a neighbors
 *     call with k 12 for that point's key, 12 links drawn)
 *   lasso: around the whole canvas it selects every point; around its left
 *     half fewer, and the Selection count agrees with the canvas
 *   query: Run embeds on embed_1, projects and searches with that exact
 *     vector; the star is drawn with one ray per result, and the results are
 *     the store's own top-k for that vector
 *   table: the Table alternative lists every point and inspects one
 *   chunk path: the long manual's points in the sample, drawn as its path
 *     (Open document, then "Show chunk path on map")
 *   duplicates: the panel lists the sample's pairs, both planted
 *     near-duplicate pairs among them
 *   outliers: the panel lists the sample's outliers, the OCR scan first
 *   keyboard: arrows move to the nearest point in the arrow's 90° sector
 *     (checked against the sample's PCA coordinates), Enter inspects and is
 *     announced, Escape clears
 *   kNN overlap: the neighbour-graph layout is kept only when its overlap is
 *     at least PCA's, else PCA stays with the sentence; both numbers are
 *     recorded in the lane JSON
 *   legend: names who computed the sample's kNN graph: "neighbour graph
 *     computed by Qdrant" on the qdrant fixture, whose graph must be Qdrant's
 *     own (Qdrant computes it for samples of up to 500 points); "neighbour
 *     graph computed by the store node" on a store that has no graph of its
 *     own, and never the backend's name for a graph the store node computed
 *   t-SNE: refused for a sample above 1,000 points, offered at 1,000
 *     (qdrant_pager)
 *   Cancel: stops a running layout and leaves PCA (qdrant_pager)
 *   privacy (B4): as in lane_vector.cjs, over this lane's frames
 *
 * The frame-time gate (2,000 points at 4x CPU throttle, p95 frame <= 33 ms)
 * is the performance lane's (lane_vector_perf.cjs), not this one's.
 * Selectors, wording and the canvas data attributes: ui.cjs.
 *
 * Usage: node lane_vector_map.cjs [base-url] [out-dir] [fixture]
 *   (base-url and out-dir default to ENGINE_URL and OUT_DIR; fixture is a key of
 *   env.cjs FIXTURES holding the demo corpus, default qdrant).
 */
'use strict';
const E = require('../env.cjs');
const C = require('./common.cjs');
const { CONSOLE, MAP } = require('./ui.cjs');
const fs = require('fs');
const path = require('path');

const [, , base = E.ENGINE_URL, out = E.OUT_DIR, fixtureKey = 'qdrant'] = process.argv;
const RESULTS = 'lane_vector_map.json';
const BACKEND_NAMES = {
	qdrant: 'Qdrant',
	qdrant_pager: 'Qdrant',
	postgres: 'pgvector',
	rocketride_vector: 'pgvector',
	chroma: 'Chroma',
};

// ---------------------------------------------------------------------------
// Helpers that need no browser
// ---------------------------------------------------------------------------

/** The document path of sample point i (null when there is none). */
function pathOf(sample, i) {
	const doc = sample && sample.docs ? sample.docs[sample.points.doc[i]] : null;
	return doc ? doc.path : null;
}

/** The (objectId, chunkId) key of sample point i, as the app builds it. */
function keyOf(sample, i) {
	const doc = sample.docs[sample.points.doc[i]];
	return [doc ? doc.objectId : '', sample.points.chunk[i]];
}

/** Indices of the sample points whose document path ends with `suffix`. */
function pointsOf(sample, suffix) {
	const out = [];
	for (let i = 0; i < sample.points.doc.length; i += 1) {
		const p = pathOf(sample, i);
		if (p && (p === suffix || p.endsWith('/' + suffix))) out.push(i);
	}
	return out;
}

/**
 * Where an arrow key must move the keyboard focus from point `from`: the
 * nearest point inside the arrow's 90° sector, in the layout's world
 * coordinates (x right, y up; the map's 2D camera scales both axes alike and
 * flips y, so the screen's sectors and distances follow). null for none.
 */
function sectorTarget(xs, ys, from, direction) {
	let best = null;
	let bestD = Infinity;
	for (let j = 0; j < xs.length; j += 1) {
		if (j === from) continue;
		const dx = xs[j] - xs[from];
		const dy = ys[j] - ys[from];
		const inSector =
			direction === 'right'
				? dx > 0 && Math.abs(dy) <= dx
				: direction === 'left'
					? dx < 0 && Math.abs(dy) <= -dx
					: direction === 'up'
						? dy > 0 && Math.abs(dx) <= dy
						: dy < 0 && Math.abs(dx) <= -dy;
		if (!inSector) continue;
		const d = dx * dx + dy * dy;
		if (d < bestD) {
			best = j;
			bestD = d;
		}
	}
	return best;
}

/**
 * Whether the map kept the right layout after a neighbour-graph refinement:
 * true, or why not. pca/refined are the kNN overlaps, shown the layout drawn,
 * notBetter whether "Neighbour layout did not improve on PCA" is shown.
 */
function layoutVerdict({ pca, refined, shown, notBetter }) {
	if (typeof pca !== 'number' || typeof refined !== 'number')
		return `the kNN overlap numbers are missing (PCA ${pca}, refined ${refined})`;
	if (refined >= pca) {
		if (shown !== 'neighbour-graph')
			return `overlap ${refined} >= PCA ${pca} but the refined layout was dropped (shown: ${shown})`;
		return notBetter ? 'the refined layout is shown with "did not improve" beside it' : true;
	}
	if (shown !== 'pca') return `overlap ${refined} < PCA ${pca} but the refined layout was kept (shown: ${shown})`;
	return notBetter ? true : 'PCA stayed but the map did not say the neighbour layout did not improve';
}

/**
 * The legend step's verdict: the legend names who computed the sample's kNN
 * graph. The qdrant fixture's graph must be Qdrant's own; a graph the store
 * node computed is named as the store node's, never the backend's.
 */
function legendVerdict({ fixtureKey, knnSource, text }) {
	const backend = BACKEND_NAMES[fixtureKey];
	if (fixtureKey === 'qdrant' && knnSource !== 'native')
		return `the Qdrant sample's kNN graph is ${knnSource}, not Qdrant's own`;
	if (knnSource === 'native')
		return MAP.nativeGraph(backend).test(text)
			? true
			: `the legend does not say "neighbour graph computed by ${backend}"`;
	if (knnSource !== 'node') return `the sample's knn_source is ${knnSource}, neither native nor node`;
	if (backend && MAP.nativeGraph(backend).test(text))
		return `the legend claims "neighbour graph computed by ${backend}" for the store node's graph`;
	return MAP.nodeGraph.test(text) ? true : 'the legend does not say "neighbour graph computed by the store node"';
}

/** The planted pairs no row names both halves of (a path matches whole, after a '/'). */
function missingPairs(rows, pairs) {
	const names = (row, rel) => new RegExp(`(^|/)${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(row);
	return pairs.filter(([a, b]) => !rows.some((row) => names(row, a) && names(row, b)));
}

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------

async function main() {
	const { chromium } = E.loadPlaywright();
	const fixture = E.FIXTURES[fixtureKey];
	if (!fixture) throw new Error(`unknown fixture ${fixtureKey}; known: ${Object.keys(E.FIXTURES).join(', ')}`);
	const pager = E.FIXTURES.qdrant_pager;
	const { step, write } = C.createRecorder(fixtureKey, out, 'vector-map');
	const store = C.storeClient(base);
	const browser = await chromium.launch({ channel: 'chrome', headless: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
	const page = await context.newPage();
	page.setDefaultTimeout(30000);
	const capture = C.captureFrames(page);
	// Every open connection keeps its console and its map mounted, hidden behind the one in front, so
	// each locator is scoped to the visible map root (the canvas itself is hidden under the Table).
	const map = page.locator(MAP.root).filter({ visible: true }).first();
	const canvas = map.locator(MAP.canvas).first();
	const toolbar = map.getByRole('toolbar', { name: MAP.toolbar }).first();
	const samplePicker = map.getByRole('combobox', { name: MAP.samplePicker }).first();
	const layoutPicker = map.getByRole('combobox', { name: MAP.layoutPicker }).first();
	const inspector = map.getByRole('region', { name: MAP.inspector }).first();

	/** Wait until a canvas attribute (as an integer) satisfies ok; its last value. */
	const pollInt = async (attr, ok, timeout = 15000) => {
		const deadline = Date.now() + timeout;
		for (;;) {
			if (capture.sockets === 0) throw new Error('the page opened no WebSocket');
			const v = await C.attrInt(canvas, attr);
			if (ok(v) || Date.now() > deadline) return v;
			await C.sleep(200);
		}
	};
	/** The options of a select, as shown. */
	const optionsOf = async (select) => {
		const texts = await select
			.locator('option')
			.allTextContents()
			.catch(() => null);
		return Array.isArray(texts) ? texts.map((t) => String(t).trim()) : [];
	};
	/** Choose a sample size by its option text; the page's answer to the sample it asks for. */
	const chooseSample = async (matches, where) => {
		const label = (await optionsOf(samplePicker)).find(matches);
		if (!label)
			throw new Error(`no sample size matches ${matches} among ${JSON.stringify(await optionsOf(samplePicker))}`);
		const since = capture.frames.length;
		await samplePicker.selectOption({ label });
		return C.waitForExchange(capture, 'sample', { since, timeout: 120000, where });
	};
	/** Open a fixture's connection and its Map tab; the page's first sample answer there. */
	const openMap = async (target) => {
		const since = capture.frames.length;
		await C.openConnection(page, target);
		await C.switchView(page, CONSOLE.mapTab);
		await canvas.waitFor({ timeout: 90000 });
		return C.waitForExchange(capture, 'sample', { since, timeout: 120000 });
	};
	/** Drag a closed lasso through the given page points. */
	const lassoThrough = async (corners) => {
		await page.mouse.move(corners[0][0], corners[0][1]);
		await page.mouse.down();
		for (const [x, y] of [...corners.slice(1), corners[0]]) await page.mouse.move(x, y, { steps: 10 });
		await page.mouse.up();
	};
	/** Wait until the layout busy line is gone (at most `timeout`). */
	const layoutSettled = async (timeout) => {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if (!MAP.layoutBusy.test(await C.textOf(toolbar))) return true;
			await C.sleep(250);
		}
		return false;
	};

	let sample = null; // the page's current detailed sample answer (demo fixture)
	let hover = null; // a page position over a sampled point
	try {
		await E.signIn(page, base);

		await step(page, 'detailed: the map draws sample.n points', async (note) => {
			const x = await openMap(fixture);
			const r = x.result;
			if (!r || r.success !== true) return `sample answered ${JSON.stringify(r).slice(0, 200)}`;
			const drawn = await pollInt(MAP.attr.points, (v) => v === r.n);
			const stats = await store.tool(fixture, 'stats', { mode: 'full' });
			note({
				n: r.n,
				n_requested: r.n_requested,
				chunks: stats && stats.chunks,
				drawn,
				mode: r.mode,
				knn_source: r.knn_source,
			});
			if (r.mode !== 'detailed' || (x.input.mode && x.input.mode !== 'detailed'))
				return `the first sample is ${r.mode}, not detailed`;
			if (!(r.n > 0)) return 'the sample is empty (is the demo corpus seeded?)';
			if (drawn !== r.n) return `the canvas drew ${drawn} points, the sample has ${r.n}`;
			if (!(stats && stats.success === true) || r.n !== Math.min(r.n_requested, stats.chunks))
				return `sample.n ${r.n} is not min(${r.n_requested}, ${stats && stats.chunks} chunks)`;
			if (!Array.isArray(r.points.snip) || r.points.snip.length !== r.n)
				return 'a detailed sample without snippets';
			if ((await C.attrText(canvas, MAP.attr.mode)) !== 'detailed') return 'the canvas does not say detailed';
			sample = r;
			return true;
		});

		await step(page, 'light: the map draws the light sample.n points, without text', async (note) => {
			if (!sample) return 'no detailed sample (first step)';
			const x = await chooseSample(
				(t) => MAP.lightOption.test(t),
				(e) => e.input.mode === 'light'
			);
			const r = x.result;
			const drawn = await pollInt(MAP.attr.points, (v) => v === (r && r.n));
			note({ n: r && r.n, n_requested: r && r.n_requested, drawn });
			if (!r || r.success !== true || r.mode !== 'light')
				return `the light sample answered ${JSON.stringify(r).slice(0, 200)}`;
			if (!(r.n > 0) || drawn !== r.n) return `the canvas drew ${drawn} points, the light sample has ${r.n}`;
			if (r.n !== Math.min(r.n_requested, sample.of.chunks))
				return `light n ${r.n} is not min(${r.n_requested}, ${sample.of.chunks})`;
			if (r.points.snip && r.points.snip.length) return 'the light sample carries text';
			if ((await C.attrText(canvas, MAP.attr.mode)) !== 'light') return 'the canvas does not say light';
			// Back to the default detailed sample for the steps below.
			const back = await chooseSample(
				(t) => MAP.detailedOption.test(t) && t.startsWith(MAP.defaultSample.toLocaleString('en-US')),
				(e) => (e.input.mode || 'detailed') === 'detailed'
			);
			if (!back.result || back.result.success !== true) return 'the detailed sample did not come back';
			sample = back.result;
			return (await pollInt(MAP.attr.points, (v) => v === sample.n)) === sample.n
				? true
				: 'the detailed sample was not drawn again';
		});

		await step(page, 'hover: a tooltip names the sampled document under the pointer', async (note) => {
			if (!sample) return 'no sample';
			await toolbar.getByRole('button', { name: MAP.fit }).first().click();
			const box = await canvas.boundingBox();
			if (!box || !(box.width > 0 && box.height > 0)) return 'the map canvas has no size';
			const tooltip = page.locator(MAP.tooltip).first();
			for (let gy = 1; gy < 14 && !hover; gy += 1) {
				for (let gx = 1; gx < 20 && !hover; gx += 1) {
					const x = box.x + (box.width * gx) / 20;
					const y = box.y + (box.height * gy) / 14;
					await page.mouse.move(x, y);
					await C.sleep(40);
					if ((await tooltip.isVisible().catch(() => false)) && (await C.textOf(tooltip)).trim())
						hover = { x, y };
				}
			}
			if (!hover) return 'no tooltip appeared anywhere over the canvas';
			const text = await C.textOf(tooltip);
			note({ tooltip: text.slice(0, 200) });
			const paths = sample.docs.map((d) => d.path);
			return paths.some((p) => text.includes(p) || text.includes(p.split('/').pop()))
				? true
				: `the tooltip ${JSON.stringify(text.slice(0, 80))} names no sampled document`;
		});

		await step(page, 'click: the inspector lists the 12 nearest chunks', async (note) => {
			if (!sample || !hover) return 'no point under the pointer (hover step)';
			const since = capture.frames.length;
			await page.mouse.click(hover.x, hover.y);
			const x = await C.waitForExchange(capture, 'neighbors', { since, timeout: 60000 });
			const selected = await pollInt(MAP.attr.selected, (v) => v !== null);
			const list = map.getByRole('list', { name: MAP.neighbourList }).first();
			await list.waitFor({ timeout: 30000 });
			const rows = await list.locator('li').count();
			const links = await pollInt(MAP.attr.links, (v) => v === 12);
			const items = x.result && Array.isArray(x.result.items) ? x.result.items.length : null;
			note({ k: x.input.k, items, rows, links, selected });
			if (x.input.k !== 12) return `the page asked for k=${x.input.k}`;
			if (selected === null || JSON.stringify(x.input.key) !== JSON.stringify(keyOf(sample, selected)))
				return `neighbours of ${JSON.stringify(x.input.key)}, but point ${selected} is selected`;
			if (items !== 12) return `the store answered ${items} neighbours`;
			if (rows !== 12) return `the inspector lists ${rows} neighbours`;
			if (links !== 12) return `the canvas drew ${links} neighbour links`;
			return (await C.textOf(inspector)).includes(pathOf(sample, selected))
				? true
				: 'the inspector does not name the selected document';
		});

		await step(page, 'lasso: the selection count follows the points inside it', async (note) => {
			if (!sample) return 'no sample';
			const n = await C.attrInt(canvas, MAP.attr.points);
			await toolbar.getByRole('button', { name: MAP.fit }).first().click();
			const box = await canvas.boundingBox();
			if (!box || !(box.width > 0 && box.height > 0)) return 'the map canvas has no size';
			const lasso = toolbar.getByRole('button', { name: MAP.lasso }).first();
			await lasso.click();
			if ((await C.attrText(lasso, 'aria-pressed')) !== 'true') return 'Lasso is not pressed after a click';
			const [l, t, r, b] = [box.x + 2, box.y + 2, box.x + box.width - 2, box.y + box.height - 2];
			const counted = async (previous) => {
				const onCanvas = await pollInt(MAP.attr.selection, (v) => v !== null && v !== previous);
				await C.switchView(page, MAP.tabs.selection);
				const m = MAP.selectionCount.exec(await C.bodyText(page));
				return { onCanvas, shown: m ? Number(m[1].replace(/,/g, '')) : null };
			};
			await lassoThrough([
				[l, t],
				[r, t],
				[r, b],
				[l, b],
			]);
			const all = await counted(null);
			await lassoThrough([
				[l, t],
				[box.x + box.width / 2, t],
				[box.x + box.width / 2, b],
				[l, b],
			]);
			const half = await counted(all.onCanvas);
			await lasso.click();
			note({ n, all, half });
			if (!(n > 0)) return 'the canvas drew no points';
			if (all.onCanvas !== n || all.shown !== n)
				return `a lasso around the whole canvas selected ${all.onCanvas} (shown ${all.shown}) of ${n}`;
			if (!(half.onCanvas > 0 && half.onCanvas < n))
				return `a lasso around the left half selected ${half.onCanvas} of ${n}`;
			return half.shown === half.onCanvas
				? true
				: `the Selection tab says ${half.shown}, the canvas ${half.onCanvas}`;
		});

		await step(page, 'query: Run draws the star and rays to the true top-k', async (note) => {
			if (!sample) return 'no sample';
			await toolbar.getByPlaceholder(MAP.queryBox).first().fill(E.WATER_QUESTION);
			const since = capture.frames.length;
			await toolbar.getByRole('button', { name: MAP.run }).first().click();
			const embed = await C.waitForExchange(capture, 'embed', { since, timeout: 90000 });
			const vector = embed.result && Array.isArray(embed.result.vectors) ? embed.result.vectors[0] : null;
			if (!Array.isArray(vector) || !vector.length)
				return `embed answered ${JSON.stringify(embed.result).slice(0, 200)}`;
			const project = await C.waitForExchange(capture, 'project', {
				since,
				where: (e) => C.sameVector(e.input.vector, vector),
			});
			const search = await C.waitForExchange(capture, 'search', {
				since,
				where: (e) => C.sameVector(e.input.vector, vector),
			});
			const star = await pollInt(MAP.attr.star, (v) => v === 1);
			const results = search.result && Array.isArray(search.result.results) ? search.result.results : [];
			const rays = await pollInt(MAP.attr.rays, (v) => v === results.length);
			const truth = await store.tool(fixture, 'search', {
				vector,
				top_k: search.input.top_k,
				include_below_floor: true,
			});
			const keys = (rows) =>
				(rows || []).map((row) => `${(row.metadata || {}).objectId}#${(row.metadata || {}).chunkId}`);
			note({
				embed_node: embed.nodeId,
				top_k: search.input.top_k,
				results: results.length,
				star,
				rays,
				page_keys: keys(results).slice(0, 5),
				store_keys: keys(truth && truth.results).slice(0, 5),
			});
			if (embed.nodeId !== 'embed_1') return `the query was embedded on ${embed.nodeId}, not embed_1`;
			if (!project.result || project.result.success !== true)
				return `project answered ${JSON.stringify(project.result).slice(0, 200)}`;
			if (search.input.include_below_floor !== true) return 'the top-k search hides below-floor rows';
			if (!results.length) return 'the search returned no rows';
			if (star !== 1) return 'no query star is drawn';
			if (rays !== results.length) return `${rays} rays for ${results.length} results`;
			return JSON.stringify(keys(results)) === JSON.stringify(keys(truth && truth.results))
				? true
				: "the rays do not go to the store's own top-k for this vector";
		});

		await step(page, 'table: the Table alternative lists every point and inspects one', async (note) => {
			if (!sample) return 'no sample';
			const table = toolbar.getByRole('button', { name: MAP.table }).first();
			await table.click();
			await map.getByText(MAP.tableCaption).first().waitFor({ timeout: 15000 });
			const m = MAP.tableRows.exec(await C.bodyText(page));
			const total = m ? Number(m[3].replace(/,/g, '')) : null;
			await map
				.getByRole('button', { name: MAP.inspectPoint(0), exact: true })
				.first()
				.click();
			const selected = await pollInt(MAP.attr.selected, (v) => v === 0);
			const text = await C.textOf(inspector);
			await table.click();
			note({ total, n: sample.n, selected });
			if (total !== sample.n) return `the table has ${total} rows for ${sample.n} points`;
			if (selected !== 0) return `inspecting row 1 selected point ${selected}`;
			return text.includes(pathOf(sample, 0)) ? true : "the inspector does not name the first point's document";
		});

		await step(page, "chunk path: the long manual's sampled chunks are drawn as its path", async (note) => {
			if (!sample) return 'no sample';
			const points = pointsOf(sample, E.DEMO_CORPUS.longManual);
			if (points.length < 2) return `the sample has ${points.length} points of ${E.DEMO_CORPUS.longManual}`;
			const i = points[0];
			const table = toolbar.getByRole('button', { name: MAP.table }).first();
			await table.click();
			for (let p = 0; p < Math.floor(i / 100); p += 1)
				await map.getByRole('button', { name: MAP.next }).first().click();
			await map
				.getByRole('button', { name: MAP.inspectPoint(i), exact: true })
				.first()
				.click();
			await table.click();
			await inspector.getByRole('button', { name: MAP.openDocument }).first().click();
			// The document tab is in front now; its "Show chunk path on map" must bring the map back by itself.
			await page.getByRole('button', { name: MAP.showChunkPath }).filter({ visible: true }).first().click();
			await canvas.waitFor({ timeout: 10000 }).catch(() => {});
			const inFront = await canvas.isVisible().catch(() => false);
			const drawn = inFront ? await pollInt(MAP.attr.chunkPath, (v) => v === points.length) : null;
			note({ document: pathOf(sample, i), in_sample: points.length, map_in_front: inFront, drawn });
			if (!inFront)
				return 'the map is not in front after "Show chunk path on map" (the document tab stayed in front)';
			return drawn === points.length
				? true
				: `the path has ${drawn} points; the sample holds ${points.length} of that document`;
		});

		await step(
			page,
			"duplicates: the panel lists the sample's pairs, the planted near-duplicates among them",
			async (note) => {
				if (!sample) return 'no sample';
				await C.switchView(page, MAP.tabs.duplicates);
				const list = map.getByRole('list', { name: MAP.duplicatesList }).first();
				await list.waitFor({ timeout: 15000 });
				const rows = await list.locator('li').allInnerTexts();
				const missing = missingPairs(Array.isArray(rows) ? rows : [], E.DEMO_CORPUS.nearDuplicates);
				note({ rows: Array.isArray(rows) ? rows.length : null, in_sample: sample.duplicates.length, missing });
				if (!Array.isArray(rows) || rows.length !== sample.duplicates.length || !rows.length)
					return `${Array.isArray(rows) ? rows.length : 'no'} rows for ${sample.duplicates.length} pairs`;
				return missing.length === 0 ? true : `planted pairs not listed: ${JSON.stringify(missing)}`;
			}
		);

		await step(page, "outliers: the panel lists the sample's outliers, the OCR scan first", async (note) => {
			if (!sample) return 'no sample';
			await C.switchView(page, MAP.tabs.outliers);
			const list = map.getByRole('list', { name: MAP.outliersList }).first();
			await list.waitFor({ timeout: 15000 });
			const rows = await list.locator('li').allInnerTexts();
			const first = sample.outliers.length ? pathOf(sample, sample.outliers[0]) : null;
			note({ rows: Array.isArray(rows) ? rows.length : null, in_sample: sample.outliers.length, first });
			if (!Array.isArray(rows) || rows.length !== sample.outliers.length || !rows.length)
				return `${Array.isArray(rows) ? rows.length : 'no'} rows for ${sample.outliers.length} outliers`;
			if (!first || !first.endsWith('/' + E.DEMO_CORPUS.outlier))
				return `the sample's first outlier is ${first}, not ${E.DEMO_CORPUS.outlier}`;
			return rows[0].includes(first)
				? true
				: `the first row ${JSON.stringify(rows[0].slice(0, 80))} is not ${first}`;
		});

		await step(page, 'keyboard: arrows follow the 90° sectors, Enter inspects, Escape clears', async (note) => {
			if (!sample) return 'no sample';
			if ((await C.attrText(canvas, MAP.attr.layout)) !== 'pca') return 'the map is not on its PCA layout';
			await canvas.focus();
			await page.keyboard.press('ArrowRight');
			const a = await pollInt(MAP.attr.focused, (v) => v !== null);
			await page.keyboard.press('ArrowRight');
			const b = await pollInt(MAP.attr.focused, (v) => v !== null && v !== a);
			await page.keyboard.press('ArrowUp');
			const c = await pollInt(MAP.attr.focused, (v) => v !== null && v !== b);
			const xs = sample.points.x;
			const ys = sample.points.y;
			const wantB = a === null ? null : sectorTarget(xs, ys, a, 'right');
			const wantC = b === null ? null : sectorTarget(xs, ys, b, 'up');
			await page.keyboard.press('Enter');
			const selected = await pollInt(MAP.attr.selected, (v) => v === c);
			// The live region empties and refills (50 ms later) on every announcement: look for up to 2 s.
			const said = await C.waitForText(page, MAP.announcement(c === null ? -1 : c, sample.n), 2000);
			const named = c !== null && (await C.textOf(inspector)).includes(pathOf(sample, c));
			await page.keyboard.press('Escape');
			const cleared =
				(await C.attrText(canvas, MAP.attr.selected)) === '' && MAP.inspectorEmpty.test(await C.bodyText(page));
			note({ a, b, c, wantB, wantC, selected, said, named, cleared });
			if (a === null) return 'an arrow key focused no point';
			if (b === null || b !== wantB)
				return `ArrowRight from ${a} went to ${b}, the nearest in its sector is ${wantB}`;
			if (c === null || c !== wantC)
				return `ArrowUp from ${b} went to ${c}, the nearest in its sector is ${wantC}`;
			if (selected !== c || !named) return 'Enter did not inspect the focused point';
			if (!said) return 'the move to the inspected point was not announced';
			return cleared ? true : 'Escape did not clear the selection';
		});

		await step(page, 'kNN overlap: the neighbour layout stays only when it beats PCA', async (note) => {
			if (!sample) return 'no sample';
			const label = (await optionsOf(layoutPicker)).find((t) => MAP.layoutOption.graph.test(t));
			if (!label) return 'no Neighbour graph layout to choose';
			await layoutPicker.selectOption({ label });
			// The refined layout's overlap appears when it finished (its budget is 15 s).
			const deadline = Date.now() + 30000;
			let refined = null;
			for (;;) {
				if (capture.sockets === 0) throw new Error('the page opened no WebSocket');
				refined = await C.attrNum(canvas, MAP.attr.overlapLayout);
				if ((refined !== null && !MAP.layoutBusy.test(await C.textOf(toolbar))) || Date.now() > deadline) break;
				await C.sleep(250);
			}
			if (refined === null) return 'the neighbour layout reported no kNN overlap within 30 s';
			const verdict = {
				pca: await C.attrNum(canvas, MAP.attr.overlapPca),
				refined,
				shown: await C.attrText(canvas, MAP.attr.layout),
				notBetter: MAP.layoutNotBetter.test(await C.bodyText(page)),
			};
			note(verdict);
			const pca = (await optionsOf(layoutPicker)).find((t) => MAP.layoutOption.pca.test(t));
			if (pca) await layoutPicker.selectOption({ label: pca });
			return layoutVerdict(verdict);
		});

		await step(
			page,
			'legend: who computed the neighbour graph (Qdrant its own, other stores the store node)',
			async (note) => {
				if (!sample) return 'no sample';
				const text = await C.textOf(map.getByRole('region', { name: MAP.legend }).first());
				note({ knn_source: sample.knn_source, legend: text.slice(0, 300) });
				return legendVerdict({ fixtureKey, knnSource: sample.knn_source, text });
			}
		);

		let pagerSample = null;
		await step(page, 't-SNE: refused above 1,000 points, offered at 1,000', async (note) => {
			const first = await openMap(pager);
			const big = await chooseSample(
				(t) => MAP.detailedOption.test(t) && t.startsWith(MAP.largeSample.toLocaleString('en-US')),
				(e) => e.input.n === MAP.largeSample
			);
			const tsne = layoutPicker.locator('option', { hasText: MAP.layoutOption.tsne }).first();
			const refusedBig = (await C.attrText(tsne, 'disabled')) !== null;
			// The reason: on the option itself, or said in the toolbar outside its pickers' option labels.
			let said = await C.textOf(toolbar);
			for (const select of [samplePicker, layoutPicker])
				for (const option of await optionsOf(select)) said = said.split(option).join(' ');
			const reason = MAP.tsneLimit.test((await C.attrText(tsne, 'title')) || '') || MAP.tsneLimit.test(said);
			const small = await chooseSample(
				(t) => MAP.detailedOption.test(t) && t.startsWith(MAP.defaultSample.toLocaleString('en-US')),
				(e) => e.input.n === MAP.defaultSample
			);
			const refusedSmall = (await C.attrText(tsne, 'disabled')) !== null;
			pagerSample = small.result;
			note({
				first_n: first.result && first.result.n,
				big_n: big.result && big.result.n,
				refusedBig,
				reason,
				small_n: small.result && small.result.n,
				refusedSmall,
			});
			if (!(big.result && big.result.n > MAP.tsneMax))
				return `the large sample has ${big.result && big.result.n} points (is qdrant_pager seeded?)`;
			if (!refusedBig || !reason)
				return `t-SNE above ${MAP.tsneMax} points: disabled ${refusedBig}, reason shown ${reason}`;
			if (!(small.result && small.result.n > 0 && small.result.n <= MAP.tsneMax))
				return `the small sample has ${small.result && small.result.n} points`;
			return refusedSmall ? `t-SNE is refused at ${small.result.n} points` : true;
		});

		await step(page, 'Cancel: stops a running layout and keeps PCA', async (note) => {
			if (!pagerSample) return 'no 1,000-point sample (t-SNE step)';
			const label = (await optionsOf(layoutPicker)).find((t) => MAP.layoutOption.tsne.test(t));
			if (!label) return 'no t-SNE layout to choose';
			await layoutPicker.selectOption({ label });
			const cancel = toolbar.getByRole('button', { name: MAP.cancel }).first();
			await cancel.waitFor({ timeout: 5000 }).catch(() => {});
			if (!(await cancel.isVisible().catch(() => false)))
				return 'no Cancel while laying out (did the layout finish first?)';
			await cancel.click();
			const settled = await layoutSettled(5000);
			const shown = await C.attrText(canvas, MAP.attr.layout);
			const said = MAP.layoutCancelled.test(await C.bodyText(page));
			note({ settled, shown, said });
			if (!settled) return 'the layout was still running 5 s after Cancel';
			if (shown !== 'pca') return `after Cancel the map shows ${shown}`;
			return said ? true : 'the map did not say the layout was cancelled';
		});

		await step(page, 'privacy: no full-dimension vectors outside vectors and embed answers', async (note) => {
			if (!capture.frames.length) return 'no WebSocket frames were captured';
			const dimension = await store.dimension(fixture);
			note({ dimension, frames: capture.frames.length });
			const violations = C.privacyViolations(capture.frames, dimension);
			return violations.length === 0 ? true : violations.slice(0, 3).join('; ');
		});
	} finally {
		await browser.close().catch(() => {});
		await store.close();
		write(RESULTS);
	}
}

if (require.main === module) {
	main()
		.then(() => {
			const data = JSON.parse(fs.readFileSync(path.join(out, RESULTS), 'utf8'));
			const failed = data.filter((r) => r.status !== 'PASS').length;
			console.log(`${data.length - failed} of ${data.length} steps passed`);
			process.exitCode = failed ? 1 : 0;
		})
		.catch((e) => {
			console.error(e);
			const file = path.join(out, RESULTS);
			if (!fs.existsSync(file)) {
				fs.mkdirSync(out, { recursive: true });
				fs.writeFileSync(
					file,
					JSON.stringify(
						[
							{
								fixture: fixtureKey,
								name: 'lane',
								status: 'FAIL',
								detail: String(e && e.message ? e.message : e),
							},
						],
						null,
						2
					)
				);
			}
			process.exitCode = 1;
		});
}

module.exports = { pathOf, keyOf, pointsOf, sectorTarget, layoutVerdict, legendVerdict, missingPairs };
