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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Generates the component gallery's per-entry token-usage map
 * (`src/modules/appdev/gallery/tokenUsage.generated.ts`).
 *
 * For every gallery entry with a live component, the generator scans the
 * component's source directory for:
 *   1. DIRECT design tokens — every `--rr-*` custom property referenced in
 *      .ts/.tsx/.css sources, and
 *   2. commonStyles USAGE — every `commonStyles.<name>` reference, resolved
 *      TRANSITIVELY through `src/themes/styles.ts` (a style that spreads
 *      another style inherits its tokens too), yielding the tokens each
 *      commonStyle contributes to the component.
 *
 * The output is deterministic (sorted keys and arrays) so `--check` mode can
 * diff the committed file against a fresh generation and fail CI on drift.
 *
 * Usage:
 *   node scripts/generate-gallery-tokens.mjs           # write the file
 *   node scripts/generate-gallery-tokens.mjs --check   # verify, no write
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// =============================================================================
// LOCATIONS
// =============================================================================

/** apps/shared (one level up from this script). */
const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The source root every scan path is relative to. */
const SRC_DIR = path.join(APP_ROOT, 'src');

/** The shell package's source root — commonStyles and the surface
    components live there since the surface partition. */
const SHELL_SRC = path.join(APP_ROOT, '..', '..', 'packages', 'shell', 'src');

/** The commonStyles definition file the transitive resolution reads. */
const STYLES_FILE = path.join(SHELL_SRC, 'themes', 'styles.ts');

/** The generated module the gallery imports. */
const OUTPUT_FILE = path.join(SRC_DIR, 'modules', 'appdev', 'gallery', 'tokenUsage.generated.ts');

// =============================================================================
// ENTRY SOURCE MAP
// =============================================================================

/**
 * Gallery entry id -> the component source directories (relative to src/)
 * that constitute the component. Entries are deliberately absent when their
 * tokens are not the app's to theme or cannot be isolated: shell-owned
 * chrome (the schematic entries), doc-only hook/utility entries, and
 * components that share a directory with unrelated chrome (nav-button,
 * popup-row, rocketride-mark live in multi-purpose locations).
 */
const ENTRY_SOURCES = {
	banner: ['components/banner'],
	button: ['components/button'],
	card: ['components/card'],
	'chat-view': ['components/chat'],
	chip: ['components/chip'],
	'confirm-dialog': ['components/modal'],
	'connection-card': ['components/connection-card'],
	'content-header': ['components/content-header'],
	'data-grid': ['components/data-grid'],
	'detail-panel': ['components/detail-panel'],
	'drop-zone': ['components/drop-zone'],
	'empty-state': ['components/empty-state'],
	explorer: ['modules/explorer'],
	'filter-strip': ['components/data-grid'],
	'grid-helpers': ['components/data-grid'],
	'input-field': ['components/input-field'],
	'mini-card': ['components/mini-card'],
	modal: ['components/modal'],
	section: ['components/section'],
	'sidebar-footer': ['components/sidebar-footer'],
	'sidebar-menu': ['components/sidebar-menu'],
	'status-badge': ['components/status-badge'],
	'tab-control': ['components/tab-control', 'components/tab-panel'],
	'toggle-group': ['components/toggle-group'],
};

// =============================================================================
// EXTRACTION HELPERS (pure — unit-tested)
// =============================================================================

/** Matches every design-token reference (`--rr-...`). */
const TOKEN_PATTERN = /--rr-[a-z0-9-]+/g;

/** Matches every `commonStyles.<name>` reference. */
const COMMON_STYLES_PATTERN = /commonStyles\.([A-Za-z0-9_]+)/g;

/**
 * Extracts the sorted, deduplicated `--rr-*` tokens from source text.
 *
 * @param {string} text - Source file contents.
 * @returns {string[]} Sorted unique token names.
 */
export function extractTokens(text) {
	return [...new Set(text.match(TOKEN_PATTERN) ?? [])].sort();
}

/**
 * Extracts the sorted, deduplicated commonStyles member names referenced in
 * source text.
 *
 * @param {string} text - Source file contents.
 * @returns {string[]} Sorted unique commonStyles member names.
 */
export function extractCommonStyleRefs(text) {
	const names = new Set();
	for (const match of text.matchAll(COMMON_STYLES_PATTERN)) names.add(match[1]);
	return [...names].sort();
}

