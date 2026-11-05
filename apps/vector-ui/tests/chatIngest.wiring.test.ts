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
// chatIngest.wiring — rules of the chat and ingest code that only the source shows
// =============================================================================
//
// There is no DOM harness, so a few rules are pinned by reading the source of
// the chat and ingest files: nothing is ever inserted as HTML, no key or
// click handling escapes to the shell's drawers and dialogs, nothing is kept
// in browser storage, no token is handled, uploads are built in one place,
// answers render through the safe Markdown renderer, and the replace dialog
// focuses Cancel.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..', 'src');

/**
 * Every .ts/.tsx file under a directory.
 *
 * @param dir - The directory.
 * @returns Absolute paths.
 */
function sourcesUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((entry) => {
		const full = path.join(dir, entry);
		return statSync(full).isDirectory() ? sourcesUnder(full) : /\.tsx?$/.test(entry) ? [full] : [];
	});
}

/** The chat and ingest lane's source files. */
const FILES = [...sourcesUnder(path.join(SRC, 'chat')), ...sourcesUnder(path.join(SRC, 'ingest')), ...['IngestPanel', 'IngestDropZone', 'UploadList', 'ChatPanel', 'SourcesPanel', 'RetrievalDebugger', 'ScoreHistogram'].map((name) => path.join(SRC, 'components', `${name}.tsx`)), ...['uploads', 'chatResult', 'retrieval', 'markdown', 'objectId', 'sha1'].map((name) => path.join(SRC, 'vector', `${name}.ts`))];

/**
 * A file's source without its comments (rules apply to code, not prose).
 *
 * @param file - The file.
 * @returns The code.
 */
