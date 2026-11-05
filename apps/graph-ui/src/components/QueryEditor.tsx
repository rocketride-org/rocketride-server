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
// GRAPH-UI - CYPHER EDITOR (Monaco with a plain text box as the fallback)
// =============================================================================
//
// The editor is the platform's shared MonacoEditor ('shared/components/monaco'):
// Monaco and its workers are chunks of this remote's own bundle, loaded lazily by
// the shared loader (no CDN, no @monaco-editor/react). Monaco has a built-in
// `cypher` language (monaco-editor 0.55, registered by the editor.main entry the
// shared loader imports), so highlighting needs no registration and no beforeMount.
//
// If Monaco does not load (a chunk that fails to arrive, or a wait longer than the
// budget below), the editor falls back to a plain <textarea>: typing, drafts,
// Ctrl/Cmd+Enter, running and history work the same, only the highlighting is gone,
// and a notice says so.
//
// Theme: the shared editor defines and forces the platform theme on create and on
// every theme flip, so this editor has no theme of its own. Its Cypher token colours
// are Monaco's vs / vs-dark ones; the 4.5:1 token rules and line-number colour in
// editorTheme.ts are still computed and measured (tests/a11y.contrast.test.ts) and
// are wired back in once the shared editor takes per-app token colours.
//
// Suggestions: ONE completion provider per realm (components/completionProvider.ts) answers every editor from the
// schema and engine of its own model's URI. Marks: a failed statement's position is set as one error mark, cleared on
// the next edit; with `warnWrites` (the read workbench) a statement the local text check would refuse is marked as you
// type. Neither exists in the plain text box.
//
// Keys: Ctrl/Cmd+Enter runs the selection or the statement at the caret;
// Ctrl/Cmd+Shift+Enter runs every statement. Neither traps focus: Tab leaves the
// plain text box, and Monaco's own "Tab moves focus" toggle (Ctrl+M) is honoured.
// =============================================================================

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type * as MonacoNS from 'monaco-editor';
import { MonacoEditor, loadMonaco } from 'shared/components/monaco';
import type { Monaco } from 'shared/components/monaco';
import type { ICompletionModel } from '../cypher/completion';
import type { IEditorSnapshot, ISelection } from '../cypher/targets';
import { readRefusalMarkers } from '../graph/writeWarnings';
import { MARKER_OWNER, applyMarkers, ensureCypherCompletion, markersKey, setCompletionContext } from './completionProvider';
import type { IEditorMarker } from './completionProvider';

// =============================================================================
// TYPES
// =============================================================================

/** What the workbench can ask of the editor. */
export interface IQueryEditorHandle {
	/** The live buffer, selection and caret, read together from the editor itself (never from React state). */
	snapshot(): IEditorSnapshot;
	/** The live selection with its text. */
	getSelection(): ISelection & { text: string };
	/** The caret offset. */
	getCaret(): number;
	/**
	 * Replace the text from outside (History, a label preview, Ask). This is the ONLY way text enters a mounted Monaco: the
	 * editor owns its own buffer while the user types, so a render that is a keystroke behind can never write old text back.
	 */
	setText(text: string): void;
	/** Move focus into the editor. */
	focus(): void;
}

/** Props. */
export interface IQueryEditorProps {
	value: string;
	onChange(value: string): void;
	/** Ctrl/Cmd+Enter. */
	onRun(): void;
	/** Ctrl/Cmd+Shift+Enter. */
	onRunAll(): void;
	/** Fired when the caret or selection settles (debounced), so "Will run" stays current. */
	onCursorChange?(): void;
	/** Accessible name of the editor. */
	label: string;
	/** What suggestions are made from (the connection's schema and engine); null or absent: none. */
	completion?: ICompletionModel | null;
	/** Marks in the text, by buffer offset (a failed statement's position). Shown until the next edit; a fresh array each render is fine. */
	markers?: readonly IEditorMarker[];
	/** Mark, as the text changes, each statement the read workbench would refuse. Off in the write console. */
	warnWrites?: boolean;
}

/** How long after the last edit the refusal marks are recomputed. */
const WARNING_DEBOUNCE_MS = 400;

// =============================================================================
// MONACO AVAILABILITY
// =============================================================================

/** How long Monaco may take to load before the plain text box takes over. */
export const MONACO_LOAD_BUDGET_MS = 10_000;

/** One shared attempt for the whole app. */
let availability: Promise<'ready' | 'failed'> | null = null;

/**
 * Try to load Monaco once (through the shared loader, which the shared editor then reuses), giving up after
 * {@link MONACO_LOAD_BUDGET_MS}.
 *
 * @returns Whether Monaco is usable.
 */
function monacoAvailability(): Promise<'ready' | 'failed'> {
	if (!availability) {
		availability = Promise.race([
			loadMonaco().then(() => 'ready' as const),
			new Promise<'failed'>((resolve) => setTimeout(() => resolve('failed'), MONACO_LOAD_BUDGET_MS)),
		]).catch(() => 'failed' as const);
	}
	return availability;
}

