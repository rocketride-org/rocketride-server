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

// =============================================================================
// DIALOG SERVICE — the shell's own imperative dialogs
// =============================================================================
//
// Dialogs are REALM UI, not a host capability: every realm that runs tool
// code bundles the shell, so the shell pops its stock dialog right there —
// no host wiring, no capability to be absent, identical in the web
// workbench and a VS Code webview. (ToolHostServices.confirm is deprecated
// in favor of this; it only ever existed because confirmation was misfiled
// as host-variant.)
//
// Because these mount their OWN React root, they are callable from plain
// classes — which is what lets `Documents` own its dirty-close policy
// instead of pushing the decision out to every app's tab bar.
//
// showChoiceDialog is the general form; showConfirmDialog is the two-option
// case of it, kept verbatim for compatibility (it is in the frozen shell
// contract, and it is the easiest way to confirm one action).
//
// One dialog at a time per realm: a second call while one is open resolves
// WITHOUT a choice rather than stacking modals — `null` from the chooser,
// `false` from the confirmer. Callers that must distinguish "the user
// cancelled" from "we never got to ask" pass `cancelId`: a real dismissal
// then resolves to that id, and only an unaskable call resolves null.
// =============================================================================

import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { ChoiceDialog } from './ChoiceDialog';
import type { IChoiceOption } from './ChoiceDialog';

/** The realm's open-dialog latch (one dialog at a time). */
let open = false;

/** {@link showConfirmDialog}'s affirmative option id. */
const CONFIRM_OK_ID = 'confirm';

/** {@link showConfirmDialog}'s dismissal option id. */
const CONFIRM_CANCEL_ID = 'cancel';

/** A {@link showChoiceDialog} request. */
export interface ChoiceDialogRequest {
	/** Dialog title. */
	title: string;
	/** Body message — a plain string or a custom node. */
	message: ReactNode;
	/** The actions, in left-to-right render order (affirmative last). */
	options: readonly IChoiceOption[];
	/**
	 * Id resolved when the dialog is DISMISSED (Escape, the corner ✕, or a
	 * cancel option). Omit and a dismissal resolves null — indistinguishable
	 * from a call that could not be shown, so pass it whenever the
	 * difference matters.
	 */
	cancelId?: string;
	/** Box width in px (defaults to the modal default). */
	width?: number;
}

/**
 * Shows a dialog with any number of actions in THIS realm and resolves with
 * the chosen option's id. Never rejects.
 *
 * Resolves `null` when the choice was never made: the dialog could not be
 * shown (another is already open), or it was dismissed and no `cancelId`
 * was given. A `null` must therefore never be treated as an affirmative —
 * the safe reading is always "do nothing".
 *
 * @param request - See {@link ChoiceDialogRequest}.
 * @returns The chosen option id, the `cancelId` on dismissal, or null.
 */
export function showChoiceDialog(request: ChoiceDialogRequest): Promise<string | null> {
	if (open) return Promise.resolve(null);
	open = true;
	return new Promise<string | null>((resolve) => {
		const hostEl = document.createElement('div');
		document.body.appendChild(hostEl);
		const root = createRoot(hostEl);
		const done = (id: string | null): void => {
			open = false;
			// Unmount on a fresh task — React forbids unmounting from inside
			// a render/event of the same root.
			setTimeout(() => {
				root.unmount();
				hostEl.remove();
			}, 0);
			resolve(id);
		};
		root.render(
			<ChoiceDialog
				title={request.title}
				message={request.message}
				options={request.options}
				{...(request.width !== undefined ? { width: request.width } : {})}
				onChoose={(id) => done(id)}
				onCancel={() => done(request.cancelId ?? null)}
			/>
		);
	});
}

/**
 * Shows the shell's confirmation dialog in THIS realm and resolves with
 * the user's choice. Never rejects; a call while another dialog is open
 * resolves false (no stacked modals).
 *
 * @param title - Dialog title.
 * @param message - Body message.
 * @param confirmLabel - Primary button label (default "Confirm").
 * @returns True when the user confirmed.
 */
export async function showConfirmDialog(title: string, message: string, confirmLabel = 'Confirm'): Promise<boolean> {
	// The two-option case of showChoiceDialog. Same footer order and styles
	// as the standalone ConfirmDialog (cancel left, affirmative right and
	// focused), so the rendering is unchanged; only one choice is "true".
	const choice = await showChoiceDialog({
		title,
		message,
		options: [
			{ id: CONFIRM_CANCEL_ID, label: 'Cancel' },
			{ id: CONFIRM_OK_ID, label: confirmLabel, primary: true },
		],
		cancelId: CONFIRM_CANCEL_ID,
	});
	return choice === CONFIRM_OK_ID;
}
