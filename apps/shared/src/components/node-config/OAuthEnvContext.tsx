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

// =============================================================================
// NODE-CONFIG — OAuth environment context (the form's ONLY host coupling)
// =============================================================================
//
// The service-config form's OAuth widgets (Login with Google/Microsoft/
// Slack) need three environment facts. They used to reach into the canvas's
// FlowProjectContext for them — a dependency inversion once the canvas
// became pipelines-tool code. Now the facts arrive through this minimal
// context: the canvas's config panel provides it from its project context;
// hosts without OAuth flows (sql-ui's connection editor) provide nothing
// and the widgets render disabled.
// =============================================================================

import { createContext, useContext } from 'react';

/** What the OAuth login widgets need from their host. */
export interface IOAuthEnv {
	/** The engine's OAuth2 root URL ('' = OAuth unavailable here). */
	oauth2RootUrl: string;
	/** The return URL the provider redirects back to. */
	oauthReturnUrl: string;
	/** Opens an external browser/window for the consent flow. */
	onOpenExternal?: (url: string) => void;
	/** Opens a plain link (providers whose flow is informational). */
	onOpenLink?: (url: string) => void;
}

const OAuthEnvContext = createContext<IOAuthEnv>({ oauth2RootUrl: '', oauthReturnUrl: '' });

/** The provider a hosting surface wraps around the form when it supports
 *  OAuth flows (the canvas config panel does; plain hosts skip it). */
export const OAuthEnvProvider = OAuthEnvContext.Provider;

/**
 * The OAuth environment (safe defaults when no provider is present).
 *
 * @returns The current environment facts.
 */
export function useOAuthEnv(): IOAuthEnv {
	return useContext(OAuthEnvContext);
}
