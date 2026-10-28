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
// FILE EDITOR — workspace text-file tab (`file:<path>` static docs)
// =============================================================================
//
// The workspace Explorer's editor for text files that have no dedicated
// designer (.ts sources, configs, markdown): the SHARED Monaco editor over
// the staged view. Edits save with Ctrl+S (or the Save button) through
// view.write() — a save is a STAGED workspace change like any other write,
// so it appears in Source Control, decorates the Explorer, and commits/
// discards through the normal flow. A path the workspace refuses to change
// (the read-only .rocketride/ guides) opens read-only, with no Save.
//
// TS/TSX files get the REAL language service, not bare Monaco defaults:
// models live at file:///workspace/<path> (so the worker knows the script
// kind and can resolve modules), and the page-wide editor TS service
// (editorTypes) supplies the scaffold compiler options, React + platform
// types, ATA for third-party imports, and the app folder's sibling sources
// for relative imports — the same surface the App Builder Code pane runs.
//
// External changes (an agent write, a discard, a commit) refresh the buffer
// only while it is CLEAN — never clobbering unsaved typing. A save names the
// version the buffer was loaded at, so a file that moved on offers Reload and
// Overwrite. The buffer belongs to the file, not the tab (fileDocument.ts).
// =============================================================================

import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles, Button } from 'shell';
import { MonacoEditor, detectLanguage } from 'shared/components/monaco';
import type { Monaco } from 'shared/components/monaco';
import { WORKSPACE_URI_PREFIX, ensureWorkspaceEditorTs, getWorkspaceEditorTs, primeProjectSources, releaseProjectSource } from '../preview/session/editorTypes';
import { fileDocument } from './fileDocument';
import { getWorkspaceVfs, isWritable } from './vfs/workspace';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		overflow: 'hidden',
		background: 'var(--rr-bg-default)',
	} as CSSProperties,
	banner: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '4px 14px',
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		borderBottom: '1px solid var(--rr-border)',
		flexShrink: 0,
	} as CSSProperties,
	bannerPath: {
		...commonStyles.textEllipsis,
		flex: 1,
		minWidth: 0,
	} as CSSProperties,
	dirtyMark: {
		color: 'var(--rr-accent, #f7901f)',
		fontWeight: 700,
		flexShrink: 0,
	} as CSSProperties,
	staleNotice: {
		color: 'var(--rr-color-warning, #e2c08d)',
		flexShrink: 0,
	} as CSSProperties,
	editor: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		overflow: 'hidden',
	} as CSSProperties,
	empty: {
		...commonStyles.textMuted,
		padding: 24,
		textAlign: 'center' as const,
	} as CSSProperties,
};

/** Monaco options for a path the workspace refuses to change. */
const READ_ONLY_OPTIONS = { readOnly: true };

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for the FileProvider document. */
interface FileProviderProps {
	/** View-relative workspace path (from the `file:` static-doc uri). */
	path: string;
}

/**
 * Monaco editor tab for a workspace text file, saving through the staged
 * view. See the file header for the dirty/external-change contract.
 *
 * @param props - See {@link FileProviderProps}.
 */
