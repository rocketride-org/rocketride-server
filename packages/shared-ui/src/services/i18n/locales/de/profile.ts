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

import { ITranslationProfile } from '../en/profile';

/** German translations for the "profile" namespace covering the user profile page. */
export const profile: ITranslationProfile = {
	title: 'Profil',
	status: {
		verified: 'Verifiziert',
		unverified: 'Nicht verifiziert',
	},
	linkedAccounts: {
		title: 'Verknüpfte Konten',
		description: 'Verbinde deine OAuth-Konten für eine nahtlose Anmeldung.',
		status: {
			linked: 'Verbunden',
			notLinked: 'Nicht verbunden',
		},
		action: {
			link: 'Konto verknüpfen',
		},
		providers: {
			github: 'GitHub',
			google: 'Google',
			microsoft: 'Microsoft',
		},
	},
};
