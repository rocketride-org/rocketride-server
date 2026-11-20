// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Runs a browser lane against a stand-in Playwright that models an empty page:
 * every call succeeds, nothing is visible, every text is empty, and
 * page.evaluate() returns what the lane's in-page function would read from a
 * page with nothing on it. A lane check that could not observe what it names
 * must then record FAIL, never PASS. Used by the *.test.cjs files here.
 *
 * A test can describe a page instead (runWithStandIn's `page` argument), to
 * show that a check fails on a page that has everything around what it names
 * but not the thing itself, and passes on one that has it:
 *   text      what every innerText() returns (the stand-in has no layout, so
 *             the body and an element inside it read the same text)
 *   aria      what every ariaSnapshot() returns
 *   visible   what every isVisible() returns
 *   count     what every count() returns
 *   evaluate  { <key>: what the in-page function returns }
 *   sequence  { <key>: [first call, second call, ...] } (the last answer repeats)
 *             A key is the in-page function's name, or text in its source.
 * The lane is also run with FALKORDB_PORT=9 (nothing listens there), so a step
 * that checks the database over its own connection observes nothing.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FAKE_PLAYWRIGHT = `
'use strict';
// The page the test describes (see stand_in.cjs); empty when it describes none.
const PAGE = JSON.parse(process.env.STAND_IN_PAGE || '{}');
const calls = {};
// What a lane's page.evaluate() callback would return on an empty page.
function emptyPage(fn, arg) {
	const src = String(fn);
	if (fn.name === 'scanContrast') return { scopeFound: arg === 'body', rows: [], strokes: [] };
	if (src.includes('runningCanvasAnimations')) {
		return { frames: 0, transformChanges: 0, runningCanvasAnimations: null };
	}
	if (src.includes('line-numbers')) return [];
	return '';
}
// What it returns on the described page. A key names the in-page function, or is text in its source.
function described(fn, arg) {
	const src = String(fn);
	const matches = (key) => key === fn.name || src.includes(key);
	const seq = Object.keys(PAGE.sequence || {}).find(matches);
	if (seq !== undefined) {
		const answers = PAGE.sequence[seq];
		const n = (calls[seq] = (calls[seq] || 0) + 1);
		return answers[Math.min(n, answers.length) - 1];
	}
	const one = Object.keys(PAGE.evaluate || {}).find(matches);
	if (one !== undefined) return PAGE.evaluate[one];
	return emptyPage(fn, arg);
}
// Every other call returns this object; nothing is visible and every text is empty, unless the page says otherwise.
const handler = {
	get(_target, prop) {
		if (prop === 'then') return undefined;
		if (prop === 'isVisible') return async () => PAGE.visible === true;
		if (prop === 'count') return async () => PAGE.count || 0;
		if (prop === 'innerText') return async () => PAGE.text || '';
		if (prop === 'ariaSnapshot') return async () => PAGE.aria || '';
		if (prop === 'evaluate') return async (fn, arg) => described(fn, arg);
		if (prop === Symbol.toPrimitive) return () => '';
		return fake;
	},
	apply() {
		return fake;
	},
};
const fake = new Proxy(function () {}, handler);
module.exports = { chromium: fake, firefox: fake, webkit: fake };
`;

/**
 * Run `browser/<lane>` with the stand-in and return its exit status, output and result rows.
 * @param {string} lane - File name under browser/, e.g. 'lane_graph.cjs'.
 * @param {string[]} args - Lane arguments after the base URL and output folder.
 * @param {string} resultFile - The JSON file the lane writes into its output folder.
 * @param {object} [page] - The page to model (see the header); an empty page when omitted.
 * @param {Record<string, string>} [env] - Extra environment for the lane.
 */
function runWithStandIn(lane, args, resultFile, page = {}, env = {}) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-selftest-'));
	try {
		const pw = path.join(tmp, 'pw', 'node_modules', 'playwright');
		fs.mkdirSync(pw, { recursive: true });
		fs.writeFileSync(path.join(pw, 'index.js'), FAKE_PLAYWRIGHT);
		const out = path.join(tmp, 'out');
		const res = spawnSync(
			process.execPath,
			[path.join(__dirname, '..', 'browser', lane), 'http://127.0.0.1:9', out, ...args],
			{
				env: {
					...process.env,
					FALKORDB_HOST: '127.0.0.1',
					FALKORDB_PORT: '9',
					...env,
					PLAYWRIGHT_DIR: path.join(tmp, 'pw'),
					STAND_IN_PAGE: JSON.stringify(page),
				},
				encoding: 'utf8',
				timeout: 60000,
			}
		);
		const file = path.join(out, resultFile);
		if (!fs.existsSync(file)) throw new Error(`${lane} wrote no ${resultFile}:\n${res.stdout}${res.stderr}`);
		return { status: res.status, stdout: res.stdout, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

module.exports = { runWithStandIn };
