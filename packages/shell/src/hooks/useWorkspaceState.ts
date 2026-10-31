// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * useWorkspaceState — the React view of {@link WorkspaceStore}.
 *
 * All behaviour (load, debounced saves, app switching, settings) lives in the
 * store, which is a plain class so the VS Code extension host can run the same
 * manager. This hook only subscribes and re-renders; it holds no state of its
 * own, which is why there are no save effects here any more — writes are
 * triggered by the mutations themselves rather than by observing React state.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { RocketRideClient } from 'rocketride';
import { WorkspaceStore } from '../workspace/workspaceStore';
import { usePrefsHost } from '../ops/prefsHost';
import { devBootConfig } from '../util/devGate';

/**
 * Manages the workspace persistence lifecycle for the browser shell.
 *
 * @param client        - Live RocketRideClient; null while connecting.
 * @param isConnected   - Whether the WebSocket is currently open.
 * @param defaultAppId  - App to activate if no saved global state exists.
 * @param workspaceDir  - Directory for all persistence files (default ".workspace").
 * @param startupAppId  - Optional override for the active app on first load.
 * @returns State values and mutation callbacks consumed by WorkspaceContext.
 */
export function useWorkspaceState(
	client: RocketRideClient | null,
	isConnected: boolean,
	defaultAppId: string,
	workspaceDir: string = '.workspace',
	startupAppId?: string,
) {
	// ONE store for this host's lifetime. A preview shell seals itself: every
	// partition it writes becomes `preview:<id>`, so editing an app in the App
	// Builder cannot touch the real app's files.
	const store = useMemo(
		() =>
			new WorkspaceStore({
				defaultAppId,
				workspaceDir,
				...(startupAppId !== undefined ? { startupAppId } : {}),
				preview: isDevPreviewShell(),
			}),
		// Identity is deliberately stable for the host's lifetime.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[],
	);

	// The store drives its own load off the connection.
	useEffect(() => {
		store.setConnection(client, isConnected);
	}, [store, client, isConnected]);

	useEffect(() => () => store.dispose(), [store]);

	// This host IS the workspace manager: serve the prefs mirror so every
	// realm (including this page's own tree) reads prefs one way.
	usePrefsHost(store);

	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

	return {
		loaded: snapshot.loaded,
		seeded: snapshot.seeded,
		activeAppId: snapshot.activeAppId,
		prefs: snapshot.prefs,
		appState: snapshot.appState,
		settings: snapshot.settings,
		switchApp: store.switchApp,
		updatePrefs: store.updatePrefs,
		updateAppState: store.updateAppState,
		flushWorkspaceNow: store.flushNow,
		/** Partition-routed (the context resolves the owner from the registry). */
		updateSetting: store.updateSetting,
		/** Loads an owner partition so its settings section joins the merged view. */
		ensurePartition: store.ensurePartition.bind(store),
	};
}

/**
 * Whether THIS document is an App Builder preview page.
 *
 * Read per document, not inherited: the outer shell and the preview iframe
 * answer differently for the SAME app id, which is the only fact that
 * distinguishes them when an app previews itself.
 *
 * @returns True when the page carries the dev-preview marker.
 */
function isDevPreviewShell(): boolean {
	try {
		// Authored preview pages carry the marker as injected config.
		if (devBootConfig()) return true;
		const params = new URLSearchParams(window.location.search);
		return params.get('rrdev') === '1' && !!params.get('appid');
	} catch {
		return false;
	}
}