const FileProvider: React.FC<FileProviderProps> = ({ path }) => {
	// The file's shared document; a change to it renders every tab of the path.
	const [doc, setDoc] = useState(() => fileDocument(getWorkspaceVfs(), path));
	const [, render] = useReducer((n: number) => n + 1, 0);

	// A path the workspace refuses to change opens read-only, with no Save.
	const readOnly = !isWritable(path);

	// The tab joins the document while mounted, and loads it (a document with unsaved text keeps it).
	useEffect(() => {
		const current = fileDocument(getWorkspaceVfs(), path);
		setDoc(current);
		const close = current.open();
		const unsubscribe = current.subscribe(render);
		void current.load();
		return () => {
			unsubscribe();
			close();
		};
	}, [path]);

	/** Saves from the UI; failures show in the banner. A read-only tab saves nothing. */
	const handleSave = useCallback(() => {
		if (readOnly) return;
		void doc.save().catch(() => undefined);
	}, [doc, readOnly]);

	// TS surface wiring (ts/tsx files only): the language service is the
	// SAME one the Code pane runs — scaffold compiler options + React libs +
	// platform types + ATA (see editorTypes).
	const isTsSurface = /\.(ts|tsx|js|jsx)$/.test(path);
	const isSource = /\.(ts|tsx)$/.test(path);

	/** Pre-create setup: the model at the document's text, page TS service up, no shadow lib under our model. */
	const handleBeforeMount = useCallback(
		(monaco: Monaco) => {
			// step: the model is keyed by its URI and outlives every tab, so it may hold older text
			// (a file deleted and created again, or a document dropped since). It takes the
			// document's text before the editor binds to it, so the editor does not report it as typing
			doc.sync = (text) => {
				const model = monaco.editor.getModel(monaco.Uri.parse(`${WORKSPACE_URI_PREFIX}${path}`));
				if (model && model.getValue() !== text) model.setValue(text);
			};
			doc.syncModel();
			if (!isTsSurface) return;
			ensureWorkspaceEditorTs(monaco);
			// step: this tab's URI gets a LIVE model — a project-source lib at
			// the same path would shadow-duplicate it
			releaseProjectSource(path);
		},
		[doc, path, isTsSurface]
	);

	/** Post-create setup: acquire package types + feed sibling sources. */
	const handleMount = useCallback(() => {
		if (!isSource) return;
		getWorkspaceEditorTs()?.ata.enqueue(path, () => doc.text ?? '');
		void primeProjectSources(path);
	}, [doc, path, isSource]);

	/** Tracks typing into the document. */
	const handleChange = useCallback(
		(value: string) => {
			doc.type(value);
			// step: acquisition follows the keystrokes (debounced in the engine)
			if (isSource) getWorkspaceEditorTs()?.ata.enqueue(path, () => doc.text ?? '');
		},
		[doc, path, isSource]
	);

	// Ctrl+S / Cmd+S inside this tab. Capture phase beats the shell's global
	// tab:save forwarding only while focus is inside this editor's subtree;
	// a read-only tab still swallows it, so the browser's save dialog stays shut.
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return undefined;
		const onKey = (e: KeyboardEvent): void => {
			if ((e.ctrlKey || e.metaKey) && e.key === 's') {
				e.preventDefault();
				e.stopPropagation();
				handleSave();
			}
		};
		root.addEventListener('keydown', onKey, true);
		return () => root.removeEventListener('keydown', onKey, true);
	}, [handleSave]);

	return (
		<div ref={rootRef} style={S.container}>
			<div style={S.banner}>
				<span style={S.bannerPath}>{path}</span>
				{doc.stale && (
					<>
						<span style={S.staleNotice}>This file changed outside this editor</span>
						<Button small variant="secondary" onClick={() => void doc.discard()} disabled={doc.saving} title="Drop your unsaved changes and show the stored file">
							Reload
						</Button>
						<Button small variant="secondary" onClick={() => void doc.save(true).catch(() => undefined)} disabled={doc.saving} title="Save your version over the newer file">
							Overwrite
						</Button>
					</>
				)}
				{!doc.stale && doc.saveError && <span style={S.staleNotice}>Save failed: {doc.saveError}</span>}
				{doc.dirty && <span style={S.dirtyMark}>●</span>}
				{!readOnly && (
					<Button small variant="secondary" onClick={handleSave} disabled={!doc.dirty || doc.saving} title="Save (Ctrl+S) — stages the change in Source Control">
						{doc.saving ? 'Saving...' : 'Save'}
					</Button>
				)}
			</div>
			{doc.error && <div style={S.empty}>Could not read this file: {doc.error}</div>}
			{!doc.error && doc.text === null && <div style={S.empty}>Loading...</div>}
			{!doc.error && doc.text !== null && (
				<div style={S.editor}>
					<MonacoEditor value={doc.text} language={detectLanguage(path)} uri={`${WORKSPACE_URI_PREFIX}${path}`} beforeMount={handleBeforeMount} onMount={handleMount} onChange={handleChange} options={readOnly ? READ_ONLY_OPTIONS : undefined} />
				</div>
			)}
		</div>
	);
};

export default FileProvider;
