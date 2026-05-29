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
import 'shared/themes/global.css';
import { RocketRideClient } from 'rocketride';
// Import directly from local source — NOT from 'shell-ui'. MF intercepts bare
// 'shell-ui' imports and tries to load from the share scope, but this IS the
// host that provides shell-ui, so the factory isn't registered yet → undefined.
import Shell from './components/layout/Shell';
import type { AppManifestEntry } from './workspace/types';
import { buildShellConfig } from './createShellConfig';
import { registerAndMapApps } from './lib/appLoader';

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
	// Read the server URI from the build-time env define
	const serverUri = process.env.ROCKETRIDE_URI || 'localhost:5565';

	// Probe the server for capabilities and public apps (no auth required)
	let capabilities: string[] = [];
	let apps: AppManifestEntry[] = [];
	try {
		const info = await RocketRideClient.getServerInfo(serverUri);
		capabilities = info.capabilities ?? [];
		apps = registerAndMapApps(info.apps ?? []);
	} catch (err) {
		console.error('[bootstrap] Server probe failed:', err);
		// Shell will render with no apps — user can retry after server is up
	}

	// Assemble the shell configuration with server capabilities
	const config = buildShellConfig(apps, capabilities);

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
