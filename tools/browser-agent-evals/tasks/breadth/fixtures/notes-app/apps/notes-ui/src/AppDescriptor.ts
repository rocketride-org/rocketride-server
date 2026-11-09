// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AppDescriptor — the one module this app exposes to the RocketRide shell.
 * The shell lazy-loads it on activation and renders `app` raw; the app
 * declares its layout inside with <AppLayout>.
 */

// HMR anchor: keeps the shared jsx runtime referenced even when a save leaves
// the root component with no JSX — that update otherwise disposes it, no later
// update can bring it back, and every later save dies silently (the
// frozen-preview bug). Failed builds are covered by emitOnErrors: false in
// rsbuild.config.mts.
import 'react/jsx-dev-runtime';

import type { AppDescriptor } from 'shell';
import App from './App';

const descriptor: AppDescriptor = {
	id: 'local.notes',
	name: 'Notes',
	branding: { appName: 'Notes' },
	app: App,
};

export default descriptor;
