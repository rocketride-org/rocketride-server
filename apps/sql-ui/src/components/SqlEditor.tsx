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
// =============================================================================

import React, { useCallback } from 'react';
import type { CSSProperties } from 'react';
import Editor from '@monaco-editor/react';
import type * as MonacoNS from 'monaco-editor';
import type { SqlDialect } from '../connect';

// =============================================================================
// TYPES
// =============================================================================

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

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * SQL editor surface: Monaco in the dialect's SQL mode with the app theme,
 * minimap off, and Ctrl/Cmd+Enter wired to the run gesture.
 */
export const SqlEditor: React.FC<ISqlEditorProps> = ({ value, onChange, dialect, onRun }) => {
	// Keep the latest onRun reachable from the (once-registered) Monaco action.
	const onRunRef = React.useRef(onRun);
	onRunRef.current = onRun;

	/**
	 * Register the theme before the editor mounts.
	 */
	const handleBeforeMount = useCallback((monaco: typeof MonacoNS) => {
		defineTheme(monaco);
	}, []);

	/**
	 * Wire the run keybinding after mount.
	 */
	const handleMount = useCallback((editor: MonacoNS.editor.IStandaloneCodeEditor, monaco: typeof MonacoNS) => {
		editor.addAction({
			id: 'sql-ui.run',
			label: 'Run Query',
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
			run: () => { onRunRef.current?.(); },
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
};

export default SqlEditor;
