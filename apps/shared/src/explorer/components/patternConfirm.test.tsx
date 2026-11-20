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
// EXPLORER — PATTERN CONFIRMATION: the safe answer is the default one
// =============================================================================
//
// The confirmation appears right after a Run keystroke. The shell's dialog
// focuses its confirm button, so a second Enter would send the flagged
// statement; this dialog moves focus to Cancel instead. There is no DOM here, so
// the focus step is driven against a minimal stand-in for the dialog.
//
// NOT COVERED HERE: the effect order the fix relies on. React runs a commit's
// effects child first, so the shell Modal's focus-in runs, then ConfirmDialog's
// confirm-button focus, then PatternConfirmDialog's own effect, which calls
// focusCancelIn last and wins. A shell change that focuses the confirm button
// later than its mount effect (a timer, a frame) would undo this without
// failing these tests.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PATTERN_CANCEL_LABEL, focusCancelIn } from './PatternConfirmDialog';

/**
 * A stand-in for the dialog the shell renders: buttons in footer order.
 *
 * @param labels - The footer buttons' labels, in order.
 * @returns The anchor inside the dialog, and the labels that received focus.
 */
function dialogWith(labels: string[]): { anchor: Element; focused: string[] } {
	const focused: string[] = [];
	const buttons = labels.map((label) => ({ textContent: ` ${label} `, focus: () => { focused.push(label); } }));
	const dialog = { querySelectorAll: (selector: string) => (selector === 'button' ? buttons : []) };
	const anchor = { closest: (selector: string) => (selector === '[role="dialog"]' ? dialog : null) };
	return { anchor: anchor as unknown as Element, focused };
}

describe('PatternConfirmDialog — default focus', () => {
	it('moves focus to Cancel, never to the button that runs the statement', () => {
		const { anchor, focused } = dialogWith([PATTERN_CANCEL_LABEL, 'Run and stop asking on this connection', 'Run statement']);
		assert.equal(focusCancelIn(anchor), true);
		assert.deepEqual(focused, [PATTERN_CANCEL_LABEL]);
	});

	it('does nothing outside a dialog or without a Cancel button', () => {
		assert.equal(focusCancelIn(null), false);
		assert.equal(focusCancelIn({ closest: () => null } as unknown as Element), false);
		const { anchor, focused } = dialogWith(['Run statement']);
		assert.equal(focusCancelIn(anchor), false);
		assert.deepEqual(focused, []);
	});
});
