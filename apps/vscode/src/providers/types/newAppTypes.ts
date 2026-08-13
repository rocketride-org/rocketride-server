// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * New App wizard webview message protocol types.
 *
 * Separated from `types.ts` (like environmentTypes.ts) so the extension host
 * can import these without pulling in webview-only modules. FrameOptions is
 * imported from the shared templates module, which is host-safe by design
 * (it must stay free of vscode imports).
 */

import type { FrameOptions } from 'shared/modules/appdev/templates';

// =============================================================================
// NEW APP WIZARD PROTOCOL
// =============================================================================

/**
 * Identity state sent from the extension host to the New App wizard.
 * Pushed on init and whenever the connection/account changes, so the wizard's
 * developer id chip and linkage name always reflect the live connection.
 */
export interface NewAppIdentity {
	/** The publisher slug applied to new apps — the org developer id, or 'local' when none. */
	developerId: string;
	/** Where the developer id came from: the organization profile, or the local default. */
	source: 'organization' | 'default';
	/** Whether a workspace folder is open (the scaffold needs a target). */
	workspaceOpen: boolean;
	/** Folder names already under apps/ — used for live collision validation. */
	existingFolders: string[];
}

/** All messages the extension host can send to the NewAppWebview. */
export type NewAppHostToWebview =
	| {
			/** Sent once on view:ready with the live identity state. */
			type: 'newapp:init';
			/** The current identity snapshot. */
			identity: NewAppIdentity;
	  }
	| {
			/** Sent when the connection or account info changes while the wizard is open. */
			type: 'newapp:identityUpdate';
			/** The refreshed identity snapshot. */
			identity: NewAppIdentity;
	  }
	| {
			/** Sent when a create request fails — the wizard re-enables its form. */
			type: 'newapp:error';
			/** Human-readable error description. */
			error: string;
	  };

/** All messages the NewAppWebview can send to the extension host. */
export type NewAppWebviewToHost =
	| {
			/** Webview is mounted and ready to receive initial data. */
			type: 'view:ready';
	  }
	| {
			/**
			 * Request to create the app. The webview sends only the app-name
			 * half — the host resolves the developer id at submit time and
			 * assembles the full app id (never trusting stale form state).
			 */
			type: 'newapp:create';
			/** The app-name slug (the half after the dot in the linkage name). */
			appName: string;
			/** Human-readable display name. */
			displayName: string;
			/** Frame options composing the generated App.tsx. */
			frame: FrameOptions;
	  }
	| {
			/** Request to close the wizard without creating anything. */
			type: 'newapp:cancel';
	  };
