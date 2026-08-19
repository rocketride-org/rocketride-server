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

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectPackedFiles } from '../appdev/packFilter';

/**
 * Materializes a file tree in a fresh temp workspace and returns its root.
 * Keys are workspace-relative POSIX paths; values are file contents.
 */
function workspace(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packfilter-'));
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(root, ...rel.split('/'));
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	}
	return root;
}

/** The sorted zip paths the filter selects. */
function zipPaths(root: string, packRoots: string[]): string[] {
	return collectPackedFiles(root, packRoots).map((f) => f.zipPath);
}

test('baseline excludes apply without any .gitignore', () => {
	const root = workspace({
		'apps/foo-ui/package.json': '{}',
		'apps/foo-ui/src/App.tsx': 'x',
		'apps/foo-ui/node_modules/react/index.js': 'x',
		'apps/foo-ui/dist/remoteEntry.js': 'x',
		'apps/foo-ui/.git/HEAD': 'x',
	});
	assert.deepEqual(zipPaths(root, ['apps/foo-ui']), ['apps/foo-ui/package.json', 'apps/foo-ui/src/App.tsx']);
});

test('workspace-root .gitignore filters the app subtree', () => {
	const root = workspace({
		'.gitignore': '*.log\n',
		'apps/foo-ui/package.json': '{}',
		'apps/foo-ui/debug.log': 'x',
	});
	assert.deepEqual(zipPaths(root, ['apps/foo-ui']), ['apps/foo-ui/package.json']);
});

test('negation patterns re-include within one .gitignore', () => {
	const root = workspace({
		'.gitignore': '*.log\n!keep.log\n',
		'apps/foo-ui/keep.log': 'x',
		'apps/foo-ui/drop.log': 'x',
	});
	assert.deepEqual(zipPaths(root, ['apps/foo-ui']), ['apps/foo-ui/keep.log']);
});

test('a nested .gitignore scopes to its own subtree only', () => {
	const root = workspace({
		'apps/foo-ui/.gitignore': '*.tmp\n',
		'apps/foo-ui/scratch.tmp': 'x',
		'apps/foo-ui/src/App.tsx': 'x',
		'shared/data.tmp': 'x',
	});
	// foo-ui's rule drops its own .tmp; shared/ is out of that rule's scope
	assert.deepEqual(zipPaths(root, ['apps/foo-ui', 'shared']), ['apps/foo-ui/.gitignore', 'apps/foo-ui/src/App.tsx', 'shared/data.tmp']);
});

test("an include root's ancestor .gitignore applies to its contents", () => {
	const root = workspace({
		'rocketride-server/.gitignore': '*.pyc\n',
		'rocketride-server/apps/shared/src/util.ts': 'x',
		'rocketride-server/apps/shared/src/cache.pyc': 'x',
	});
	assert.deepEqual(zipPaths(root, ['rocketride-server/apps/shared']), ['rocketride-server/apps/shared/src/util.ts']);
});

test('.rrapp markers pack even when gitignored', () => {
	const root = workspace({
		'.gitignore': '*.rrapp\n',
		'apps/foo-ui/foo.rrapp': '{"id":"acme.foo"}',
		'apps/foo-ui/package.json': '{}',
	});
	assert.deepEqual(zipPaths(root, ['apps/foo-ui']), ['apps/foo-ui/foo.rrapp', 'apps/foo-ui/package.json']);
});

test('a named root beats the rule that ignores it; other rules still filter', () => {
	const root = workspace({
		'.gitignore': 'vendor/\n*.log\n',
		'vendor/lib.js': 'x',
		'vendor/debug.log': 'x',
	});
	// vendor/ is explicitly included: the rule set ignoring it is dropped for
	// this walk, but *.log (a different line in the SAME file) — dropping is
	// per rule SET, so the whole root .gitignore no longer applies here while
	// the baseline still does.
	assert.deepEqual(zipPaths(root, ['vendor']), ['vendor/debug.log', 'vendor/lib.js']);
});

test('overlapping roots dedupe by zip path', () => {
	const root = workspace({
		'apps/foo-ui/package.json': '{}',
	});
	assert.deepEqual(zipPaths(root, ['apps/foo-ui', 'apps/foo-ui/package.json']), ['apps/foo-ui/package.json']);
});

