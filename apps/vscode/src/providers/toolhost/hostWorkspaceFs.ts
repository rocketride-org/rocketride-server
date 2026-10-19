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
// TOOLHOST — the extension host's own ToolWorkspaceFs
// =============================================================================
//
// The GENERIC workspace-FS capability, implemented over direct
// vscode.workspace access for code running in the extension host itself
// (webview tool controllers get the same capability over the
// WorkspaceFsService RPC instead). Globs, bytes, and watches — this file
// knows nothing about what any tool does with them.
// =============================================================================

import * as vscode from 'vscode';
// Deep import on purpose: the tools/core BARREL exports the builtin
// registry, which carries React/shell types the extension host's no-DOM
// compile must never see. workspaceFs is the pure capability contract.
// Deep leaf import: the extension host must not pull the shell's React
// barrel; the capability interface lives in a dependency-free module.
import type { ToolWorkspaceFs } from 'shell/src/components/workspace/toolWorkspaceFs';

/** The extension host's workspace-FS capability (direct access, no RPC). */
export const hostWorkspaceFs: ToolWorkspaceFs = {
	async findFiles(include, exclude) {
		const uris = await vscode.workspace.findFiles(include, exclude ?? null);
		return uris.map((uri) => uri.fsPath);
	},
	async workspaceRoots() {
		return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
	},
	async readTextFile(path) {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
		return Buffer.from(bytes).toString('utf8');
	},
	async readFileBase64(path, maxBytes) {
		const uri = vscode.Uri.file(path);
		// Stat before reading — the size gate keeps data: URIs bounded.
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.size > maxBytes) return null;
		const bytes = await vscode.workspace.fs.readFile(uri);
		return Buffer.from(bytes).toString('base64');
	},
	watch(globs, onEvent) {
		const emit = (uri: vscode.Uri): void => onEvent(uri.fsPath);
		const watchers = globs.map((glob) => {
			const watcher = vscode.workspace.createFileSystemWatcher(glob);
			watcher.onDidCreate(emit);
			watcher.onDidChange(emit);
			watcher.onDidDelete(emit);
			return watcher;
		});
		return () => { for (const watcher of watchers) watcher.dispose(); };
	},
};
