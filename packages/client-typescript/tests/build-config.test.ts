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
 * Regression guard for the packaging gap that shipped rocketride@1.3.0
 * without `app-sdk`: `src/app-sdk` exists, is declared in package.json's
 * `exports` map, and is fully documented, but tsconfig.{cjs,esm,types}.json
 * only had `include: ["./src/client/**\/*"]` — a sibling directory silently
 * never got compiled, so `dist/**\/app-sdk` was never produced and `import
 * ... from 'rocketride/app-sdk'` failed on every real install. `ts-jest`
 * (this test runner) doesn't enforce a tsconfig's `include` list the way
 * `tsc -p` does, so a normal unit test importing from `src/app-sdk` would
 * NOT have caught this — only checking the packaging config itself does.
 *
 * This test is intentionally generic (derives the expected directory list
 * from `src/` itself) so it also catches the next top-level module that
 * gets added without updating the build config, not just this one.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const PACKAGE_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src');

// `src/cli` is intentionally excluded: it isn't part of the package.json
// "exports" map (it's the "bin" entry) and is built by its own dedicated
// tsconfig.cli.json, which already includes both "./src/cli/**/*" and
// "./src/client/**/*" for that reason.
const EXCLUDED_TOP_LEVEL_DIRS = new Set(['cli']);

const BUILD_TSCONFIGS = ['tsconfig.cjs.json', 'tsconfig.esm.json', 'tsconfig.types.json'];

function readJsonc(filePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Top-level directories under src/ that contain their own index.ts entry point. */
function getModuleRootDirs(): string[] {
	return fs
		.readdirSync(SRC_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((name) => !EXCLUDED_TOP_LEVEL_DIRS.has(name))
		.filter((name) => fs.existsSync(path.join(SRC_DIR, name, 'index.ts')));
}

describe('client-typescript packaging config', () => {
	const moduleRoots = getModuleRootDirs();

	it('finds at least the known module roots (sanity check the discovery logic itself)', () => {
		expect(moduleRoots).toEqual(expect.arrayContaining(['client', 'app-sdk']));
	});

	for (const tsconfigName of BUILD_TSCONFIGS) {
		describe(tsconfigName, () => {
			const config = readJsonc(path.join(PACKAGE_DIR, tsconfigName));
			const include = (config.include as string[] | undefined) ?? [];

			for (const dir of moduleRoots) {
				it(`includes src/${dir}/**/*`, () => {
					const expectedPattern = `./src/${dir}/**/*`;
					expect(include).toContain(expectedPattern);
				});
			}
		});
	}

	it('package.json "exports" paths for "." and "./analytics" agree with the src/client rootDir nesting', () => {
		// Once a sibling directory (app-sdk) is compiled alongside src/client,
		// TypeScript's inferred rootDir becomes ./src instead of ./src/client,
		// which shifts every src/client/* output one level deeper (to
		// dist/<target>/client/...). package.json must point at the shifted
		// paths, not the old un-nested ones.
		const pkg = readJsonc(path.join(PACKAGE_DIR, 'package.json'));
		const exportsMap = pkg.exports as Record<string, Record<string, string>>;

		expect(pkg.main).toBe('./dist/cjs/client/index.js');
		expect(pkg.module).toBe('./dist/esm/client/index.js');
		expect(pkg.types).toBe('./dist/types/client/index.d.ts');

		expect(exportsMap['.']).toEqual({
			types: './dist/types/client/index.d.ts',
			import: './dist/esm/client/index.js',
			require: './dist/cjs/client/index.js',
		});
		expect(exportsMap['./analytics']).toEqual({
			types: './dist/types/client/analytics/index.d.ts',
			import: './dist/esm/client/analytics/index.js',
			require: './dist/cjs/client/analytics/index.js',
		});

		// app-sdk is a sibling of client, not nested inside it, so its
		// resolved path never had a "client/" segment to begin with.
		expect(exportsMap['./app-sdk']).toEqual({
			types: './dist/types/app-sdk/index.d.ts',
			import: './dist/esm/app-sdk/index.js',
			require: './dist/cjs/app-sdk/index.js',
		});
	});
});
