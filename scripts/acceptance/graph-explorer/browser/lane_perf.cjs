// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Graph Explorer canvas performance in the real served shell (Chrome via CDP).
 * For one seeded graph size already loaded into the FalkorDB perf graph (gen_perf.py, PERF_GRAPH),
 * at each CPU throttling rate: time to first full draw, node/edge counts drawn,
 * the app's own layout status line, frame intervals + long tasks while panning,
 * JS heap, and three successive Expand round trips.
 * Fixtures: start_fixtures.py (the perf fixture). SHOW_MORE=1 keeps pressing "Show more nodes".
 * Usage: node lane_perf.cjs <base-url> <out-json> <n> [rates,comma]
 *        (e.g. "$ENGINE_URL" "$OUT_DIR/perf-300.json" 300 1,4)
 */
'use strict';
// page.evaluate() and addInitScript() callbacks run in the browser.
/* global document, requestAnimationFrame, window */
const E = require('../env.cjs');
const { chromium } = E.loadPlaywright();
const fs = require('fs');
const path = require('path');

const [, , base, outFile, nArg, ratesArg = '1,4'] = process.argv;
if (!base || !outFile || !nArg) {
	console.error('usage: node lane_perf.cjs <base-url> <out-json> <n> [rates,comma]');
	process.exit(2);
}
const N = Number(nArg);
const QUERY = 'MATCH (n:P) WITH collect(n) AS ns OPTIONAL MATCH (:P)-[r:R]->(:P) RETURN ns, collect(r) AS rs';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const pct = (xs, p) =>
	xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null;

async function settleCount(page, sel, timeoutMs) {
	const t0 = Date.now();
	let last = -1,
		stableSince = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const c = await page.locator(sel).count();
		if (c !== last) {
			last = c;
			stableSince = Date.now();
		}
		if (c > 0 && Date.now() - stableSince > 1500) return { count: c, ms: stableSince - t0 };
		await page.waitForTimeout(100);
	}
	return { count: last, ms: null };
}

