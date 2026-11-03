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
// TOOLHOST — generic workspace-FS capability service (the host.fs.* backend)
// =============================================================================
//
// The host half of the `WorkspaceFs` capability: tool controllers in the
// sidebar realm find, read, and watch workspace files through the
// `host.fs.*` ops (shared/ops/fsOps) — the host executes globs and reads and
// knows NOTHING about what the controller is looking for (`.rrapp` bindings,
// `.pipe` files, …). That knowledge lives with each tool in
// apps/shared/src/tools/<tool>.
//
// Reads are confined to the open workspace folders — a realm can never use
// this to read outside them. Watch subscriptions belong to one webview PAGE
// (keyed by the realm-generated `sub` string): resetSubscriptions() runs on
// every page boot, so a reloaded page never inherits (or leaks) its
// predecessor's watchers. Watch events emit through the callback the owning
// provider supplies (the realm-registered `sidebar.fs.event` op).
// =============================================================================

import * as vscode from 'vscode';

/** Whether an absolute path lies inside one of the open workspace folders. */
function insideWorkspace(fsPath: string): boolean {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const normalized = fsPath.replace(/\\/g, '/').toLowerCase();
	return folders.some((folder) => {
		const root = folder.uri.fsPath.replace(/\\/g, '/').toLowerCase();
		return normalized === root || normalized.startsWith(`${root}/`);
	});
}

/**
 * The generic workspace-FS service for one webview (the sidebar). Owns the
 * live watch subscriptions; the owning provider serves the `host.fs.*` ops
 * through it and disposes the service with itself.
 */
export class WorkspaceFsService {
	/** Live watch disposables per subscription key (one watcher per glob,
	 *  plus the workspace-folders listener). */
	private watchers = new Map<string, vscode.Disposable[]>();

	/** Glob search over the open workspace folders → absolute fsPaths. */
	public async findFiles(include: string, exclude?: string): Promise<string[]> {
		const uris = await vscode.workspace.findFiles(include, exclude ?? null);
		return uris.map((uri) => uri.fsPath);
	}

	/** The open workspace folders' absolute fsPaths. */
	public workspaceRoots(): string[] {
		return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
	}

	/** One workspace file as UTF-8 (containment-guarded). */
	public async readText(fsPath: string): Promise<string> {
		this.assertInside(fsPath);
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));
		return Buffer.from(bytes).toString('utf8');
	}

	/** One workspace file as base64, null when over `maxBytes`. */
	public async readBase64(fsPath: string, maxBytes: number): Promise<string | null> {
		this.assertInside(fsPath);
		const uri = vscode.Uri.file(fsPath);
		// Stat before reading: the size gate is what keeps the response (and
		// the caller's data: URI) bounded.
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.size > maxBytes) return null;
		const bytes = await vscode.workspace.fs.readFile(uri);
		return Buffer.from(bytes).toString('base64');
	}

	/** One directory's immediate entries ('' = the first root). */
	public async list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
		const base = dir || this.workspaceRoots()[0] || '';
		if (!base) return [];
		this.assertInside(base);
		const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(base));
		return entries.map(([name, kind]) => ({ name, type: kind === vscode.FileType.Directory ? 'dir' as const : 'file' as const }));
	}

	/** A path's kind, or null when absent. */
	public async stat(fsPath: string): Promise<'file' | 'dir' | null> {
		this.assertInside(fsPath);
		try {
			const s = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
			return s.type === vscode.FileType.Directory ? 'dir' : 'file';
		} catch {
			return null;
		}
	}

	/** Many files in one call; unreadable paths are omitted. */
	public async readMany(paths: string[]): Promise<Record<string, unknown>> {
		const out: Record<string, unknown> = {};
		await Promise.all(paths.map(async (p) => {
			try {
				out[p] = await this.readText(p);
			} catch { /* unreadable — omitted by contract */ }
		}));
		return out;
	}

	/** Writes UTF-8 text (containment-guarded). */
	public async writeText(fsPath: string, text: string): Promise<void> {
		this.assertInside(fsPath);
		await vscode.workspace.fs.writeFile(vscode.Uri.file(fsPath), Buffer.from(text, 'utf8'));
	}

	/** Writes binary carried as base64. */
	public async writeBase64(fsPath: string, dataB64: string): Promise<void> {
		this.assertInside(fsPath);
		await vscode.workspace.fs.writeFile(vscode.Uri.file(fsPath), Buffer.from(dataB64, 'base64'));
	}

	/** Renames a file or directory (both ends containment-guarded). */
	public async rename(from: string, to: string): Promise<void> {
		this.assertInside(from);
		this.assertInside(to);
		await vscode.workspace.fs.rename(vscode.Uri.file(from), vscode.Uri.file(to));
	}

	/** Deletes a file or directory. */
	public async delete(fsPath: string, recursive?: boolean): Promise<void> {
		this.assertInside(fsPath);
		await vscode.workspace.fs.delete(vscode.Uri.file(fsPath), { recursive: recursive === true, useTrash: false });
	}

	/** Creates a directory (parents included — vscode semantics). */
	public async mkdir(fsPath: string): Promise<void> {
		this.assertInside(fsPath);
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(fsPath));
	}

	/** Guards a read path to the open workspace folders. */
	private assertInside(fsPath: string): void {
		if (!insideWorkspace(fsPath)) throw new Error(`Path is outside the workspace: ${fsPath}`);
	}

	/** Starts one watch subscription (idempotent-by-replace per key). */
	public watch(sub: string, globs: string[], emit: (path: string) => void): void {
		this.unwatch(sub);
		const onUri = (uri: vscode.Uri): void => emit(uri.fsPath);
		const disposables: vscode.Disposable[] = globs.map((glob) => {
			const watcher = vscode.workspace.createFileSystemWatcher(glob);
			watcher.onDidCreate(onUri);
			watcher.onDidChange(onUri);
			watcher.onDidDelete(onUri);
			return watcher;
		});
		// Adding/removing a workspace folder fires no file event, but
		// invalidates any glob's result set — tick the subscription with the
		// synthetic '' event so the subscriber re-evaluates.
		disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => emit('')));
		this.watchers.set(sub, disposables);
	}

	/** Stops one watch subscription. */
	public unwatch(sub: string): void {
		const watchers = this.watchers.get(sub);
		if (!watchers) return;
		this.watchers.delete(sub);
		for (const watcher of watchers) watcher.dispose();
	}

	/**
	 * Drops every live subscription — called on the webview's page boot
	 * (view:ready): a fresh page mints fresh keys and must not inherit (or
	 * leak) its predecessor's watchers. view:ready stays the page-lifecycle
	 * signal because HTML rewrites (the CSP reboot, the Dev Tools RESET)
	 * reboot the page WITHOUT re-resolving the webview.
	 */
	public resetSubscriptions(): void {
		for (const sub of [...this.watchers.keys()]) this.unwatch(sub);
	}

	/** Disposes all watchers (provider teardown). */
	public dispose(): void {
		this.resetSubscriptions();
	}
}
