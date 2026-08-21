#!/usr/bin/env node

/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * rocketride-init / typescript-init — workspace bootstrap shim.
 *
 *     pnpm install <server>/client/typescript-init
 *     pnpm exec typescript-init
 *
 * (No argument needed — the shim reads the server from its own install
 * spec in package.json. An explicit `[server-url]` argument overrides.)
 *
 * This shim is deliberately tiny and STABLE — it never carries platform
 * logic, so a cached copy (pnpm's URL store, a registry mirror) stays
 * correct forever. All real, server-versioned material arrives by plain
 * HTTP from the server itself:
 *
 *   1. Download the server's own client tarball to its permanent
 *      vendored location (.rocketride/client/rocketride.tgz).
 *   2. Install it as a FILE dependency — content-hashed, so a rebuilt
 *      server package always installs (URL dependencies would be cached
 *      by pnpm and silently never refetched).
 *   3. Hand off to that client's `rocketride init` for sign-in and
 *      workspace provisioning.
 *
 * Re-running is the update path: the download refreshes the vendored
 * tarball and init reconciles the workspace against the server.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_SERVER = 'http://localhost:5565';
const TGZ_DIR = path.join('.rocketride', 'client');
const TGZ_PATH = path.join(TGZ_DIR, 'rocketride.tgz');

// pnpm's Windows entry is a .cmd shim, and Node (22+) refuses to spawn
// .cmd files without a shell. On Windows we therefore run ONE
// self-quoted command string through the shell (every token quoted, so
// cmd.exe metacharacters like & in URLs cannot split the command);
// elsewhere it is a plain no-shell spawn.
const PNPM = 'pnpm';

/**
 * Spawn a command portably (see the PNPM note above).
 *
 * @param {string} cmd - The executable.
 * @param {string[]} args - Its arguments.
 * @param {object} opts - spawnSync options.
 * @returns {object} The spawnSync result.
 */
function spawnPortable(cmd, args, opts) {
	if (process.platform === 'win32') {
		const line = [cmd].concat(args).map(function (a) { return '"' + a + '"'; }).join(' ');
		return spawnSync(line, Object.assign({ shell: true }, opts));
	}
	return spawnSync(cmd, args, opts);
}

/**
 * Print usage and exit.
 */
function usage() {
	console.log('Usage: typescript-init [server-url]');
	console.log('');
	console.log('Bootstraps the current directory as a RocketRide workspace. The');
	console.log('server defaults to the one this shim was installed from');
	console.log(`(else ${DEFAULT_SERVER}).`);
	process.exit(0);
}

/**
 * Recover the server this shim was installed from: the workspace
 * package.json records the install URL verbatim as the dependency spec
 * (e.g. "http://host:5565/client/typescript-init").
 *
 * @returns {string} The server origin, or '' when not installed by URL.
 */
function installSourceServer() {
	try {
		const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
		const specs = Object.assign({}, pkg.dependencies, pkg.devDependencies);
		for (const spec of Object.values(specs)) {
			const match = /^(https?:\/\/[^\s]+?)\/client\/typescript-init\/?$/i.exec(String(spec));
			if (match) {
				return match[1];
			}
		}
	} catch {
		// No/unreadable package.json — fall through to the default
	}
	return '';
}

/**
 * Run one command inherited to this terminal; exit with its code on failure.
 *
 * @param {string} cmd - The executable.
 * @param {string[]} args - Its arguments.
 */
function run(cmd, args) {
	const result = spawnPortable(cmd, args, { stdio: 'inherit' });
	if (result.status !== 0) {
		console.error('\n' + cmd + ' ' + args.join(' ') + ' failed (exit ' + (result.status === null ? 'signal' : result.status) + ')');
		process.exit(result.status === null ? 1 : result.status);
	}
}

/**
 * Bootstrap: download the server's client, pin it, hand off to init.
 */
async function main() {
	const arg = process.argv[2];
	if (arg === '--help' || arg === '-h') {
		usage();
	}
	const server = (arg || installSourceServer() || DEFAULT_SERVER).replace(/\/+$/, '');

	// step: preconditions - node 18+ (for fetch) and pnpm on the PATH
	const major = Number(process.versions.node.split('.')[0]);
	if (major < 18) {
		console.error('Node 18 or newer is required (found ' + process.versions.node + ').');
		process.exit(1);
	}
	const pnpm = spawnPortable(PNPM, ['--version'], {});
	if (pnpm.status !== 0) {
		console.error('pnpm is required. Install it with: npm install -g pnpm');
		process.exit(1);
	}

	// step: download the server's own client tarball straight to its
	// permanent vendored location - a plain GET, so the server's current
	// build always wins
	console.log('Downloading the client package from ' + server + '/client/typescript ...');
	let res;
	try {
		res = await fetch(server + '/client/typescript');
	} catch (err) {
		console.error('Cannot reach ' + server + ' - is the server running? (' + (err && err.message ? err.message : err) + ')');
		process.exit(1);
	}
	if (!res.ok) {
		console.error(server + ' did not serve the client package (HTTP ' + res.status + ').');
		process.exit(1);
	}
	fs.mkdirSync(TGZ_DIR, { recursive: true });
	fs.writeFileSync(TGZ_PATH, Buffer.from(await res.arrayBuffer()));
	console.log('Saved ' + TGZ_PATH + '.');

	// step: install as a FILE dependency - content-hashed, cache-proof
	if (!fs.existsSync('package.json')) {
		run(PNPM, ['init']);
	}
	run(PNPM, ['add', 'file:' + TGZ_PATH.split(path.sep).join('/')]);

	// step: hand off to the server-matched CLI for sign-in + provisioning
	console.log('\nClient installed. Continuing with workspace initialization...\n');
	run(PNPM, ['exec', 'rocketride', 'init', '--uri', server]);
}

main().catch(function (err) {
	console.error(err && err.message ? err.message : String(err));
	process.exit(1);
});
