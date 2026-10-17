// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * NewAppWebview — the VS Code New App wizard (page-newapp webview).
 *
 * THIN by design: the entire wizard form lives in shared's
 * `modules/appdev` (NewAppForm). This webview contributes only the
 * transport — identity/error state arrives over useMessaging from
 * NewAppProvider, and the form's create/cancel callbacks ride back the
 * same way. The host owns identity resolution and writes the scaffold in
 * one pass on create.
 *
 * Architecture:
 *   NewAppProvider (Node.js) <-> postMessage <-> NewAppWebview (browser)
 */

import React, { useCallback, useState } from 'react';
// Deep import by design: the wizard page carries the FORM alone — the
// appdev barrel would pull the whole App Builder view layer into this
// otherwise-thin webview bundle.
import { NewAppForm } from 'shared/modules/appdev/NewAppForm';
import type { FrameOptions } from 'shared/modules/appdev/templates';
import { useMessaging } from '../hooks/useMessaging';
import type { NewAppHostToWebview, NewAppIdentity, NewAppWebviewToHost } from '../../types/newAppTypes';

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Bridges the shared NewAppForm onto the extension-host message protocol:
 * inbound init/identityUpdate/error messages become props, the form's
 * callbacks become newapp:create / newapp:cancel messages.
 */
const NewAppWebview: React.FC = () => {
	// ── State ────────────────────────────────────────────────────────────
	/** Live identity from the host; null until newapp:init arrives. */
	const [identity, setIdentity] = useState<NewAppIdentity | null>(null);

	/** True while a create request is in flight. */
	const [creating, setCreating] = useState(false);

	/** Error from a failed create, shown in the form footer. */
	const [error, setError] = useState<string | null>(null);

	// ── Incoming messages ────────────────────────────────────────────────
	const handleMessage = useCallback((message: NewAppHostToWebview) => {
		switch (message.type) {
			case 'newapp:init':
			case 'newapp:identityUpdate':
				setIdentity(message.identity);
				break;

			case 'newapp:error':
				// Create failed — surface the error and re-enable the form
				setError(message.error);
				setCreating(false);
				break;
		}
	}, []);

	const { sendMessage } = useMessaging<NewAppWebviewToHost, NewAppHostToWebview>({ onMessage: handleMessage });

	// ── Callbacks ────────────────────────────────────────────────────────

	/** Sends the create request and locks the form until the host answers. */
	const handleCreate = useCallback(
		(appName: string, displayName: string, frame: FrameOptions) => {
			setError(null);
			setCreating(true);
			sendMessage({ type: 'newapp:create', appName, displayName, frame });
		},
		[sendMessage],
	);

	/** Asks the host to close the wizard without creating anything. */
	const handleCancel = useCallback(() => {
		sendMessage({ type: 'newapp:cancel' });
	}, [sendMessage]);

	// ── Render ───────────────────────────────────────────────────────────

	if (!identity) return null;

	return <NewAppForm identity={identity} creating={creating} error={error} onCreate={handleCreate} onCancel={handleCancel} />;
};

export default NewAppWebview;