/**
 * Parses `styles.ts` into per-const blocks: name -> { tokens, refs }, where
 * `refs` are the other consts a definition spreads (`...otherConst`).
 *
 * Steps: walk lines; a `const NAME` line opens a block; the first following
 * line that starts with `}` closes it; tokens and spread references are
 * regex-extracted from the block text.
 *
 * @param {string} text - The styles.ts source.
 * @returns {Map<string, { tokens: string[]; refs: string[] }>} Blocks by name.
 */
export function parseStyleBlocks(text) {
	const blocks = new Map();
	const lines = text.split('\n');
	let name = null;
	let buffer = [];
	for (const line of lines) {
		if (name === null) {
			// Block opener: a top-level `const NAME` declaration
			const open = line.match(/^const ([A-Za-z0-9_]+)\s*[:=(]/);
			if (open) {
				name = open[1];
				buffer = [line];
			}
			continue;
		}
		buffer.push(line);
		// Block closer: the first top-level closing brace line
		if (/^\}/.test(line)) {
			const block = buffer.join('\n');
			const refs = new Set();
			for (const spread of block.matchAll(/\.\.\.([A-Za-z0-9_]+)/g)) refs.add(spread[1]);
			blocks.set(name, { tokens: extractTokens(block), refs: [...refs].sort() });
			name = null;
			buffer = [];
		}
	}
	return blocks;
}

/**
 * Resolves one style name to its full token set, following spread references
 * transitively (memoized; cycles are tolerated by the visited guard).
 *
 * @param {string} name - The commonStyles member name.
 * @param {Map<string, { tokens: string[]; refs: string[] }>} blocks - Parsed blocks.
 * @param {Map<string, string[]>} memo - Resolution cache, shared across calls.
 * @param {Set<string>} [visiting] - Cycle guard for the active DFS path.
 * @returns {string[]} Sorted unique tokens the style resolves to.
 */
export function resolveStyleTokens(name, blocks, memo, visiting = new Set()) {
	if (memo.has(name)) return memo.get(name);
	const block = blocks.get(name);
	if (!block || visiting.has(name)) return [];
	visiting.add(name);
	const tokens = new Set(block.tokens);
	for (const ref of block.refs) {
		for (const token of resolveStyleTokens(ref, blocks, memo, visiting)) tokens.add(token);
	}
	visiting.delete(name);
	const sorted = [...tokens].sort();
	memo.set(name, sorted);
	return sorted;
}

// =============================================================================
// SOURCE SCANNING
// =============================================================================

/**
 * Recursively lists every scannable source file (.ts/.tsx/.css, tests
 * excluded) under a directory.
 *
 * @param {string} dir - Absolute directory path.
 * @returns {string[]} Absolute file paths.
 */
function listSourceFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			files.push(...listSourceFiles(full));
			continue;
		}
		if (!/\.(ts|tsx|css)$/.test(entry) || /\.test\./.test(entry)) continue;
		files.push(full);
	}
	return files.sort();
}

/**
 * Builds the full usage map: entry id -> { direct, commonStyles }.
 *
 * Steps: parse styles.ts once; for each entry, concatenate its component
 * sources, extract direct tokens and commonStyles references, and resolve
 * each referenced style to the tokens it contributes.
 *
 * @returns {Record<string, { direct: string[]; commonStyles: Record<string, string[]> }>}
 */
function buildUsageMap() {
	const blocks = parseStyleBlocks(readFileSync(STYLES_FILE, 'utf8'));
	const memo = new Map();
	const usage = {};
	for (const [entryId, dirs] of Object.entries(ENTRY_SOURCES)) {
		const text = dirs
			.flatMap((dir) => {
				// Surface components live in the shell package since the
				// partition; the rest (canvas, deploy-panel, ...) remain here.
				const local = path.join(SRC_DIR, dir);
				const stock = path.join(SHELL_SRC, dir);
				if (existsSync(local)) return listSourceFiles(local);
				if (existsSync(stock)) return listSourceFiles(stock);
				// A missing dir means a stale ENTRY_SOURCES row — silently
				// emitting an empty token set would mask it.
				throw new Error(`Gallery entry '${entryId}': source dir '${dir}' found in neither ${local} nor ${stock}`);
			})
			.map((file) => readFileSync(file, 'utf8'))
			.join('\n');
		const commonStyles = {};
		for (const ref of extractCommonStyleRefs(text)) {
			const tokens = resolveStyleTokens(ref, blocks, memo);
			// Keep only refs that actually contribute tokens - pure layout
			// helpers with no token would render an empty row on the card.
			if (tokens.length > 0) commonStyles[ref] = tokens;
		}
		usage[entryId] = { direct: extractTokens(text), commonStyles };
	}
	return usage;
}

