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

export type RocketRideConnectionMode = 'cloud' | 'docker' | 'service' | 'onprem' | 'local';

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
 * Whether the mode has a fixed URL that the user cannot change.
 */
export function connectionModeHasFixedUrl(connectionMode: RocketRideConnectionMode | string): boolean {
	return connectionMode === 'cloud' || connectionMode === 'docker' || connectionMode === 'service' || connectionMode === 'local';
}
