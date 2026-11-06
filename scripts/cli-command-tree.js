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
 * Print the TypeScript `rocketride` CLI's command tree as JSON, for
 * scripts/validate-cli-docs.py.
 *
 * Loads the CLI's TypeScript sources directly (transpiled in memory with the
 * repo's `typescript` package), so it needs no client build. It calls the same
 * register*Commands functions, in the same order, as createProgram() in
 * packages/client-typescript/src/cli/rocketride.ts.
 *
 * Output: [{ "path": "app create", "options": ["--json", ...], "group": false }, ...]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const CLI_DIR = path.join(__dirname, '..', 'packages', 'client-typescript', 'src', 'cli');

// The SDK sources import siblings as './x.js' (ESM style). Point those at the .ts file.
const resolveFilename = Module._resolveFilename;
/** Resolve a `./x.js` import from a .ts file to `./x.ts` when that file exists. */
Module._resolveFilename = function (request, parent, ...rest) {
	if (parent?.filename?.endsWith('.ts') && request.startsWith('.') && request.endsWith('.js')) {
		const tsFile = path.resolve(path.dirname(parent.filename), request.slice(0, -3) + '.ts');
		if (fs.existsSync(tsFile)) return tsFile;
	}
	return resolveFilename.call(this, request, parent, ...rest);
};

/** Load a .ts file by transpiling it to CommonJS in memory. */
Module._extensions['.ts'] = (module, filename) => {
	const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
		fileName: filename,
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
	});
	module._compile(outputText, filename);
};

// The register calls createProgram() makes, read from its source. This script replays only plain
// `registerXCommands(program);` calls, so fail if rocketride.ts registers commands any other way
// (other arguments, a helper, an inline program.command()) rather than check a shorter list.
const entry = fs.readFileSync(path.join(CLI_DIR, 'rocketride.ts'), 'utf8');
const registerNames = [...entry.matchAll(/^\s*(register\w+Commands)\(program\);/gm)].map((m) => m[1]);
const registerCalls = [...entry.matchAll(/\bregister\w+Commands\s*\(/g)].length;
if (registerNames.length === 0 || registerCalls !== registerNames.length || /\.command\s*\(/.test(entry)) {
	throw new Error(
		'cli-command-tree: rocketride.ts registers commands in a way this script does not replay. ' +
			'Update scripts/cli-command-tree.js to match createProgram().',
	);
}

const registers = {};
for (const file of fs.readdirSync(path.join(CLI_DIR, 'commands'))) {
	if (file.endsWith('.ts')) Object.assign(registers, require(path.join(CLI_DIR, 'commands', file)));
}

// commander is a dependency of the TypeScript client, not of the repo root.
const { Command } = Module.createRequire(path.join(CLI_DIR, 'rocketride.ts'))('commander');
const program = new Command('rocketride');
for (const name of registerNames) {
	if (typeof registers[name] !== 'function') {
		throw new Error(`cli-command-tree: rocketride.ts calls ${name}, which no file in src/cli/commands exports`);
	}
	registers[name](program);
}

const tree = [];
/**
 * Add each sub-command of `command` to the tree, depth first.
 *
 * @param {import('commander').Command} command - The command whose sub-commands to add.
 * @param {string[]} prefix - The words of `command`'s own path.
 */
const walk = (command, prefix) => {
	for (const sub of command.commands) {
		const words = [...prefix, sub.name()];
		tree.push({
			path: words.join(' '),
			options: sub.options.map((option) => option.long).filter(Boolean),
			group: sub.commands.length > 0,
		});
		walk(sub, words);
	}
};
walk(program, []);
process.stdout.write(JSON.stringify(tree));
