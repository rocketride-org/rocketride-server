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
 * Type definition for the "onboarding-tour" translation namespace.
 * Describes translatable strings for the guided onboarding tour shown to new users,
 * including home page steps, canvas steps, and the "work with nodes" walkthrough.
 */
export interface ITranslationOnboardingTour {
	buttons: {
		skip: string;
		next: string;
		gotIt: string;
	};
	home: {
		step1: {
			title: string;
			content: string;
		};
		step2: {
			title: string;
			content: string;
		};
		step3: {
			title: string;
			content: string;
		};
	};
	canvas: {
		step1: {
			title: string;
			content: {
				part1: string;
				part2: string;
				part3: string;
			};
		};
		step2: {
			title: string;
			content: string;
		};
	};
	workWithNodes: {
		title: string;
		step1: string;
		step2: string;
		step3: string;
		step4: string;
		stepCounter: string;
		button: string;
	};
}

/** English translations for the "onboarding-tour" namespace covering the new-user guided tour. */
export const onboardingTour: ITranslationOnboardingTour = {
	buttons: {
		skip: 'Skip',
		next: 'Next',
		gotIt: 'Got it',
	},
	home: {
		step1: {
			title: 'Create your first project',
			content:
				'Click "New Project" to get started. You can begin from a blank canvas or use a predefined template.',
		},
		step2: {
			title: 'Track your progress',
			content:
				"See how many projects you've created, what's running, and how much data has been processed.",
		},
		step3: {
			title: 'Connect with the community',
			content:
				'Join our Discord community to get help, connect with our team, and discover new ways to use the Data Toolchain.',
		},
	},
	canvas: {
		step1: {
			title: 'Build with the toolbar',
			content: {
				part1: 'Click',
				part2: 'to add new nodes and',
				part3: 'to add comments to your project. Also get quick controls for adjusting your view and access shortcuts.',
			},
		},
		step2: {
			title: 'Add Nodes',
			content: 'Browse and select from available nodes to build your data pipeline.',
		},
	},
	workWithNodes: {
		title: 'Work with nodes',
		step1: 'Open a node to configure it',
		step2: 'Access additional options',
		step3: 'Click a connection point to see compatible nodes, or drag to link them together.',
		step4: 'Hit run to execute your pipeline.',
		stepCounter: '3 of 3',
		button: 'Got it',
	},
};
