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

/**
 * App Builder pnpm presence checks and user interaction.
 */
import * as vscode from 'vscode';
import { MISSING_PNPM_MESSAGE, isPnpmMissingError, checkPnpmInstalled, isWindowsMissingPnpmShellExit } from '../shared/util/pnpm';

export { MISSING_PNPM_MESSAGE, isPnpmMissingError, checkPnpmInstalled, isWindowsMissingPnpmShellExit };

let lastPromptTime = 0;
const PROMPT_DEBOUNCE_MS = 5000;

/**
 * Shows an error toast notifying the user that pnpm is required and offers
 * a one-click action to install it via terminal or open the docs.
 *
 * @param detail - Optional custom message text to display.
 */
export async function promptMissingPnpm(detail?: string): Promise<boolean> {
	const now = Date.now();
	if (now - lastPromptTime < PROMPT_DEBOUNCE_MS) {
		return false;
	}
	lastPromptTime = now;

	const message = detail ?? MISSING_PNPM_MESSAGE;
	const action = await vscode.window.showErrorMessage(
		message,
		'Install pnpm',
		'Documentation'
	);

	if (action === 'Install pnpm') {
		const terminal = vscode.window.createTerminal('RocketRide: Install pnpm');
		terminal.show();
		terminal.sendText('npm install -g pnpm');
		return true;
	}
	if (action === 'Documentation') {
		void vscode.env.openExternal(vscode.Uri.parse('https://pnpm.io/installation'));
	}
	return false;
}
