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
 * base-installer.ts - Base class for per-agent stub installers
 *
 * Marker protocol:
 *   <!-- ROCKETRIDE:BEGIN -->
 *   {stub content}
 *   <!-- ROCKETRIDE:END -->
 *
 * - install:   appends markers + content (or replaces if markers already exist)
 * - uninstall: removes markers + content, deletes file if empty
 *
 * The merge/strip logic lives in the client-common source library — the
 * exact code the CLI's `rocketride init` runs — and the stub templates
 * come from the workspace's downloaded docs bundle
 * (.rocketride/docs/stubs/), so installed stubs always match the
 * connected server.
 */

import * as vscode from 'vscode';
import { installStub, stripStubContent, MARKER_BEGIN, MARKER_END } from '../../../../packages/client-common/typescript/src/provision';

export abstract class BaseAgentInstaller {
	/** Agent display name (e.g., "Cursor") */
	abstract readonly name: string;

	/** Stub filename inside the workspace's .rocketride/docs/stubs/ directory (e.g., "cursor.mdc") */
	abstract readonly stubSource: string;

	/** Target path relative to workspace root (e.g., ".cursor/rules/rocketride.mdc") */
	abstract readonly stubTarget: string;

	/**
	 * Install the stub into the workspace.
	 * If the target file exists and already contains markers, replaces the marked section.
	 * If the target file exists without markers, appends.
	 * If the target file doesn't exist, creates it.
	 *
	 * Returns true if installed/updated successfully.
	 */
	async install(workspaceRoot: vscode.Uri): Promise<boolean> {
		return installStub(workspaceRoot.fsPath, this.stubSource, this.stubTarget);
	}

	/**
	 * Check if the stub is already installed in the workspace.
	 */
	async isInstalled(workspaceRoot: vscode.Uri): Promise<boolean> {
		const targetUri = vscode.Uri.joinPath(workspaceRoot, this.stubTarget);
		try {
			const bytes = await vscode.workspace.fs.readFile(targetUri);
			const content = Buffer.from(bytes).toString('utf8');
			return content.includes(MARKER_BEGIN) && content.includes(MARKER_END);
		} catch {
			return false;
		}
	}

	/**
	 * Remove the RocketRide stub from the target file.
	 * If the file becomes empty (or whitespace-only) after removal, deletes it.
	 *
	 * Returns true if uninstalled successfully.
	 */
	async uninstall(workspaceRoot: vscode.Uri): Promise<boolean> {
		const targetUri = vscode.Uri.joinPath(workspaceRoot, this.stubTarget);
		let existing: string;
		try {
			const bytes = await vscode.workspace.fs.readFile(targetUri);
			existing = Buffer.from(bytes).toString('utf8');
		} catch {
			return false; // Nothing to uninstall
		}

		const stripped = stripStubContent(existing);
		if (stripped.trim() === '') {
			await vscode.workspace.fs.delete(targetUri);
		} else {
			await vscode.workspace.fs.writeFile(targetUri, Buffer.from(stripped, 'utf8'));
		}
		return true;
	}
}
