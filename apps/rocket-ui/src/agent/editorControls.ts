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
// EDITOR CONTROLS — the open editors, as the workspace view sees them
// =============================================================================

/**
 * Each open document registers here: a text file's tabs (fileDocument.ts)
 * and a pipeline's canvases (canvasDocument.ts). One path can have both, a
 * text tab and a canvas on one .pipe, so every path with editors has one
 * overlay on the view for all of them: dirty while any is, and readers get
 * the first dirty editor's buffer. Each editor loads the stored file past
 * every buffer, so it never takes another editor's typing for clean content.
 */

import type { IWorkspaceFileSystem, VfsOverlay } from 'shared/modules/vfs/vfsTypes';

/** One open document of a path: its buffer for readers, and its save. */
export interface EditorRegistration extends VfsOverlay {
	/** The document it holds: `file:<path>` for a text file, the pipeline's URI for a canvas. */
	uri: string;
	/** Rejects when the save fails, and with SaveDroppedError when the user dropped the buffer while the save waited its turn. */
	save(): Promise<void>;
}

interface PathEditors {
	editors: EditorRegistration[];
	unregister: () => void;
}

/** The mounted editors, by workspace view, then by path. */
const views = new WeakMap<IWorkspaceFileSystem, Map<string, PathEditors>>();

/** Registers one editor of a path; the path's overlay goes on the view with its first editor and off with its last. */
export function registerEditor(view: IWorkspaceFileSystem, path: string, editor: EditorRegistration): () => void {
	let paths = views.get(view);
	if (!paths) {
		paths = new Map();
		views.set(view, paths);
	}
	let entry = paths.get(path);
	if (!entry) {
		const editors: EditorRegistration[] = [];
		const overlay: VfsOverlay = {
			getContent: () => (editors.find((e) => e.isDirty()) ?? editors[0])?.getContent(),
			isDirty: () => editors.some((e) => e.isDirty()),
		};
		entry = { editors, unregister: view.registerOverlay(path, overlay) };
		paths.set(path, entry);
	}
	const mine = entry;
	mine.editors.push(editor);
	return () => {
		const at = mine.editors.indexOf(editor);
		if (at >= 0) mine.editors.splice(at, 1);
		if (mine.editors.length > 0 || paths.get(path) !== mine) return;
		mine.unregister();
		paths.delete(path);
	};
}

/**
 * Saves the editor of one document and no other editor of its path: a text
 * tab and a canvas on one .pipe each save their own buffer. The editor shows
 * a failure itself. Null when no editor holds the document.
 */
export function saveDocumentEditor(view: IWorkspaceFileSystem, uri: string): Promise<void> | null {
	for (const entry of views.get(view)?.values() ?? []) {
		const editor = entry.editors.find((e) => e.uri === uri);
		if (editor) return editor.isDirty() ? editor.save() : Promise.resolve();
	}
	return null;
}
