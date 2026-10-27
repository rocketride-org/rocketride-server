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
// SHORTCUT SHEET — when `?` opens it
// =============================================================================
//
// `?` is a character people type, so it must never open the sheet from a
// text field, a contenteditable element or the SQL editor. The target checks
// are duck-typed because the tests have no DOM; the wiring test reads the
// source of the workbench, as the other view tests do.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isEditableTarget, opensShortcutSheet } from '../src/components/shortcuts';

/** A stand-in for a DOM element: just what the check reads. */
function el(tagName: string, extra: Record<string, unknown> = {}): EventTarget {
	return { tagName, isContentEditable: false, closest: () => null, ...extra } as unknown as EventTarget;
}

const press = (key: string, target: EventTarget | null, mods: Record<string, boolean> = {}) =>
	({ key, ctrlKey: false, metaKey: false, altKey: false, target, ...mods });

describe('isEditableTarget', () => {
	it('is true for inputs, textareas and selects', () => {
		for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(isEditableTarget(el(tag)), true, tag);
	});

	it('is true for contenteditable elements', () => {
		assert.equal(isEditableTarget(el('DIV', { isContentEditable: true })), true);
	});

	it('is true inside the Monaco editor', () => {
		const inMonaco = el('TEXTAREA');
		assert.equal(isEditableTarget(el('DIV', { closest: (sel: string) => (sel.includes('.monaco-editor') ? {} : null) })), true);
		assert.equal(isEditableTarget(inMonaco), true);
	});

	it('is false for buttons, the body and nothing', () => {
		assert.equal(isEditableTarget(el('BUTTON')), false);
		assert.equal(isEditableTarget(el('BODY')), false);
		assert.equal(isEditableTarget(null), false);
	});
});

describe('opensShortcutSheet', () => {
	it('opens on ? from the page', () => {
		assert.equal(opensShortcutSheet(press('?', el('BODY'))), true);
		assert.equal(opensShortcutSheet(press('?', el('BUTTON'))), true);
	});

	it('ignores ? typed into editable targets', () => {
		assert.equal(opensShortcutSheet(press('?', el('INPUT'))), false);
		assert.equal(opensShortcutSheet(press('?', el('TEXTAREA'))), false);
		assert.equal(opensShortcutSheet(press('?', el('DIV', { isContentEditable: true }))), false);
		assert.equal(opensShortcutSheet(press('?', el('DIV', { closest: () => ({}) }))), false);
	});

	it('ignores ? while a dialog is open', () => {
		const inDialog = el('BUTTON', { closest: (sel: string) => (sel.includes('[role="dialog"]') ? {} : null) });
		assert.equal(opensShortcutSheet(press('?', inDialog)), false);
	});

	it('ignores other keys and chorded ?', () => {
		assert.equal(opensShortcutSheet(press('/', el('BODY'))), false);
		assert.equal(opensShortcutSheet(press('?', el('BODY'), { ctrlKey: true })), false);
		assert.equal(opensShortcutSheet(press('?', el('BODY'), { metaKey: true })), false);
		assert.equal(opensShortcutSheet(press('?', el('BODY'), { altKey: true })), false);
	});
});

describe('the workbench wiring', () => {
	const view = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'ConnectionView.tsx'), 'utf8');

	it('listens for keydown and asks opensShortcutSheet before opening the sheet', () => {
		assert.match(view, /addEventListener\('keydown'/);
		assert.match(view, /opensShortcutSheet\(event\)/);
		assert.match(view, /<ShortcutSheet\b/);
	});

	it('probes again after the store is cleared', () => {
		assert.match(view, /useSchemaGeneration\(\)/);
		assert.match(view, /`\$\{endpoint\.key\}#\$\{epoch\}`/);
	});

	it('has a header button that opens the same sheet', () => {
		assert.match(view, /Shortcuts/);
		assert.match(view, /setShortcutsOpen\(true\)/);
	});
});

// DA-R2 M1: since the schema-only fix, QueryView's runner refuses a keyboard
// run and sends nothing (canRun), so the sheet must not say it "still tries".
describe('the shortcut sheet says what a keyboard run does on a schema-only node', () => {
	const sheet = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'ShortcutSheet.tsx'), 'utf8');
	const view = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'QueryView.tsx'), 'utf8');

	it('it is refused and sends nothing; Check again is the way back', () => {
		assert.match(view, /canRun: \(\) => \{\s*if \(allowExecuteOff\) \{[\s\S]*?return false;/);
		assert.doesNotMatch(sheet, /still tries/);
		assert.match(sheet, /On a schema-only node a run from the keyboard sends nothing and says why; Check again on the query page looks again/);
	});
});

