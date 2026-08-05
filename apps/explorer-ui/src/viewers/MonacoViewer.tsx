// =============================================================================
// MONACO VIEWER — syntax-highlighted code editor for text & code files
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import type { Documents } from 'shell-ui';

// -----------------------------------------------------------------------------
// Extension → Monaco language ID mapping
// -----------------------------------------------------------------------------

const EXT_TO_LANGUAGE: Record<string, string> = {
	// Web
	'.html': 'html',
	'.htm': 'html',
	'.css': 'css',
	'.scss': 'scss',
	'.less': 'less',
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	'.ts': 'typescript',
	'.tsx': 'typescript',
	'.mts': 'typescript',
	'.cts': 'typescript',
	'.vue': 'html',
	'.svelte': 'html',

	// Data / config
	'.json': 'json',
	'.jsonl': 'json',
	'.geojson': 'json',
	'.json5': 'json',
	'.pipe': 'json',
	'.yaml': 'yaml',
	'.yml': 'yaml',
	'.toml': 'ini',
	'.ini': 'ini',
	'.cfg': 'ini',
	'.conf': 'ini',
	'.properties': 'ini',
	'.env': 'ini',
	'.xml': 'xml',
	'.xsl': 'xml',
	'.xslt': 'xml',
	'.xsd': 'xml',
	'.svg': 'xml',
	'.plist': 'xml',
	'.graphql': 'graphql',
	'.gql': 'graphql',
	'.proto': 'protobuf',

	// Markdown
	'.md': 'markdown',
	'.markdown': 'markdown',
	'.mdx': 'markdown',
	'.mdown': 'markdown',
	'.mkd': 'markdown',
	'.mkdn': 'markdown',

	// Shell / scripting
	'.sh': 'shell',
	'.bash': 'shell',
	'.zsh': 'shell',
	'.fish': 'shell',
	'.bat': 'bat',
	'.cmd': 'bat',
	'.ps1': 'powershell',
	'.psm1': 'powershell',
	'.psd1': 'powershell',

	// Systems languages
	'.c': 'c',
	'.h': 'c',
	'.cpp': 'cpp',
	'.cxx': 'cpp',
	'.cc': 'cpp',
	'.hpp': 'cpp',
	'.hxx': 'cpp',
	'.cs': 'csharp',
	'.go': 'go',
	'.rs': 'rust',
	'.swift': 'swift',
	'.m': 'objective-c',
	'.mm': 'objective-c',
	'.zig': 'zig',

	// JVM
	'.java': 'java',
	'.kt': 'kotlin',
	'.kts': 'kotlin',
	'.scala': 'scala',
	'.groovy': 'groovy',
	'.gradle': 'groovy',
	'.clj': 'clojure',
	'.cljs': 'clojure',
	'.cljc': 'clojure',

	// Scripting / dynamic
	'.py': 'python',
	'.pyi': 'python',
	'.pyw': 'python',
	'.rb': 'ruby',
	'.rake': 'ruby',
	'.gemspec': 'ruby',
	'.php': 'php',
	'.pl': 'perl',
	'.pm': 'perl',
	'.lua': 'lua',
	'.r': 'r',
	'.R': 'r',
	'.dart': 'dart',
	'.ex': 'elixir',
	'.exs': 'elixir',
	'.erl': 'erlang',
	'.hrl': 'erlang',
	'.hs': 'haskell',
	'.lhs': 'haskell',
	'.fs': 'fsharp',
	'.fsx': 'fsharp',
	'.fsi': 'fsharp',
	'.jl': 'julia',

	// Database
	'.sql': 'sql',
	'.mysql': 'mysql',
	'.pgsql': 'pgsql',

	// Infrastructure / DevOps
	'.dockerfile': 'dockerfile',
	'.tf': 'hcl',
	'.tfvars': 'hcl',
	'.bicep': 'bicep',

	// Misc
	'.diff': 'diff',
	'.patch': 'diff',
	'.log': 'log',
	'.txt': 'plaintext',
	'.text': 'plaintext',
	'.rst': 'restructuredtext',
	'.tex': 'latex',
	'.latex': 'latex',
	'.bib': 'bibtex',
	'.coffee': 'coffeescript',
	'.litcoffee': 'coffeescript',
	'.handlebars': 'handlebars',
	'.hbs': 'handlebars',
	'.pug': 'pug',
	'.jade': 'pug',
	'.razor': 'razor',
	'.cshtml': 'razor',
	'.twig': 'twig',
	'.sol': 'sol',
	'.abt': 'abt',
	'.abap': 'abap',
	'.sb': 'sb',
	'.st': 'st',
	'.awk': 'awk',
	'.pas': 'pascal',
	'.pp': 'pascal',
	'.vb': 'vb',
	'.vbs': 'vb',

	// Lock / config files (by exact name handled via special case)
	'.lock': 'plaintext',
	'.gitignore': 'plaintext',
	'.editorconfig': 'ini',
	'.eslintrc': 'json',
	'.prettierrc': 'json',
};

