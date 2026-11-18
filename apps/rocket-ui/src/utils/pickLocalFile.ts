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
// PICK LOCAL FILE — the browser's file dialog as a promise
// =============================================================================

/** The `accept` attribute per kind the Assets pane asks for. */
const ACCEPT: Record<'image' | 'markdown', string> = {
	image: 'image/svg+xml,image/png,image/jpeg,image/gif,image/webp,.svg,.png,.jpg,.jpeg,.gif,.webp',
	markdown: 'text/markdown,.md',
};

/**
 * Opens the browser's file dialog and resolves the chosen file's name and
 * bytes — the cloud host's half of the Assets pane's `pickFile` (VS Code
 * uses its native dialog). Resolves null when the dialog is dismissed.
 *
 * @param accept - Which kind of file to offer.
 * @returns The file, or null on cancel.
 */
export function pickLocalFile(accept: 'image' | 'markdown'): Promise<{ name: string; data: Uint8Array } | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = ACCEPT[accept];
		input.style.display = 'none';
		const finish = (): void => {
			input.remove();
		};
		input.addEventListener('change', () => {
			const file = input.files?.[0];
			finish();
			if (!file) {
				resolve(null);
				return;
			}
			void file.arrayBuffer().then((buffer) => resolve({ name: file.name, data: new Uint8Array(buffer) }));
		});
		// step: a dismissed dialog fires `cancel` (no change) — resolve null
		input.addEventListener('cancel', () => {
			finish();
			resolve(null);
		});
		document.body.appendChild(input);
		input.click();
	});
}
