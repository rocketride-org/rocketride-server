// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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
 * Cursor IDE integration utilities
 */

import * as vscode from 'vscode';
import * as path from 'path';

const DOCS_ROOT_DIR = 'docs/root';
const DOCS_API_DIR = 'docs/api';
const RULES_FILENAME = 'rules.md';
const CURSORRULES_FILENAME = '.cursorrules';
const MARKER_START = '# RocketRide - Cursor Instructions';
const MARKER_END = '### RocketRide End of instructions';

/**
 * Detects if running in Cursor IDE
 */
export function isCursor(): boolean {
	// Cursor identifies itself in various ways
	return vscode.env.appName.toLowerCase().includes('cursor') ||
		   process.env.TERM_PROGRAM === 'cursor' ||
		   // @ts-expect-error - Cursor-specific API
		   typeof vscode.workspace?.isCursor !== 'undefined';
}

/**
 * Gets the extension root directory
 */
function getExtensionRoot(): string | undefined {
	const extension = vscode.extensions.getExtension('rocketride.rocketride');
	return extension?.extensionPath;
}

/**
 * Reads the rules.md file from extension docs/root
 */
async function readRules(): Promise<string | null> {
	try {
		const extensionRoot = getExtensionRoot();
		if (!extensionRoot) {
			console.error('Failed to get extension root path');
			return null;
		}
		
		const rulesPath = vscode.Uri.file(path.join(extensionRoot, DOCS_ROOT_DIR, RULES_FILENAME));
		const content = await vscode.workspace.fs.readFile(rulesPath);
		return Buffer.from(content).toString('utf8');
	} catch (error) {
		console.error('Failed to read rules.md from extension:', error);
		return null;
	}
}

/**
 * Syncs extension's rules.md to workspace .cursorrules, replacing ${ROCKETRIDE_EXTDIR} with actual path
 */
async function syncCursorRules(workspaceRoot: string, rulesContent: string): Promise<void> {
	try {
		const extensionRoot = getExtensionRoot();
		if (!extensionRoot) {
			throw new Error('Failed to get extension root path');
		}

		// Replace ${ROCKETRIDE_EXTDIR} with actual extension docs/api path
		const rocketrideDocsPath = path.join(extensionRoot, DOCS_API_DIR);
		const processedContent = rulesContent.replace(/\$\{ROCKETRIDE_EXTDIR\}/g, rocketrideDocsPath);

		const targetPath = vscode.Uri.file(path.join(workspaceRoot, CURSORRULES_FILENAME));

		let finalContent: string;

		// Check if file exists
		try {
			const existingContent = await vscode.workspace.fs.readFile(targetPath);
			const existingText = Buffer.from(existingContent).toString('utf8');

			// Check if our content is already there
			const markerStartIndex = existingText.indexOf(MARKER_START);
			const markerEndIndex = existingText.indexOf(MARKER_END);

			if (markerStartIndex !== -1 && markerEndIndex !== -1) {
				// Our content exists, replace it
				const before = existingText.substring(0, markerStartIndex);
				const after = existingText.substring(markerEndIndex + MARKER_END.length);
				finalContent = before + processedContent + after;
			} else {
				// Our content doesn't exist, append it
				finalContent = existingText + '\n\n' + processedContent;
			}
		} catch {
			// File doesn't exist, create it with full content
			finalContent = processedContent;
		}

		// Write the file
		await vscode.workspace.fs.writeFile(targetPath, Buffer.from(finalContent, 'utf8'));
	} catch (error) {
		throw new Error(`Failed to sync Cursor rules: ${error}`);
	}
}

/**
 * Removes Cursor integration files from workspace
 */
async function removeCursorRules(workspaceRoot: string): Promise<void> {
	try {
		const targetPath = vscode.Uri.file(path.join(workspaceRoot, CURSORRULES_FILENAME));

		try {
			const existingContent = await vscode.workspace.fs.readFile(targetPath);
			const existingText = Buffer.from(existingContent).toString('utf8');

			// Check if our content is there
			const markerStartIndex = existingText.indexOf(MARKER_START);
			const markerEndIndex = existingText.indexOf(MARKER_END);

			if (markerStartIndex !== -1 && markerEndIndex !== -1) {
				// Remove our content
				const before = existingText.substring(0, markerStartIndex);
				const after = existingText.substring(markerEndIndex + MARKER_END.length);
				const finalContent = (before + after).trim();

				if (finalContent) {
					// Write remaining content
					await vscode.workspace.fs.writeFile(targetPath, Buffer.from(finalContent, 'utf8'));
				} else {
					// Delete file if empty
					await vscode.workspace.fs.delete(targetPath);
				}
			}
		} catch {
			// File doesn't exist, nothing to remove
		}
	} catch {
		// Ignore
	}
}

/**
 * Syncs or removes Cursor integration based on enabled state
 */
export async function integrateCursor(workspaceRoot: string, enabled: boolean): Promise<void> {
	if (enabled) {
		// Read the rules.md file from extension
		const rulesContent = await readRules();
		if (!rulesContent) {
			throw new Error('rules.md file not found in extension docs/root');
		}
		await syncCursorRules(workspaceRoot, rulesContent);
	} else {
		await removeCursorRules(workspaceRoot);
	}
}
