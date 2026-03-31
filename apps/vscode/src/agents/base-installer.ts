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
 * base-installer.ts - Abstract Base for Agent Stub Installers
 *
 * Provides marker-based idempotent install/update/uninstall logic.
 * Concrete installers only need to declare name, stubSource, and stubTarget.
 *
 * Marker protocol:
 *   <!-- ROCKETRIDE:BEGIN -->
 *   {stub content}
 *   <!-- ROCKETRIDE:END -->
 *
 * - install:   appends markers + content (or replaces if markers already exist)
 * - uninstall: removes markers + content, deletes file if empty
 */

import * as vscode from 'vscode';

const MARKER_BEGIN = '<!-- ROCKETRIDE:BEGIN -->';
const MARKER_END = '<!-- ROCKETRIDE:END -->';

export abstract class BaseAgentInstaller {
	/** Agent display name (e.g., "Cursor") */
	abstract readonly name: string;

	/** Stub filename inside the extension's docs/stubs/ directory (e.g., "cursor.mdc") */
	abstract readonly stubSource: string;

	/** Target path relative to workspace root (e.g., ".cursor/rules/rocketride.mdc") */
	abstract readonly stubTarget: string;

	/**
	 * Read the stub template from the extension bundle.
	 */
	async readStub(extensionPath: string): Promise<string> {
		const stubUri = vscode.Uri.file(`${extensionPath}/docs/stubs/${this.stubSource}`);
		const bytes = await vscode.workspace.fs.readFile(stubUri);
		return Buffer.from(bytes).toString('utf8');
	}

	/**
	 * Install the stub into the workspace.
	 * If the target file exists and already contains markers, replaces the marked section.
	 * If the target file exists without markers, appends.
	 * If the target file doesn't exist, creates it.
	 *
	 * Returns true if installed/updated successfully.
	 */
	async install(extensionPath: string, workspaceRoot: vscode.Uri): Promise<boolean> {
		const stubContent = await this.readStub(extensionPath);
		const targetUri = vscode.Uri.joinPath(workspaceRoot, this.stubTarget);

		// Ensure parent directory exists
		const parentUri = vscode.Uri.joinPath(targetUri, '..');
		await vscode.workspace.fs.createDirectory(parentUri);

		let existing = '';
		try {
			const bytes = await vscode.workspace.fs.readFile(targetUri);
			existing = Buffer.from(bytes).toString('utf8');
		} catch {
			// File doesn't exist — will create
		}

		const newContent = this.mergeContent(existing, stubContent);

		// Only write if content actually changed — avoid dirtying the repo.
		// Normalize line endings so \r\n vs \n doesn't trigger a false write.
		if (newContent.replace(/\r\n/g, '\n') === existing.replace(/\r\n/g, '\n')) {
			return false;
		}

		await vscode.workspace.fs.writeFile(targetUri, Buffer.from(newContent, 'utf8'));
		return true;
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

		const stripped = this.stripMarkedContent(existing);
		if (stripped.trim() === '') {
			await vscode.workspace.fs.delete(targetUri);
		} else {
			await vscode.workspace.fs.writeFile(targetUri, Buffer.from(stripped, 'utf8'));
		}
		return true;
	}

	/**
	 * Merge stub content into existing file content using markers.
	 * - If markers exist: replace content between them.
	 * - If no markers: append stub content (with leading newline separator).
	 * - If file is empty: return stub content as-is.
	 */
	protected mergeContent(existing: string, stubContent: string): string {
		if (existing === '') {
			return stubContent;
		}

		const beginIdx = existing.indexOf(MARKER_BEGIN);
		const endIdx = existing.indexOf(MARKER_END);

		if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
			// Replace existing marked section
			const before = existing.substring(0, beginIdx);
			const after = existing.substring(endIdx + MARKER_END.length);
			return before + this.extractMarkedContent(stubContent) + after;
		}

		// Append with separator
		return existing.trimEnd() + '\n\n' + stubContent;
	}

	/**
	 * Extract the full marked block (including markers) from stub content.
	 * If the stub doesn't contain markers, wraps it.
	 */
	private extractMarkedContent(stubContent: string): string {
		const beginIdx = stubContent.indexOf(MARKER_BEGIN);
		const endIdx = stubContent.indexOf(MARKER_END);

		if (beginIdx !== -1 && endIdx !== -1) {
			return stubContent.substring(beginIdx, endIdx + MARKER_END.length);
		}

		return `${MARKER_BEGIN}\n${stubContent}\n${MARKER_END}`;
	}

	/**
	 * Remove the marked block (markers + content between) from a string.
	 */
	private stripMarkedContent(content: string): string {
		const beginIdx = content.indexOf(MARKER_BEGIN);
		const endIdx = content.indexOf(MARKER_END);

		if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
			return content;
		}

		const before = content.substring(0, beginIdx);
		const after = content.substring(endIdx + MARKER_END.length);
		return (before + after).replace(/\n{3,}/g, '\n\n').trim();
	}
}
