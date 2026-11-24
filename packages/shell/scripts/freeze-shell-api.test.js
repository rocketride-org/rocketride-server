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

'use strict';

// =============================================================================
// freeze-shell-api tests — what counts as a change between two bundles
// =============================================================================
//
// Pins the rules declarationTexts gives the freeze's body comparison:
//   1. the order of the names inside one named import is cosmetic: two
//      bundles that differ only there compare equal, so --check passes and a
//      full freeze mints no redundant version;
//   2. an import that names another binding or another module still differs;
//   3. overload order is NOT cosmetic: swapping two overloads is a change.
//
// Built-in runner; loads the script's typescript devDependency, as a freeze does:
//     node --test packages/shell/scripts/freeze-shell-api.test.js
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { declarationTexts } = require('./freeze-shell-api');

/**
 * A bundle body: the given import lines ahead of one declaration that uses them.
 *
 * @param {string[]} imports - The import statements, one per line.
 * @returns {string} The bundle body.
 */
function bundle(imports) {
	const declaration = ['export interface Props {', '\tstyle?: CSSProperties;', '\tchildren?: ReactNode;', '}'];
	return [...imports, ...declaration].join('\n');
}

test('the order of the names in a named import is not a change', () => {
	const before = declarationTexts(bundle(["import { CSSProperties, ReactNode } from 'react';"]));
	const after = declarationTexts(bundle(["import { ReactNode, CSSProperties } from 'react';"]));

	assert.deepEqual([...after], [...before]);
});

test('the order of aliased and type-only named imports is not a change either', () => {
	const before = declarationTexts(
		bundle([
			"import type { CSSProperties, ReactNode } from 'react';",
			"import { CellComponent, Options as Options$1, Tabulator } from 'tabulator-tables';",
		])
	);
	const after = declarationTexts(
		bundle([
			"import type { ReactNode, CSSProperties } from 'react';",
			"import { Tabulator, Options as Options$1, CellComponent } from 'tabulator-tables';",
		])
	);

	assert.deepEqual([...after], [...before]);
});

test('an import of another binding or from another module is still a change', () => {
	const base = declarationTexts(bundle(["import { CSSProperties, ReactNode } from 'react';"]));
	const otherName = declarationTexts(bundle(["import { CSSProperties, ReactElement } from 'react';"]));
	const otherModule = declarationTexts(bundle(["import { CSSProperties, ReactNode } from 'preact';"]));
	const typeOnly = declarationTexts(bundle(["import type { CSSProperties, ReactNode } from 'react';"]));

	assert.notDeepEqual([...otherName.keys()], [...base.keys()]);
	assert.notDeepEqual([...otherModule.keys()], [...base.keys()]);
	assert.notDeepEqual([...typeOnly.keys()], [...base.keys()]);
});

test('swapping two overloads is a change', () => {
	const first = 'export declare function pick(value: string): string;';
	const second = 'export declare function pick(value: number): number;';

	const before = declarationTexts([first, second].join('\n'));
	const after = declarationTexts([second, first].join('\n'));

	assert.equal(before.size, 1);
	assert.notEqual(after.get('FunctionDeclaration:pick'), before.get('FunctionDeclaration:pick'));
});
