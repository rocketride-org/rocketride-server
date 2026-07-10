// =============================================================================
// TEST-UI — App Descriptor
// =============================================================================

import React from 'react';
import type { AppDescriptor } from 'shell-ui';
import TestApp from './TestApp';
import TestSidebar from './TestSidebar';
import RocketRideMark from './RocketRideMark';

const TEST_APP: AppDescriptor = {
	id: 'rocketride.test',
	name: 'Test UI',
	branding: {
		appName: 'Test UI',
		iconDark: React.createElement(RocketRideMark, { bodyColor: '#E0DDF0' }),
		iconLight: React.createElement(RocketRideMark, { bodyColor: '#1E1A34' }),
	},
	components: {
		App: TestApp,
		Sidebar: TestSidebar,
	},
};

export default TEST_APP;
