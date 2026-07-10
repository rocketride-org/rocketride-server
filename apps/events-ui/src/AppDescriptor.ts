// =============================================================================
// EVENTS-UI — App Descriptor
// =============================================================================

import React from 'react';
import type { AppDescriptor } from 'shell-ui';
import EventsApp from './EventsApp';
import EventsSidebar from './EventsSidebar';
import { RocketRideMark } from 'shared';

const EVENTS_APP: AppDescriptor = {
	id: 'rocketride.events',
	name: 'Event Monitor',
	branding: {
		appName: 'Event Monitor',
		// style fills the shell's sized icon wrapper (the shared mark defaults to a
		// fixed 24px; width/height:100% preserves the prior fill-to-slot behaviour).
		iconDark: React.createElement(RocketRideMark, { bodyColor: '#E0DDF0', style: { width: '100%', height: '100%' } }),
		iconLight: React.createElement(RocketRideMark, { bodyColor: '#1E1A34', style: { width: '100%', height: '100%' } }),
	},
	components: {
		App: EventsApp,
		Sidebar: EventsSidebar,
	},
};

export default EVENTS_APP;
