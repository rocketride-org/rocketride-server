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
// GUIDES TESTS: guide reads from the thinking rows
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { guideReads } from './guides';

test('guide reads are the .rocketride reads and catalog calls in the thinking rows', () => {
	// lines as a real edit-01 session saved them
	const rows = ['Start by reading the required concepts guide and listing the workspace.\n- read_file .rocketride/docs/ROCKETRIDE_CONCEPTS.md — ok\n- list_workspace — ok', '- read_file pipelines/support-chat.pipe — ok\n- search_files .rocketride/docs/ROCKETRIDE_COMPONENT_REFERENCE.md — ok\n- rocketride_client getService — ok', '- read_file .rocketride/services-catalog.json — error: No file at .rocketride/services-catalog.json.\n- read_file .rocketride/docs/ROCKETRIDE_CONCEPTS.md — ok\n- rocketride_client getServices — ok\n- rocketride_client use — ok'];
	const g = guideReads(rows);
	assert.deepEqual(
		g.reads.map((r) => `${r.tool} ${r.path} ${r.ok ? 'ok' : 'error'}`),
		['read_file .rocketride/docs/ROCKETRIDE_CONCEPTS.md ok', 'search_files .rocketride/docs/ROCKETRIDE_COMPONENT_REFERENCE.md ok', 'read_file .rocketride/services-catalog.json error', 'read_file .rocketride/docs/ROCKETRIDE_CONCEPTS.md ok']
	);
	assert.deepEqual(g.files, ['.rocketride/docs/ROCKETRIDE_CONCEPTS.md']);
	assert.equal(g.catalogCalls, 2);
});