/** Well-known filenames that don't rely on extensions. */
const NAME_TO_LANGUAGE: Record<string, string> = {
	'dockerfile': 'dockerfile',
	'makefile': 'makefile',
	'cmakelists.txt': 'cmake',
	'gemfile': 'ruby',
	'rakefile': 'ruby',
	'vagrantfile': 'ruby',
	'.gitignore': 'ini',
	'.dockerignore': 'ini',
	'.editorconfig': 'ini',
	'.env': 'ini',
	'.env.local': 'ini',
	'.env.development': 'ini',
	'.env.production': 'ini',
};

/**
 * Detect the Monaco language ID from a file URI / path.
 */
function detectLanguage(uri: string): string {
	// Try exact filename match first
	const filename = uri.split('/').pop()?.toLowerCase() ?? '';
	const byName = NAME_TO_LANGUAGE[filename];
	if (byName) return byName;

	// Then try extension
	const dotIdx = filename.lastIndexOf('.');
	if (dotIdx >= 0) {
		const ext = filename.substring(dotIdx).toLowerCase();
		const byExt = EXT_TO_LANGUAGE[ext];
		if (byExt) return byExt;
	}

	return 'plaintext';
}

// -----------------------------------------------------------------------------
// Theme bridge — reads --rr-* CSS variables and defines a Monaco theme
// -----------------------------------------------------------------------------

const THEME_NAME = 'rr-theme';

