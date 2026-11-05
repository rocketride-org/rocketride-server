// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// THE EDITOR: MONACO IS BUNDLED, SUGGESTIONS AND MARKS ARE WIRED ONCE
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(__dirname, '..');
/** Source without comments, so a rule is checked against code only. */
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

/** Every file under a directory. */
function walk(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test('Monaco stays bundled: no CDN loader and no @monaco-editor/react anywhere in the app or its package', () => {
	for (const file of walk(path.join(ROOT, 'src')).filter((f) => /\.(ts|tsx)$/.test(f))) {
		assert.doesNotMatch(strip(fs.readFileSync(file, 'utf8')), /cdn|jsdelivr|unpkg|@monaco-editor\/react/i, path.relative(ROOT, file));
	}
	const manifest = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
	assert.doesNotMatch(manifest, /cdn|jsdelivr|unpkg|@monaco-editor\/react/i);
	const editor = fs.readFileSync(path.join(ROOT, 'src', 'components', 'QueryEditor.tsx'), 'utf8');
	assert.match(editor, /from 'shared\/components\/monaco'/);
	assert.doesNotMatch(strip(editor), /import (?!type)[^;]*from 'monaco-editor'/, 'only types come from monaco-editor');
});

test('the editor registers the one provider before it mounts, switches off word suggestions, and cleans up its entry', () => {
	const editor = strip(fs.readFileSync(path.join(ROOT, 'src', 'components', 'QueryEditor.tsx'), 'utf8'));
	assert.match(editor, /beforeMount=\{handleBeforeMount\}/);
	assert.match(editor, /ensureCypherCompletion\(monaco\)/);
	assert.doesNotMatch(editor, /registerCompletionItemProvider/, 'the provider is registered in one module, not per editor');
	assert.match(editor, /wordBasedSuggestions: 'off'/);
	assert.match(editor, /setCompletionContext\(modelUri\.current, null\)/);
});

test('the failure mark is cleared by the next edit, and refusal warnings only appear when asked for', () => {
	const editor = strip(fs.readFileSync(path.join(ROOT, 'src', 'components', 'QueryEditor.tsx'), 'utf8'));
	assert.match(editor, /onDidChangeModelContent\([\s\S]*failureShown\.current = false/);
	assert.match(editor, /latestMarks\.current\.warnWrites/);
	assert.match(editor, /\[marksKey, mounted, showMarks\]/, 'the failure mark effect is keyed on the marks\' content');
	assert.match(editor, /refusals\.current = \[\];\n\s*showMarks\(\)/, 'an edit drops warnings measured on the old text');
});

test('the plain text box says what it lacks, suggestions and marks included', () => {
	const editor = fs.readFileSync(path.join(ROOT, 'src', 'components', 'QueryEditor.tsx'), 'utf8');
	assert.match(editor, /export const EDITOR_FALLBACK_NOTICE = '[^']*only highlighting, suggestions and error marks are missing/);
});