(async () => {
	fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
	const browser = await chromium.launch({ channel: 'chrome' });
	const results = [];
	for (const rate of ratesArg.split(',').map(Number)) {
		const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
		const page = await context.newPage();
		const cdp = await context.newCDPSession(page);
		const r = { n: N, cpuThrottle: rate, browser: `Chrome ${browser.version()}` };
		try {
			await E.signIn(page, base);
			await page.getByRole('button', { name: 'Open Graph Explorer' }).click();
			await page.getByText(E.FIXTURES.falkordbPerf).first().click();
			await page.getByRole('button', { name: 'Open workbench' }).click();
			await page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 45000 });
			await cdp.send('Emulation.setCPUThrottlingRate', { rate });
			await page.evaluate(() => {
				window.__lt = [];
				new PerformanceObserver((l) =>
					l.getEntries().forEach((e) => window.__lt.push({ start: e.startTime, dur: e.duration }))
				).observe({ type: 'longtask', buffered: false });
			});
			await page.locator('.monaco-editor .view-lines').first().click();
			await page.keyboard.press(`${MOD}+a`);
			await page.keyboard.press('Delete');
			await page.keyboard.type(QUERY);
			const tRun = Date.now();
			await page.keyboard.press(`${MOD}+Enter`);
			const drawn = await settleCount(page, '.react-flow__node', 120000);
			r.timeToStableDrawMs = drawn.ms === null ? null : Date.now() - tRun - 1500;
			r.nodesDrawn = drawn.count;
			if (drawn.count <= 0) await page.screenshot({ path: outFile.replace(/\.json$/, `-x${rate}-nodraw.png`) });
			// SHOW_MORE=1: keep pressing "Show more nodes" until the canvas maximum is drawn, then measure that.
			if (process.env.SHOW_MORE) {
				for (let i = 0; i < 8; i++) {
					const more = page.getByRole('button', { name: 'Show more nodes' });
					if (!(await more.count()) || !(await more.first().isEnabled())) break;
					await more.first().click();
					const s2 = await settleCount(page, '.react-flow__node', 120000);
					r.nodesDrawn = s2.count;
				}
				r.showMore = true;
				await page.evaluate(() => window.__lt.splice(0));
			}
			r.edgesDrawn = await page.locator('.graph-ui-edge').count();
			const body = await page.locator('body').innerText();
			r.statusLines = body
				.split('\n')
				.filter((l) => /layout|first \d|nodes|relationships|budget|truncat|of [\d,]+ nodes/i.test(l))
				.slice(0, 6);
			const ltAfterDraw = await page.evaluate(() => window.__lt.splice(0));
			r.longTasksDuringDrawMs = {
				count: ltAfterDraw.length,
				max: Math.max(0, ...ltAfterDraw.map((x) => x.dur)),
				total: Math.round(ltAfterDraw.reduce((a, x) => a + x.dur, 0)),
			};
			// Pan: drag the empty canvas pane for ~2 s while sampling rAF intervals.
			const pane = page.locator('.react-flow__pane').first();
			const box = await pane.boundingBox();
			await page.evaluate(() => {
				window.__fr = [];
				let last = performance.now();
				window.__sampling = true;
				const tick = (t) => {
					window.__fr.push(t - last);
					last = t;
					if (window.__sampling) requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			});
			await cdp.send('Performance.enable');
			const m0 = Object.fromEntries(
				(await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value])
			);
			// Pan from EMPTY canvas space (a point whose hit target is the pane, not a node).
			const empty = await page.evaluate((b) => {
				for (let gy = 0.06; gy < 0.95; gy += 0.04)
					for (let gx = 0.04; gx < 0.96; gx += 0.04) {
						const x = b.x + b.width * gx,
							y = b.y + b.height * gy;
						const el = document.elementFromPoint(x, y);
						if (el && !el.closest('.react-flow__node') && el.closest('.react-flow')) return { x, y };
					}
				return null;
			}, box);
			const cx = empty ? empty.x : box.x + 10,
				cy = empty ? empty.y : box.y + 10;
			r.panStart = empty ? 'empty-space' : 'fallback-corner';
			await page.mouse.move(cx, cy);
			await page.mouse.down();
			for (let i = 0; i < 60; i++) {
				await page.mouse.move(cx + Math.sin(i / 6) * 220, cy + Math.cos(i / 6) * 120, { steps: 2 });
				await page.waitForTimeout(30);
			}
			await page.mouse.up();
			const frames = await page.evaluate(() => {
				window.__sampling = false;
				return window.__fr.slice(2);
			});
			const m1 = Object.fromEntries(
				(await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value])
			);
			const d = (k) => Math.round(((m1[k] || 0) - (m0[k] || 0)) * 1000);
			r.panCpuMs = {
				script: d('ScriptDuration'),
				styleRecalc: d('RecalcStyleDuration'),
				layout: d('LayoutDuration'),
				task: d('TaskDuration'),
				frames: frames.length,
				perFrameTask: +(d('TaskDuration') / Math.max(1, frames.length)).toFixed(1),
			};
			const ltPan = await page.evaluate(() => window.__lt.splice(0));
			r.panFrameMs = {
				samples: frames.length,
				p50: +pct(frames, 50)?.toFixed(1),
				p95: +pct(frames, 95)?.toFixed(1),
				max: +Math.max(0, ...frames).toFixed(1),
			};
			r.longTasksDuringPan = { count: ltPan.length, max: Math.round(Math.max(0, ...ltPan.map((x) => x.dur))) };
			// Node drag: the same motion with the mouse down on a node.
			// Grab a node whose centre is really its own hit target (not covered by another
			// node or an overlay), nearest the pane centre, and prove afterwards that it moved:
			// a drag that misses the node is just a pan and must not be reported as a drag.
			const pick = await page.evaluate(() => {
				const pr = document.querySelector('.react-flow__pane').getBoundingClientRect();
				const px = pr.x + pr.width / 2,
					py = pr.y + pr.height / 2;
				let best = null;
				for (const el of document.querySelectorAll('.react-flow__node')) {
					const b = el.getBoundingClientRect();
					const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
					if (!hit || !el.contains(hit)) continue;
					const d = Math.hypot(b.x + b.width / 2 - px, b.y + b.height / 2 - py);
					if (!best || d < best.d) best = { d, id: el.getAttribute('data-id') };
				}
				return best && best.id;
			});
			if (!pick) throw new Error('no unobstructed node to drag');
			const dragNode = page.locator(`.react-flow__node[data-id=${JSON.stringify(pick)}]`);
			const before = await dragNode.evaluate((el) => el.style.transform);
			const nb = await dragNode.boundingBox();
			await page.evaluate(() => {
				window.__fr = [];
				let last = performance.now();
				window.__sampling = true;
				const tick = (t) => {
					window.__fr.push(t - last);
					last = t;
					if (window.__sampling) requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			});
			const m2 = Object.fromEntries(
				(await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value])
			);
			await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
			await page.mouse.down();
			for (let i = 0; i < 60; i++) {
				await page.mouse.move(
					nb.x + nb.width / 2 + Math.sin(i / 6) * 160,
					nb.y + nb.height / 2 + Math.cos(i / 6) * 90,
					{ steps: 2 }
				);
				await page.waitForTimeout(30);
			}
			await page.mouse.up();
			const dframes = await page.evaluate(() => {
				window.__sampling = false;
				return window.__fr.slice(2);
			});
			const m3 = Object.fromEntries(
				(await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value])
			);
			const dd = (k) => Math.round(((m3[k] || 0) - (m2[k] || 0)) * 1000);
			const ltDrag = await page.evaluate(() => window.__lt.splice(0));
			r.dragMovedNode = (await dragNode.evaluate((el) => el.style.transform)) !== before;
			if (!r.dragMovedNode)
				r.dragInvalid = 'the dragged node did not move; drag figures below are a pan, not a drag';
			r.dragFrameMs = {
				samples: dframes.length,
				p50: +pct(dframes, 50)?.toFixed(1),
				p95: +pct(dframes, 95)?.toFixed(1),
				max: +Math.max(0, ...dframes).toFixed(1),
			};
			r.dragCpuMs = {
				script: dd('ScriptDuration'),
				task: dd('TaskDuration'),
				perFrameTask: +(dd('TaskDuration') / Math.max(1, dframes.length)).toFixed(1),
			};
			r.longTasksDuringDrag = { count: ltDrag.length, max: Math.round(Math.max(0, ...ltDrag.map((x) => x.dur))) };
			r.jsHeapMB = await page.evaluate(() =>
				performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null
			);
			// Three successive expansions on drawn nodes.
			r.expandMs = [];
			for (let k = 0; k < 3; k++) {
				const before = await page.locator('.react-flow__node').count();
				await page
					.locator('.react-flow__node')
					.nth(k * 7)
					.click({ force: true });
				const t0 = Date.now();
				await page.getByRole('button', { name: 'Expand' }).first().click();
				let after = before;
				for (let i = 0; i < 200; i++) {
					await page.waitForTimeout(100);
					after = await page.locator('.react-flow__node').count();
					const txt = await page.locator('body').innerText();
					if (after !== before || /No new neighbours|added|neighbour/i.test(txt)) break;
				}
				r.expandMs.push({ ms: Date.now() - t0, nodesBefore: before, nodesAfter: after });
			}
			const ltExpand = await page.evaluate(() => window.__lt.splice(0));
			r.longTasksDuringExpand = {
				count: ltExpand.length,
				max: Math.round(Math.max(0, ...ltExpand.map((x) => x.dur))),
			};
			await page.screenshot({ path: outFile.replace(/\.json$/, `-x${rate}.png`) });
		} catch (e) {
			r.error = e.message.split('\n')[0];
		}
		results.push(r);
		console.log(JSON.stringify(r));
		await context.close();
	}
	await browser.close();
	fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
