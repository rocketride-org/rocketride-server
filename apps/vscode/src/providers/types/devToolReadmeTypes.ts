// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Dev-tool details page protocol — shared by DevToolReadmeProvider
 * (extension host) and DevToolReadmeWebview (browser).
 *
 * The page is the modules flow's detail view (VS Code extension-page style):
 * tool identity header, Install/Remove, and the app's README rendered below.
 */

/** The tool identity + readme shown on the details page. */
export interface ReadmeToolInfo {
	id: string;
	name: string;
	version?: string;
	publisher?: string;
	description?: string;
	categories?: string[];
	/** Inlined icon (data: URI) for the header chip. */
	iconDataUri?: string;
	/** The app's README markdown ('' when the manifest carries none). */
	readme: string;
}

/** Messages from the extension host to the webview. */
export type ReadmeHostToWebview =
	| { type: 'readme:init'; payload: { tool: ReadmeToolInfo | null; installed: boolean; connected: boolean } };

/** Messages from the webview to the extension host. */
export type ReadmeWebviewToHost =
	| { type: 'view:ready' }
	| { type: 'readme:install'; appId: string }
	| { type: 'readme:remove'; appId: string };
