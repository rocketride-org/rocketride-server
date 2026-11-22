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
// PACKAGE DRAFT — the pending changes of the PACKAGE page (no React, no host)
// =============================================================================

/**
 * The PACKAGE page holds what its panes change as a DRAFT until Save: a patch
 * over the document's root keys, and the files the Assets pane wrote (the
 * README text, the icon, inserted images), kept in memory. Save writes the
 * files, applies the patch to the document and saves it; Cancel drops both.
 *
 * This module is the pure half: the patch arithmetic and the file overlay a
 * pane reads its own pending writes back through. The page owns the state.
 */

import type { IAssetsHost } from '../../../../components/assets';
import { besidePath, posixBasename } from '../../../../components/assets/assetsModel';

// =============================================================================
// TYPES
// =============================================================================

/** The document's root keys the PACKAGE panes write; no pane writes any other. */
export const PACKAGE_KEYS = ['project_id', 'name', 'description', 'source', 'parameters', 'store'] as const;

/** One root key the PACKAGE panes write. */
export type PackageKey = (typeof PACKAGE_KEYS)[number];

/** The draft's document half: the root keys that differ from the document, each with its pending value (undefined = the key is removed). */
export type PackagePatch = Partial<Record<PackageKey, unknown>>;

/** The draft's file half: pending content by path beside the document (posix, normalised). */
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
// THE PATCH
// =============================================================================

/**
 * Whether two values of a root key hold the same content. Key order counts:
 * the parameters map and the links map are ordered lists to the reader.
 *
 * @param a - One value.
 * @param b - The other.
 * @returns True when both serialise to the same JSON (undefined equals undefined only).
 */
function sameValue(a: unknown, b: unknown): boolean {
	if (a === undefined || b === undefined) return a === b;
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The patch that turns the document into `next`, over the PACKAGE keys only.
 *
 * @param document - The pipeline document as the host holds it.
 * @param next - The document a pane asked for (the document with the pane's change).
 * @returns The keys whose value differs, each with the value `next` holds.
 */
export function patchOf(document: object, next: object): PackagePatch {
	const from = document as Record<string, unknown>;
	const to = next as Record<string, unknown>;
	const patch: PackagePatch = {};
	for (const key of PACKAGE_KEYS) {
		if (!sameValue(from[key], to[key])) patch[key] = to[key];
	}
	return patch;
}

/**
 * The patch without the keys the document already agrees with: after a Save
 * the host's document catches up and the draft empties by itself.
 *
 * @param document - The pipeline document as the host holds it.
 * @param patch - The pending patch.
 * @returns The SAME patch object when nothing was dropped, else a smaller one.
 */
export function prunePatch(document: object, patch: PackagePatch): PackagePatch {
	const held = document as Record<string, unknown>;
	const kept: PackagePatch = {};
	let dropped = false;
	for (const key of PACKAGE_KEYS) {
		if (!(key in patch)) continue;
		if (sameValue(held[key], patch[key])) dropped = true;
		else kept[key] = patch[key];
	}
	return dropped ? kept : patch;
}

/**
 * The document with the patch applied: a pending value replaces the key, a
 * pending removal deletes it. Every other key is the document's.
 *
 * @param document - The pipeline document as the host holds it.
 * @param patch - The pending patch.
 * @returns A new document object; the SAME object when the patch is empty.
 */
export function applyPatch<T extends object>(document: T, patch: PackagePatch): T {
	if (isEmptyPatch(patch)) return document;
	const next: Record<string, unknown> = { ...(document as Record<string, unknown>) };
	for (const key of PACKAGE_KEYS) {
		if (!(key in patch)) continue;
		if (patch[key] === undefined) delete next[key];
		else next[key] = patch[key];
	}
	return next as T;
}

/**
 * Whether a patch holds no pending change.
 *
 * @param patch - The patch.
 * @returns True when no key is pending.
 */
export function isEmptyPatch(patch: PackagePatch): boolean {
	return PACKAGE_KEYS.every((key) => !(key in patch));
}

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
