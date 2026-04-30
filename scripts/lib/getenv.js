// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Centralised environment loader for build configs.
 *
 * Reads rocketride-server/.config (public defaults) and overlays the
 * appropriate .env file on top.  Which .env is used depends on whether
 * the build is running in overlay mode:
 *
 *   Overlay mode  (ROCKETRIDE_BUILD_ROOT set):  <overlay-root>/.env
 *   Standalone    (no overlay):                  rocketride-server/.env
 */
const path = require('path');
const fs = require('fs');

/** Absolute path to the rocketride-server repo root. */
const SERVER_ROOT = path.resolve(__dirname, '../..');

// ============================================================================
// PARSE FILE
// ============================================================================

/**
 * Parse a key=value file (comments and blank lines ignored).
 *
 * @param {string} filePath - Absolute path to the file to parse.
 * @returns {Record<string, string>} Parsed key-value pairs.
 */
function parseFile(filePath) {
	try {
		const text = fs.readFileSync(filePath, 'utf8');
		const result = {};
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const eq = trimmed.indexOf('=');
			if (eq < 0) continue;
			result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
		}
		return result;
	} catch {
		return {};
	}
}

// ============================================================================
// GET ENV
// ============================================================================

/**
 * Load merged build environment: .config defaults + .env overrides.
 *
 * In overlay mode (ROCKETRIDE_BUILD_ROOT is set by build.js when
 * --overlay-root is passed), the .env is read from the overlay root.
 * Otherwise the .env is read from the rocketride-server root.
 *
 * @returns {Record<string, string>} Merged configuration.
 */
function getenv() {
	// Step 1: read .config (public defaults, always from server root)
	const config = parseFile(path.join(SERVER_ROOT, '.config'));

	// Step 2: determine which .env to use
	// Overlay mode: ROCKETRIDE_BUILD_ROOT = <overlay-root>/build
	const buildRoot = process.env.ROCKETRIDE_BUILD_ROOT;
	const envRoot = buildRoot ? path.resolve(buildRoot, '..') : SERVER_ROOT;
	const env = parseFile(path.join(envRoot, '.env'));

	// Step 3: merge — .env values override .config defaults
	return { ...config, ...env };
}

// ============================================================================
// REQUIRE KEYS
// ============================================================================

/**
 * Verify that all required keys are present and non-empty in the env object.
 * Throws with a descriptive message listing every missing key.
 *
 * @param {Record<string, string>} env    - The merged environment object.
 * @param {string[]}               keys   - Keys that must be present and non-empty.
 * @param {string}                 caller - Build target name for the error message.
 */
function requireKeys(env, keys, caller) {
	const missing = keys.filter((k) => !env[k]);
	if (missing.length > 0) {
		throw new Error(`[${caller}] Missing required environment variable(s): ${missing.join(', ')}\n` + `Check your .env (or .config) file.`);
	}
}

module.exports = { getenv, parseFile, requireKeys };
