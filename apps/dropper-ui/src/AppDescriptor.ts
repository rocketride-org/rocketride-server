// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AppDescriptor — the one module this app exposes to the RocketRide shell.
 *
 * ONE package, two mounts (plan 3.6): `app` is the browser mode the shell
 * renders after sign-in (bound by `?pipe=<address>`); `devToolFrame` and
 * `devToolSidebar` are the workbench mode a host mounts directly, one
 * document per dropper source address. Declared under the `devTool` manifest
 * category in package.json.
 */

// HMR anchor: keeps the shared jsx runtime referenced even when a save leaves
// the root component with no JSX — that update otherwise disposes it, no later
// update can bring it back, and every later save dies silently (the
// frozen-preview bug). Failed builds are covered by emitOnErrors: false in
// rsbuild.config.mts.
import 'react/jsx-dev-runtime';

import type { AppDescriptor } from 'shell';
import App from './App';
import { DropperDevTool, DropperDevToolSidebar } from './DevTool';

const DROPPER_APP: AppDescriptor = {
	id: 'rocketride.dropper',
	name: 'Dropper',
	branding: { appName: 'Dropper' },
	app: App,
	devToolFrame: DropperDevTool,
	devToolSidebar: DropperDevToolSidebar,
};

export default DROPPER_APP;
