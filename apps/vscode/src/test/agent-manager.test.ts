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

import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentManager } from '../agents/agent-manager';

/** Minimal in-memory stand-in for vscode.Memento, scoped to a single test. */
function createMemento(): vscode.Memento {
	const store = new Map<string, unknown>();
	return {
		get: ((key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue)) as vscode.Memento['get'],
		update: async (key: string, value: unknown) => {
			store.set(key, value);
		},
		keys: () => [...store.keys()],
	};
}

suite('AgentManager', () => {
	test('detectEnvironment does not auto-detect Copilot when the Copilot extension is not installed', async () => {
		// The Extension Development Host used for these tests has no Copilot extension
		// installed, so this directly exercises the fixed detection logic (issue #1186:
		// previously any VS Code instance was treated as having Copilot).
		assert.strictEqual(vscode.extensions.getExtension('GitHub.copilot'), undefined);
		assert.strictEqual(vscode.extensions.getExtension('GitHub.copilot-chat'), undefined);

		const manager = new AgentManager();
		const detected = await manager.detectEnvironment();

		assert.ok(!detected.some((installer) => installer.name === 'Copilot'), 'Copilot should not be auto-detected without the real Copilot extension installed');
	});

	test('autoInstall does not write to the workspace when the user declines the consent prompt', async () => {
		const workspaceRoot = vscode.Uri.file(path.join(os.tmpdir(), `rocketride-test-${Date.now()}`));
		const originalShowInformationMessage = vscode.window.showInformationMessage;
		vscode.window.showInformationMessage = (async () => 'Not now') as typeof vscode.window.showInformationMessage;

		const context = { globalState: createMemento() } as unknown as vscode.ExtensionContext;

		try {
			const manager = new AgentManager();
			// Force a detection regardless of what's actually installed in the test host,
			// so this test exercises the consent gate itself rather than environment detection.
			manager.detectEnvironment = async () => [{ name: 'Copilot', stubTarget: '.github/copilot-instructions.md' } as never];
			await manager.autoInstall(context, __dirname, workspaceRoot);

			let workspaceExists = true;
			try {
				await vscode.workspace.fs.stat(workspaceRoot);
			} catch {
				workspaceExists = false;
			}
			assert.strictEqual(workspaceExists, false, 'declining consent must not create any workspace files');
		} finally {
			vscode.window.showInformationMessage = originalShowInformationMessage;
		}
	});
});
