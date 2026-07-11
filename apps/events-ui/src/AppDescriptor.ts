// =============================================================================
// EVENTS-UI — App Descriptor
// =============================================================================

import React from 'react';
import type { AppDescriptor } from 'shell-ui';
import EventsApp from './EventsApp';
import EventsSidebar from './EventsSidebar';
import RocketRideMark from './RocketRideMark';

const EVENTS_APP: AppDescriptor = {
	id: 'rocketride.events',
	name: 'Event Monitor',
	branding: {
		appName: 'Event Monitor',
		iconDark: React.createElement(RocketRideMark, { bodyColor: '#E0DDF0' }),
		iconLight: React.createElement(RocketRideMark, { bodyColor: '#1E1A34' }),
	},
	components: {
		App: EventsApp,
		Sidebar: EventsSidebar,
	},
};

export default EVENTS_APP;
