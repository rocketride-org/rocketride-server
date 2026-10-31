// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SIDEBAR WIRE VOCABULARY — extension host ↔ sidebar webview
// =============================================================================
//
// Both typed ends of the sidebar's postMessage traffic. The host's
// SidebarProvider switches over `WebviewToHost['type']`; the webview's
// useMessaging is parameterized on both unions — a renamed or mistyped
// message breaks the build instead of a flow.
//
// Namespaces per the wire-name convention: `sidebar:*` (this surface),
// `devtool:*` (tool peer relay), `svc:fs*` (the workspace-FS service RPC).
// Prefs ride the bus (the shell:prefs:<partition> mirror) — no prefs:* wire;
// strip prefs (mode/order/disabled builtins) are plain pref keys.
// =============================================================================


/** The webview's requests to the extension host. */
export type SidebarWebviewToHost =
	| { type: 'view:ready' }
	| { type: 'sidebar:command'; command: string; args?: unknown[] };

/** The extension host pushes NOTHING over postMessage any more — every
 *  host->webview fact rides the bus (retained topics, signals, realm-
 *  registered ops). */
export type SidebarHostToWebview = never;
