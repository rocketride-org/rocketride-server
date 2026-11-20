// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Graph Explorer: themes, reduced motion and contrast, in the real served shell.
 * Per browser, two runs on the FalkorDB acceptance fixture (gx-local Graph (FalkorDB)):
 *   light theme (rocketride-light) + prefers-reduced-motion: reduce
 *   dark theme  (rocketride)       + prefers-reduced-motion: no-preference (control)
 * Checks: the theme really applied (--rr-palette-mode); the first fit animates only without
 * reduced motion (viewport transform sampled every frame) and no canvas animation runs under
 * reduce; WCAG 2.x contrast of every visible text element (4.5:1, large text 3:1; disabled
 * controls exempt) on the landing, the drawn graph, the Table view and the open inspector, and
 * of relationship strokes vs the canvas (1.4.11, 3:1) on the drawn graph (and wherever else
 * they are on screen). Self-written checker (no axe). A row that measured nothing (no text
 * element, a missing scope, no stroke on the drawn graph, no sampled viewport or canvas)
 * is a FAIL.
 * Usage: node lane_a11y.cjs [base-url] [out-dir] [chrome|firefox|webkit|all]
 * (base-url and out-dir default to ENGINE_URL and OUT_DIR).
 * Browsers: Chrome lanes use the installed Google Chrome (channel "chrome"); Firefox and
 * WebKit use Playwright builds (`npx playwright install firefox webkit`, optionally under
 * PLAYWRIGHT_BROWSERS_PATH).
 */
'use strict';
// page.evaluate() and addInitScript() callbacks run in the browser.
/* global SVGElement, document, getComputedStyle, innerHeight, innerWidth, localStorage */
/* global requestAnimationFrame, window */
const E = require('../env.cjs');
const { chromium, firefox, webkit } = E.loadPlaywright();
const fs = require('fs');
const path = require('path');

const [, , base = E.ENGINE_URL, out = E.OUT_DIR, which = 'all'] = process.argv;
const NODE = E.FIXTURES.falkordb;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const results = [];
const contrastReport = [];
const rec = (b, run, name, ok, detail) => {
	results.push({ browser: b, run, name, status: ok ? 'PASS' : 'FAIL', detail });
	const suffix = detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 300)}` : '';
	console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${b}/${run}: ${name}${suffix}`);
};

