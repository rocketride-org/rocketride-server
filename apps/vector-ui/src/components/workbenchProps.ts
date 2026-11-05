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
// VECTOR-UI - THE WORKBENCH'S PANEL PROPS (types only)
// =============================================================================
//
// What the console (views/ConsoleView.tsx, the workbench) hands each of its
// tab panels. The console keeps the connection's wiring (the scope and its
// resolution, the chat's scope, saved filters, health) and passes the
// results down; a panel renders and calls the entry's controller or the
// console's actions. A panel is mounted the first time its tab shows and
// stays mounted, so `visible` says whether it is the one in front (and the
// console's document is too).
// =============================================================================

import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import type { IConnectionEntry } from '../adapters/connections';
import type { Availability, ConsoleActions, ConsoleModel, IDocumentsFilter, IScopeState, ISavedFilter, SelectionState, VectorChannels } from '../contract/types';
import type { IConsoleState } from '../vector/consoleStore';
import type { ConditionKind } from '../vector/filters';
import type { IHealthSummary } from '../vector/health';

/** What every tab panel of the workbench gets. */
export interface IWorkbenchPanelProps {
	/** The connection's objects (controller, selection store, tab, query mode, staged documents, fields). */
	entry: IConnectionEntry;
	model: ConsoleModel;
	channels: VectorChannels;
	actions: ConsoleActions;
	/** The controller's snapshot. */
	console: IConsoleState;
	/** The selection's snapshot. */
	selection: SelectionState;
	/** True while this panel's tab is the one shown and the console's document is in front. */
	visible: boolean;
}

/** The Documents tab. */
export interface IDocumentsTabProps extends IWorkbenchPanelProps {
	/** The connection's scope (ConsoleModel.scope), or null with no condition. */
	scope: IScopeState | null;
	/** The scope changed (null: no condition left). */
	onScope(next: IScopeState | null): void;
	/** `limits.scope_keys_max`. */
	cap: number;
	/** Whether each kind of condition can be offered on this store. */
	available: Partial<Record<ConditionKind, Availability>>;
	/** This connection's saved filters, and saving and deleting them. */
	saved: readonly ISavedFilter[];
	/** Save a filter: null when saved, else why not. */
	onSave(name: string, filter: IDocumentsFilter): string | null;
	onDeleteSaved(id: string): void;
	/** What the scope covers, while one applies (vector/filters.ts scopeStripText), or null. */
	scopeLine: string | null;
	/** The loaded documents' health. */
	health: IHealthSummary;
}

/** The Query tab. */
export interface IQueryTabProps extends IWorkbenchPanelProps {
	/** The model with the scope as it applies to search and the chat (vector/consoleModel.ts consoleScope). */
	surfaceModel: ConsoleModel;
	/** The documents the next chat question is restricted to, or null. */
	chatDocuments: readonly string[] | null;
	/** Why the chat's question goes to every document while a scope is on, or null. */
	chatNotice: string | null;
	/** Clear the chat's restriction ("Ask about these" first, else the scope's Chat toggle). */
	onClearChatScope(): void;
}

/** The Collection tab. */
export interface ICollectionPanelProps extends IWorkbenchPanelProps {
	/** The live endpoint. */
	endpoint: IExplorerEndpoint;
	/** Its probe (the `dialect` answer), when one exists. */
	probe: IProbeResult | undefined;
}
