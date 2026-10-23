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
// MANIFEST — what the app pack must carry besides the app folder
// =============================================================================
//
// `shared/...` imports resolve only through tsconfig paths onto ../shared/src.
// A pack built from the app folder alone (App Builder, `rocketride app deploy`)
// carries apps/shared only when appManifest.include names it, so an app that
// imports from shared must declare it, in the form the other apps use.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const APP_ROOT = path.join(__dirname, '..');

/**
 * Every source file under a directory.
 *
 * @param dir - The directory.
 * @returns Absolute paths of .ts / .tsx files.
 */
function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return sources(full);
		return /\.tsx?$/.test(entry.name) ? [full] : [];
	});
}

describe('appManifest', () => {
	it('declares apps/shared in include, because the app imports from shared', () => {
		const importers = sources(path.join(APP_ROOT, 'src')).filter((file) => /from '(?:shared)\//.test(readFileSync(file, 'utf8')));
		assert.ok(importers.length > 0, 'the app imports from shared');
		const manifest = JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).appManifest as { include?: unknown };
		assert.deepEqual(manifest.include, ['apps/shared']);
	});

	it('ships a version that installs seeded before the Explorer rework do not have, so a local engine re-seeds the app', () => {
		// A local (OSS) engine copies a built-in app's bundle into its store
		// once, and seeds it again only when the version in apps.json (stamped
		// from this package.json by registerApp) differs from the version it
		// seeded (packages/ai/src/ai/account/oss/__init__.py). Every install
		// before the shared Explorer rework seeded 1.0.0, so at 1.0.0 an upgraded
		// engine would keep serving the old SQL Explorer.
		const { version } = JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
		assert.equal(typeof version, 'string');
		assert.match(version as string, /^\d+\.\d+\.\d+$/);
		assert.notEqual(version, '1.0.0');
	});
});
