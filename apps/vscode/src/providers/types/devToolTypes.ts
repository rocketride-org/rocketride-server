// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Dev-tool panel message protocol — shared by DevToolPanelProvider (extension
 * host) and DevToolWebview (browser).
 *
 * There is no host→webview protocol: the panel's identity is STAMPED into the
 * served HTML (`data-rr-tool` / `data-rr-doc`), and the webview derives
 * connection, engine URL, and its catalog row from the shell:status /
 * shell:account mirror topics of its bus-realm ConnectionManager.
 */

/** Messages from the webview to the extension host. */
export type DevToolWebviewToHost =
	| { type: 'view:ready' }
	// The DevToolProps.documents API: the tool asks for a (new or existing)
	// top-level document of its own, or closes one.
	| { type: 'devtool:openDocument'; docKey: string; title: string }
	| { type: 'devtool:closeDocument'; docKey: string };