// Runs in the page: every visible element with its own text, its colour against the
// effective background (alpha-composited up the ancestor chain), and the WCAG ratio.
function scanContrast(scopeSelector) {
	const parse = (s) => {
		const m = /rgba?\(([^)]+)\)/.exec(s || '');
		if (!m) return null;
		const p = m[1]
			.split(/[\s,/]+/)
			.filter(Boolean)
			.map(Number);
		return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
	};
	const over = (top, under) => ({
		r: top.r * top.a + under.r * (1 - top.a),
		g: top.g * top.a + under.g * (1 - top.a),
		b: top.b * top.a + under.b * (1 - top.a),
		a: 1,
	});
	const lum = (c) => {
		const f = (v) => {
			v /= 255;
			return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
		};
		return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
	};
	const ratio = (a, b) => {
		const x = lum(a),
			y = lum(b);
		return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
	};
	const bgOf = (el) => {
		const chain = [];
		for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
			const c = parse(getComputedStyle(n).backgroundColor);
			if (c && c.a > 0) {
				chain.push(c);
				if (c.a >= 1) break;
			}
		}
		let acc = { r: 255, g: 255, b: 255, a: 1 };
		const rootBg = parse(getComputedStyle(document.body).backgroundColor);
		if (rootBg && rootBg.a >= 1 && !chain.some((c) => c.a >= 1)) acc = rootBg;
		for (let i = chain.length - 1; i >= 0; i--) acc = over(chain[i], acc);
		return acc;
	};
	const visible = (el) => {
		const r = el.getBoundingClientRect();
		if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth)
			return false;
		for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
			const s = getComputedStyle(n);
			if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
		}
		return true;
	};
	// No fallback: a missing scope (say, the inspector without its dialog role) measures nothing.
	const scope = document.querySelector(scopeSelector);
	const rows = [];
	for (const el of scope ? scope.querySelectorAll('*') : []) {
		const own = [...el.childNodes]
			.filter((n) => n.nodeType === 3)
			.map((n) => n.textContent.trim())
			.join(' ')
			.trim();
		if (!own || !visible(el)) continue;
		const s = getComputedStyle(el);
		const isSvgText = el instanceof SVGElement;
		const fg = parse(isSvgText ? s.fill : s.color);
		if (!fg) continue;
		const bg = isSvgText ? bgOf(el.closest('.graph-ui-canvas') || el.parentElement) : bgOf(el);
		const effFg = fg.a < 1 ? over(fg, bg) : fg;
		const size = parseFloat(s.fontSize),
			bold = Number(s.fontWeight) >= 700;
		const large = size >= 24 || (bold && size >= 18.66);
		const disabled = !!el.closest('[disabled],[aria-disabled="true"]');
		const region = el.closest('.monaco-editor')
			? 'editor'
			: el.closest('.graph-ui-canvas')
				? 'canvas'
				: el.closest('[role="dialog"]')
					? 'inspector'
					: 'chrome';
		const trail = [];
		for (let n = el; n && n.nodeType === 1 && trail.length < 6; n = n.parentElement) {
			const cls = (typeof n.className === 'string' ? n.className : n.getAttribute('class') || '')
				.split(/\s+/)
				.filter(Boolean)
				.slice(0, 2)
				.join('.');
			trail.push(
				n.tagName.toLowerCase() +
					(cls ? '.' + cls : '') +
					(n.getAttribute('data-testid') ? `[${n.getAttribute('data-testid')}]` : '')
			);
		}
		const bgc = isSvgText
			? null
			: (() => {
					for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
						const c = getComputedStyle(n).backgroundColor;
						if (parse(c) && parse(c).a > 0) return c;
					}
					return 'page';
				})();
		let fgVar = '';
		for (let n = el; n && n.nodeType === 1 && !fgVar; n = n.parentElement) {
			const v = n.style && n.style.color;
			if (v && v.includes('var(')) fgVar = v;
		}
		rows.push({
			text: own.slice(0, 40),
			region,
			ratio: +ratio(effFg, bg).toFixed(2),
			need: large ? 3 : 4.5,
			disabled,
			fg: isSvgText ? s.fill : s.color,
			bg: bgc,
			size,
			trail: trail.join(' < '),
			fgVar,
		});
	}
	// Relationship strokes vs the canvas background (non-text contrast, 3:1).
	const strokes = [];
	const canvas = document.querySelector('.graph-ui-canvas');
	if (canvas) {
		const cbg = bgOf(canvas);
		for (const p of document.querySelectorAll('.graph-ui-edge path')) {
			const cs = getComputedStyle(p);
			const c = parse(cs.stroke);
			// Group opacity (dimmed context) also lowers what the eye sees.
			let op = 1;
			for (let n = p; n && !(n.classList && n.classList.contains('graph-ui-canvas')); n = n.parentElement)
				op *= Number(getComputedStyle(n).opacity || 1);
			const eff = c ? { ...c, a: c.a * op } : null;
			if (eff) strokes.push(+ratio(eff.a < 1 ? over(eff, cbg) : eff, cbg).toFixed(2));
		}
	}
	return { scopeFound: !!scope, rows, strokes };
}

