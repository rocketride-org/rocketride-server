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
// SQL-UI — SQL EDITOR (Monaco wrapper, token-themed)
// =============================================================================
//
// The app carries its own Monaco dependency (apps never import another app's
// components); the wrapper follows explorer-ui's MonacoViewer pattern: the
// @monaco-editor/react Editor with a theme derived from the --rr-* tokens.
//
// Two things here are deliberately MODULE-level rather than per-instance:
//
//   1. The completion provider. `registerCompletionItemProvider` is global to
//      a language id, and every query document stays mounted (SqlApp hides
//      inactive editors with display:none), so registering per instance would
//      stack N providers and show every suggestion N times. One provider per
//      language is registered on first mount and lives for the module's
//      lifetime; what varies per editor is looked up by MODEL URI in a map
//      that each instance adds to on mount and removes from on unmount.
//
//   2. The decoration stylesheet. Inline styles cannot reach Monaco's
//      decoration class names, so one `<style>` element is injected once,
//      guarded by id — the pattern the shell's InputField uses for its
//      placeholder colour.
// =============================================================================

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import Editor from '@monaco-editor/react';
import type * as MonacoNS from 'monaco-editor';
import type { SqlDialect } from '../connect';
import type { ICompletionModel } from '../sql/completion';
import { suggestAt } from '../sql/completion';

// =============================================================================
// TYPES
// =============================================================================

/** One decorated character range in the buffer. */
export interface IDecorationRange {
	/** Start offset (inclusive). */
	start: number;
	/** End offset (exclusive). */
	end: number;
	/** Decoration class: `sql-ui-stmt-active`, `-running`, or `-last`. */
	className: string;
}

/** Where the caret and selection are, after a settle. */
export interface IEditorCursorState {
	/** Character offset of the caret. */
	offset: number;
	/** Selected text, or '' when the selection is empty. */
	selectionText: string;
	/** Start offset of the selection (equals `offset` when empty). */
	selectionStart: number;
	/** End offset of the selection (equals `offset` when empty). */
	selectionEnd: number;
}

/** The imperative surface `QueryView` drives the editor through. */
export interface ISqlEditorHandle {
	/** The selected text, or '' when the selection is empty. */
	getSelectionText(): string;
	/**
	 * The live selection with its offsets. Read this on the run path: the
	 * debounced `onCursorChange` state can be up to one debounce behind a
	 * drag, which would attribute the run to the wrong lines.
	 */
	getSelection(): { text: string; start: number; end: number };
	/** Character offset of the caret in the buffer. */
	getCursorOffset(): number;
	/** Replace the statement decorations (pass [] to clear). */
	setDecorations(ranges: IDecorationRange[]): void;
	/** Move focus into the editor. */
	focus(): void;
}

/** Props for the {@link SqlEditor} component. */
export interface ISqlEditorProps {
	/** Current SQL text. */
	value: string;
	/** Fired with the new text on every edit. */
	onChange: (value: string) => void;
	/** Engine dialect — selects Monaco's sql/mysql/pgsql language mode. */
	dialect: SqlDialect;
	/** Fired when the user presses Ctrl/Cmd+Enter (run gesture). */
	onRun?: () => void;
	/** Fired on Ctrl/Cmd+Shift+Enter (run every statement). */
	onRunAll?: () => void;
	/**
	 * Fired on Ctrl/Cmd+Shift+E. Optional: the EXPLAIN panel is a later
	 * slice, and the keybinding is a no-op until this is supplied.
	 */
	onExplain?: () => void;
	/**
	 * Fired after the caret or selection settles (debounced), so the caller
	 * can show which statement a run would send. Not the run path — that reads
	 * the handle, which is never stale.
	 */
	onCursorChange?: (state: IEditorCursorState) => void;
	/** Schema-derived suggestions for this connection, when a snapshot exists. */
	completion?: ICompletionModel | null;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Editor frame: stock input border treatment around the Monaco surface.
	frame: {
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		overflow: 'hidden',
		height: '100%',
		minHeight: 0,
	} as CSSProperties,
};

/** Id of the injected decoration stylesheet (guarantees a single insertion). */
const DECORATION_STYLE_ID = 'sql-ui-statement-decoration-style';

/**
 * Inject the statement-decoration rules exactly once.
 *
 * Monaco applies decorations by class name, which inline styles cannot reach,
 * so the three states get one document-level rule each (plus a gutter mark).
 * Guarded against non-DOM environments and repeated insertion — the pattern
 * `InputField` uses for its placeholder colour.
 */
