// =============================================================================
// TEST-UI — App Descriptor
// =============================================================================

// HMR anchor: keeps the shared jsx runtime referenced even when the app's
// root component fails to compile — an error build otherwise orphans it, the
// hot runtime tombstones its factory, and every later fix-apply dies
// silently (the frozen-preview bug).
import 'react/jsx-dev-runtime';

import type { AppDescriptor } from 'shell';
import TestApp from './TestApp';

const TEST_APP: AppDescriptor = {
	id: 'rocketride.test',
	name: 'Test UI',
	branding: {
		appName: 'Test UI',
		// NO iconDark/iconLight here: branding icons OUTRANK the manifest icon
		// by contract, and the RocketRideMark entries this block used to carry
		// (wordmark-header era) masked the app's real icon on the rail and
		// panel header. Absent, the shell falls through to the manifest icon.
	},
	// Two-column app: TestApp's root AppLayout declares the connections/views
	// sidebar and the status bar.
	app: TestApp,
};

export default TEST_APP;
