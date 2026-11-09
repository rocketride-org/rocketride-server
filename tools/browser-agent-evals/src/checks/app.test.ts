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

// =============================================================================
// APP CHECK TESTS: the runner's own type-check and build of an app
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DATA_DIR } from '../catalog';
import { readTree } from '../references';
import { appFolders, changedApps, checkApps, withLoads } from './app';

test('an app counts as changed when a file under it was added, changed or deleted, and not when it is gone', () => {
	const start = { 'apps/a-ui/src/App.tsx': 'a', 'apps/a-ui/src/Old.tsx': 'old', 'apps/b-ui/src/App.tsx': 'b', 'apps/c-ui/src/App.tsx': 'c', 'apps/gone-ui/package.json': '{}' };
	// a-ui: a file it imports was deleted; b-ui: untouched; c-ui: changed; gone-ui: deleted whole; new-ui: added
	const final = { 'apps/a-ui/src/App.tsx': 'a', 'apps/b-ui/src/App.tsx': 'b', 'apps/c-ui/src/App.tsx': 'c2', 'apps/new-ui/package.json': '{}' };
	assert.deepEqual(changedApps(start, final), ['apps/a-ui', 'apps/c-ui', 'apps/new-ui']);
});

test('a hand-made app passes its type-check and build, and a copy with type errors fails on types', async () => {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'app-check-'));
	const good = readTree(path.join(DATA_DIR, 'fixtures/notes-app'));
	const broken = readTree(path.join(DATA_DIR, 'fixtures/notes-app-broken'));
	assert.deepEqual(appFolders(good), ['apps/notes-ui']);
	const [ok] = Object.values(await checkApps(['apps/notes-ui'], good, path.join(work, 'good')));
	assert.equal(ok.ok, true, ok.detail);
	assert.equal(ok.build.ok, true);
	assert.match(ok.build.output, /built|dist|ready/i, 'rsbuild reports a build');
	const [bad] = Object.values(await checkApps(['apps/notes-ui'], broken, path.join(work, 'bad')));
	assert.equal(bad.ok, false);
	assert.match(bad.detail, /^types: .*error TS/s);
	assert.equal(bad.build.ok, null);
	// the work folders are removed, so nothing is left behind
	assert.deepEqual(fs.readdirSync(work), []);
	fs.rmSync(work, { recursive: true });
});

test('a failed Design preview load fails the app check, and an unread one only adds a note', () => {
	const base = (ok: boolean) => ({ ok, detail: ok ? 'types and build pass' : 'types: 1 error', types: { ok, output: '' }, build: { ok: ok ? true : null, output: '' } });
	const checks = { 'apps/a': base(true), 'apps/b': base(true), 'apps/c': base(true), 'apps/d': base(false), 'apps/e': base(true) };
	withLoads(checks, {
		'apps/a': { ok: true, detail: 'loads: 5 Console rows, no errors', errors: [], crashed: false },
		'apps/b': { ok: false, detail: 'the app shows its error screen', errors: ['x'], crashed: true },
		'apps/c': { ok: null, detail: 'not read: no Console rows', errors: [], crashed: false },
		'apps/d': { ok: true, detail: 'loads', errors: [], crashed: false },
	});
	assert.equal(checks['apps/a'].ok, true);
	assert.equal(checks['apps/b'].ok, false);
	assert.equal(checks['apps/b'].detail, 'load: the app shows its error screen');
	assert.equal(checks['apps/c'].ok, true);
	assert.match(checks['apps/c'].detail, /load not checked/);
	assert.equal(checks['apps/d'].ok, false, 'a load cannot pass an app whose build failed');
	assert.equal(checks['apps/e'].ok, true);
	assert.equal('load' in checks['apps/e'], false);
});
