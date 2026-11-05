// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Runs a browser lane against a stand-in Playwright that models a page with
 * nothing to observe: every call succeeds, every text is empty, every
 * attribute is missing, page.evaluate() returns '', and no WebSocket ever
 * opens. Two variants:
 *   'empty'   nothing is visible and every count is 0;
 *   'visible' every element is visible and every count is 1 (a page full of
 *             elements that say nothing), so a check that only waits for an
 *             element, or counts one, cannot pass either.
 * A lane check that could not observe what it names must then record FAIL,
 * never PASS. The lane also gets a CLIENT_TS_DIR with no built client, so it
 * cannot read the store's side either.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const fakePlaywright = (variant) => `
'use strict';
const VISIBLE = ${variant === 'visible'};
const handler = {
	get(_target, prop) {
		if (prop === 'then') return undefined;
		if (prop === 'isVisible') return async () => VISIBLE;
		if (prop === 'count') return async () => (VISIBLE ? 1 : 0);
		if (prop === 'innerText' || prop === 'textContent') return async () => '';
		if (prop === 'allInnerTexts' || prop === 'allTextContents') return async () => (VISIBLE ? [''] : []);
		if (prop === 'getAttribute') return async () => null;
		if (prop === 'evaluate') return async () => '';
		if (prop === 'on') return () => undefined;
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
 * Run `browser/<lane>` with the stand-in; its exit status, output and result rows.
 * @param {string} lane - File name under browser/, e.g. 'lane_vector.cjs'.
 * @param {string[]} args - Lane arguments after the base URL and output folder.
 * @param {string} resultFile - The JSON file the lane writes into its output folder.
 * @param {'empty'|'visible'} [variant] - The stand-in page (default 'empty').
 */
function runWithStandIn(lane, args, resultFile, variant = 'empty') {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-selftest-'));
	try {
		const pw = path.join(tmp, 'pw', 'node_modules', 'playwright');
		fs.mkdirSync(pw, { recursive: true });
		fs.writeFileSync(path.join(pw, 'index.js'), fakePlaywright(variant));
		const out = path.join(tmp, 'out');
		const res = spawnSync(
			process.execPath,
			[path.join(__dirname, '..', 'browser', lane), 'http://127.0.0.1:9', out, ...args],
			{
				env: {
					...process.env,
					PLAYWRIGHT_DIR: path.join(tmp, 'pw'),
					CLIENT_TS_DIR: path.join(tmp, 'no-client'),
					LAN_URL: '',
				},
				encoding: 'utf8',
				timeout: 180000,
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
