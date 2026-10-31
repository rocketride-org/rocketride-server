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
import type { WorkspaceFs } from 'shell/src/workspace/workspaceFs';

/** The extension host's workspace-FS capability (direct access, no RPC). */
export const hostWorkspaceFs: WorkspaceFs = {
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
	async list(dir) {
		const base = dir || (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath || '';
		if (!base) return [];
		const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(base));
		return entries.map(([name, kind]) => ({ name, type: kind === vscode.FileType.Directory ? 'dir' as const : 'file' as const }));
	},
	async stat(path) {
		try {
			const s = await vscode.workspace.fs.stat(vscode.Uri.file(path));
			return s.type === vscode.FileType.Directory ? 'dir' : 'file';
		} catch {
			return null;
		}
	},
	async read(path) {
		return this.readTextFile(path);
	},
	async readMany(paths) {
		const out: Record<string, unknown> = {};
		await Promise.all(paths.map(async (p) => {
			try {
				out[p] = await this.readTextFile(p);
			} catch { /* unreadable — omitted by contract */ }
		}));
		return out;
	},
	async write(path, content) {
		await this.writeTextFile(path, typeof content === 'string' ? content : JSON.stringify(content));
	},
	async writeTextFile(path, text) {
		await vscode.workspace.fs.writeFile(vscode.Uri.file(path), Buffer.from(text, 'utf8'));
	},
	async writeFileBase64(path, dataB64) {
		await vscode.workspace.fs.writeFile(vscode.Uri.file(path), Buffer.from(dataB64, 'base64'));
	},
	async rename(from, to) {
		await vscode.workspace.fs.rename(vscode.Uri.file(from), vscode.Uri.file(to));
	},
	async delete(path, recursive) {
		await vscode.workspace.fs.delete(vscode.Uri.file(path), { recursive: recursive === true, useTrash: false });
	},
	async mkdir(path) {
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path));
	},
	async refresh() { /* direct-disk host: nothing cached to re-walk */ },
	// ── Staging: the AUTO-COMMIT workspace — trivially nothing pending ──
	async pending() {
		return { hasPending: false, changedPaths: {}, dirtyPaths: [] };
	},
	async diff() {
		return { before: null, after: null };
	},
	async commit() {
		return { committed: 0, conflicts: [] };
	},
	async checkpoint() {
		return null;
	},
	async rollback() { /* nothing staged, ever */ },
	async undoTurn() {
		return { committed: 0, conflicts: [] };
	},
	async discard() { /* nothing staged, ever */ },
	async layers() {
		return [];
	},
	async setWriteThrough() { /* always write-through */ },
	async whenReady() { /* no staging to rehydrate */ },
};
