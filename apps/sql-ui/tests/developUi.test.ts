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
// SQL-UI — DEVELOP'S SIDEBAR AND EDITOR FIXES (#2625), KEPT THROUGH THE PORT
// =============================================================================
//
// The component code has no render harness here, so the sidebar rules are
// pinned as source patterns, and the editor's rename rule as the pure function
// it was extracted into:
//
//   - a click on the already-active connection starts no "opening" state (no
//     focus change would ever clear it);
//   - only the row ITSELF opens on Enter/Space: the nested action buttons keep
//     their own meaning;
//   - focus mirrors hover, so keyboard users reach the revealed actions, and
//     blur only clears when focus leaves the row;
//   - a connection bound to a node whose pipeline is stopped can still be
//     renamed: the binding is kept, only the name changes;
//   - dead overlay code (develop deleted it) is gone.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { keptPipelineBinding } from '../src/connect/keptBinding';
import type { SavedSqlConnection } from '../src/connect';

const SRC = path.resolve(__dirname, '..', 'src');
const source = (file: string): string => fs.readFileSync(path.join(SRC, file), 'utf8');

const BOUND: SavedSqlConnection = { id: 'c1', mode: 'pipeline', name: 'Orders', projectId: 'p1', pipelineName: 'A', source: 's1', nodeId: 'db_1', provider: 'db_postgres' };

describe('the sidebar rows', () => {
	const sidebar = source('SqlSidebar.tsx');

	it('an already-active connection raises no focus change, so no opening state is set for it', () => {
		assert.match(sidebar, /if \(endpointKeyForConnection\(conn\) !== activeKey\) setOpeningId\(conn\.id\);/);
	});

	it('only the row itself opens on Enter or Space (the nested buttons keep their own)', () => {
		assert.match(sidebar, /e\.target === e\.currentTarget && \(e\.key === 'Enter' \|\| e\.key === ' '\)/);
	});

	it('focus mirrors hover, and blur clears it only when focus leaves the row', () => {
		assert.match(sidebar, /onFocus=\{\(\) => setHoveredId\(conn\.id\)\}/);
		assert.match(sidebar, /!e\.currentTarget\.contains\(e\.relatedTarget as Node \| null\)/);
	});

	it('the deleted overlay machinery stays deleted', () => {
		assert.equal(fs.existsSync(path.join(SRC, 'components', 'ConnectionOverlays.tsx')), false);
		assert.doesNotMatch(source('navigation.ts'), /ConnectionOverlayRequest|requestConnectionOverlay|useConnectionOverlay/);
		assert.doesNotMatch(source('SqlDevTool.tsx') + source('SqlApp.tsx'), /OverlayHost|ConnectionOverlays/);
	});
});

describe('renaming a connection whose pipeline is stopped', () => {
	it('keeps the binding and applies the new name when the selection is the existing binding', () => {
		assert.deepEqual(keptPipelineBinding(BOUND, 'p1:s1:db_1', '  Orders v2 '), { ...BOUND, name: 'Orders v2' });
	});

	it('an empty name keeps the old one', () => {
		assert.deepEqual(keptPipelineBinding(BOUND, 'p1:s1:db_1', '   '), BOUND);
	});

	it('any other selection (another node, nothing, or an add) is not a kept binding', () => {
		assert.equal(keptPipelineBinding(BOUND, 'p2:s1:db_1', 'x'), null);
		assert.equal(keptPipelineBinding(BOUND, null, 'x'), null);
		assert.equal(keptPipelineBinding(null, 'p1:s1:db_1', 'x'), null);
		assert.equal(keptPipelineBinding({ id: 'c2', mode: 'direct', name: 'D', provider: 'db_mysql', config: {} }, 'p1:s1:db_1', 'x'), null);
	});

	it('the editor saves the kept record through the env (the controller owns the list), not a local commit', () => {
		const modal = source('components/NewConnectionModal.tsx');
		assert.match(modal, /const kept = keptPipelineBinding\(editing, selectedKey, name\);/);
		assert.match(modal, /await env\.saveConnection\(kept\);/);
	});
});
