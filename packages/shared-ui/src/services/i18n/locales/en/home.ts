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
 * Type definition for the "home" translation namespace.
 * Describes translatable strings for the home / overview page including
 * quick-start tiles, social links, reward prompts, and copyright text.
 */
export interface ITranslationHome {
	title: string;
	sourcesPageButton: string;
	socialsTitle: string;
	rewardsTitle: string;
	tiles: {
		heading: string;
		one: {
			title: string;
			description: string;
		};
		two: {
			title: string;
			description: string;
		};
		three: {
			title: string;
			description: string;
		};
		four: {
			title: string;
			description: string;
		};
	};
	rewards: {
		one: {
			title: string;
			description: string;
			buttonTitle: string;
		};
		two: {
			title: string;
			description: string;
			buttonTitle: string;
		};
		three: {
			title: string;
			description: string;
			buttonTitle: string;
		};
	};
	copyright: string;
}

/** English translations for the "home" namespace covering the overview / landing page. */
export const home: ITranslationHome = {
	title: 'Overview',
	sourcesPageButton: 'Explore your data',
	socialsTitle: 'Follow us for more updates!',
	rewardsTitle: 'Your voice earns you rewards!',
	tiles: {
		heading: 'Quick Start',
		one: {
			title: 'New Project',
			description: 'Turn unstructured data into AI-ready assets',
		},
		two: {
			title: 'Documentation',
			description: 'Find everything you need to get started with RocketRide Data Toolchain',
		},
		three: {
			title: 'Tutorials',
			description: 'Check out our how-to videos and guides',
		},
		four: {
			title: 'Get Involved',
			description: 'Join our Discord to share feedback & connect',
		},
	},
	rewards: {
		one: {
			title: 'Refer a friend',
			description: 'Invite other people to join our platform using your link',
			buttonTitle: 'Get Link',
		},
		two: {
			title: 'Join our Discord channel',
			description: 'Connect with us, share your feedback, and get help from specialists',
			buttonTitle: 'Join now',
		},
		three: {
			title: 'Share your experience',
			description: 'Post on X what you enjoy, and how Data Toolchain is helping you.',
			buttonTitle: 'Tell us what you think',
		},
	},
	copyright: 'Copyright © {{year}} RocketRide, Inc.',
};
