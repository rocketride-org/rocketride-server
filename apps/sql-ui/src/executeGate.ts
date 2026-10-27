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
// SQL-UI — EXECUTE GATE (what a schema-only node turns off, and what it says)
// =============================================================================
//
// `allow_execute` gates every `execute` on the node, reads included, so a node
// with it off is schema only: tables, columns and keys are readable, nothing
// else is. Every control that needs a statement uses these two answers, so the
// reason is worded once.
// =============================================================================

import type { ExecuteState } from './schema/schemaStore';

/** Why a control is off. Short enough for a button tooltip. */
export const SCHEMA_ONLY_REASON = 'Needs allow_execute on the node.';

/**
 * Id of the workbench's visible schema-only note. The gated controls on the
 * workbench and its Overview point at it (`aria-describedby`), so the reason
 * is read with the control.
 */
export const SCHEMA_ONLY_NOTE_ID = 'sql-schema-only';

/**
 * What a schema-only connection can and cannot do, for the banner and the
 * Data page.
 *
 * @param nodeName - The node's display name.
 * @returns The sentence.
 */
export function schemaOnlyExplanation(nodeName: string): string {
	return `The ${nodeName} node has allow_execute off, so SQL Explorer can show tables and columns but cannot read rows, run queries, explain or change anything. To change that, turn on allow_execute on the node and restart the pipeline.`;
}

/**
 * The reason a statement-needing control is off, or null while it is usable.
 * `unknown` is usable: a probe still in flight must not disable anything.
 *
 * @param state - The connection's execute state.
 * @returns The reason, or null.
 */
export function executeGateReason(state: ExecuteState): string | null {
	return state === 'off' ? SCHEMA_ONLY_REASON : null;
}
