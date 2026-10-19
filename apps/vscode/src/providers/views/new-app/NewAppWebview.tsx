// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * NewAppWebview — the New App wizard as a shell bus realm (page-frame page).
 *
 * THIN by design: the entire wizard form lives in shared's appdev module
 * (NewAppForm). This page contributes only the host seams: identity via
 * `host.appdev.identity` (+ the `identityChanged` push — the wizard is
 * modeless, a login while it sits open changes the linkage name), the
 * one-pass scaffold via `host.appdev.scaffold` (its resolution closes the
 * page; a rejection re-enables the form with the validation message), and
 * Cancel via `host.closePage`.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ConnectionManager } from 'shell';
// Deep import by design: the wizard page carries the FORM alone — the
// appdev barrel would pull the whole App Builder view layer into the bundle.
import { NewAppForm } from 'shared/tools/appdev/views/new-app/NewAppForm';
import type { NewAppIdentity } from 'shared/tools/appdev/types';
import type { FrameOptions } from 'shared/tools/appdev/templates';

// =============================================================================
// COMPONENT
// =============================================================================

const NewAppWebview: React.FC = () => {
	const cm = ConnectionManager.getInstance();

	/** Live identity from the host; null until the first pull answers. */
	const [identity, setIdentity] = useState<NewAppIdentity | null>(null);

	/** True while a scaffold request is in flight (locks the form). */
	const [creating, setCreating] = useState(false);

	/** Error from a failed create, shown in the form footer. */
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void cm.request('host.appdev.identity', {} as never).then(
			(r) => setIdentity(r as NewAppIdentity),
			() => {}
		);
		return cm.handle('host.appdev.identityChanged', (p) => setIdentity(p as NewAppIdentity));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/** One scaffold pass; success retires the page (the scaffold already
	 *  opened the App Builder), a rejection re-enables the form. */
	const handleCreate = useCallback(
		(appName: string, displayName: string, frame: FrameOptions) => {
			setError(null);
			setCreating(true);
			cm.request('host.appdev.scaffold', { appName, displayName, frame } as never).then(
				() => cm.emitOp('host.closePage', { page: 'newapp' }),
				(err: unknown) => {
					setError(err instanceof Error ? err.message : String(err));
					setCreating(false);
				}
			);
		},
		[cm]
	);

	/** Close the wizard without creating anything. */
	const handleCancel = useCallback(() => {
		cm.emitOp('host.closePage', { page: 'newapp' });
	}, [cm]);

	if (!identity) return null;

	return <NewAppForm identity={identity} creating={creating} error={error} onCreate={handleCreate} onCancel={handleCancel} />;
};

export default NewAppWebview;
