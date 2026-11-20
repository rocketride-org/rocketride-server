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
// SQL-UI — SHORTCUTS (when the shortcut sheet's `?` key applies)
// =============================================================================
//
// Pure checks, kept apart from the sheet so they run without a DOM. The
// targets are read through the few properties the checks need.
// =============================================================================

/** The part of a keydown event the sheet's key reads. */
export interface ShortcutKeyEvent {
	/** The character the key produced. */
	key: string;
	/** Whether Ctrl was held. */
	ctrlKey: boolean;
	/** Whether Cmd (Meta) was held. */
	metaKey: boolean;
	/** Whether Alt was held. */
	altKey: boolean;
	/** The element the event started from. */
	target: EventTarget | null;
}

/**
 * Whether typing in this element writes text, so single-character shortcuts
 * must leave it alone: inputs, textareas, selects, contenteditable elements
 * and anything inside the Monaco editor (its text area sits inside
 * `.monaco-editor`).
 *
 * @param target - The event target.
 * @returns True when the key belongs to the element.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
	const el = target as Partial<HTMLElement> | null;
	if (!el) return false;
	const tag = (el.tagName ?? '').toUpperCase();
	if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
	if (el.isContentEditable === true) return true;
	return typeof el.closest === 'function' && el.closest('.monaco-editor, [contenteditable="true"]') !== null;
}

/**
 * Whether the element sits inside an open dialog, which owns the keyboard.
 *
 * @param target - The event target.
 * @returns True inside a dialog.
 */
function isInsideDialog(target: EventTarget | null): boolean {
	const el = target as Partial<HTMLElement> | null;
	return typeof el?.closest === 'function' && el.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]') !== null;
}

/**
 * Whether this key press should open the shortcut sheet: a bare `?` that is
 * not typed into a text field or the editor, and not while a dialog is open.
 *
 * @param event - The keydown event.
 * @returns True when the sheet should open.
 */
export function opensShortcutSheet(event: ShortcutKeyEvent): boolean {
	if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return false;
	return !isEditableTarget(event.target) && !isInsideDialog(event.target);
}
