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
// TEST SUPPORT: the workbench's Documents and Trash tabs and its pending bar, rendered statically
// =============================================================================
//
// A connection entry from a fresh registry (no link: nothing can be sent),
// a console model over the pgvector dialect fixture, and the props the
// workbench hands each panel. The listings are whatever the test builds with
// the pager. The components are required lazily, so each test file installs
// its own stand-in for 'shell' first.
// =============================================================================

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IExplorerEndpoint, IRoleChannel } from 'shared/explorer';
import type { IConnectionEntry } from '../../src/adapters/connections';
import type { IDocumentsTabProps, IWorkbenchPanelProps } from '../../src/components/workbenchProps';
import type { Availability, ConsoleActions, ConsoleModel, IDialectResult, IScopeState, VectorChannels } from '../../src/contract/types';
import type { IPagerState } from '../../src/vector/documents';
import { fixture } from './fixtures';

const noop = (): void => undefined;

/** Writing on. */
export const WRITES_ON: Availability = { enabled: true, reason: null };

/** Writing off, as the console says it. */
export const WRITES_OFF: Availability = { enabled: false, reason: 'Removing documents is turned off on this store node (allow_writes).' };

/** An endpoint for the registry. */
export function panelEndpoint(key = 'k-panels'): IExplorerEndpoint {
	return { key, legacyKey: null, projectId: 'vp', pipelineName: 'Vector docs', runKind: 'dev', ownerKind: 'user', ownerId: 'u1', teamId: 't1', roles: { tools: { source: 'tools_1' }, chat: null, ingest: null }, missingRoles: ['chat', 'ingest'], source: 'tools_1', nodeId: 'store_1', nodeName: 'Store', provider: 'postgres', state: 'ready', running: true, components: [], anchorRole: 'tools', readOnly: false } as IExplorerEndpoint;
}

/**
 * A connection's console model over the pgvector dialect fixture.
 *
 * @param over - Fields to change.
 * @returns The model.
 */
export function panelModel(over: Partial<ConsoleModel> = {}): ConsoleModel {
	const dialect = fixture<IDialectResult>('dialect_pgvector');
	const endpoint = panelEndpoint();
	return { connectionKey: endpoint.key, connection: { endpoint, dialect }, nodes: { store: 'store_1', embed: 'embed_1', llm: null, llmName: null }, collection: dialect.collection, stats: null, limits: dialect.limits, capabilities: dialect.capabilities, writes: WRITES_ON, ingest: WRITES_ON, chat: WRITES_ON, embed: WRITES_ON, readOnly: false, ...over };
}

/** A Tools channel that answers nothing (no effect runs in a static render). */
const tools = { invoke: () => new Promise<never>(() => undefined) } as unknown as IRoleChannel;

/** The role channels. */
export const PANEL_CHANNELS: VectorChannels = { tools, chat: null, ingest: null };

/**
 * A fresh connection entry (its own registry; no link).
 *
 * @param key - The endpoint key.
 * @returns The entry.
 */
export function panelEntry(key = 'k-panels'): IConnectionEntry {
	const { createConnectionRegistry } = require('../../src/adapters/connections') as typeof import('../../src/adapters/connections');
	return createConnectionRegistry().entry(panelEndpoint(key), null);
}

/** What a test sets on a panel. */
export interface IPanelOptions {
	entry?: IConnectionEntry;
	model?: ConsoleModel;
	directory?: IPagerState;
	trash?: IPagerState;
	/** stats.deleted_documents. */
	trashCount?: number | null;
	removal?: IWorkbenchPanelProps['console']['removal'];
	/** A pending confirmation. */
	confirm?: IWorkbenchPanelProps['console']['confirm'];
	actions?: Partial<ConsoleActions>;
}

/**
 * The props every panel gets.
 *
 * @param opts - What to set.
 * @returns The props.
 */
export function panelProps(opts: IPanelOptions = {}): IWorkbenchPanelProps {
	const entry = opts.entry ?? panelEntry();
	const base = entry.controller.getState();
	const stats = opts.trashCount === undefined ? base.stats : { ...base.stats, view: { deletedDocuments: opts.trashCount } as IWorkbenchPanelProps['console']['stats']['view'] };
	return {
		entry,
		model: opts.model ?? panelModel(),
		channels: PANEL_CHANNELS,
		actions: { openDocument: noop, showOnMap: noop, requestRemove: noop, askAbout: noop, documentsChanged: noop, announce: noop, ...opts.actions },
		console: { ...base, directory: opts.directory ?? base.directory, trash: opts.trash ?? base.trash, stats, removal: opts.removal ?? base.removal, confirm: opts.confirm ?? base.confirm },
		selection: entry.selection.getState(),
		visible: true,
	};
}

/**
 * The Documents tab's markup.
 *
 * @param opts - What to set, plus its scope and cap.
 * @returns The markup.
 */
export function renderDocumentsTab(opts: IPanelOptions & { scope?: IScopeState | null; cap?: number } = {}): string {
	const { DocumentsTab } = require('../../src/components/DocumentsTab') as typeof import('../../src/components/DocumentsTab');
	const props: IDocumentsTabProps = { ...panelProps(opts), scope: opts.scope ?? null, onScope: noop, cap: opts.cap ?? 2_000, available: {}, saved: [], onSave: () => null, onDeleteSaved: noop, scopeLine: null, health: { flagged: 0, counts: { no_first_chunk: 0, gaps: 0, deleted_chunks: 0, empty_parse: 0, oversize: 0 }, unreported: [], loaded: 0, complete: true } };
	return renderToStaticMarkup(<DocumentsTab {...props} />);
}

/**
 * The Trash tab's markup.
 *
 * @param opts - What to set.
 * @returns The markup.
 */
export function renderTrashTab(opts: IPanelOptions = {}): string {
	const { TrashTab } = require('../../src/components/TrashTab') as typeof import('../../src/components/TrashTab');
	return renderToStaticMarkup(<TrashTab {...panelProps(opts)} />);
}

/**
 * The pending bar's markup.
 *
 * @param opts - What to set.
 * @returns The markup ('' while nothing is staged).
 */
export function renderPendingBar(opts: IPanelOptions = {}): string {
	const { PendingBar } = require('../../src/components/PendingBar') as typeof import('../../src/components/PendingBar');
	return renderToStaticMarkup(<PendingBar {...panelProps(opts)} />);
}
