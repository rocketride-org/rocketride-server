// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EXPLORER FS — where the frame's store access actually goes
// =============================================================================
//
// The viewer surface reaches the server store through this ONE seam instead
// of holding a RocketRide client. Two implementations:
//
//   LOCAL  (createLocalExplorerFs)  — wraps the shell client directly; used
//          by the full app, whose realm legitimately owns a connection.
//   REMOTE (createRemoteExplorerFs) — routes every call over controller(...)
//          ops to the tool's sidebar controller (the file tree's realm,
//          which keeps its own client). Used by dev-tool document frames:
//          frames hold NO client. Presigned-URL fetches stay in the frame —
//          they are plain HTTP, no engine connection involved.
// =============================================================================

import { ConnectionManager } from 'shell';
import type { ToolControllerFn } from 'shell';
import type { ExplorerDirEntry, ExplorerOps, ExplorerStat } from './ops';

/** The store surface the explorer frame uses — never a client. */
export interface IExplorerFs {
	/** Whether the store is reachable (gates mounting and hex fallback). */
	ready: boolean;
	/** Directory listing (name + type per entry). */
	list(dir: string): Promise<ExplorerDirEntry[]>;
	/** Read a text file. */
	readString(path: string): Promise<string>;
	/** Presigned URL for streaming/fetching the file's bytes. */
	getUrl(path: string): Promise<string>;
	/** Write a text file. */
	writeString(path: string, content: string): Promise<void>;
	/** Rename/move. */
	rename(oldPath: string, newPath: string): Promise<void>;
	/** File metadata (type, size). */
	stat(path: string): Promise<ExplorerStat>;
	/** Delete a file, or a directory recursively. */
	remove(path: string): Promise<void>;
	/** Create a directory. */
	mkdir(path: string): Promise<void>;
}

/** The slice streaming viewers (hex/video/audio) need. */
export type ExplorerViewerFs = Pick<IExplorerFs, 'getUrl' | 'stat'>;

/**
 * The bus-backed store surface — the controller realm's implementation.
 * Every call is a brokered `client.*` op: in-process at the framework root
 * (cloud full app), bridged to the extension host in the VS Code sidebar
 * realm. No client object, no socket, no token in this realm.
 *
 * @param isConnected - The realm's connection flag (mirror-primed off-root).
 * @returns The fs (rebuild when the flag changes).
 */
export function createLocalExplorerFs(isConnected: boolean): IExplorerFs {
	const cm = ConnectionManager.getInstance();
	const need = (): void => {
		if (!isConnected) throw new Error('Not connected to a server.');
	};
	return {
		ready: isConnected,
		list: async (dir) => {
			need();
			const result = await cm.request('client.fsListDir', { path: dir }) as { entries?: Array<{ name: string; type: string }> };
			return (result.entries ?? []).map((e) => ({ name: e.name, type: e.type === 'dir' ? 'dir' as const : 'file' as const }));
		},
		readString: (path) => { need(); return cm.request('client.fsReadString', { path }) as Promise<string>; },
		getUrl: (path) => { need(); return cm.request('client.fsGetUrl', { path }) as Promise<string>; },
		writeString: async (path, content) => { need(); await cm.request('client.fsWriteString', { path, text: content }); },
		rename: async (oldPath, newPath) => { need(); await cm.request('client.fsRename', { from: oldPath, to: newPath }); },
		stat: async (path) => {
			need();
			const stat = await cm.request('client.fsStat', { path }) as { type?: 'file' | 'dir'; size?: number };
			return { ...(stat.type !== undefined ? { type: stat.type } : {}), ...(stat.size !== undefined ? { size: stat.size } : {}) };
		},
		remove: async (path) => {
			need();
			const stat = await cm.request('client.fsStat', { path }) as { type?: string };
			if (stat.type === 'dir') await cm.request('client.fsRmdir', { path, recursive: true });
			else await cm.request('client.fsDelete', { path });
		},
		mkdir: async (path) => { need(); await cm.request('client.fsMkdir', { path }); },
	};
}

/**
 * The controller-backed store surface (dev-tool document frames): every
 * call crosses the tool channel and executes on the controller's single
 * engine connection.
 *
 * @param call - The frame's controller function (createToolController(peer)).
 * @param ready - The controller realm's server reachability (`host:connection`).
 * @returns The fs (rebuild when `ready` changes).
 */
export function createRemoteExplorerFs(call: ToolControllerFn<ExplorerOps>, ready: boolean): IExplorerFs {
	return {
		ready,
		list: (dir) => call('explorer.listDir', { dir }),
		readString: (path) => call('explorer.readString', { path }),
		getUrl: (path) => call('explorer.getUrl', { path }),
		writeString: (path, content) => call('explorer.writeString', { path, content }),
		rename: (oldPath, newPath) => call('explorer.rename', { oldPath, newPath }),
		stat: (path) => call('explorer.stat', { path }),
		remove: (path) => call('explorer.remove', { path }),
		mkdir: (path) => call('explorer.mkdir', { path }),
	};
}