// =============================================================================
// OUTPUT RENDERING
// =============================================================================

/** The MIT header every generated source file carries. */
const MIT_HEADER = `// MIT License
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
// SOFTWARE.`;

/**
 * Renders the generated TypeScript module text from a usage map.
 *
 * @param {Record<string, { direct: string[]; commonStyles: Record<string, string[]> }>} usage - The map.
 * @returns {string} The full file contents.
 */
export function renderModule(usage) {
	const lines = [];
	lines.push(MIT_HEADER);
	lines.push('');
	lines.push('// =============================================================================');
	lines.push('// COMPONENT GALLERY — TOKEN USAGE (AUTO-GENERATED, DO NOT EDIT)');
	lines.push('// =============================================================================');
	lines.push('');
	lines.push('/**');
	lines.push(' * Per-entry design-token usage, generated by');
	lines.push(' * `scripts/generate-gallery-tokens.mjs` from the component sources and the');
	lines.push(' * transitive commonStyles resolution over `themes/styles.ts`.');
	lines.push(' *');
	lines.push(' * Regenerate: `node scripts/generate-gallery-tokens.mjs` (from');
	lines.push(' * apps/shared). Verify without writing: pass `--check`.');
	lines.push(' */');
	lines.push('');
	lines.push('/** Token usage for one gallery entry. */');
	lines.push('export interface IGalleryTokenUsage {');
	lines.push('\t/** Tokens referenced directly in the component sources. */');
	lines.push('\tdirect: string[];');
	lines.push('\t/** commonStyles members the component uses -> tokens each contributes. */');
	lines.push('\tcommonStyles: Record<string, string[]>;');
	lines.push('}');
	lines.push('');
	lines.push('/** Token usage keyed by gallery entry id (doc-only entries absent). */');
	lines.push('export const GALLERY_TOKEN_USAGE: Record<string, IGalleryTokenUsage> = {');
	for (const entryId of Object.keys(usage).sort()) {
		const { direct, commonStyles } = usage[entryId];
		lines.push(`\t'${entryId}': {`);
		lines.push(`\t\tdirect: [${direct.map((t) => `'${t}'`).join(', ')}],`);
		const styleNames = Object.keys(commonStyles).sort();
		if (styleNames.length === 0) {
			lines.push('\t\tcommonStyles: {},');
		} else {
			lines.push('\t\tcommonStyles: {');
			for (const styleName of styleNames) {
				lines.push(`\t\t\t${styleName}: [${commonStyles[styleName].map((t) => `'${t}'`).join(', ')}],`);
			}
			lines.push('\t\t},');
		}
		lines.push('\t},');
	}
	lines.push('};');
	lines.push('');
	return lines.join('\n');
}

// =============================================================================
// CLI
// =============================================================================

/**
 * Entry point: generate and write, or verify with `--check`.
 * Exits non-zero in check mode when the committed file is stale.
 */
function main() {
	// The resolution reads the shell package's SOURCE (styles.ts and the
	// surface component .tsx files). Standalone app repos vendor only the
	// COMPILED shell (.rocketride/shell), so a faithful regeneration — and
	// therefore drift-checking — is only possible in the monorepo. Keep the
	// committed map as-is and skip here.
	if (!existsSync(STYLES_FILE)) {
		console.log('shell source not present (standalone repo) - keeping committed tokenUsage.generated.ts');
		return;
	}
	const rendered = renderModule(buildUsageMap());
	if (process.argv.includes('--check')) {
		// A missing generated file is maximal drift, not a crash.
		const current = existsSync(OUTPUT_FILE) ? readFileSync(OUTPUT_FILE, 'utf8') : '';
		// Compare EOL-insensitively: the renderer emits LF, but a Windows
		// checkout under core.autocrlf=true (GitHub's Windows runners) smudges
		// the committed file to CRLF — a raw byte compare would then report
		// permanent staleness on that platform only.
		if (current.replace(/\r\n/g, '\n') !== rendered.replace(/\r\n/g, '\n')) {
			console.error('tokenUsage.generated.ts is stale - run: node scripts/generate-gallery-tokens.mjs');
			process.exit(1);
		}
		console.log('tokenUsage.generated.ts is up to date');
		return;
	}
	writeFileSync(OUTPUT_FILE, rendered, 'utf8');
	console.log(`Wrote ${path.relative(APP_ROOT, OUTPUT_FILE)}`);
}

// Run only when invoked directly (the exports stay importable from tests)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
