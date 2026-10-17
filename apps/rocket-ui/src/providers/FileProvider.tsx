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
// discards through the normal flow.
//
// TS/TSX files get the REAL language service, not bare Monaco defaults:
// models live at file:///workspace/<path> (so the worker knows the script
// kind and can resolve modules), and the page-wide editor TS service
// (editorTypes) supplies the scaffold compiler options, React + platform
// types, ATA for third-party imports, and the app folder's sibling sources
// for relative imports — the same surface the App Builder Code pane runs.
//
// External changes (an agent write, a discard, a commit) refresh the buffer
// only while it is CLEAN — never clobbering unsaved typing; a dirty buffer
// shows a "file changed underneath" notice instead.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles, Button } from 'shell';
import { MonacoEditor, detectLanguage } from 'shared/modules/monaco';
import type { Monaco } from 'shared/modules/monaco';
import { WORKSPACE_URI_PREFIX, ensureWorkspaceEditorTs, getWorkspaceEditorTs, primeProjectSources, releaseProjectSource } from '../appdev/editorTypes';
import { getWorkspaceVfs } from '../workspace/workspace';

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
	const [content, setContent] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	const [stale, setStale] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	// The live buffer rides a ref so save/guard logic never closes over a
	// stale render's content.
	const bufferRef = useRef<string>('');
	const dirtyRef = useRef(false);

	const load = useCallback(async () => {
		try {
			const raw = await getWorkspaceVfs().read(path);
			const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
			if (dirtyRef.current) {
				// step: never clobber unsaved typing — flag the divergence instead
				if (text !== bufferRef.current) setStale(true);
				return;
			}
			bufferRef.current = text;
			setContent(text);
			setStale(false);
			setError(null);
		} catch (err) {
			if (!dirtyRef.current) {
				setContent(null);
				setError(err instanceof Error ? err.message : String(err));
			}
		}
	}, [path]);

	// Load on mount; external ticks refresh only a CLEAN buffer (see load).
	useEffect(() => {
		void load();
		return getWorkspaceVfs().subscribe(() => void load());
	}, [load]);

	// TS surface wiring (ts/tsx files only): the language service is the
	// SAME one the Code pane runs — scaffold compiler options + React libs +
	// platform types + ATA (see editorTypes).
	const isTsSurface = /\.(ts|tsx|js|jsx)$/.test(path);
	const isSource = /\.(ts|tsx)$/.test(path);

	/** Pre-create setup: page TS service up, no shadow lib under our model. */
	const handleBeforeMount = useCallback(
		(monaco: Monaco) => {
			if (!isTsSurface) return;
			ensureWorkspaceEditorTs(monaco);
			// step: this tab's URI gets a LIVE model — a project-source lib at
			// the same path would shadow-duplicate it
			releaseProjectSource(path);
		},
		[path, isTsSurface]
	);

	/** Post-create setup: acquire package types + feed sibling sources. */
	const handleMount = useCallback(() => {
		if (!isSource) return;
		getWorkspaceEditorTs()?.ata.enqueue(path, () => bufferRef.current);
		void primeProjectSources(path);
	}, [path, isSource]);

	/** Tracks typing into the local buffer. */
	const handleChange = useCallback(
		(value: string) => {
			bufferRef.current = value;
			dirtyRef.current = true;
			setDirty(true);
			// step: acquisition follows the keystrokes (debounced in the engine)
			if (isSource) getWorkspaceEditorTs()?.ata.enqueue(path, () => bufferRef.current);
		},
		[path, isSource]
	);

	/** Saves the buffer through the view — a staged write like any other. */
	const handleSave = useCallback(async () => {
		if (!dirtyRef.current || saving) return;
		setSaving(true);
		try {
			await getWorkspaceVfs().write(path, bufferRef.current, 'editor');
			dirtyRef.current = false;
			setDirty(false);
			setStale(false);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [path, saving]);

	// Ctrl+S / Cmd+S inside this tab. Capture phase beats the shell's global
	// tab:save forwarding only while focus is inside this editor's subtree.
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return undefined;
		const onKey = (e: KeyboardEvent): void => {
			if ((e.ctrlKey || e.metaKey) && e.key === 's') {
				e.preventDefault();
				e.stopPropagation();
				void handleSave();
			}
		};
		root.addEventListener('keydown', onKey, true);
		return () => root.removeEventListener('keydown', onKey, true);
	}, [handleSave]);

	return (
		<div ref={rootRef} style={S.container}>
			<div style={S.banner}>
				<span style={S.bannerPath}>{path}</span>
				{stale && <span style={S.staleNotice}>changed outside this editor — saving overwrites</span>}
				{dirty && <span style={S.dirtyMark}>●</span>}
				<Button small variant="secondary" onClick={() => void handleSave()} disabled={!dirty || saving} title="Save (Ctrl+S) — stages the change in Source Control">
					{saving ? 'Saving...' : 'Save'}
				</Button>
			</div>
			{error && <div style={S.empty}>Could not read this file: {error}</div>}
			{!error && content === null && <div style={S.empty}>Loading...</div>}
			{!error && content !== null && (
				<div style={S.editor}>
					<MonacoEditor value={content} language={detectLanguage(path)} uri={`${WORKSPACE_URI_PREFIX}${path}`} beforeMount={handleBeforeMount} onMount={handleMount} onChange={handleChange} />
				</div>
			)}
		</div>
	);
};

export default FileProvider;