function ensureDecorationStyle(): void {
	if (typeof document === 'undefined') return;
	if (document.getElementById(DECORATION_STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = DECORATION_STYLE_ID;
	el.textContent = [
		'.sql-ui-stmt-active { background: color-mix(in srgb, var(--rr-brand) 8%, transparent); }',
		'.sql-ui-stmt-active-gutter { border-left: 2px solid var(--rr-brand); }',
		'.sql-ui-stmt-running { background: color-mix(in srgb, var(--rr-brand) 16%, transparent); }',
		'.sql-ui-stmt-running-gutter { border-left: 2px solid var(--rr-brand); }',
		'.sql-ui-stmt-last { background: color-mix(in srgb, var(--rr-text-secondary) 8%, transparent); }',
		'.sql-ui-stmt-last-gutter { border-left: 2px solid var(--rr-text-secondary); }',
	].join('\n');
	document.head.appendChild(el);
}

// Inject at module load (a no-op outside the DOM) so the first decoration is
// already styled — a mount effect would run a frame too late and flash.
ensureDecorationStyle();

// =============================================================================
// LANGUAGE + THEME
// =============================================================================

/**
 * Map an engine dialect onto Monaco's SQL language ids (mirrors explorer-ui's
 * extension mapping: .sql/.mysql/.pgsql).
 *
 * @param dialect - The engine dialect.
 * @returns The Monaco language id.
 */
function languageFor(dialect: SqlDialect): string {
	if (dialect === 'mysql') return 'mysql';
	if (dialect === 'postgres') return 'pgsql';
	return 'sql';
}

/** Theme name registered with Monaco. */
const THEME_NAME = 'rr-sql-theme';

/**
 * Read a CSS custom property from :root.
 *
 * @param name - The custom property name.
 * @param fallback - Value when the property is unset.
 * @returns The trimmed value or the fallback.
 */
function cssVar(name: string, fallback: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Register the token-derived editor theme. Compact subset of explorer-ui's
 * theme bridge: background/foreground/line numbers from --rr-* tokens (which
 * are plain hex in every shipped theme), base vs/vs-dark from the palette mode.
 *
 * @param monaco - The loaded Monaco namespace.
 */
function defineTheme(monaco: typeof MonacoNS): void {
	const dark = cssVar('--rr-palette-mode', 'light').replace(/['"]/g, '') === 'dark';
	monaco.editor.defineTheme(THEME_NAME, {
		base: dark ? 'vs-dark' : 'vs',
		inherit: true,
		rules: [],
		colors: {
			'editor.background': cssVar('--rr-bg-paper', dark ? '#252526' : '#ffffff'),
			'editor.foreground': cssVar('--rr-text-primary', dark ? '#cccccc' : '#1a1a1a'),
			'editorLineNumber.foreground': cssVar('--rr-text-secondary', '#666666'),
			'editorLineNumber.activeForeground': cssVar('--rr-text-primary', '#1a1a1a'),
		},
	});
}

// Monotonic theme-change counter shared by every editor instance.
let themeVersion = 0;

/**
 * Watch for app theme changes and bump a version the editor can re-derive its
 * Monaco theme from (explorer-ui's MonacoViewer pattern): a MutationObserver
 * on the documentElement's data-theme/class/style attributes catches the
 * shell's theme toggle, which Monaco's registered theme cannot see by itself.
 *
 * @returns The current theme version (changes on every theme switch).
 */
function useThemeVersion(): number {
	const [version, setVersion] = useState(themeVersion);

	useEffect(() => {
		// Any attribute mutation that can restyle :root counts as a change.
		const observer = new MutationObserver(() => {
			themeVersion += 1;
			setVersion(themeVersion);
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme', 'class', 'style'],
		});
		return () => observer.disconnect();
	}, []);

	return version;
}

// =============================================================================
// COMPLETION (one provider per language id, for the whole module's lifetime)
// =============================================================================

/** Per-editor completion state, keyed by the editor model's URI. */
const completionByModel = new Map<string, { model: ICompletionModel; dialect: SqlDialect }>();

/** True once the providers are registered; they are never re-registered. */
let providersRegistered = false;

/** How long after the last caret move the cursor callback fires. */
const CURSOR_DEBOUNCE_MS = 150;

/**
 * Translate a candidate kind into a Monaco completion-item kind.
 *
 * @param monaco - The loaded Monaco namespace.
 * @param kind - The candidate's kind.
 * @returns The Monaco item kind.
 */
function itemKind(monaco: typeof MonacoNS, kind: string): MonacoNS.languages.CompletionItemKind {
	if (kind === 'table') return monaco.languages.CompletionItemKind.Struct;
	if (kind === 'column') return monaco.languages.CompletionItemKind.Field;
	return monaco.languages.CompletionItemKind.Snippet;
}

/**
 * Register ONE completion provider per SQL language id.
 *
 * The providers are intentionally never disposed: they belong to the module,
 * not to any editor, and disposing them when one query tab closes would break
 * every other open tab. What IS released per editor is its entry in
 * {@link completionByModel}, removed on unmount.
 *
 * @param monaco - The loaded Monaco namespace.
 */
function ensureCompletionProviders(monaco: typeof MonacoNS): void {
	if (providersRegistered) return;
	providersRegistered = true;

	for (const language of ['sql', 'mysql', 'pgsql']) {
		monaco.languages.registerCompletionItemProvider(language, {
			triggerCharacters: ['.'],
			provideCompletionItems: (model, position) => {
				const entry = completionByModel.get(model.uri.toString());
				if (!entry) return { suggestions: [] };
				const text = model.getValue();
				const offset = model.getOffsetAt(position);
				const word = model.getWordUntilPosition(position);
				// Replace the partial word, so accepting a suggestion does not
				// leave the characters already typed in front of it.
				const range: MonacoNS.IRange = {
					startLineNumber: position.lineNumber,
					endLineNumber: position.lineNumber,
					startColumn: word.startColumn,
					endColumn: word.endColumn,
				};
				const candidates = suggestAt(entry.model, text.slice(0, offset), entry.dialect, text.slice(offset));
				return {
					suggestions: candidates.map((candidate) => ({
						label: candidate.label,
						kind: itemKind(monaco, candidate.kind),
						detail: candidate.detail,
						documentation: candidate.documentation,
						sortText: candidate.sortText,
						insertText: candidate.insertText,
						insertTextRules: candidate.snippet
							? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
							: undefined,
						range,
					})),
				};
			},
		});
	}
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * SQL editor surface: Monaco in the dialect's SQL mode with the app theme,
 * minimap off, schema-aware suggestions, statement decorations, and the run
 * keybindings wired to the callbacks.
 */
export const SqlEditor = forwardRef<ISqlEditorHandle, ISqlEditorProps>(function SqlEditor(
	{ value, onChange, dialect, onRun, onRunAll, onExplain, onCursorChange, completion },
	ref,
) {
	// Keep the latest callbacks reachable from the (once-registered) Monaco
	// actions. Assigned in an effect: mutating a ref during render is unsafe
	// under concurrent rendering (a discarded render must not leak its props).
	// useLayoutEffect: the refs must be current before Monaco's native keydown
	// — outside React's event system — can fire post-commit; a passive effect
	// leaves a gap where the stale closure would run.
	const onRunRef = useRef(onRun);
	const onRunAllRef = useRef(onRunAll);
	const onExplainRef = useRef(onExplain);
	const onCursorRef = useRef(onCursorChange);
	useLayoutEffect(() => {
		onRunRef.current = onRun;
		onRunAllRef.current = onRunAll;
		onExplainRef.current = onExplain;
		onCursorRef.current = onCursorChange;
		completionRef.current = completion;
		dialectRef.current = dialect;
	}, [onRun, onRunAll, onExplain, onCursorChange, completion, dialect]);

	// Monaco namespace captured at mount + the app-theme version, so a theme
	// toggle re-derives the token-based editor theme.
	const monacoRef = useRef<typeof MonacoNS | null>(null);
	const editorRef = useRef<MonacoNS.editor.IStandaloneCodeEditor | null>(null);
	const decorationsRef = useRef<MonacoNS.editor.IEditorDecorationsCollection | null>(null);
	const modelUriRef = useRef<string | null>(null);
	const [modelUri, setModelUri] = useState<string | null>(null);
	// Mirrors of the current props, so handleMount can publish immediately
	// rather than waiting a render for the effect above.
	const completionRef = useRef(completion);
	const dialectRef = useRef(dialect);
	const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const themeVersion = useThemeVersion();

	// Re-define and re-apply the theme whenever the app theme changes.
	useEffect(() => {
		if (monacoRef.current) {
			defineTheme(monacoRef.current);
			monacoRef.current.editor.setTheme(THEME_NAME);
		}
	}, [themeVersion]);

	// Publish this editor's completion model for the shared provider to find,
	// and take it back down on unmount so a closed tab stops answering.
	//
	// The URI is STATE, not just a ref, and that is the whole point: @monaco-
	// editor/react mounts asynchronously (loader promise, then editor, then
	// onMount), so on the first pass this effect has no URI to publish under.
	// Keyed on a ref alone it would never run again for a document whose
	// schema snapshot was already loaded before the editor appeared — the
	// ordinary path, browse a connection first and then open a query — and the
	// user would get Monaco's bare keyword list with no tables or columns.
	useEffect(() => {
		if (!modelUri) return;
		if (completion) completionByModel.set(modelUri, { model: completion, dialect });
		else completionByModel.delete(modelUri);
	}, [modelUri, completion, dialect]);

	useEffect(() => () => {
		if (modelUriRef.current) completionByModel.delete(modelUriRef.current);
		if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
	}, []);

	useImperativeHandle(ref, (): ISqlEditorHandle => ({
		getSelectionText: () => {
			const editor = editorRef.current;
			const selection = editor?.getSelection();
			if (!editor || !selection || selection.isEmpty()) return '';
			return editor.getModel()?.getValueInRange(selection) ?? '';
		},
		getSelection: () => {
			const editor = editorRef.current;
			const model = editor?.getModel();
			const selection = editor?.getSelection();
			if (!editor || !model || !selection || selection.isEmpty()) {
				const offset = editor && model ? model.getOffsetAt(editor.getPosition() ?? model.getPositionAt(0)) : 0;
				return { text: '', start: offset, end: offset };
			}
			return {
				text: model.getValueInRange(selection),
				start: model.getOffsetAt(selection.getStartPosition()),
				end: model.getOffsetAt(selection.getEndPosition()),
			};
		},
		getCursorOffset: () => {
			const editor = editorRef.current;
			const position = editor?.getPosition();
			if (!editor || !position) return 0;
			return editor.getModel()?.getOffsetAt(position) ?? 0;
		},
		setDecorations: (ranges) => {
			const monaco = monacoRef.current;
			const model = editorRef.current?.getModel();
			const collection = decorationsRef.current;
			if (!monaco || !model || !collection) return;
			collection.set(ranges.map((entry) => ({
				range: monaco.Range.fromPositions(model.getPositionAt(entry.start), model.getPositionAt(entry.end)),
				options: {
					className: entry.className,
					linesDecorationsClassName: `${entry.className}-gutter`,
					stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				},
			})));
		},
		focus: () => editorRef.current?.focus(),
	}), []);

	/**
	 * Register the theme and the shared completion providers before the editor
	 * mounts.
	 *
	 * @param monaco - The loaded Monaco namespace.
	 */
	const handleBeforeMount = useCallback((monaco: typeof MonacoNS) => {
		monacoRef.current = monaco;
		defineTheme(monaco);
		ensureCompletionProviders(monaco);
	}, []);

	/**
	 * Wire the keybindings, the decoration collection and cursor tracking.
	 *
	 * @param editor - The mounted editor instance.
	 * @param monaco - The loaded Monaco namespace.
	 */
	const handleMount = useCallback((editor: MonacoNS.editor.IStandaloneCodeEditor, monaco: typeof MonacoNS) => {
		editorRef.current = editor;
		decorationsRef.current = editor.createDecorationsCollection([]);
		const uri = editor.getModel()?.uri.toString() ?? null;
		modelUriRef.current = uri;
		setModelUri(uri);
		// Publish straight away too: the state update above lands a render
		// later, and a fast typist can open the suggest widget before then.
		if (uri && completionRef.current) {
			completionByModel.set(uri, { model: completionRef.current, dialect: dialectRef.current });
		}

		editor.addAction({
			id: 'sql-ui.run',
			label: 'Run Selection or Statement at Cursor',
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
			run: () => { onRunRef.current?.(); },
		});
		editor.addAction({
			id: 'sql-ui.runAll',
			label: 'Run All Statements',
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
			run: () => { onRunAllRef.current?.(); },
		});
		editor.addAction({
			id: 'sql-ui.explain',
			label: 'Explain Statement',
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE],
			run: () => { onExplainRef.current?.(); },
		});

		// Caret/selection tracking for the "Will run:" line. Debounced, because
		// it only drives a preview; the run path reads the handle instead.
		editor.onDidChangeCursorSelection(() => {
			if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
			cursorTimerRef.current = setTimeout(() => {
				const model = editor.getModel();
				const position = editor.getPosition();
				const selection = editor.getSelection();
				if (!model || !position) return;
				const offset = model.getOffsetAt(position);
				const active = selection && !selection.isEmpty() ? selection : null;
				onCursorRef.current?.({
					offset,
					selectionText: active ? model.getValueInRange(active) : '',
					selectionStart: active ? model.getOffsetAt(active.getStartPosition()) : offset,
					selectionEnd: active ? model.getOffsetAt(active.getEndPosition()) : offset,
				});
			}, CURSOR_DEBOUNCE_MS);
		});
	}, []);

	return (
		<div style={styles.frame}>
			<Editor
				value={value}
				language={languageFor(dialect)}
				theme={THEME_NAME}
				beforeMount={handleBeforeMount}
				onMount={handleMount}
				onChange={(next) => onChange(next ?? '')}
				options={{
					minimap: { enabled: false },
					fontSize: 13,
					lineNumbersMinChars: 3,
					scrollBeyondLastLine: false,
					automaticLayout: true,
					wordWrap: 'on',
					padding: { top: 10, bottom: 10 },
				}}
			/>
		</div>
	);
});

export default SqlEditor;