function code(file: string): string {
	return readFileSync(file, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/**
 * Read a source file relative to src/.
 *
 * @param relative - The path.
 * @returns Its code.
 */
function source(relative: string): string {
	return code(path.join(SRC, relative));
}

test('wiring: every file of the lane exists', () => {
	for (const file of FILES) assert.ok(existsSync(file), path.relative(SRC, file));
	assert.ok(FILES.length >= 23);
});

test('wiring: nothing is ever inserted as HTML, evaluated, or loaded as an image or frame', () => {
	for (const file of FILES) {
		const text = code(file);
		const name = path.relative(SRC, file);
		assert.doesNotMatch(text, /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/, name);
		assert.doesNotMatch(text, /\beval\s*\(|new\s+Function\s*\(/, name);
		assert.doesNotMatch(text, /<img\b|<iframe\b|<object\b|<embed\b/, name);
	}
});

test('wiring: no handler stops propagation or listens for keys above the shell', () => {
	for (const file of FILES) {
		const text = code(file);
		const name = path.relative(SRC, file);
		assert.doesNotMatch(text, /stopPropagation|stopImmediatePropagation/, name);
		assert.doesNotMatch(text, /(window|document)\s*\.\s*addEventListener\s*\(\s*['"]key/, name);
	}
});

test('wiring: nothing is kept in browser storage, logged, or holds a token', () => {
	for (const file of FILES) {
		const text = code(file);
		const name = path.relative(SRC, file);
		assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|document\.cookie/, name);
		assert.doesNotMatch(text, /console\.(log|info|debug|warn|error)/, name);
		assert.doesNotMatch(text, /\.token\b|\btoken\s*:|getToken|roleTokens/, name);
	}
});

test('wiring: uploads are described in one place, and never carry an objectId', () => {
	for (const file of FILES) {
		const name = path.relative(SRC, file);
		const text = code(file);
		if (name === path.join('vector', 'uploads.ts')) continue;
		assert.doesNotMatch(text, /objinfo\s*:/, `${name} builds an upload payload; only vector/uploads.ts may`);
	}
	const uploads = source(path.join('vector', 'uploads.ts'));
	const payload = /export function sendFilesPayload[\s\S]*?\n}/.exec(uploads)?.[0] ?? '';
	assert.match(payload, /objinfo: \{ name: file\.path, origin: UPLOAD_ORIGIN \}/);
	assert.doesNotMatch(payload, /objectId/);
	assert.match(source(path.join('ingest', 'ingestQueue.ts')), /deps\.sendFiles\(sendFilesPayload\(unit\)/);
});

test('wiring: upload progress comes from the shell event stream and only upload events are taken', () => {
	const hook = source(path.join('ingest', 'useIngest.ts'));
	assert.match(hook, /useShellEvent\('shell:event'/);
	assert.match(hook, /'apaevt_status_upload'/);
	assert.match(hook, /queue\.handleEvent\(/);
	// The drop's entries are taken inside the handler, before any await; the walk says what it could not read.
	assert.match(hook, /const snapshot = entriesFromDataTransfer\(transfer\);\s*void traverseDrop\(snapshot\)/);
	assert.match(hook, /errors: result\.errors/);
});

test("wiring: an answer's sources go to the map with the answer's question, through the one function that tells the map first", () => {
	const panel = source(path.join('components', 'ChatPanel.tsx'));
	assert.match(panel, /onShowOnMap=\{\(keys\) => showAnswerOnMap\(selection, actions, turn\.question, keys\)\}/);
	assert.match(panel, /import \{ showAnswerOnMap \} from '\.\.\/adapters\/consoleActions';/);
	// Nothing else highlights for the chat: a chat highlight without its question would get the centre, not the star.
	for (const file of sourcesUnder(SRC)) {
		const rel = path.relative(SRC, file);
		if (rel === path.join('adapters', 'consoleActions.ts')) continue;
		assert.doesNotMatch(code(file), /showOnMap\([^)]*'chat'\)/, `${rel} highlights for the chat without telling the map the question`);
	}
});

test('wiring: answers render through the safe Markdown renderer, never the shell chat renderers', () => {
	const panel = source(path.join('components', 'ChatPanel.tsx'));
	assert.match(panel, /<Markdown text=\{answer\.text\} \/>/);
	for (const file of FILES) assert.doesNotMatch(code(file), /\bMarkdownRenderer\b|\bChatView\b|\bMessageList\b|\buseChatMessages\b/, path.relative(SRC, file));
});

test('wiring: the chat thread scrolls on the key that changes when an answer arrives, not on the turn count alone', () => {
	const panel = source(path.join('components', 'ChatPanel.tsx'));
	assert.match(panel, /const scrollKey = threadScrollKey\(turns\);/);
	assert.match(panel, /element\.scrollTop = element\.scrollHeight;\s*\}, \[scrollKey\]\);/);
	assert.doesNotMatch(panel, /\}, \[turns\.length\]\);/);
});

test('wiring: the replace dialog moves the focus to Cancel when it opens', () => {
	const dialog = source(path.join('ingest', 'ReplaceConfirmDialog.tsx'));
	assert.match(dialog, /useEffect\(\(\) => \{\s*focusCancelIn\(anchor\.current, question\.cancelLabel\);/);
	assert.match(dialog, /destructive/);
	assert.match(dialog, /<div ref=\{anchor\}>/);
});

test('wiring: "Why these?" sends exactly the vector embed returned, and keeps it out of state', () => {
	const debuggerSource = source(path.join('components', 'RetrievalDebugger.tsx'));
	assert.match(debuggerSource, /const vector = Array\.isArray\(vectors\) && Array\.isArray\(vectors\[0\]\) \? \(vectors\[0\] as number\[\]\) : null;/);
	assert.match(debuggerSource, /debuggerSearchInput\(vector, embeddingModel, topK, model\.limits\)/);
	assert.doesNotMatch(debuggerSource, /useState<[^>]*number\[\]/);
	// The component's state type holds the view of the answer, never the vector.
	const phase = /type Phase = [^;]*;/.exec(debuggerSource)?.[0] ?? '';
	assert.ok(phase !== '');
	assert.doesNotMatch(phase, /vector|number\[\]/);
});

/**
 * The top-level arguments of every call to the imported `callTool` in some code.
 *
 * @param text - The code.
 * @returns One argument list per call.
 */
function callToolArguments(text: string): string[][] {
	const calls: string[][] = [];
	for (const match of text.matchAll(/(^|[^.\w])callTool\(/g)) {
		const start = (match.index ?? 0) + match[0].length;
		const args: string[] = [];
		let depth = 0;
		let current = '';
		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (depth === 0 && ch === ')') break;
			if ('([{'.includes(ch)) depth++;
			if (')]}'.includes(ch)) depth--;
			if (depth === 0 && ch === ',') {
				args.push(current.trim());
				current = '';
			} else current += ch;
		}
		if (current.trim() !== '') args.push(current.trim());
		calls.push(args);
	}
	return calls;
}

test('wiring: every tool call names its node', () => {
	let seen = 0;
	for (const file of FILES) {
		const text = code(file);
		// Only the files that call the shared helper (not the queue's own callTool seam).
		if (!/import \{[^}]*\bcallTool\b[^}]*\} from '(\.\.\/chat|\.)\/toolCalls'/.test(text)) continue;
		for (const args of callToolArguments(text)) {
			seen += 1;
			assert.ok(args.length >= 4 && args[3] !== 'null' && args[3] !== 'undefined', `${path.relative(SRC, file)}: callTool(${args.join(', ')})`);
		}
	}
	// The probe and count (useIngest) and embed and search ("Why these?").
	assert.ok(seen >= 3, `only ${seen} calls found`);
});
