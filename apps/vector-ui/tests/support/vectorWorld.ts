// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// TEST SUPPORT: a fake engine with one Vector Explorer project running
// =============================================================================
//
// The shared library's fakeWorld, with the three sources of one project
// (ingest, chat, tools) over a pgvector store node, answering every vector
// tool from the provisional wire fixtures. Tests override single tools.
// =============================================================================

import { fakeWorld, projectRows, vectorComponents } from 'shared/explorer/connect/testing';
import type { IFakeRow, IFakeWorld, IToolCall } from 'shared/explorer/connect/testing';
import { fixture } from './fixtures';

/** A tool's answer in a scripted world: a value, a promise, or a throw. */
export type ToolBehaviour = (call: IToolCall) => unknown;

/**
 * The default answer of each vector tool (a pgvector node that allows writes).
 *
 * @param call - The tool call.
 * @returns Its answer.
 */
export function pgvectorNode(call: IToolCall): unknown {
	switch (call.tool) {
		case 'dialect':
			return fixture('dialect_pgvector');
		case 'stats':
			return call.input?.mode === 'quick' ? fixture('stats_quick') : fixture('stats_pgvector');
		case 'list_documents':
			return call.input?.cursor ? fixture('list_documents_page2_last') : fixture('list_documents_page1');
		case 'chunks':
			return fixture('chunks_page');
		case 'delete':
			return call.input?.deleted_only ? fixture('delete_deleted_only') : fixture('delete_ok');
		case 'soft_delete':
			return fixture('soft_delete_ok');
		case 'restore':
			return fixture('restore_ok');
		case 'embed':
			return fixture('embed_ok');
		default:
			return { success: false, code: 'UNSUPPORTED', error: `no ${call.tool}` };
	}
}

/** The three running sources of one project (ingest, chat and tools) over one store node. */
export function vectorRows(store = 'postgres'): IFakeRow[] {
	return projectRows(['ingest_1', 'chat_1', 'tools_1'], vectorComponents(store));
}

/**
 * A fake engine running one Vector Explorer project.
 *
 * @param over - Per-tool answers that replace the defaults.
 * @param rows - The task rows (default: the three sources over pgvector).
 * @returns The world.
 */
export function vectorWorld(over: Partial<Record<string, ToolBehaviour>> = {}, rows: IFakeRow[] = vectorRows()): IFakeWorld {
	return fakeWorld(rows, (call) => {
		const custom = over[call.tool];
		return custom ? custom(call) : pgvectorNode(call);
	});
}
