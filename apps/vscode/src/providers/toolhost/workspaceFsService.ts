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
// TOOLHOST — generic workspace-FS capability service
// =============================================================================
//
// The host side of the `services.fs`/`watch` capability from the
// sidebar-as-controller architecture: tool controllers running in the
// sidebar webview find, read, and watch workspace files through this RPC —
// the host executes globs and reads, and knows NOTHING about what the
// controller is looking for (`.rrapp` bindings, `.pipe` files, …). That
// knowledge lives with each tool in apps/shared/src/tools/<tool>.
//
// Wire protocol (webview → host):
//   { type:'svc:fs',         id, method:'findFiles',  include, exclude? }
//   { type:'svc:fs',         id, method:'workspaceRoots' }
//   { type:'svc:fs',         id, method:'readText',   path }
//   { type:'svc:fs',         id, method:'readBase64', path, maxBytes }
//   { type:'svc:fs.watch',   id, globs }
//   { type:'svc:fs.unwatch', id }
// host → webview:
//   { type:'svc:fs:result', id, ok:true, result } | { ..., ok:false, error }
//   { type:'svc:fs:event',  id, path }
//
// Reads are confined to the open workspace folders — the webview can never
// use this to read outside them. Watch subscriptions belong to one webview
// PAGE: resetSubscriptions() runs on every view:ready, so a reloaded page
// (whose subscription ids restart) never leaks its predecessor's watchers.
// =============================================================================

import * as vscode from 'vscode';

/** A request message this service consumes. */
type FsServiceRequest =
	| { type: 'svc:fs'; id: number; method: 'findFiles'; include: string; exclude?: string }
	| { type: 'svc:fs'; id: number; method: 'workspaceRoots' }
	| { type: 'svc:fs'; id: number; method: 'readText'; path: string }
	| { type: 'svc:fs'; id: number; method: 'readBase64'; path: string; maxBytes: number }
	| { type: 'svc:fs.watch'; id: number; globs: string[] }
	| { type: 'svc:fs.unwatch'; id: number };

/** Posts one message into the owning webview. */
type Post = (message: unknown) => void;

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
 * live watch subscriptions; the owning provider routes matching messages in
 * and disposes the service with itself.
 */
export class WorkspaceFsService {
	/** Live watch disposables per subscription id (one watcher per glob,
	 *  plus the workspace-folders listener). */
	private watchers = new Map<number, vscode.Disposable[]>();

	/**
	 * Routes one webview message. Returns true when this service consumed it.
	 *
	 * @param message - The raw webview message.
	 * @param post - Posts responses/events back into the webview.
	 * @returns True when handled.
	 */
	public handle(message: unknown, post: Post): boolean {
		const msg = message as FsServiceRequest | null;
		if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return false;
		switch (msg.type) {
			case 'svc:fs':
				void this.respond(msg, post);
				return true;
			case 'svc:fs.watch':
				this.startWatch(msg.id, msg.globs, post);
				return true;
			case 'svc:fs.unwatch':
				this.stopWatch(msg.id);
				return true;
			default:
				return false;
		}
	}

	/** Executes one request and posts its result (errors in-band). */
	private async respond(msg: Extract<FsServiceRequest, { type: 'svc:fs' }>, post: Post): Promise<void> {
		try {
			let result: unknown;
			switch (msg.method) {
				case 'findFiles': {
					const uris = await vscode.workspace.findFiles(msg.include, msg.exclude ?? null);
					result = uris.map((uri) => uri.fsPath);
					break;
				}
				case 'workspaceRoots':
					result = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
					break;
				case 'readText': {
					this.assertInside(msg.path);
					const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(msg.path));
					result = Buffer.from(bytes).toString('utf8');
					break;
				}
				case 'readBase64': {
					this.assertInside(msg.path);
					const uri = vscode.Uri.file(msg.path);
					// Stat before reading: the size gate is what keeps the
					// response (and the caller's data: URI) bounded.
					const stat = await vscode.workspace.fs.stat(uri);
					if (stat.size > msg.maxBytes) {
						result = null;
						break;
					}
					const bytes = await vscode.workspace.fs.readFile(uri);
					result = Buffer.from(bytes).toString('base64');
					break;
				}
			}
			post({ type: 'svc:fs:result', id: msg.id, ok: true, result });
		} catch (error) {
			post({ type: 'svc:fs:result', id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** Guards a read path to the open workspace folders. */
	private assertInside(fsPath: string): void {
		if (!insideWorkspace(fsPath)) throw new Error(`Path is outside the workspace: ${fsPath}`);
	}

	/** Starts one watch subscription (a watcher per glob). */
	private startWatch(id: number, globs: string[], post: Post): void {
		this.stopWatch(id);
		const emit = (uri: vscode.Uri): void => post({ type: 'svc:fs:event', id, path: uri.fsPath });
		const disposables: vscode.Disposable[] = globs.map((glob) => {
			const watcher = vscode.workspace.createFileSystemWatcher(glob);
			watcher.onDidCreate(emit);
			watcher.onDidChange(emit);
			watcher.onDidDelete(emit);
			return watcher;
		});
		// Adding/removing a workspace folder fires no file event, but
		// invalidates any glob's result set — tick the subscription with a
		// synthetic event so the subscriber re-evaluates.
		disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
			post({ type: 'svc:fs:event', id, path: '' });
		}));
		this.watchers.set(id, disposables);
	}

	/** Stops one watch subscription. */
	private stopWatch(id: number): void {
		const watchers = this.watchers.get(id);
		if (!watchers) return;
		this.watchers.delete(id);
		for (const watcher of watchers) watcher.dispose();
	}

	/**
	 * Drops every live subscription — called on the webview's view:ready: a
	 * fresh page restarts its ids from zero and must not inherit (or leak)
	 * its predecessor's watchers.
	 */
	public resetSubscriptions(): void {
		for (const id of [...this.watchers.keys()]) this.stopWatch(id);
	}

	/** Disposes all watchers (provider teardown). */
	public dispose(): void {
		this.resetSubscriptions();
	}
}
