// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Client Common Module
 *
 * The client-common SOURCE library (typescript/ + python/) is compiled in
 * by its consumers (client CLIs, VS Code extension) — this module owns no
 * artifact. Its one task, `client-common:stamp`, keeps the baked sign-in
 * defaults (auth-defaults.ts / auth_defaults.py) in sync with `.config`
 * (RR_ZITADEL_URL / RR_ZITADEL_CLI_CLIENT_ID) — the same pattern
 * client-typescript:sync-version uses for SDK_VERSION. Client builds run
 * it before compiling/staging the library.
 */
const path = require('path');
const fs = require('fs');
const { PROJECT_ROOT } = require('../../../scripts/lib');

const TS_DEFAULTS = path.join(__dirname, '..', 'typescript', 'src', 'auth-defaults.ts');
const PY_DEFAULTS = path.join(__dirname, '..', 'python', 'src', 'rocketride_common', 'auth_defaults.py');
const CONFIG_FILE = path.join(PROJECT_ROOT, '.config');

/**
 * Read one KEY=VALUE assignment from .config, with process.env override
 * (the builder may be invoked with the variable already set).
 */
function readConfigValue(key) {
	if (process.env[key] !== undefined) {
		return process.env[key].trim();
	}
	if (!fs.existsSync(CONFIG_FILE)) {
		return '';
	}
	for (const line of fs.readFileSync(CONFIG_FILE, 'utf8').split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.startsWith(`${key}=`)) {
			return trimmed.slice(key.length + 1).trim();
		}
	}
	return '';
}

/**
 * Rewrite one `NAME = '<value>'` literal in a source file; returns true
 * when the file changed. Throws when the declaration is missing — a
 * renamed constant must fail the build, not silently stop stamping.
 */
function stampLiteral(filePath, pattern, replacement, label) {
	const content = fs.readFileSync(filePath, 'utf8');
	if (!pattern.test(content)) {
		throw new Error(`${label} declaration not found in ${filePath}`);
	}
	const updated = content.replace(pattern, replacement);
	if (updated !== content) {
		fs.writeFileSync(filePath, updated, 'utf8');
		return true;
	}
	return false;
}

function makeStampAction() {
	return {
		run: async (ctx, task) => {
			const zitadelUrl = readConfigValue('RR_ZITADEL_URL');
			const cliClientId = readConfigValue('RR_ZITADEL_CLI_CLIENT_ID');

			// step: stamp both language twins from the same source of truth
			let changed = false;
			changed = stampLiteral(TS_DEFAULTS, /export const DEFAULT_ZITADEL_URL = '[^']*'/, `export const DEFAULT_ZITADEL_URL = '${zitadelUrl}'`, 'DEFAULT_ZITADEL_URL') || changed;
			changed = stampLiteral(TS_DEFAULTS, /export const DEFAULT_CLI_CLIENT_ID = '[^']*'/, `export const DEFAULT_CLI_CLIENT_ID = '${cliClientId}'`, 'DEFAULT_CLI_CLIENT_ID') || changed;
			changed = stampLiteral(PY_DEFAULTS, /DEFAULT_ZITADEL_URL = '[^']*'/, `DEFAULT_ZITADEL_URL = '${zitadelUrl}'`, 'DEFAULT_ZITADEL_URL') || changed;
			changed = stampLiteral(PY_DEFAULTS, /DEFAULT_CLI_CLIENT_ID = '[^']*'/, `DEFAULT_CLI_CLIENT_ID = '${cliClientId}'`, 'DEFAULT_CLI_CLIENT_ID') || changed;

			task.output = changed ? `Stamped auth defaults from .config (${cliClientId ? 'CLI sign-in enabled' : 'no CLI client id'})` : 'Auth defaults already current';
		},
	};
}

module.exports = {
	name: 'client-common',
	description: 'Shared client operations library (source, compiled in by consumers)',

	actions: [
		// Description-less: rides the client builds, not `builder build`.
		{ name: 'client-common:stamp', action: makeStampAction },
	],
};
