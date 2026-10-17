// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Dev-tool panel message protocol — shared by DevToolPanelProvider (extension
 * host) and DevToolWebview (browser).
 *
 * The webview is a Module Federation host: it connects its own SDK client
 * with the credential below, registers the tool's remote at the engine's
 * versioned entry URL, loads the AppDescriptor, and mounts `devToolFrame`.
 */

/** The tool identity and connection facts the webview needs to mount it. */
export interface DevToolInitPayload {
	/** The host-document key this panel serves (per-document tools — e.g.
	    one panel per database connection); '' for the tool's single frame. */
	docKey: string;
	/** Engine base URL ('' when disconnected). */
	engineHttpUrl: string;
	/** Session credential for the webview's own SDK connection ('' = none). */
	authToken: string;
	/** Whether the extension currently holds a server connection. */
	connected: boolean;
	/** The tool to mount. */
	app: {
		id: string;
		moduleId: string;
		name: string;
		/** Registry version resolving the remote entry URL. */
		registryVersion: number;
	} | null;
}

/** Messages from the extension host to the webview. */
export type DevToolHostToWebview =
	| { type: 'devtool:init'; payload: DevToolInitPayload }
	| { type: 'devtool:peer'; payload: unknown };

/** Messages from the webview to the extension host. */
export type DevToolWebviewToHost =
	| { type: 'view:ready' }
	| { type: 'devtool:peer'; payload: unknown }
	// The DevToolProps.documents API: the tool asks for a (new or existing)
	// top-level document of its own, or closes one.
	| { type: 'devtool:openDocument'; docKey: string; title: string }
	| { type: 'devtool:closeDocument'; docKey: string };
