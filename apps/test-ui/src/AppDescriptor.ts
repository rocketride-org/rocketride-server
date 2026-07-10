// =============================================================================
// TEST-UI — App Descriptor
// =============================================================================

import React from 'react';
import type { AppDescriptor } from 'shell-ui';
import TestApp from './TestApp';
import TestSidebar from './TestSidebar';
import { RocketRideMark } from 'shared';

const TEST_APP: AppDescriptor = {
	id: 'rocketride.test',
	name: 'Test UI',
	branding: {
		appName: 'Test UI',
		// style fills the shell's sized icon wrapper (the shared mark defaults to a
		// fixed 24px; width/height:100% preserves the prior fill-to-slot behaviour).
		iconDark: React.createElement(RocketRideMark, { bodyColor: '#E0DDF0', style: { width: '100%', height: '100%' } }),
		iconLight: React.createElement(RocketRideMark, { bodyColor: '#1E1A34', style: { width: '100%', height: '100%' } }),
	},
	components: {
		App: TestApp,
		Sidebar: TestSidebar,
	},
};

export default TEST_APP;
