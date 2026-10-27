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
// MENU KEYS — arrow keys move between a button menu's items
// =============================================================================
//
// The Query page's Export and safety-level menus are buttons in a popup. Up
// and Down move between them (wrapping), and Home and End go to the first and
// last, as a menu does. The rule is pure; the view applies it to the
// buttons it renders.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { menuKeyTarget } from '../src/a11y/menuKeys';

const view = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'QueryView.tsx'), 'utf8');

describe('menuKeyTarget', () => {
	it('moves down and up, wrapping at either end', () => {
		assert.equal(menuKeyTarget('ArrowDown', 0, 3), 1);
		assert.equal(menuKeyTarget('ArrowDown', 2, 3), 0);
		assert.equal(menuKeyTarget('ArrowUp', 0, 3), 2);
		assert.equal(menuKeyTarget('ArrowUp', 1, 3), 0);
	});

	it('goes to the first and the last with Home and End', () => {
		assert.equal(menuKeyTarget('Home', 2, 3), 0);
		assert.equal(menuKeyTarget('End', 0, 3), 2);
	});

	it('starts from the ends when focus is on no item', () => {
		assert.equal(menuKeyTarget('ArrowDown', -1, 3), 0);
		assert.equal(menuKeyTarget('ArrowUp', -1, 3), 2);
	});

	it('leaves every other key, and an empty menu, alone', () => {
		assert.equal(menuKeyTarget('Enter', 0, 3), null);
		assert.equal(menuKeyTarget('a', 0, 3), null);
		assert.equal(menuKeyTarget('ArrowDown', 0, 0), null);
	});
});

describe('the Query page menus', () => {
	it('both menus move between their items with the arrow keys', () => {
		assert.equal((view.match(/onKeyDown=\{(?:\(event\) => )?moveMenuFocus/g) ?? []).length + (view.match(/moveMenuFocus\(event\)/g) ?? []).length >= 2, true);
		assert.match(view, /function moveMenuFocus\(event: React\.KeyboardEvent<HTMLElement>\): void \{/);
		assert.match(view, /const target = menuKeyTarget\(event\.key, items\.indexOf\(document\.activeElement as HTMLButtonElement\), items\.length\);/);
	});

	it('a menu closed by an outside click gives focus back to its button, unless the click put focus somewhere', () => {
		assert.match(view, /onClose=\{\(\) => \{\s*setSafetyMenuOpen\(false\);\s*refocusIfLost\(safetyAnchorRef\);\s*\}\}/);
		assert.match(view, /onClose=\{\(\) => \{\s*setExportOpen\(false\);\s*refocusIfLost\(exportAnchorRef\);\s*\}\}/);
		assert.match(view, /if \(document\.activeElement === null \|\| document\.activeElement === document\.body\) anchor\.current\?\.querySelector\('button'\)\?\.focus\(\);/);
	});
});
