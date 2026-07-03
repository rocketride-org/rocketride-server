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
// STORE VFS — IVirtualFileSystem backed by the RocketRide server store
// =============================================================================
//
// Wraps the SDK's fs* methods so Documents and Explorer can operate on
// files stored on the connected server.  All paths are relative to the
// store root (e.g. "docs/readme.md").
//
// Content modes (see mediaTypes.ts):
//   inline — read as text string via fsReadString
//   blob   — fetch presigned URL, return local blob: URL
//   link   — not handled here; video/audio viewers call fsGetUrl directly
// =============================================================================

import type { RocketRideClient } from 'rocketride';
import type { IVirtualFileSystem } from 'shared/modules/explorer/types';
import { getMediaInfo } from './mediaTypes';

/**
 * Creates an IVirtualFileSystem backed by the RocketRide server store.
 *
 * @param client - The connected RocketRideClient instance.
 * @returns A VFS that proxies all operations to the server.
 */
export function createStoreVfs(client: RocketRideClient): IVirtualFileSystem {
	return {
		async list(dir: string) {
			try {
				const result = await client.fsListDir(dir);
				return (result.entries ?? []).map((e: any) => ({
					name: e.name,
					type: e.type ?? 'file',
				}));
			} catch {
				return [];
			}
		},

		async read(path: string) {
			try {
				const { contentMode, mime } = getMediaInfo(path);
				if (contentMode === 'inline' || contentMode === 'link') {
					// Link files (video/audio) store an empty string — their
					// viewers call fsGetUrl directly for streaming URLs.
					if (contentMode === 'link') return '';
					return await client.fsReadString(path);
				}
				// blob — get a presigned URL, fetch the data, return a blob: URL
				const url = await client.fsGetUrl(path);
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`Failed to fetch ${path}: ${response.status} ${response.statusText}`);
				}
				const data = await response.arrayBuffer();
				const blob = new Blob([data], { type: mime });
				return URL.createObjectURL(blob);
			} catch {
				// Return null (not '') to signal "load failed" vs "empty content".
				// revertDocument() bails on null, so the FilePane revert effect
				// won't re-fire forever on a failing blob load.
				return null;
			}
		},

		async write(path: string, content: unknown) {
			const { contentMode } = getMediaInfo(path);
			if (typeof content === 'string' && contentMode === 'inline') {
				await client.fsWriteString(path, content);
			}
		},

		async rename(oldPath: string, newPath: string) {
			await client.fsRename(oldPath, newPath);
		},

		async delete(path: string) {
			const stat = await client.fsStat(path);
			if (stat.type === 'dir') {
				await client.fsRmdir(path, true);
			} else {
				await client.fsDelete(path);
			}
		},

		async mkdir(path: string) {
			await client.fsMkdir(path);
		},
	};
}
