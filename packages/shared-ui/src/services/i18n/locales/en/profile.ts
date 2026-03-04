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
 * Type definition for the "profile" translation namespace.
 * Describes translatable strings for the user profile page including
 * verification status and linked OAuth account management.
 */
export interface ITranslationProfile {
	title: string;
	status: {
		verified: string;
		unverified: string;
	};
	linkedAccounts: {
		title: string;
		description: string;
		status: {
			linked: string;
			notLinked: string;
		};
		action: {
			link: string;
		};
		providers: {
			github: string;
			google: string;
			microsoft: string;
		};
	};
}

/** English translations for the "profile" namespace covering the user profile page. */
export const profile: ITranslationProfile = {
	title: 'Profile',
	status: {
		verified: 'Verified',
		unverified: 'Unverified',
	},
	linkedAccounts: {
		title: 'Linked accounts',
		description: 'Connect your OAuth accounts to sign in seamlessly.',
		status: {
			linked: 'Linked',
			notLinked: 'Not linked',
		},
		action: {
			link: 'Link account',
		},
		providers: {
			github: 'GitHub',
			google: 'Google',
			microsoft: 'Microsoft',
		},
	},
};
