// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Monitor host/webview protocol — the message contract between
 * MonitorProvider (extension host) and the server-monitor webview. Composes
 * the shell base (shellTypes.ts) beside the dashboard + grid-layout channel.
 *
 * Pure types only — imported by both the extension host and the webview.
 */

import type { DashboardResponse } from 'rocketride';
import type { ShellHostToWebview, ShellWebviewToHost } from './shellTypes';

/** All messages the extension host can send to the MonitorWebview. */
export type MonitorHostToWebview =
	| ShellHostToWebview
	| { type: 'monitor:dashboard'; data: DashboardResponse }
	// Grid config channel seed: the stored per-table layout map (tableId ->
	// { persistence type -> blob }) from the extension's workspaceState, sent
	// with the view:ready reply BEFORE the first dashboard snapshot so the
	// webview bridge cache is primed before any grid reads its layout.
	| { type: 'grid:config:init'; layouts: Record<string, Record<string, unknown>> };

/** All messages the MonitorWebview can send to the extension host. */
export type MonitorWebviewToHost =
	| ShellWebviewToHost
	| { type: 'monitor:refresh' }
	// Grid config channel writes: persist / drop one table's layout blobs in
	// the extension's workspaceState (blobType is the Tabulator persistence
	// type — 'sort' | 'columns' | 'page' | the RR-private 'display'/'format').
	| { type: 'grid:config:set'; tableId: string; blobType: string; blob: unknown }
	| { type: 'grid:config:clear'; tableId: string };
