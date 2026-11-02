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

	// The negative case above rides on the host profile having no Copilot; these
	// two pin the other half of the contract — that the real extension IDs, and
	// only those, are what turns detection on.
	for (const extensionId of ['GitHub.copilot', 'GitHub.copilot-chat']) {
		test(`detectEnvironment auto-detects Copilot when ${extensionId} is installed`, async () => {
			const originalGetExtension = vscode.extensions.getExtension;
			vscode.extensions.getExtension = ((id: string) => (id === extensionId ? ({ id } as vscode.Extension<unknown>) : undefined)) as typeof vscode.extensions.getExtension;

			try {
				const manager = new AgentManager();
				const detected = await manager.detectEnvironment();

				assert.ok(
					detected.some((installer) => installer.name === 'Copilot'),
					`Copilot should be auto-detected when ${extensionId} is installed`
				);
			} finally {
				vscode.extensions.getExtension = originalGetExtension;
			}
		});
	}

	test('autoInstall writes nothing to the workspace while autoAgentIntegration is unset', async () => {
		// autoAgentIntegration defaults to false: the user ticking the box is the
		// consent, so an unset setting must never touch the workspace.
		assert.notStrictEqual(vscode.workspace.getConfiguration('rocketride').get<boolean>('integrations.autoAgentIntegration'), true);

		const workspaceRoot = vscode.Uri.file(path.join(os.tmpdir(), `rocketride-test-${Date.now()}`));
		const manager = new AgentManager();
		// Force a detection regardless of what's actually installed in the test host,
		// so this test exercises the setting gate rather than environment detection.
		manager.detectEnvironment = async () => [{ name: 'Copilot', stubTarget: '.github/copilot-instructions.md' } as never];
		await manager.autoInstall(workspaceRoot);

		let workspaceExists = true;
		try {
			await vscode.workspace.fs.stat(workspaceRoot);
		} catch {
			workspaceExists = false;
		}
		assert.strictEqual(workspaceExists, false, 'an unset autoAgentIntegration must not create any workspace files');
	});
});
