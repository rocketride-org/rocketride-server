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
// PACKAGE DRAFT — the pending files of the PACKAGE page (no React, no host)
// =============================================================================

/**
 * A pipeline has one draft, the document its host holds; the PACKAGE page
 * writes straight into it. The FILES the Assets pane writes (the README
 * text, the icon, inserted images) are not the document: the page keeps
 * them in memory until Save writes them beside the pipeline, and Cancel
 * drops them.
 *
 * This module is that file half, pure: the overlay a pane reads its own
 * pending writes back through. The page owns the state.
 */

import type { IAssetsHost } from '../../../../components/assets';
import { besidePath, posixBasename } from '../../../../components/assets/assetsModel';

// =============================================================================
// TYPES
// =============================================================================

/** The pending files: content by path beside the document (posix, normalised). */
export type PendingFiles = Map<string, Uint8Array | string>;

// =============================================================================
// CONSTANTS
// =============================================================================

/** The media type of each image extension a pending file can be shown as. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
};

/** Bytes per `String.fromCharCode` call when encoding base64: under every engine's argument limit. */
const BASE64_CHUNK = 0x8000;

// =============================================================================
// THE FILE OVERLAY
// =============================================================================

/**
 * A pending file as the `data:` URI a thumbnail or the icon tile shows.
 *
 * @param relPath - The file's path beside the document.
 * @param data - The pending content.
 * @returns The URI, or null when the extension is not an image the pane shows.
 */
export function pendingDataUri(relPath: string, data: Uint8Array | string): string | null {
	const dot = relPath.lastIndexOf('.');
	const mediaType = dot < 0 ? undefined : IMAGE_MEDIA_TYPES[relPath.slice(dot + 1).toLowerCase()];
	if (!mediaType) return null;
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
	}
	return `data:${mediaType};base64,${btoa(binary)}`;
}

/**
 * The Assets host a draft reads and writes through: a write is KEPT in
 * `pending` instead of reaching the file, and a read answers the pending
 * content first, so the pane shows its own unsaved work. Picking a file is
 * the host's as it is. Opening a file in the host's editor is refused while
 * that file has pending content: the editor would show the file on disk.
 *
 * @param host - The host's file operations beside the document.
 * @param pending - The draft's pending files; this function mutates it on a write.
 * @param onChange - Called after every write, so the page re-reads the draft's size.
 * @returns The overlay, with `openFile` only when the host has one.
 */
export function overlayAssetsHost(host: IAssetsHost, pending: PendingFiles, onChange: () => void): IAssetsHost {
	const overlay: IAssetsHost = {
		readFile: async (relPath) => {
			const key = besidePath(relPath);
			const held = key === null ? undefined : pending.get(key);
			if (held === undefined) return host.readFile(relPath);
			return typeof held === 'string' ? held : new TextDecoder().decode(held);
		},
		readImageDataUri: async (relPath) => {
			const key = besidePath(relPath);
			const held = key === null ? undefined : pending.get(key);
			if (key === null || held === undefined) return host.readImageDataUri(relPath);
			return pendingDataUri(key, held);
		},
		writeFile: async (relPath, data) => {
			const key = besidePath(relPath);
			if (key === null) throw new Error(`${relPath} is not a path beside the pipeline.`);
			pending.set(key, data);
			onChange();
		},
		pickFile: (accept) => host.pickFile(accept),
	};
	const openFile = host.openFile?.bind(host);
	if (openFile) {
		overlay.openFile = async (relPath) => {
			const key = besidePath(relPath);
			if (key !== null && pending.has(key)) throw new Error(`${posixBasename(key)} has unsaved changes here: Save them first, then open it in the editor.`);
			return openFile(relPath);
		};
	}
	return overlay;
}
