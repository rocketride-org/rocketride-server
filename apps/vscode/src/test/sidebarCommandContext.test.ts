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

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePipelineCommandUri, resolvePipelineSourceComponentId } from '../providers/sidebarCommandContext';

test('prefers explicit sidebar selection when present', () => {
	const explicitUri = { fsPath: '/tmp/selected.pipe' };
	const activeEditorUri = { fsPath: '/tmp/active.pipe' };

	const result = resolvePipelineCommandUri(explicitUri, activeEditorUri);

	assert.equal(result, explicitUri);
});

test('falls back to active .pipe editor when sidebar selection is missing', () => {
	const activeEditorUri = { fsPath: '/tmp/active.pipe' };

	const result = resolvePipelineCommandUri(undefined, activeEditorUri);

	assert.equal(result, activeEditorUri);
});

test('falls back to active .pipe.json editor when sidebar selection is missing', () => {
	const activeEditorUri = { fsPath: '/tmp/active.pipe.json' };

	const result = resolvePipelineCommandUri(undefined, activeEditorUri);

	assert.equal(result, activeEditorUri);
});

test('ignores non-pipeline active editors', () => {
	const activeEditorUri = { fsPath: '/tmp/readme.md' };

	const result = resolvePipelineCommandUri(undefined, activeEditorUri);

	assert.equal(result, undefined);
});

test('falls back to active custom editor tab when there is no active text editor', () => {
	const activeTabUri = { fsPath: '/tmp/active.pipe' };

	const result = resolvePipelineCommandUri(undefined, undefined, activeTabUri);

	assert.equal(result, activeTabUri);
});

test('prefers explicit source component id when available', () => {
	const result = resolvePipelineSourceComponentId('chat_1', 'pipeline_source', [{ id: 'source_1' }]);

	assert.equal(result, 'chat_1');
});

test('falls back to the pipeline source field when no explicit component id exists', () => {
	const result = resolvePipelineSourceComponentId(undefined, 'pipeline_source', [{ id: 'source_1' }]);

	assert.equal(result, 'pipeline_source');
});

test('falls back to the first parsed source component when pipeline.source is missing', () => {
	const result = resolvePipelineSourceComponentId(undefined, undefined, [{ id: 'source_1' }, { id: 'source_2' }]);

	assert.equal(result, 'source_1');
});

test('returns undefined when no source component can be resolved', () => {
	const result = resolvePipelineSourceComponentId(undefined, undefined, []);

	assert.equal(result, undefined);
});
