// MIT License
//
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
// NEW APP PROVIDER — the web New App wizard (the `newapp` document)
// =============================================================================

/**
 * The web host around the shared NewAppForm: identity comes straight from
 * the live client (developer id from the organization profile, collision
 * list from the .appdev scan), and Create scaffolds the shared template set
 * into the store VFS in one pass — then closes the wizard and opens the new
 * app's App Builder document.
 *
 * Web twin of the VSCode NewAppProvider (which scaffolds into the native
 * workspace over the message bridge).
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useShellConnection } from 'shell';
// Deep import matching the VSCode wizard page: the form alone, never the
// whole appdev view layer.
import { NewAppForm } from 'shared/modules/appdev/NewAppForm';
import type { FrameOptions, NewAppIdentity } from 'shared/modules/appdev';
import { getDocs } from '../docs';
import { APPDEV_DIR, listAppFolders, scaffoldApp } from '../appdev/appStore';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	root: {
		flex: 1,
		minHeight: 0,
		minWidth: 0,
		display: 'flex',
		flexDirection: 'column',
	},
	loading: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
	},
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Feeds the shared NewAppForm from the live connection and runs the
 * scaffold against the store VFS on create.
 */
const NewAppProvider: React.FC = () => {
	const { client, isConnected } = useShellConnection();

	// ── Identity — live from the client + the .appdev scan ───────────────
	const [identity, setIdentity] = useState<NewAppIdentity | null>(null);
	useEffect(() => {
		if (!client || !isConnected) {
			// Disconnected: the form renders with its no-target note.
			setIdentity({ developerId: 'local', source: 'default', workspaceOpen: false, existingFolders: [] });
			return;
		}
		let cancelled = false;
		void listAppFolders().then((folders) => {
			if (cancelled) return;
			const developerId = client.getAccountInfo()?.organization?.developerId ?? undefined;
			setIdentity({
				developerId: developerId || 'local',
				source: developerId ? 'organization' : 'default',
				workspaceOpen: true,
				existingFolders: folders,
			});
		});
		return () => {
			cancelled = true;
		};
	}, [client, isConnected]);

	// ── Create ───────────────────────────────────────────────────────────
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/** Scaffolds the app, then swaps this wizard doc for the app document. */
	const handleCreate = useCallback(
		async (appName: string, displayName: string, frame: FrameOptions) => {
			if (!client || !identity) return;
			setError(null);
			setCreating(true);
			try {
				const { appId } = await scaffoldApp({
					appName,
					displayName,
					publisher: identity.developerId || 'local',
					frame,
				});
				// The sidebar re-scans off the scaffold's own onFsChange bus
				// notifications (emitFsChange inside scaffoldApp) — no extra
				// announcement needed here.
				// step: close the wizard and open the new app's builder
				const docs = getDocs();
				docs?.discardDocument('newapp');
				docs?.openStaticDocument(`app:${appId}`, displayName);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				setCreating(false);
			}
		},
		[client, identity],
	);

	/** Closes the wizard without creating anything. */
	const handleCancel = useCallback(() => {
		getDocs()?.discardDocument('newapp');
	}, []);

	// ── Render ───────────────────────────────────────────────────────────
	if (!identity) return <div style={styles.root}><div style={styles.loading}>Loading&hellip;</div></div>;

	return (
		<div style={styles.root}>
			<NewAppForm identity={identity} creating={creating} error={error} locationPrefix={`${APPDEV_DIR}/`} noWorkspaceNote="Connect to a server first — the app is scaffolded into your store." onCreate={(appName, displayName, frame) => void handleCreate(appName, displayName, frame)} onCancel={handleCancel} />
		</div>
	);
};

export default NewAppProvider;
