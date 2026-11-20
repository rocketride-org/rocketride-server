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
// QUERY VIEW WIRING — the text an editor run marks as "already run"
// =============================================================================
//
// The `sql` state can lag the editor by a render when Ctrl+Enter follows the
// last keystrokes. The statements a run sends are cut from the editor's LIVE
// text (liveBufferText); the text it then marks as run must be that same live
// text, or "Load into editor" asks to replace text that was in fact run. The
// view has no DOM harness here, so this checks the source, as the SqlEditor
// wiring tests do.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'QueryView.tsx'), 'utf8');

describe('QueryView: what an editor run marks as run', () => {
	it('never marks the lagging React copy of the text as run', () => {
		assert.ok(!/committedTextRef\.current\s*=\s*sql\s*;/.test(source), 'the end of an editor run still marks the `sql` state as the text that ran');
	});

	it('marks the live editor text the run was cut from, captured when the run starts', () => {
		assert.match(source, /editorRunTextRef\.current\s*=\s*text\s*;/);
		assert.match(source, /startedRunTextRef\.current\s*=\s*editorRunTextRef\.current\s*;/);
		assert.match(source, /committedTextRef\.current\s*=\s*startedRunTextRef\.current\s*;/);
		// Both editor runs go through the capture, with the live text.
		for (const name of ['runOne', 'runAll']) {
			const body = new RegExp(`const ${name} = useCallback\\(\\(\\): void => \\{([\\s\\S]*?)\\}, \\[`).exec(source);
			assert.ok(body, `${name} not found`);
			assert.match(body[1]!, /liveBufferText\(editorRef\.current, sql\)/, `${name} reads the live text`);
			assert.match(body[1]!, /runFromEditor\(/, `${name} captures it`);
		}
	});
});
