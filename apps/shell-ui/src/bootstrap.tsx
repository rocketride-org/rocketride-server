// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Shell-UI bootstrap — probes the server for capabilities and the home app,
 * registers the home MF remote, creates the popup portal container, and
 * renders the shell.
 *
 * The probe returns the home app manifest entry (SaaS: rocketride.home,
 * OSS: rocketride.hello) so the shell can register its MF remote and use
 * it as the default landing page. No full catalog fetch is needed.
 *
 * Desktop apps are fetched after auth via DesktopAppsContext. The store
 * catalog is fetched on demand when the user browses the app store.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/figtree';
import 'shared/themes/global.css';
import { RocketRideClient } from 'rocketride';
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
 * 1. Probes the server for capabilities and the home app entry.
 * 2. Registers the home app as an MF remote.
 * 3. Assembles the shell configuration.
 * 4. Creates the popup portal container.
 * 5. Renders the Shell React tree.
 */
async function main() {
	const serverUri = process.env.ROCKETRIDE_URI || 'localhost:5565';

	// Probe for server capabilities and the home app (lightweight, single call)
	let capabilities: string[] = [];
	let apps: AppManifestEntry[] = [];
	try {
		const info = await RocketRideClient.getServerInfo(serverUri);
		capabilities = info.capabilities ?? [];

		// Register the home app as an MF remote if the probe returned one
		const homeApp = (info as Record<string, unknown>).home as Record<string, unknown> | undefined;
		if (homeApp?.entry && homeApp?.id) {
			apps = registerAndMapApps([homeApp as unknown as AppManifestEntry]);
		}
	} catch (err) {
		console.error('[bootstrap] Server probe FAILED:', err);
	}

	// Assemble shell config with the home app and capabilities
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
