// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// createShellConfig — Assembles the ShellConfig for the cloud host
// =============================================================================

import { fetchAndApplyTheme } from 'shared/themes';
import type { ShellConfig, ShellApiConfig, AppManifestEntry } from 'shell-ui';
import { ConnectionManager } from './connection/connection';

// =============================================================================
// API CONFIG — read from RR_* process.env defines (cloud only)
// =============================================================================

/**
 * Compile-time snapshot of all RR_* environment variables baked into the cloud
 * bundle by rsbuild's `source.define` substitution.
 *
 * This object is passed into ShellConfig and distributed to remote apps through
 * React context (ShellApiConfigProvider / useShellApiConfig).  Remote apps must
 * NEVER read `process.env` directly — they must use `useShellApiConfig()`.
 */
const API_CONFIG: ShellApiConfig = {
	// Base URI for the RocketRide WebSocket server
	ROCKETRIDE_URI:             process.env.ROCKETRIDE_URI,
	// Hard-coded API key for service accounts / dev; bypasses OAuth2 when present
	RR_APIKEY:                 process.env.RR_APIKEY,
	// Stripe publishable key — passed to loadStripe() in CheckoutModal
	RR_STRIPE_PUBLISHABLE_KEY: process.env.RR_STRIPE_PUBLISHABLE_KEY,
	// Zitadel OIDC issuer URL — required for the OAuth2 PKCE sign-in flow
	RR_ZITADEL_URL:            process.env.RR_ZITADEL_URL,
	// OAuth2 client ID registered with Zitadel for this SPA
	RR_ZITADEL_CLIENT_ID:      process.env.RR_ZITADEL_CLIENT_ID,
};

// =============================================================================
// THEME OPTIONS
// =============================================================================

/**
 * Ordered list of theme choices surfaced in the Shell's theme picker.
 *
 * Each entry maps a CSS theme bundle identifier (`id`) to a human-readable
 * display name (`name`).  The first entry (`rocketride-light`) is applied
 * as the default theme via `onInit`.
 */
const THEME_OPTIONS = [
	{ id: 'rocketride-light', name: 'RocketRide Light' },
	{ id: 'light', name: 'Light' },
	{ id: 'dark', name: 'Dark' },
	{ id: 'gray', name: 'Gray' },
	{ id: 'rocketride', name: 'RocketRide Dark' },
];

// =============================================================================
// BUILD SHELL CONFIG
// =============================================================================

/**
 * Assembles and returns the complete `ShellConfig` for the cloud host.
 *
 * Called once during app bootstrap after the server has delivered the app
 * manifest JSON.  All apps (including home) come from the manifest — there
 * are no built-in apps prepended.
 *
 * @param apps         - Array of app manifest entries from the server probe.
 * @param capabilities - Server capability tags (['oss'] or ['saas']).
 * @returns A fully populated ShellConfig ready to pass to `<ShellApp>`.
 */
export function buildShellConfig(apps: AppManifestEntry[], capabilities: string[] = []): ShellConfig {
	// Determine mode from server capabilities
	const isSaas = capabilities.includes('saas');
	const brandName = isSaas ? 'RocketRide Cloud' : 'RocketRide';

	return {
		// All apps from the server probe — no built-in apps
		apps,

		// Server capabilities for feature-flagging (billing, OAuth, etc.)
		capabilities,

		// API endpoints and credentials baked in at build time
		apiConfig: API_CONFIG,

		// Branding shown on the loading screen before any app is mounted
		loginBranding: {
			appName: brandName,
			welcomeTitle: brandName,
			welcomeSubtitle: 'Select an app to get started.',
		},

		// Apply the user's saved theme on first mount so the loading screen
		// background matches their preference instead of always showing light.
		// Falls back to rocketride-light if nothing is saved yet.
		onInit: () => {
			const homeTheme = (() => { try { return localStorage.getItem('rr:home:theme'); } catch { return null; } })();
			const saved = (() => {
				if (homeTheme === 'dark') return 'rocketride';
				if (homeTheme === 'light') return 'rocketride-light';
				try { return localStorage.getItem('rr:theme') || 'rocketride-light'; } catch { return 'rocketride-light'; }
			})();
			return fetchAndApplyTheme(saved, '/shell/themes').catch(console.error);
		},

		themeConfig: {
			options: THEME_OPTIONS,

			// Fetch and apply the selected theme's CSS tokens, then broadcast
			// the resolved token map so remote app iframes can synchronise
			onThemeChange: (themeId: string) => {
				fetchAndApplyTheme(themeId, '/shell/themes')
					.then((tokens) => ConnectionManager.getInstance().emit('shell:themeChange', { tokens }))
					.catch(console.error);
			},
		},

		// Account info populated by ShellApp after auth
		account: {},
	};
}
