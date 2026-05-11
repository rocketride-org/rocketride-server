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

/**
 * Auth user hook — server-driven identity (no OIDC).
 * Identity is injected via ShellIdentityContext, set when
 * connectClient() succeeds and returns a ConnectResult.
 */

import React, { createContext, useContext } from 'react';
import type { ConnectResult } from 'rocketride';

// Re-export ConnectResult under the public alias AuthUser so consumers
// don't need to import from the rocketride SDK directly.
export type { ConnectResult as AuthUser };

/**
 * React context that holds the authenticated user identity.
 * Populated by ShellApp once connectClient() resolves successfully;
 * null when the user is not yet authenticated or the connection has not been established.
 */
export const ShellIdentityContext = createContext<ConnectResult | null>(null);

/**
 * Hook that returns the current authenticated user identity, or null if
 * the shell has not yet completed a successful connectClient() call.
 *
 * Consumers should treat a null return as "not authenticated" and either
 * show a loading state or redirect to login.
 *
 * @returns The ConnectResult from the most recent successful connection, or null.
 */
export function useAuthUser(): ConnectResult | null {
	// Read the identity value out of ShellIdentityContext, which is set by
	// ShellApp after connectClient() resolves. Returns null when no provider
	// is present or the identity has not been populated yet.
	return useContext(ShellIdentityContext);
}

/**
 * Hook that returns a logout callback, or null if logout is not applicable.
 *
 * In the current server-driven auth architecture, logout is handled by
 * ShellApp via a full page reload rather than an explicit callback, so
 * this hook always returns null. It exists as a forward-compatible
 * placeholder for future OAuth-based logout flows.
 *
 * @returns Always null in the current implementation.
 */
export function useLogout(): (() => void) | null {
	return null; // Logout is handled directly in ShellApp via page reload
}
