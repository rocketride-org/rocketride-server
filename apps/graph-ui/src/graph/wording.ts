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
// GRAPH - WORDING (what the UI says about limits, budgets and incompleteness)
// =============================================================================
//
// Three different things can leave part of a result unseen, and the UI must say
// WHICH, because they have different remedies:
//
//   1. The NODE cut the response (`truncated`, with `truncated_by` rows,
//      elements or values): the query matched more than the node would send.
//   2. The CANVAS budget hid part of what arrived (300 at first, 1,000 nodes and
//      2,000 relationships at most): the Table still lists every returned row.
//   3. The NEIGHBOURHOOD is incomplete: an expansion saw only part of a node's
//      relationships.
//
// None of these ever claims a count of the whole database: a number here is
// always a count of what was RETURNED.
//
// Row-limit lines reuse SQL Explorer's wording ("Limit reached, more rows may
// exist"); "Stop waiting" says exactly what it does.
// =============================================================================

import { INITIAL_NODES, MAX_NODES, MAX_RELATIONSHIPS } from './budgets';
import type { IGraphModel } from './model';
import type { ReadQueryResult } from './types';

/** "1,000" style number formatting (stable across locales). */
export function num(n: number): string {
	return n.toLocaleString('en-US');
}

/**
 * Which limit the node applied, in words, or null when the result is whole.
 *
 * @param result - A `read_query` envelope.
 * @returns A sentence, or null when nothing was cut.
 */
export function truncationText(result: Pick<ReadQueryResult, 'truncated' | 'truncated_by' | 'row_limit' | 'element_limit' | 'value_limit'>): string | null {
	if (!result.truncated) return null;
	switch (result.truncated_by) {
		case 'elements':
			return `Stopped at ${num(result.element_limit)} graph elements in one response; the query returned more. Narrow the query, or limit what collect() gathers.`;
		case 'values':
			return `Stopped at ${num(result.value_limit)} values in one response; the query returned more. Select fewer or smaller properties.`;
		case 'rows':
		default:
			return `Limit reached at ${num(result.row_limit)} rows, more rows may exist.`;
	}
}

/**
 * The result's one-line meta text.
 *
 * Distinguishes a result that hit the limit EXACTLY (nothing more matched) from
 * one that was cut: only the second says more may exist.
 *
 * @param result - A `read_query` envelope.
 * @param elapsedMs - Round-trip time, when known.
 * @returns Text such as `3 rows returned (limit 1,000) · 0.4 s round trip`.
 */
export function rowsMeta(result: Pick<ReadQueryResult, 'rows' | 'row_limit' | 'truncated'>, elapsedMs?: number): string {
	const n = result.rows.length;
	const noun = n === 1 ? 'row' : 'rows';
	const exact = !result.truncated && n === result.row_limit;
	const base = exact ? `${num(n)} ${noun} returned (limit ${num(result.row_limit)} reached; nothing more matched)` : `${num(n)} ${noun} returned (limit ${num(result.row_limit)})`;
	return elapsedMs === undefined ? base : `${base} · ${(elapsedMs / 1000).toFixed(1)} s round trip`;
}

/**
 * The line under a result: the affected count first when the write console reported one, then {@link rowsMeta}.
 *
 * @param run - The run shown (its outcome, affected count and round trip).
 * @param result - Its answer.
 * @returns Text such as `3 affected · 0 rows returned (limit 25,000) · 0.4 s round trip`.
 */
export function resultMeta(run: { outcome: string; affected?: number; ms?: number } | null, result: Pick<ReadQueryResult, 'rows' | 'row_limit' | 'truncated'>): string {
	const rows = rowsMeta(result, run?.ms);
	return run?.outcome === 'affected' ? `${num(run.affected ?? 0)} affected · ${rows}` : rows;
}

/**
 * What the canvas budget hid, or null when everything that arrived is drawn.
 *
 * @param model - The canvas model.
 * @returns A sentence about the graph view only; the Table is unaffected.
 */
export function canvasBudgetText(model: Pick<IGraphModel, 'nodes' | 'resultNodes' | 'hiddenNodes' | 'hiddenRelationships' | 'resultRelationships'>): string | null {
	const parts: string[] = [];
	if (model.hiddenNodes > 0) {
		const limit = model.nodes.size >= MAX_NODES ? `canvas maximum ${num(MAX_NODES)}` : `first draw ${num(INITIAL_NODES)}`;
		parts.push(`The graph shows ${num(model.nodes.size)} of the ${num(model.resultNodes)} nodes in this result (${limit}).`);
	}
	if (model.hiddenRelationships > 0) {
		parts.push(`${num(model.hiddenRelationships)} of the ${num(model.resultRelationships)} relationships in this result are not drawn: a budget was reached or an end node was not part of the result.`);
	}
	return parts.length === 0 ? null : `${parts.join(' ')} The Table lists every returned row.`;
}

/**
 * What an expansion did, for the live region and the status line.
 *
 * An expansion leaves the relationships already drawn out of its request, so "expand again" asks for the next ones.
 * The one case where it cannot help is an answer the node cut that held nothing new (`stuckAt`): repeating the same
 * request returns the same rows, so the sentence says that instead.
 *
 * @param added - New neighbours drawn.
 * @param skipped - New neighbours left out by a cap.
 * @param incomplete - True when the node answered with more rows than were used (more neighbours exist).
 * @param budget - The canvas budget that stopped it, if any.
 * @param stuckAt - The node's row limit, when its cut answer held nothing new; otherwise null.
 * @returns A sentence.
 */