/**
 * Whether the code editor is available, loading, or has been given up on.
 *
 * @returns `loading`, `ready` or `failed`.
 */
function useMonacoStatus(): 'loading' | 'ready' | 'failed' {
	const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
	useEffect(() => {
		let alive = true;
		void monacoAvailability().then((result) => {
			if (alive) setStatus(result);
		});
		return () => {
			alive = false;
		};
	}, []);
	return status;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// display:flex lets the shared editor's container (flex: 1) fill the frame.
	frame: { border: '1px solid var(--rr-border)', borderRadius: 6, overflow: 'hidden', height: '100%', minHeight: 0, display: 'flex' } as CSSProperties,
	text: {
		width: '100%',
		height: '100%',
		minHeight: 120,
		boxSizing: 'border-box',
		resize: 'none',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		padding: 10,
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 13,
		lineHeight: 1.5,
		background: 'var(--rr-bg-paper)',
		color: 'var(--rr-text-primary)',
		tabSize: 2,
	} as CSSProperties,
	notice: { fontSize: 11.5, color: 'var(--rr-text-secondary)', padding: '4px 2px' } as CSSProperties,
};

/** The wording of the fallback notice (also used by the README and the tests). */
export const EDITOR_FALLBACK_NOTICE = 'The code editor could not be loaded, so a plain text box is used. Running, drafts and history work the same; only highlighting, suggestions and error marks are missing.';

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Cypher editor.
 *
 * @param props - See {@link IQueryEditorProps}.
 * @returns The editor, or a plain text box when Monaco is unavailable.
 */
