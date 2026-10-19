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
// CONFIRM SERVICE — the shell's own imperative confirmation dialog
// =============================================================================
//
// Confirmation is REALM UI, not a host capability: every realm that runs
// tool code bundles the shell, so the shell pops its stock ConfirmDialog
// right there — no host wiring, no capability to be absent, identical in
// the web workbench and a VS Code webview. (ToolHostServices.confirm is
// deprecated in favor of this; it only ever existed because confirmation
// was misfiled as host-variant.)
//
// One dialog at a time per realm: a second call while one is open resolves
// false immediately rather than stacking modals.
// =============================================================================

import { createRoot } from 'react-dom/client';
import { ConfirmDialog } from './ConfirmDialog';

/** The realm's open-dialog latch (one confirmation at a time). */
let open = false;

/**
 * Shows the shell's confirmation dialog in THIS realm and resolves with
 * the user's choice. Never rejects; a call while another confirmation is
 * open resolves false (no stacked modals).
 *
 * @param title - Dialog title.
 * @param message - Body message.
 * @param confirmLabel - Primary button label (default "Confirm").
 * @returns True when the user confirmed.
 */
export function showConfirmDialog(title: string, message: string, confirmLabel = 'Confirm'): Promise<boolean> {
	if (open) return Promise.resolve(false);
	open = true;
	return new Promise<boolean>((resolve) => {
		const hostEl = document.createElement('div');
		document.body.appendChild(hostEl);
		const root = createRoot(hostEl);
		const done = (confirmed: boolean): void => {
			open = false;
			// Unmount on a fresh task — React forbids unmounting from inside
			// a render/event of the same root.
			setTimeout(() => {
				root.unmount();
				hostEl.remove();
			}, 0);
			resolve(confirmed);
		};
		root.render(
			<ConfirmDialog
				title={title}
				message={message}
				confirmLabel={confirmLabel}
				onConfirm={() => done(true)}
				onCancel={() => done(false)}
			/>
		);
	});
}