function summarise(scan) {
	const checked = scan.rows.filter((r) => !r.disabled);
	const fails = checked.filter((r) => r.ratio < r.need);
	const byRegion = {};
	for (const r of checked) {
		const g = (byRegion[r.region] ||= { n: 0, min: Infinity, fails: 0 });
		g.n++;
		g.min = Math.min(g.min, r.ratio);
		if (r.ratio < r.need) g.fails++;
	}
	const strokeMin = scan.strokes.length ? Math.min(...scan.strokes) : null;
	// Which theme token each failure is drawn with (inline var() on the element or an ancestor that set it).
	const byToken = {};
	for (const f of fails) {
		const m = /var\((--[\w-]+)/.exec(f.fgVar || '');
		const t = m ? m[1] : '(inherited/other)';
		(byToken[t] ||= { n: 0, examples: [] }).n++;
		if (byToken[t].examples.length < 4) byToken[t].examples.push(`${f.text} ${f.ratio}:1 [${f.region}]`);
	}
	return {
		scopeFound: scan.scopeFound === true,
		checked: checked.length,
		exemptDisabled: scan.rows.length - checked.length,
		fails,
		failCount: fails.length,
		byToken,
		byRegion,
		strokeCount: scan.strokes.length,
		strokeMin,
	};
}

async function run(bname, launcher, opts, runName, theme, motion) {
	const browser = await launcher.launch(opts);
	const context = await browser.newContext({
		viewport: { width: 1440, height: 920 },
		reducedMotion: motion,
		colorScheme: theme === 'rocketride' ? 'dark' : 'light',
	});
	await context.addInitScript((t) => {
		try {
			// This callback runs in the page, not in Node, so Node's localStorage support does not apply.
			/* eslint-disable n/no-unsupported-features/node-builtins */
			localStorage.setItem('rr:theme', t);
			localStorage.setItem('rr:home:theme', t === 'rocketride' ? 'dark' : 'light');
			/* eslint-enable n/no-unsupported-features/node-builtins */
		} catch {
			/* storage blocked */
		}
	}, theme);
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	const shot = (n) => page.screenshot({ path: path.join(out, `a11y-${bname}-${runName}-${n}.png`) }).catch(() => {});
	// needStrokes: the view draws relationships, so finding no stroke is a FAIL, not a skip.
	const contrast = async (where, scope, needStrokes = false) => {
		const s = summarise(await page.evaluate(scanContrast, scope));
		contrastReport.push({ browser: bname, run: runName, where, ...s });
		const measured = s.scopeFound && s.checked > 0;
		const textOk = measured && s.failCount === 0;
		const why = !s.scopeFound
			? `scope ${scope} not found`
			: s.checked === 0
				? 'no visible text element measured'
				: s.fails;
		rec(
			bname,
			runName,
			`contrast ${where}: ${s.checked} text elements, ` +
				`min ${JSON.stringify(Object.fromEntries(Object.entries(s.byRegion).map(([k, v]) => [k, v.min])))}`,
			textOk,
			textOk ? undefined : why
		);
		if (needStrokes || s.strokeCount) {
			rec(
				bname,
				runName,
				`relationship strokes vs canvas >= 3:1 on ${where} (${s.strokeCount}, min ${s.strokeMin})`,
				s.strokeCount > 0 && s.strokeMin >= 3,
				s.strokeCount ? s.strokeMin : 'no relationship stroke found'
			);
		}
	};
	try {
		await E.signIn(page, base);
		// Signed-in users get their saved preference from the server, so pick the theme in the
		// home page's theme switch when the stored one differs.
		const wantMode = theme === 'rocketride' ? 'dark' : 'light';
		const modeNow = () =>
			page.evaluate(() =>
				getComputedStyle(document.documentElement)
					.getPropertyValue('--rr-palette-mode')
					.replace(/['"]/g, '')
					.trim()
			);
		if ((await modeNow()) !== wantMode) {
			// The home page's own switch (role=switch, "Switch to dark/light mode").
			await page
				.getByRole('switch', { name: wantMode === 'dark' ? 'Switch to dark mode' : 'Switch to light mode' })
				.click();
			await page.waitForTimeout(1200);
		}
		await page.getByRole('button', { name: 'Open Graph Explorer' }).click();
		await page.getByText(NODE).first().waitFor({ timeout: 45000 });
		await page.waitForTimeout(800);
		const mode = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue('--rr-palette-mode').replace(/['"]/g, '').trim()
		);
		rec(bname, runName, `theme applied (--rr-palette-mode = ${mode})`, mode === wantMode, mode);
		await shot('landing');
		await contrast('landing', 'body');

		await page.getByText(NODE).first().click();
		await page.getByRole('button', { name: 'Open workbench' }).click();
		const editor = page.locator('.monaco-editor .view-lines').first();
		await editor.waitFor({ timeout: 45000 });
		// Sample the viewport transform on every frame from just before the run.
		await page.evaluate(() => {
			window.__vt = [];
			window.__vtOn = true;
			const tick = () => {
				const v = document.querySelector('.react-flow__viewport');
				window.__vt.push(v ? v.style.transform : '');
				if (window.__vtOn) requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		await editor.click();
		await page.keyboard.press(`${MOD}+a`);
		await page.keyboard.press('Delete');
		// Two lines, so the editor shows an inactive line number as well as the active one.
		await page.keyboard.type('MATCH (a:Person)-[r]->(b)');
		await page.keyboard.press('Enter');
		await page.keyboard.type('RETURN a, r, b');
		await page.keyboard.press(`${MOD}+a`);
		await page.keyboard.press(`${MOD}+Enter`);
		await page.locator('.react-flow__node').first().waitFor({ timeout: 60000 });
		await page.waitForTimeout(1500);
		const motionData = await page.evaluate(() => {
			window.__vtOn = false;
			const vals = window.__vt.filter(Boolean);
			const distinct = vals.filter((v, i) => i === 0 || v !== vals[i - 1]);
			const canvas = document.querySelector('.graph-ui-canvas');
			const anims =
				canvas && canvas.getAnimations
					? canvas.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length
					: null;
			return { frames: vals.length, transformChanges: distinct.length, runningCanvasAnimations: anims };
		});
		if (motion === 'reduce') {
			// Without animation the fit lands in one step: initial transform + at most one or two jumps
			// (the fit, and a refit when the result line appears and the canvas changes size).
			// Both rows need something sampled: frames from the viewport, and a canvas to ask for animations.
			rec(
				bname,
				runName,
				'reduced motion: fit jumps, no animation ' +
					`(${motionData.transformChanges} transform values over ${motionData.frames} frames)`,
				motionData.frames > 0 && motionData.transformChanges <= 3,
				motionData
			);
			rec(
				bname,
				runName,
				'reduced motion: no running canvas animations',
				motionData.runningCanvasAnimations === 0,
				motionData.runningCanvasAnimations === null
					? 'no canvas (or no getAnimations) to check'
					: motionData.runningCanvasAnimations
			);
		} else {
			rec(
				bname,
				runName,
				`control (no-preference): the fit animates (${motionData.transformChanges} transform values)`,
				motionData.transformChanges > 3,
				motionData
			);
		}
		await shot('graph');
		const ln = await page.evaluate(() =>
			[...document.querySelectorAll('.monaco-editor .line-numbers')].map((e) => ({
				text: e.textContent.trim(),
				color: getComputedStyle(e).color,
				active: e.classList.contains('active-line-number'),
			}))
		);
		const red = ln.filter((x) => /rgb\(255, 0, 0\)/.test(x.color));
		rec(
			bname,
			runName,
			"editor line numbers are not Monaco's parse-failure red " +
				`(${ln.length} numbers: ${[...new Set(ln.map((x) => x.color))].join(' / ')})`,
			ln.length >= 2 && red.length === 0,
			ln
		);
		await contrast('graph result', 'body', true);

		await page.getByRole('tab', { name: 'Table' }).click();
		await page.waitForTimeout(500);
		await shot('table');
		await contrast('table view', 'body');

		await page.getByRole('tab', { name: 'Graph' }).click();
		await page.locator('.react-flow__node').first().click();
		await page.getByRole('button', { name: 'Inspect' }).first().click();
		await page.getByRole('button', { name: 'Copy JSON' }).first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(motion === 'reduce' ? 150 : 700);
		await shot('inspector');
		await contrast('inspector', '[role="dialog"]');
		await page.keyboard.press('Escape');
		rec(bname, runName, 'no uncaught page errors', errors.length === 0, errors.slice(0, 3));
	} catch (e) {
		rec(bname, runName, 'lane completed', false, e.message.split('\n')[0]);
		await shot('error');
	}
	await browser.close();
}

(async () => {
	fs.mkdirSync(out, { recursive: true });
	const all = { chrome: [chromium, { channel: 'chrome' }], firefox: [firefox, {}], webkit: [webkit, {}] };
	const pick = which === 'all' ? Object.keys(all) : which.split(',');
	for (const b of pick) {
		const [launcher, opts] = all[b];
		await run(b, launcher, opts, 'light-reduce', 'rocketride-light', 'reduce');
		await run(b, launcher, opts, 'dark-motion', 'rocketride', 'no-preference');
	}
	fs.writeFileSync(path.join(out, 'lane_a11y.json'), JSON.stringify({ results, contrast: contrastReport }, null, 1));
	const pass = results.filter((r) => r.status === 'PASS').length;
	console.log(`\n${pass}/${results.length} PASS`);
	process.exit(pass === results.length ? 0 : 1);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
