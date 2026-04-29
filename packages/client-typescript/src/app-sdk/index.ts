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
// rocketride/app-sdk — subpath export for third-party app development
//
// Import types and runtime stubs for building apps that integrate with the
// RocketRide shell:
//
//   import type { AppDescriptor, ShellViewRenderProps } from 'rocketride/app-sdk';
//   import { useShellConnection, useWorkspace } from 'rocketride/app-sdk';
//
// At build time:   TypeScript resolves these declarations and provides full
//                  IntelliSense for all types and hooks.
//
// At runtime:      Module Federation's shared singleton mechanism replaces
//                  these stubs with the real implementations injected by the
//                  shell host (cloud-ui).  Third-party apps never bundle the
//                  implementations — they receive them from the shell's shared
//                  scope at load time.
//
// Adding a new hook: add the declaration here and implement the real version
// in cloud-ui/src/hooks/shellHooks.ts (or wherever the shell exposes it).
// =============================================================================

// ── Re-export all types from the types module ─────────────────────────────────
export type { AppDescriptor, AppManifestEntry, AppSettingDefinition, DocumentState, ShellApiConfig, ShellBrandingConfig, ShellThemeConfig, ShellThemeOption, ShellViewDescriptor, ShellViewRenderProps, StripePlan, ViewItem, WorkspaceContext, WorkspacePrefs } from './types';

// ── Import RocketRideClient for the useShellConnection return type ────────────
import type { RocketRideClient } from '../client/index';
import type { WorkspaceContext, ShellApiConfig } from './types';

// =============================================================================
// HOOK DECLARATIONS
// At runtime Module Federation replaces these with real implementations from
// the shell host.  The declarations here give TypeScript the full signature.
// =============================================================================

/**
 * Access the active shell connection and its status.
 *
 * @returns Object with `client` (the live RocketRideClient, or null when
 *          disconnected), `isConnected` flag, and `statusMessage` for UI display.
 *
 * @example
 * ```tsx
 * const { client, isConnected } = useShellConnection();
 * if (!client) return <p>Connecting…</p>;
 * ```
 */
export declare function useShellConnection(): {
	client: RocketRideClient | null;
	isConnected: boolean;
	statusMessage: string | null;
};

/**
 * Access the workspace context: open apps, loaded descriptors, document
 * management helpers, and user preferences.
 *
 * @returns {@link WorkspaceContext}
 */
export declare function useWorkspace(): WorkspaceContext;

/**
 * Access the shell-level API config keys (environment variables forwarded
 * from the server).  Safe to call in any app component.
 *
 * @returns {@link ShellApiConfig} — a string-keyed record of config values.
 */
export declare function useShellApiConfig(): ShellApiConfig;

/**
 * Access the currently authenticated user's basic profile.
 *
 * @returns Object with optional `userName` and `userEmail` strings.
 */
export declare function useAuthUser(): {
	userName?: string;
	userEmail?: string;
};

// =============================================================================
// EVENT HANDLER TYPES
// =============================================================================

/** Handlers for shell-emitted lifecycle events. */
export interface ShellEventHandlers {
	/** Fired when the shell's active theme changes. */
	onThemeChange?: (themeId: string) => void;
	/** Fired when the shell manifest is refreshed (e.g. new app published). */
	onManifestRefresh?: () => void;
	/** Fired when the connection status changes. */
	onConnectionChange?: (isConnected: boolean) => void;
}

/**
 * Subscribe to shell-emitted lifecycle events.
 *
 * Handlers are automatically removed when the calling component unmounts.
 * Pass a stable (memoised) handlers object to avoid re-subscription on
 * every render.
 *
 * @param handlers {@link ShellEventHandlers}
 */
export declare function useShellEvents(handlers: ShellEventHandlers): void;