test('a file pack root is taken verbatim', () => {
	const root = workspace({
		'.gitignore': 'config.json\n',
		'config.json': '{}',
	});
	// Explicitly named file: packed even though a pattern ignores it
	assert.deepEqual(zipPaths(root, ['config.json']), ['config.json']);
});

test('a missing pack root fails loudly', () => {
	const root = workspace({ 'apps/foo-ui/package.json': '{}' });
	assert.throws(() => zipPaths(root, ['apps/ghost']), /apps\/ghost/);
});

test("'' packs the workspace root itself (app-as-workspace)", () => {
	const root = workspace({
		'package.json': '{}',
		'src/App.tsx': 'x',
		'node_modules/react/index.js': 'x',
	});
	assert.deepEqual(zipPaths(root, ['']), ['package.json', 'src/App.tsx']);
});

test('a nested negation re-includes a file an ancestor ignored (deepest wins)', () => {
	const root = workspace({
		'.gitignore': '*.log\n',
		'apps/foo-ui/.gitignore': '!keep.log\n',
		'apps/foo-ui/package.json': '{}',
		'apps/foo-ui/keep.log': 'x',
		'apps/foo-ui/drop.log': 'x',
	});
	// The root *.log ignores every log; foo-ui's deeper !keep.log wins for
	// keep.log (git precedence is deepest-wins), while drop.log stays excluded.
	assert.deepEqual(zipPaths(root, ['apps/foo-ui']), ['apps/foo-ui/.gitignore', 'apps/foo-ui/keep.log', 'apps/foo-ui/package.json']);
});

test('a negation cannot re-include a baseline (node_modules) exclude', () => {
	const root = workspace({
		'apps/foo-ui/.gitignore': '!node_modules\n',
		'apps/foo-ui/package.json': '{}',
		'apps/foo-ui/node_modules/react/index.js': 'x',
	});
	// The baseline is a hard floor — no user negation revives node_modules.
	assert.deepEqual(zipPaths(root, ['apps/foo-ui']), ['apps/foo-ui/.gitignore', 'apps/foo-ui/package.json']);
});

test('a symlink whose target escapes the workspace is not packed', (t) => {
	// An outside tree carrying a secret, and a workspace that links into it.
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'packfilter-outside-'));
	fs.writeFileSync(path.join(outside, 'secret.txt'), 'credentials');
	const root = workspace({ 'apps/foo-ui/package.json': '{}' });
	const link = path.join(root, 'apps', 'foo-ui', 'vendor');
	try {
		fs.symlinkSync(outside, link, 'dir');
	} catch (err) {
		// Windows without the symlink-creation privilege — nothing to assert.
		t.skip(`symlinks unavailable: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	// vendor/ resolves outside the workspace, so its files never enter the zip.
	assert.deepEqual(zipPaths(root, ['apps/foo-ui']), ['apps/foo-ui/package.json']);
});

test('a symlink to an in-workspace dir is still packed (containment allows it)', (t) => {
	const root = workspace({
		'apps/foo-ui/package.json': '{}',
		'shared/lib.ts': 'x',
	});
	const link = path.join(root, 'apps', 'foo-ui', 'linked-shared');
	try {
		fs.symlinkSync(path.join(root, 'shared'), link, 'dir');
	} catch (err) {
		t.skip(`symlinks unavailable: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	// The link's real target is inside the workspace, so it is walked and its
	// file packs at the link's path.
	assert.deepEqual(zipPaths(root, ['apps/foo-ui']), ['apps/foo-ui/linked-shared/lib.ts', 'apps/foo-ui/package.json']);
});

test('a symlink target that is also a separate pack root packs under both paths', (t) => {
	const root = workspace({
		'apps/foo-ui/package.json': '{}',
		'shared/lib.ts': 'x',
	});
	const link = path.join(root, 'apps', 'foo-ui', 'linked-shared');
	try {
		fs.symlinkSync(path.join(root, 'shared'), link, 'dir');
	} catch (err) {
		t.skip(`symlinks unavailable: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	// `shared` is reached through the link (as apps/foo-ui/linked-shared/…) AND
	// named as its own root. A shared realpath cycle-guard would drop the
	// second walk and lose shared/lib.ts; the per-root guard keeps both zip
	// paths (cross-root dedup is by zip path, not real path).
	assert.deepEqual(zipPaths(root, ['apps/foo-ui', 'shared']), [
		'apps/foo-ui/linked-shared/lib.ts',
		'apps/foo-ui/package.json',
		'shared/lib.ts',
	]);
});
