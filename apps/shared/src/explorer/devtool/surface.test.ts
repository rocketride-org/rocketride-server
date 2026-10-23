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

// =============================================================================
// EXPLORER DEV TOOL — SURFACE (a deep entry that imports no VALUE from 'shell')
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DIR = __dirname;
const modules = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const read = (file: string): string => fs.readFileSync(path.join(DIR, file), 'utf8');

describe('the dev-tool deep entry', () => {
	it('has the modules the lanes import', () => {
		for (const name of ['activation.ts', 'busClient.ts', 'controller.ts', 'deadline.ts', 'frame.ts', 'frameIdentity.ts', 'gridPersistence.ts', 'identity.ts', 'prefs.ts', 'realm.ts', 'reply.ts', 'state.ts', 'summon.ts', 'testing.ts', 'timeouts.ts', 'watch.ts']) {
			assert.ok(modules.includes(name), name);
		}
	});

	it("no module imports a VALUE from 'shell' (type-only imports are fine)", () => {
		for (const file of modules) {
			const valueImports = read(file).split('\n').filter((line) => /^(import|export) .*from 'shell';/.test(line) && !/^(import|export) type /.test(line));
			assert.deepEqual(valueImports, [], file);
		}
	});

	it('only the test harness reaches into the shell package sources', () => {
		for (const file of modules) {
			const reaches = /packages\/shell\/src/.test(read(file).split('\n').filter((line) => line.startsWith('import')).join('\n'));
			assert.equal(reaches, file === 'testing.ts', file);
		}
	});

	it("is not re-exported from the library barrel (its promise: no VALUE import from 'shell')", () => {
		const barrel = fs.readFileSync(path.join(DIR, '..', 'index.ts'), 'utf8');
		assert.doesNotMatch(barrel, /devtool/);
	});
});
