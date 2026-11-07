// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
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

// ONE declaration for this union — see shared/types/connection.ts.
import type { ConnectionMode } from '../types/connection';
export type RocketRideConnectionMode = ConnectionMode;

export interface CloudConnectionConfig {
	development: {
		connectionMode: RocketRideConnectionMode | string | null;
	};
	deployment: {
		connectionMode: RocketRideConnectionMode | string | null;
	};
}

/**
 * Whether the mode requires the user to provide an API key manually.
 * Cloud uses OAuth2 (no manual key), docker/service use env-derived keys,
 * local needs no auth. Only on-prem requires user-provided API key.
 */
export function connectionModeRequiresApiKey(connectionMode: RocketRideConnectionMode | string): boolean {
	return connectionMode === 'onprem';
}

/**
 * Whether the mode uses OAuth2 authentication (browser sign-in).
 */
export function connectionModeUsesOAuth(connectionMode: RocketRideConnectionMode | string): boolean {
	return connectionMode === 'cloud';
}

/**
 * Whether either connection slot is configured to use Cloud.
 * Team selection is server-profile scoped in the current VS Code architecture.
 */
export function isCloudConnectionConfigured(config: CloudConnectionConfig): boolean {
	return [config.development, config.deployment].some((group) => {
		return group.connectionMode === 'cloud';
	});
}
