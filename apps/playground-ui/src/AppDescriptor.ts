// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AppDescriptor — the one module this app exposes to the RocketRide shell.
 *
 * ONE package, two ways in: `app` is the browser mode the shell renders
 * after sign-in (bound by `?pipe=<address>`, the host app of every agent
 * tile); `devToolFrame` and `devToolSidebar` are the workbench mode Rocket
 * Builder and VS Code mount directly — a tab per agent, the connections tree
 * in the tool sidebar. Declared under the `devTool` manifest category in
 * package.json.
 */

import 'react/jsx-dev-runtime';
import type { AppDescriptor } from 'shell';
import App from './App';
import { PlaygroundDevTool, PlaygroundDevToolSidebar } from './DevTool';

const PLAYGROUND_APP: AppDescriptor = {
	id: 'playground',
	name: 'Playground',
	branding: { appName: 'Playground' },
	app: App,
	devToolFrame: PlaygroundDevTool,
	devToolSidebar: PlaygroundDevToolSidebar,
};

export default PLAYGROUND_APP;
