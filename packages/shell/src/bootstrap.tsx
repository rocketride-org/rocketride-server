// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Shell-UI bootstrap — probes the server for capabilities and public apps,
 * registers Module Federation remotes, creates the popup portal container,
 * and renders the shell.
 *
 * All apps are loaded from the server probe (rrext_public_probe) — there are no
 * built-in apps hardcoded here. After authentication, the shell receives the
 * user's full entitled app set via the ConnectResult.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/figtree';
import './themes/global.css';
import { RocketRideClient } from 'rocketride';
// Import directly from local source — NOT from 'shell'. MF intercepts bare
// 'shell' imports and tries to load from the share scope, but this IS the
// host that provides shell, so the factory isn't registered yet → undefined.
import Shell from './components/layout/Shell';
import type { AppManifestEntry } from './components/workspace/types';
import { buildShellConfig } from './createShellConfig';
import { registerAndMapApps } from './util/appLoader';
import { installDevHooks } from './util/devMode';

// =============================================================================
// BOOTSTRAP
// =============================================================================

/**
 * Main bootstrap function.
 *
 * 1. Probes the server for capabilities and public apps (pre-auth).
 * 2. Registers MF remotes and maps apps to runtime entries.
 * 3. Assembles the shell configuration with server capabilities.
 * 4. Creates the popup portal container.
 * 5. Renders the Shell React tree.
 */
async function main() {
	// The server is ALWAYS wherever this page was served from — no address
	// is baked into the bundle (one artifact serves every environment). The
	// dev split-host loop keeps this true via the dev server's proxy.
	const serverUri = window.location.origin;

	// Probe the server for capabilities and public apps (no auth required)
	let capabilities: string[] = [];
	let apps: AppManifestEntry[] = [];
	let stripePublishableKey = '';
	let apiEndpoint = '';
	try {
		const info = await RocketRideClient.getServerInfo(serverUri);
		capabilities = info.capabilities ?? [];
		apps = registerAndMapApps(info.apps ?? []);
		// Stripe publishable key comes from the server (not baked at build
		// time) so one bundle works against test- and live-keyed servers.
		stripePublishableKey = info.stripePublishableKey ?? '';
		// The server says where live traffic goes (already resolved by the
		// SDK — 'origin' became the probed address). Same as the page origin
		// on single-host deployments; a direct API host on split ones, so
		// only this probe transits the serving edge.
		apiEndpoint = info.endpoints.api;
	} catch (err) {
		console.error('[bootstrap] Server probe failed:', err);
		// Shell will render with no apps — user can retry after server is up
	}

	// Install the app-dev hooks (registerLocalApp / __rrShellDev / dev share
	// scope). No-ops entirely unless this is a dev build or the URL carries
	// rrdev=1 — production sessions expose nothing. Fire-and-forget: the
	// hooks signal readiness to embedders themselves via shell:devReady.
	void installDevHooks();

	// Assemble the shell configuration with server capabilities
	const config = buildShellConfig(apps, capabilities, stripePublishableKey, apiEndpoint);

	// Create portal container for popup menus (must exist before React renders)
	if (!document.getElementById('rr-popup-portal')) {
		const portal = document.createElement('div');
		portal.id = 'rr-popup-portal';
		document.body.appendChild(portal);
	}

	// Render the shell
	ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
		<React.StrictMode>
			<Shell config={config} />
		</React.StrictMode>,
	);
}

main();
