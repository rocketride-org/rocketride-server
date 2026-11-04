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
// EXPLORER FS — the viewers' narrow store surface
// =============================================================================
//
// The viewer surface reaches the server store through this ONE seam. A single
// implementation wraps the realm's own RocketRideClient — in the full app
// that is the root's client, in a dev-tool frame it is the realm client
// (`useShellConnection().client`), whose requests ride the shell bus. The
// old LOCAL/REMOTE split (controller-served `explorer.*` tool ops) existed
// only because frames once had no client at all. Presigned-URL fetches stay
// plain HTTP, no engine connection involved.
// =============================================================================

import type { RocketRideClient } from 'rocketride';

/** One directory entry of a listing. */
export interface ExplorerDirEntry {
	/** Entry name (no path). */
	name: string;
	/** Entry kind — matches the shell VFS contract. */
	type: 'dir' | 'file';
}

/** File metadata. */
export interface ExplorerStat {
	/** 'file' or 'dir'. */
	type?: string;
	/** Size in bytes (files). */
	size?: number;
}

/** The store surface the explorer viewers use. */
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
 * The store surface over the realm's client. Works identically in every
 * realm: the SDK packs/validates locally, and only the transport differs.
 *
 * @param client - The realm's connected client, or null while disconnected.
 * @returns The fs (rebuild when the client/connection changes).
 */
export function createExplorerFs(client: RocketRideClient | null): IExplorerFs {
	const need = (): RocketRideClient => {
		if (!client) throw new Error('Not connected to a server.');
		return client;
	};
	return {
		ready: client !== null,
		list: async (dir) => {
			const result = await need().fsListDir(dir);
			return (result.entries ?? []).map((e) => ({ name: e.name, type: e.type === 'dir' ? 'dir' as const : 'file' as const }));
		},
		readString: (path) => need().fsReadString(path),
		getUrl: (path) => need().fsGetUrl(path),
		writeString: (path, content) => need().fsWriteString(path, content),
		rename: (oldPath, newPath) => need().fsRename(oldPath, newPath),
		stat: async (path) => {
			const stat = await need().fsStat(path);
			return { ...(stat.type !== undefined ? { type: stat.type } : {}), ...(stat.size !== undefined ? { size: stat.size } : {}) };
		},
		remove: async (path) => {
			const c = need();
			const stat = await c.fsStat(path);
			if (stat.type === 'dir') await c.fsRmdir(path, true);
			else await c.fsDelete(path);
		},
		mkdir: (path) => need().fsMkdir(path),
	};
}
