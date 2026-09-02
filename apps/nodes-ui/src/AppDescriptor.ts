// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React from 'react';
import type { AppDescriptor } from 'shell';
import { RocketRideMark } from 'shell';
import NodesApp from './NodesApp';

/**
 * AppDescriptor for the Node Catalog app.
 *
 * The storefront for nodes the community publishes: browse what is available,
 * see who wrote it and what it costs, and install one into your own workspace,
 * where the engine picks it up on the next run.
 */
const NODES_APP: AppDescriptor = {
	id: 'rocketride.nodes',
	name: 'Node Catalog',
	branding: {
		appName: 'Node Catalog',
		// Fills the shell's sized icon wrapper, as the other apps do.
		iconDark: React.createElement(RocketRideMark, { bodyColor: '#E0DDF0', style: { width: '100%', height: '100%' } }),
		iconLight: React.createElement(RocketRideMark, { bodyColor: '#1E1A34', style: { width: '100%', height: '100%' } }),
	},
	app: NodesApp,
};

export default NODES_APP;