export function expandText(added: number, skipped: number, incomplete: boolean, budget: null | 'nodes' | 'relationships', stuckAt: number | null = null): string {
	if (stuckAt !== null && added === 0 && skipped === 0 && budget === null) {
		return `No new neighbours: the node stops at ${num(stuckAt)} rows and every row it returned is already drawn, so expanding again returns the same rows. Write a query by hand to see its other relationships.`;
	}
	if (added === 0 && skipped === 0 && !incomplete) return 'No new neighbours.';
	const head = `Added ${num(added)} ${added === 1 ? 'neighbour' : 'neighbours'}.`;
	if (budget === 'nodes') return `${head} The canvas holds its maximum of ${num(MAX_NODES)} nodes; dismiss some to make room.`;
	if (budget === 'relationships') return `${head} The canvas holds its maximum relationships; dismiss some to make room.`;
	if (skipped > 0) return `${head} ${num(skipped)} more were left out (at most 100 new neighbours per expansion); expand again to see more.`;
	if (incomplete) return `${head} This node has more relationships than were fetched; expand again for more.`;
	return head;
}

/**
 * What Connect did. An answer the node cut (`truncated`, or as many rows as were asked for) never claims that nothing
 * more exists: asking again returns the same rows, so the remedy is to connect fewer nodes.
 *
 * @param added - Relationships newly drawn.
 * @param budget - The canvas budget that stopped it, if any.
 * @param cut - True when the node returned only part of what matched.
 * @param rowLimit - The row limit the node applied.
 * @returns A sentence.
 */
export function connectText(added: number, budget: null | 'nodes' | 'relationships', cut: boolean, rowLimit: number): string {
	if (budget === 'relationships') return `Added ${num(added)} relationships; the canvas holds its maximum of ${num(MAX_RELATIONSHIPS)}.`;
	const head = `Added ${num(added)} ${added === 1 ? 'relationship' : 'relationships'} among the nodes on the canvas`;
	if (cut) return `${added === 0 ? 'No new relationships were drawn' : head}, but the node stopped at ${num(rowLimit)} rows, so more relationships among the nodes on the canvas may exist. Connect asks for the same rows again; dismiss some nodes and connect fewer at a time to see others.`;
	return added === 0 ? 'No further relationships among the nodes on the canvas.' : `${head}.`;
}

/**
 * The announcement for a fresh result.
 *
 * @param rows - Rows returned.
 * @param nodes - Distinct nodes found.
 * @param relationships - Distinct relationships found.
 * @param truncated - The node's truncation sentence, if any.
 * @returns A sentence for the live region.
 */
export function resultAnnouncement(rows: number, nodes: number, relationships: number, truncated: string | null): string {
	const shape = nodes > 0 ? `${num(nodes)} ${nodes === 1 ? 'node' : 'nodes'} and ${num(relationships)} ${relationships === 1 ? 'relationship' : 'relationships'}` : '';
	const base = `${num(rows)} ${rows === 1 ? 'row' : 'rows'} returned${shape ? `, ${shape}` : ''}.`;
	return truncated ? `${base} ${truncated}` : base;
}

/** The sentence under a Stop-waiting action: it stops the app, not the database. */
export const STOP_WAITING_NOTE = 'Stop waiting stops this app from waiting; the query may still be running on the database, and it cannot be cancelled from here.';

/** Shown instead of Graph when the layout could not run and the grid was used. */
export const GRID_NOTICE = 'The layout worker could not run, so nodes are placed on a grid. The Table lists every returned row.';

/** Said when no dev-tool controller (the Graph Explorer sidebar) is up to carry a document's calls. */
export const CONTROLLER_NOT_READY_TEXT = 'Open the Graph Explorer sidebar to connect: this document reaches the server through it.';

/** Shown when copying is blocked (some editor panels, such as VS Code's, do not allow the clipboard): the text is offered to select instead. */
export const COPY_BLOCKED_NOTE = 'Copying is not allowed in this window. The text is below: select it and copy it with Ctrl+C (Cmd+C on a Mac).';

/** The upgrade message for a node without `read_query`: never a fallback to another tool. */
export const UPGRADE_READ_QUERY = 'This node does not support read_query yet. Upgrade the node to browse with Graph Explorer; the app never falls back to execute for reads.';

/** The upgrade message for a node that cannot refresh its schema. The stored snapshot stays on screen. */
export const UPGRADE_REFRESH_SCHEMA = 'This node cannot refresh its schema yet, so the snapshot taken when its pipeline started is shown. Upgrade the node for a schema you can refresh.';

/** The upgrade message for a node that does not answer Ask (get_query). */
export const UPGRADE_GET_QUERY = 'This node cannot turn a question into Cypher yet. Upgrade the node to use Ask; writing Cypher by hand works without it.';

/** The upgrade message for a node that cannot run the write console (execute with the graph shape). */
export const UPGRADE_EXECUTE = 'This node does not support execute with the graph result shape yet. Upgrade the node to use the write console.';

/**
 * The upgrade message for a tool a node does not have.
 *
 * @param tool - The tool name ('' when unknown).
 * @returns The wording; read_query's never suggests a fallback.
 */
export function upgradeText(tool: string): string {
	switch (tool) {
		case 'refresh_schema':
			return UPGRADE_REFRESH_SCHEMA;
		case 'get_query':
			return UPGRADE_GET_QUERY;
		case 'execute':
			return UPGRADE_EXECUTE;
		case 'read_query':
		case '':
			return UPGRADE_READ_QUERY;
		default:
			return `This node does not support ${tool} yet. Upgrade the node to use this part of Graph Explorer.`;
	}
}

/** The unavailable state for Ask when the pipeline has no LLM. */
export const ASK_UNAVAILABLE = 'Asking questions needs a language model in the pipeline, and this one has none. Browsing with Cypher works without it.';