/** Read a CSS custom property from :root, returning the trimmed value or the fallback. */
function cssVar(name: string, fallback: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Convert any CSS color to a Monaco-compatible hex string (#RRGGBB or #RRGGBBAA).
 * Monaco's defineTheme only accepts hex — rgba() / named colors are silently ignored.
 */
function toHex(color: string): string {
	// Already hex — pass through
	if (color.startsWith('#')) return color;

	// Use an off-screen canvas to resolve any CSS color to rgba
	const ctx = document.createElement('canvas').getContext('2d');
	if (!ctx) return color;
	ctx.fillStyle = color;
	const resolved = ctx.fillStyle; // browser normalises to #rrggbb or rgba(...)

	if (resolved.startsWith('#')) return resolved;

	const match = resolved.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
	if (!match) return color;

	const r = Number(match[1]);
	const g = Number(match[2]);
	const b = Number(match[3]);
	const a = match[4] !== undefined ? Math.round(Number(match[4]) * 255) : 255;

	const hex = '#' + [r, g, b, ...(a < 255 ? [a] : [])]
		.map(v => v.toString(16).padStart(2, '0'))
		.join('');
	return hex;
}

/**
 * Detect whether the app is currently in dark mode by checking the
 * `--rr-palette-mode` token (set by applyTheme / rocketride-default.css).
 */
function isDarkMode(): boolean {
	const mode = cssVar('--rr-palette-mode', 'light').replace(/['"]/g, '');
	return mode === 'dark';
}

/**
 * Build and register a Monaco theme from the live --rr-* CSS variables.
 * Must be called after `monaco` has loaded (i.e. inside `beforeMount` or after
 * the loader promise resolves).
 */
function defineRrTheme(monaco: typeof import('monaco-editor')): void {
	const dark = isDarkMode();

	// Helper: read a CSS variable and guarantee Monaco-safe hex output
	const hex = (name: string, fallback: string) => toHex(cssVar(name, fallback));

	// Read the app's CSS variables with sensible fallbacks
	const bg        = hex('--rr-bg-paper',        dark ? '#252526' : '#ffffff');
	const fg        = hex('--rr-text-primary',     dark ? '#cccccc' : '#1a1a1a');
	const fgSec     = hex('--rr-text-secondary',   dark ? '#999999' : '#666666');
	const border    = hex('--rr-border',            dark ? '#444444' : '#dcdcdc');
	const selection = dark ? '#264f78' : '#add6ff';
	const lineHl    = dark ? '#ffffff0a' : '#0000000a';
	const inputBg   = hex('--rr-bg-input',         dark ? '#3c3c3c' : '#ffffff');
	const widgetBg  = hex('--rr-bg-widget',         dark ? '#252526' : '#f3f3f3');
	const listHover = toHex(cssVar('--rr-bg-list-hover', dark ? '#ffffff0a' : '#0000000a'));
	const listActive = hex('--rr-bg-list-active',   dark ? '#094771' : '#0e639c');
	const listActiveFg = hex('--rr-fg-list-active', '#ffffff');
	const accent    = hex('--rr-accent',            '#f7901f');
	const link      = hex('--rr-text-link',         dark ? '#3794ff' : '#1976d2');
	const scrollbar = toHex(cssVar('--rr-bg-scrollbar-thumb', '#79797966'));
	const focusBorder = hex('--rr-border-focus',    dark ? '#007fd4' : '#0078d4');

	monaco.editor.defineTheme(THEME_NAME, {
		base: dark ? 'vs-dark' : 'vs',
		inherit: true,
		rules: [],
		colors: {
			// Editor
			'editor.background': bg,
			'editor.foreground': fg,
			'editor.lineHighlightBackground': lineHl,
			'editor.selectionBackground': selection,
			'editor.inactiveSelectionBackground': dark ? '#3a3d4166' : '#e5ebf166',
			'editorCursor.foreground': accent,

			// Line numbers
			'editorLineNumber.foreground': fgSec,
			'editorLineNumber.activeForeground': fg,

			// Gutter / rulers
			'editorGutter.background': bg,
			'editorRuler.foreground': border,
			'editorIndentGuide.background': border,
			'editorIndentGuide.activeBackground': fgSec,

			// Widgets (find, hover, suggest)
			'editorWidget.background': widgetBg,
			'editorWidget.foreground': fg,
			'editorWidget.border': border,
			'editorHoverWidget.background': widgetBg,
			'editorHoverWidget.border': border,
			'editorSuggestWidget.background': widgetBg,
			'editorSuggestWidget.border': border,
			'editorSuggestWidget.foreground': fg,
			'editorSuggestWidget.selectedBackground': listActive,
			'editorSuggestWidget.highlightForeground': accent,

			// Input (find dialog)
			'input.background': inputBg,
			'input.foreground': fg,
			'input.border': border,
			'inputOption.activeBorder': accent,
			'focusBorder': focusBorder,

			// Lists (autocomplete, etc.)
			'list.hoverBackground': listHover,
			'list.activeSelectionBackground': listActive,
			'list.activeSelectionForeground': listActiveFg,
			'list.inactiveSelectionBackground': dark ? '#37373d' : '#e4e6f1',
			'list.highlightForeground': accent,

			// Scrollbar
			'scrollbarSlider.background': scrollbar,
			'scrollbarSlider.hoverBackground': dark ? '#79797999' : '#64646480',
			'scrollbarSlider.activeBackground': dark ? '#797979cc' : '#00000080',

			// Minimap (disabled but just in case)
			'minimap.background': bg,

			// Links
			'editorLink.activeForeground': link,

			// Bracket match
			'editorBracketMatch.background': dark ? '#0064001a' : '#0064001a',
			'editorBracketMatch.border': accent,
		},
	});
}

// -----------------------------------------------------------------------------
// Hook: watch for theme changes and re-register the Monaco theme
// -----------------------------------------------------------------------------

let themeVersion = 0;

function useThemeVersion(): number {
	const [version, setVersion] = useState(themeVersion);

	useEffect(() => {
		// Watch for data-theme attribute changes on <html> (web app theme toggle)
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

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

const containerStyle: CSSProperties = {
	flex: 1,
	minHeight: 0,
	overflow: 'hidden',
};

interface Props {
	docs: Documents;
	uri: string;
	content: string;
	readOnly?: boolean;
}

export const MonacoViewer: React.FC<Props> = ({ docs, uri, content, readOnly }) => {
	const language = useMemo(() => detectLanguage(uri), [uri]);
	const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
	const themeVersion = useThemeVersion();

	// Re-define the theme whenever the app theme changes
	useEffect(() => {
		if (monacoRef.current) {
			defineRrTheme(monacoRef.current);
			monacoRef.current.editor.setTheme(THEME_NAME);
		}
	}, [themeVersion]);

	const handleBeforeMount = useCallback((monaco: typeof import('monaco-editor')) => {
		monacoRef.current = monaco;
		defineRrTheme(monaco);
	}, []);

	const handleChange = useCallback(
		(value: string | undefined) => {
			docs.updateContent(uri, value ?? '');
		},
		[docs, uri],
	);

	return (
		<div style={containerStyle}>
			<Editor
				height="100%"
				language={language}
				value={content}
				onChange={handleChange}
				theme={THEME_NAME}
				beforeMount={handleBeforeMount}
				options={{
					readOnly,
					fontSize: 13,
					lineHeight: 20,
					tabSize: 4,
					fontFamily: 'var(--rr-font-mono, "Cascadia Code", Consolas, "Courier New", monospace)',
					minimap: { enabled: false },
					scrollBeyondLastLine: false,
					automaticLayout: true,
					wordWrap: 'off',
					renderLineHighlight: 'line',
					padding: { top: 8 },
				}}
			/>
		</div>
	);
};
