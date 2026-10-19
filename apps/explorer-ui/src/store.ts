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

import type { IVirtualFileSystem } from 'shell';
import { getMediaInfo } from './mediaTypes';
import type { IExplorerFs } from './fs';

// =============================================================================
// LOAD ERROR SENTINEL
// =============================================================================
//
// When a blob-mode read fails (e.g. RR_SIGNING_KEY unset -> fsGetUrl throws,
// or the presigned fetch returns non-2xx) we cannot produce a blob: URL.
// Rather than returning null — which is indistinguishable from "still loading"
// once it reaches the viewer — read() returns this typed sentinel carrying the
// failure message.  FilePane detects it (via isFileLoadError) and hands the
// message to the viewer, which renders an error instead of hanging on
// "Loading...".  The sentinel is truthy, so it also stops the FilePane revert
// effect from re-firing (that effect only reverts while content is empty).
// =============================================================================

// =============================================================================
// MINTED BLOB URLS
// =============================================================================

/**
 * Every blob: URL this SESSION created. Document content can outlive the
 * session that minted it (the Documents store keeps content across reloads),
 * but a blob: URL dies with its page — and a pre-media-table document may
 * even carry raw text where a blob URL belongs. FilePane treats any blob-mode
 * content NOT in this set as stale and re-reads it from the server.
 */
const mintedBlobUrls = new Set<string>();

/**
 * Type guard: true when the given content is a blob: URL minted by THIS
 * session (i.e. still alive and safe to hand to a viewer).
 *
 * @param value - The document content to test.
 * @returns True for a live, this-session blob URL.
 */
export function isLiveBlobUrl(value: unknown): value is string {
	return typeof value === 'string' && mintedBlobUrls.has(value);
}

/**
 * Drops a URL from the minted set — called when the last viewer releases it
 * and the object URL is revoked, so a document still holding the string gets
 * a fresh read instead of a dead reference.
 *
 * @param url - The revoked blob: URL.
 */
export function forgetBlobUrl(url: string): void {
	mintedBlobUrls.delete(url);
}

/** Sentinel value stored as a document's content when a blob load failed. */
export interface FileLoadError {
	/** Discriminant tag identifying this as a load-error sentinel. */
	readonly kind: 'file-load-error';
	/** Human-readable failure message surfaced to the viewer. */
	readonly message: string;
}

/**
 * Builds a FileLoadError sentinel from an unknown thrown value.
 *
 * @param err - The value caught while reading (Error or otherwise).
 * @returns A FileLoadError carrying the extracted message.
 */
function makeFileLoadError(err: unknown): FileLoadError {
	return { kind: 'file-load-error', message: err instanceof Error ? err.message : String(err) };
}

/**
 * Type guard: true when a document's content is a FileLoadError sentinel.
 *
 * @param value - The document content to test.
 * @returns True if the value is a load-error sentinel.
 */
export function isFileLoadError(value: unknown): value is FileLoadError {
	// Narrow structurally without a cast: object -> has 'kind' -> tag matches.
	return (
		typeof value === 'object' &&
		value !== null &&
		'kind' in value &&
		value.kind === 'file-load-error'
	);
}

/**
 * Creates an IVirtualFileSystem backed by the RocketRide server store.
 *
 * @param fs - The explorer's store surface (local in the full app,
 *             controller-routed in dev-tool frames — see fs.ts).
 * @returns A VFS that proxies all operations to the server.
 */
export function createStoreVfs(fs: IExplorerFs): IVirtualFileSystem {
	return {
		async list(dir: string) {
			try {
				return await fs.list(dir);
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
					return await fs.readString(path);
				}
				// blob — get a presigned URL, fetch the data, return a blob: URL
				const url = await fs.getUrl(path);
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`Failed to fetch ${path}: ${response.status} ${response.statusText}`);
				}
				const data = await response.arrayBuffer();
				const blob = new Blob([data], { type: mime });
				const blobUrl = URL.createObjectURL(blob);
				mintedBlobUrls.add(blobUrl);
				return blobUrl;
			} catch (err) {
				// Blob loads surface a typed error sentinel (not null/'') so the
				// failure is distinguishable from "still loading" and carries a
				// message the viewer can render.  The sentinel is truthy, so the
				// FilePane revert effect (which only reverts while content is
				// empty) stops re-firing once it lands.  Inline/link failures keep
				// returning null — their viewers are unchanged by this fix.
				const { contentMode } = getMediaInfo(path);
				return contentMode === 'blob' ? makeFileLoadError(err) : null;
			}
		},

		async write(path: string, content: unknown) {
			const { contentMode } = getMediaInfo(path);
			if (typeof content === 'string' && contentMode === 'inline') {
				await fs.writeString(path, content);
			}
		},

		async rename(oldPath: string, newPath: string) {
			await fs.rename(oldPath, newPath);
		},

		async delete(path: string) {
			// File-vs-directory branching lives behind the seam (and on the
			// controller for remote frames).
			await fs.remove(path);
		},

		async mkdir(path: string) {
			await fs.mkdir(path);
		},
	};
}