export const QueryEditor = forwardRef<IQueryEditorHandle, IQueryEditorProps>(function QueryEditor({ value, onChange, onRun, onRunAll, onCursorChange, label, completion, markers, warnWrites }, ref) {
	const status = useMonacoStatus();
	const editorRef = useRef<MonacoNS.editor.IStandaloneCodeEditor | null>(null);
	const textRef = useRef<HTMLTextAreaElement | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Monaco is UNCONTROLLED: it starts from the first value and then owns its buffer. A controlled `value` prop is a copy that
	// lags a render behind fast typing, and the shared editor writes its `value` prop back into the model whenever the two
	// differ. So the shared editor only ever gets `initial.current`, which changes only before Monaco has mounted (setText).
	const initial = useRef(value);
	const pending = useRef<string | null>(null);

	// The latest callbacks, readable from the once-registered Monaco actions.
	const latest = useRef({ onRun, onRunAll, onCursorChange });
	useLayoutEffect(() => {
		latest.current = { onRun, onRunAll, onCursorChange };
	});

	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[]
	);

	// ── Suggestions and marks (Monaco only) ──────────────────────────────────
	const monacoRef = useRef<Monaco | null>(null);
	const modelUri = useRef<string | null>(null);
	const warnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Bumped when Monaco mounts, so the effects below run once there is a model to put things on.
	const [mounted, setMounted] = useState(0);
	// The failure's marks are shown until the next edit; the refusal warnings follow the text.
	const failureShown = useRef(false);
	const refusals = useRef<IEditorMarker[]>([]);
	const latestMarks = useRef({ markers, warnWrites });
	useLayoutEffect(() => {
		latestMarks.current = { markers, warnWrites };
	});

	/** Put the current marks on the model: the failure's (until an edit) and the refusal warnings. */
	const showMarks = useCallback(() => {
		const monaco = monacoRef.current;
		const model = editorRef.current?.getModel();
		if (!monaco || !model) return;
		applyMarkers(monaco, model, [...(failureShown.current ? latestMarks.current.markers ?? [] : []), ...(latestMarks.current.warnWrites ? refusals.current : [])]);
	}, []);

	/** Recompute the refusal warnings from the live text. */
	const scanRefusals = useCallback(() => {
		const model = editorRef.current?.getModel();
		refusals.current = model && latestMarks.current.warnWrites ? readRefusalMarkers(model.getValue()) : [];
		showMarks();
	}, [showMarks]);

	useEffect(() => {
		const uri = modelUri.current;
		if (!uri) return;
		setCompletionContext(uri, completion ?? null);
	}, [completion, mounted]);

	// Keyed on what the marks say, not on the array: a caller that builds a fresh array each render must not bring a mark
	// back on the text after an edit cleared it.
	const marksKey = markersKey(markers);
	useEffect(() => {
		failureShown.current = marksKey !== '';
		showMarks();
	}, [marksKey, mounted, showMarks]);

	useEffect(() => {
		scanRefusals();
	}, [warnWrites, mounted, scanRefusals]);

	useEffect(
		() => () => {
			if (warnTimer.current) clearTimeout(warnTimer.current);
			if (modelUri.current) setCompletionContext(modelUri.current, null);
			// The model is disposed with the editor; its marks go with it.
			const model = editorRef.current?.getModel();
			if (monacoRef.current && model && !model.isDisposed()) monacoRef.current.editor.setModelMarkers(model, MARKER_OWNER, []);
		},
		[]
	);

	useImperativeHandle(
		ref,
		(): IQueryEditorHandle => ({
			snapshot: () => {
				// One read, one source: the textarea's current value, or the Monaco model's. The `value` prop (React state) is never consulted.
				const area = textRef.current;
				if (area) return { text: area.value, start: area.selectionStart, end: area.selectionEnd, caret: area.selectionStart };
				const editor = editorRef.current;
				const model = editor?.getModel();
				const selection = editor?.getSelection();
				const position = editor?.getPosition();
				if (!editor || !model) return { text: '', start: 0, end: 0, caret: 0 };
				const start = selection ? model.getOffsetAt(selection.getStartPosition()) : 0;
				const end = selection ? model.getOffsetAt(selection.getEndPosition()) : 0;
				return { text: model.getValue(), start, end, caret: position ? model.getOffsetAt(position) : start };
			},
			getSelection: () => {
				const area = textRef.current;
				if (area) return { start: area.selectionStart, end: area.selectionEnd, text: area.value.slice(area.selectionStart, area.selectionEnd) };
				const editor = editorRef.current;
				const model = editor?.getModel();
				const selection = editor?.getSelection();
				if (!editor || !model || !selection) return { start: 0, end: 0, text: '' };
				const start = model.getOffsetAt(selection.getStartPosition());
				const end = model.getOffsetAt(selection.getEndPosition());
				return { start, end, text: model.getValueInRange(selection) };
			},
			getCaret: () => {
				const area = textRef.current;
				if (area) return area.selectionStart;
				const editor = editorRef.current;
				const position = editor?.getPosition();
				return editor && position ? editor.getModel()?.getOffsetAt(position) ?? 0 : 0;
			},
			setText: (text) => {
				const editor = editorRef.current;
				const model = editor?.getModel();
				if (editor && model) {
					if (model.getValue() === text) return;
					// An edit, not a reset: Ctrl+Z brings the previous text back.
					editor.executeEdits('graph-ui', [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }]);
					editor.pushUndoStop();
				} else {
					// Monaco has not mounted yet (or the plain text box is in use, which is controlled by `value`).
					pending.current = text;
					initial.current = text;
				}
			},
			focus: () => {
				if (textRef.current) textRef.current.focus();
				else editorRef.current?.focus();
			},
		}),
		[]
	);

	const settle = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => latest.current.onCursorChange?.(), 150);
	}, []);

	const handleBeforeMount = useCallback((monaco: Monaco) => {
		ensureCypherCompletion(monaco);
	}, []);

	const handleMount = useCallback(
		(editor: MonacoNS.editor.IStandaloneCodeEditor, monaco: Monaco) => {
			editorRef.current = editor;
			monacoRef.current = monaco;
			modelUri.current = editor.getModel()?.uri.toString() ?? null;
			// An edit ends the failure's mark (it pointed into the old text) and schedules the refusal check.
			editor.onDidChangeModelContent(() => {
				failureShown.current = false;
				// The refusal warnings were measured on the old text: drop them until the check runs again.
				refusals.current = [];
				showMarks();
				if (warnTimer.current) clearTimeout(warnTimer.current);
				if (latestMarks.current.warnWrites) warnTimer.current = setTimeout(scanRefusals, WARNING_DEBOUNCE_MS);
			});
			setMounted((n) => n + 1);
			if (pending.current !== null) {
				editor.setValue(pending.current);
				pending.current = null;
			}
			editor.addAction({ id: 'graph-ui.run', label: 'Run Selection or Statement at Cursor', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => latest.current.onRun() });
			editor.addAction({ id: 'graph-ui.runAll', label: 'Run All Statements', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter], run: () => latest.current.onRunAll() });
			editor.onDidChangeCursorSelection(settle);
		},
		[settle, showMarks, scanRefusals]
	);

	if (status === 'failed') {
		return (
			<div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
				<textarea
					ref={textRef}
					aria-label={label}
					style={styles.text}
					value={value}
					spellCheck={false}
					onChange={(event) => onChange(event.target.value)}
					onSelect={settle}
					onKeyUp={settle}
					onClick={settle}
					onKeyDown={(event) => {
						if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
							event.preventDefault();
							if (event.shiftKey) latest.current.onRunAll();
							else latest.current.onRun();
						}
					}}
				/>
				<div style={styles.notice}>{EDITOR_FALLBACK_NOTICE}</div>
			</div>
		);
	}

	// The shared editor mounts only once Monaco has loaded: it awaits the same (memoized) load with no catch of its own, so
	// mounting it earlier would leave a rejected load unhandled after the text box had already taken over.
	return (
		<div style={styles.frame} aria-label={label} aria-busy={status === 'loading'}>
			{status === 'ready' && (
				<MonacoEditor
					language="cypher"
					value={initial.current}
					beforeMount={handleBeforeMount}
					onMount={handleMount}
					onChange={onChange}
					options={{ wordBasedSuggestions: 'off', minimap: { enabled: false }, fontSize: 13, lineNumbersMinChars: 3, scrollBeyondLastLine: false, automaticLayout: true, wordWrap: 'on', padding: { top: 10, bottom: 10 }, ariaLabel: label }}
				/>
			)}
		</div>
	);
});

export default QueryEditor;
