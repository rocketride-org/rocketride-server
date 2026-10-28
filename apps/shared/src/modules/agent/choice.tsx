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
// CHOICE — the unsaved-changes prompt: save mine first, discard mine, keep mine
// =============================================================================

/**
 * The question about unsaved changes, mounted the way the shell's confirm
 * service mounts ChoiceDialog. It does not use the service's
 * showChoiceDialog, which cannot take a dialog down when the run ends.
 */

import { createRoot } from 'react-dom/client';
import { ChoiceDialog, type IChoiceOption } from 'shell';

import type { ChoiceFn, UnsavedChoice } from './toolkits/common';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * The buttons, left to right. Keep mine is last and none is primary, so the
 * dialog focuses Keep mine: it opens while the user may be typing, and Space
 * or Enter typed into it then changes nothing.
 */
const CHOICE_OPTIONS: readonly IChoiceOption[] = [
	{ id: 'save', label: 'Save mine first' },
	{ id: 'discard', label: 'Discard mine', destructive: true },
	{ id: 'keep', label: 'Keep mine' },
];

const OPEN_DIALOG = '[role="dialog"][aria-modal="true"]';
const OWN_DIALOG = 'data-agent-choice';

// =============================================================================
// THE QUEUE
// =============================================================================

/** One question on screen, and a way to take it down unanswered. */
export interface ShownChoice {
	answer: Promise<UnsavedChoice>;
	close: () => void;
}

/**
 * Shows questions one at a time, in the order asked. A question whose turn
 * comes while a dialog that is not ours is open (`blocked`) resolves
 * 'unasked', unshown; one whose signal aborts resolves 'keep' and is taken
 * down.
 */
export function queueChoices(show: (title: string, message: string) => ShownChoice, blocked: () => boolean = () => false): ChoiceFn {
	let turn: Promise<unknown> = Promise.resolve();
	return (title, message, signal) => {
		const ask = (): Promise<UnsavedChoice> => {
			if (signal?.aborted) return Promise.resolve('keep');
			if (blocked()) return Promise.resolve('unasked');
			const shown = show(title, message);
			if (!signal) return shown.answer;
			return new Promise<UnsavedChoice>((resolve) => {
				const end = (): void => {
					shown.close();
					resolve('keep');
				};
				signal.addEventListener('abort', end, { once: true });
				const answered = (choice: UnsavedChoice): void => {
					signal.removeEventListener('abort', end);
					resolve(choice);
				};
				shown.answer.then(answered, () => answered('keep'));
			});
		};
		const asked = turn.then(ask);
		turn = asked.catch(() => undefined);
		return asked;
	};
}

/**
 * Whether a modal dialog that is not one of ours is open. Ours are passed
 * over: the last one stays in the page until its deferred unmount, and must
 * not block the next question. Hidden ones are too: below 1024 px the shell's
 * closed navigation drawer stays in the page as a modal dialog with
 * `visibility: hidden`. Chrome 105 to 120 know that option only by its old
 * name, checkVisibilityCSS. A browser without checkVisibility counts every
 * dialog, so a question never opens over another.
 */
export function otherDialogOpen(root: ParentNode = document): boolean {
	return [...root.querySelectorAll(OPEN_DIALOG)].some((dialog) => !dialog.closest(`[${OWN_DIALOG}]`) && dialog.checkVisibility?.({ visibilityProperty: true, checkVisibilityCSS: true }) !== false);
}

// =============================================================================
// THE DIALOG
// =============================================================================

/** Mounts the dialog in this realm. */
function mountChoice(title: string, message: string): ShownChoice {
	const hostEl = document.createElement('div');
	hostEl.setAttribute(OWN_DIALOG, '');
	document.body.appendChild(hostEl);
	const root = createRoot(hostEl);
	let mounted = true;
	const close = (): void => {
		if (!mounted) return;
		mounted = false;
		// Unmount on a fresh task. React forbids unmounting from inside
		// a render or event of the same root.
		setTimeout(() => {
			root.unmount();
			hostEl.remove();
		}, 0);
	};
	const answer = new Promise<UnsavedChoice>((resolve) => {
		const settle = (choice: UnsavedChoice): void => {
			close();
			resolve(choice);
		};
		root.render(<ChoiceDialog title={title} message={message} options={CHOICE_OPTIONS} onChoose={(id) => settle(id === 'save' || id === 'discard' ? id : 'keep')} onCancel={() => settle('keep')} />);
	});
	return { answer, close };
}

/** Asks the user what to do with their unsaved changes, one dialog at a time. */
export const showChoice: ChoiceFn = queueChoices(mountChoice, () => otherDialogOpen());
