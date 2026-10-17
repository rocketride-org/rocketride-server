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
// Deep .ts import (never the barrel — it drags the .tsx view layer into
// the jsx-less extension-host program).
import type { NewAppIdentity } from 'shared/modules/appdev/types';

// =============================================================================
// NEW APP WIZARD PROTOCOL
// =============================================================================

// The identity snapshot itself is the shared type — the extension host
// pushes it on init and whenever the connection/account changes, so the
// wizard's developer id chip and linkage name always reflect the live
// connection.
export type { NewAppIdentity } from 'shared/modules/appdev/types';

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
