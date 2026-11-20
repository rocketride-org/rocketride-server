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
// SQL-UI — EDITING A PIPELINE CONNECTION WHOSE NODE IS NOT RUNNING
// =============================================================================
//
// The connection editor lists the discoverable database nodes. When the node a
// saved connection is bound to is not discoverable (its pipeline is stopped),
// the connection can still be renamed: the existing binding is kept and only
// the name changes. Any other selection with no endpoint is an error.
// =============================================================================

import type { SavedSqlConnection } from './savedConnections';

/**
 * The record to save when the selected node is not discoverable but is the
 * node the connection being edited is already bound to.
 *
 * @param editing - The connection being edited (null when adding).
 * @param selectedKey - The key of the node selected in the editor (null: none).
 * @param name - The name typed in the editor.
 * @returns The record with the binding kept and the new name, or null when the selection is not the existing binding.
 */
export function keptPipelineBinding(editing: SavedSqlConnection | null, selectedKey: string | null, name: string): SavedSqlConnection | null {
	if (editing?.mode !== 'pipeline' || selectedKey !== `${editing.projectId}:${editing.source}:${editing.nodeId}`) return null;
	return { ...editing, name: name.trim() || editing.name };
}
