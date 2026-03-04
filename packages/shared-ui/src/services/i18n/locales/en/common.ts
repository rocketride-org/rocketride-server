// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Type definition for the "common" translation namespace.
 * Describes shared, application-wide translatable strings including navigation labels,
 * authorization prompts, referral copy, context menu items, and help section text.
 */
export interface ITranslationCommon {
	rocketride: string;
	copyright: string;
	logout: string;
	profile: string;
	scanRunning: string;
	actionRunning: string;
	scanFailed: string;
	actionFailed: string;
	scanCompleted: string;
	actionCompleted: string;
	editConfiguration: string;
	browse: string;
	delete: string;
	navigation: {
		home: string;
		sources: string;
		toolchains: string;
		browser: string;
		settings: string;
		system: string;
		usage: string;
	};
	plan: string;
	lastLoaded: string;
	next: string;
	connectWithUs: string;
	runningTasks: string;
	authorization: {
		title: string;
		apiKeyPlaceholder: string;
		apiKeyLabel: string;
		apiKeyRequired: string;
		apiKeySuccess: string;
		submit: string;
		joinWaitlist: string;
		goToUsagePortal: string;
	};
	referral: {
		title: string;
		description: string;
		copied: string;
		copyLink: string;
		youGet1: string;
		youGet2: string;
		youGetDescription: string;
		theyGet1: string;
		theyGet2: string;
		theyGetDescription: string;
		warning: string;
	};
	moreMenu: {
		moreOptions: string;
		open: string;
		duplicate: string;
		selectAll: string;
		delete: string;
		documentation: string;
		ungroup: string;
	};
	errorEmptyName: string;
	errorExistingName: string;
	rename: string;
	dateCreated: string;
	lastEdited: string;
	account: {
		manageApiKeys: string;
		manageProfile: string;
	};
	termsOfService: {
		text: string;
		link: string;
	};
	welcome: string;
	help: {
		help: string;
		documentation: string;
		videoTutorials: string;
		community: string;
		requestFeature: string;
		reportBug: string;
		submitFeedback: string;
	};
	feedback: {
		feedback: string;
	};
	changelog: {
		changelog: string;
	};
	rocketrideClient: {
		connected: string;
		disconnected: string;
	};
}

/** English translations for the "common" namespace covering app-wide shared UI strings. */
export const common: ITranslationCommon = {
	rocketride: 'RocketRide',
	copyright: 'Copyright (c)',
	logout: 'Logout',
	profile: 'Profile',
	scanRunning: 'Scanning is in progress',
	actionRunning: 'Action is in progress',
	scanFailed: 'Scan failed. Try again please.',
	actionFailed: 'Load failed. Try again please.',
	scanCompleted: 'Scan is complete.',
	actionCompleted: 'Load is complete.',
	editConfiguration: 'Edit Configuration',
	browse: 'Browse',
	delete: 'Delete',
	navigation: {
		home: 'Home',
		sources: 'Sources',
		toolchains: 'Projects',
		browser: 'Browser',
		settings: 'Settings',
		system: 'System',
		usage: 'Usage',
	},
	help: {
		help: 'Help',
		documentation: 'Documentation',
		videoTutorials: 'Video Tutorials',
		community: 'Community',
		requestFeature: 'Request Feature',
		reportBug: 'Report Bug',
		submitFeedback: 'Submit Feedback',
	},
	plan: 'plan',
	lastLoaded: 'Last Loaded',
	next: 'Next',
	connectWithUs: 'Connect with us',
	runningTasks: 'You have running tasks in this project',
	authorization: {
		title: 'Authorization',
		apiKeyPlaceholder: 'Enter your API key',
		apiKeyLabel: 'API Key',
		apiKeyRequired: 'You need to add an API key to run the pipeline',
		apiKeySuccess: 'API key successfully set',
		submit: 'Submit',
		joinWaitlist: 'Join the waitlist',
		goToUsagePortal: 'Get one on the Usage Portal',
	},
	referral: {
		title: 'Refer a User',
		copied: 'Referral link copied to clipboard!',
		copyLink: 'Copy referral link',
		description:
			'Invite your friend to try the Data Toolchain using your link. Once they sign up you will both get free tokens.',
		youGet1: 'You get',
		youGet2: 'tokens for each referral.',
		youGetDescription: 'For each friend you invite.',
		theyGet1: 'Your friend gets',
		theyGet2: 'tokens.',
		theyGetDescription: 'For the first time.',
		warning:
			'Your friend must use the link above to ensure you and your friend receive your token rewards.',
	},
	moreMenu: {
		moreOptions: 'More option',
		open: 'Open',
		duplicate: 'Duplicate',
		selectAll: 'Select All',
		delete: 'Delete',
		documentation: 'Documentation',
		ungroup: 'Ungroup',
	},
	errorEmptyName: 'Please enter a name',
	errorExistingName: 'Please enter a new name',
	rename: 'Rename',
	dateCreated: 'Created',
	lastEdited: 'Last Edited',
	account: {
		manageApiKeys: 'Manage API Keys',
		manageProfile: 'Manage Profile',
	},
	termsOfService: {
		text: 'By continuing, you agree to our',
		link: 'Terms of Service',
	},
	welcome: 'Welcome to the Data Toolchain!',
	feedback: {
		feedback: 'Feedback',
	},
	changelog: {
		changelog: 'Changelog',
	},
	rocketrideClient: {
		connected: 'RocketRide Client is connected',
		disconnected: 'RocketRide Client is disconnected',
	},
};
