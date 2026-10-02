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
// rocketride/app-sdk — subpath export for shell app development
// =============================================================================
//
// External developers install `rocketride` and import from this subpath:
//
//   import type { AppDescriptor, ShellAppProps } from 'rocketride/app-sdk';
//   import { useShellConnection, useWorkspace, connectionManager } from 'rocketride/app-sdk';
//
// At build time:   TypeScript resolves these declarations and provides full
//                  IntelliSense for all types, hooks, and functions.
//
// At runtime:      Module Federation's shared singleton mechanism replaces
//                  every export below with the real implementation from the
//                  shell host.  Third-party apps never bundle the
//                  implementations — outside the host (a plain Node/browser
//                  environment, a unit test that doesn't mock this module),
//                  each one throws a clear error rather than silently
//                  returning `undefined`.
// =============================================================================

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type {
	// Shell component prop contracts
	ShellAppProps,
	ConnectResult,

	// App configuration
	AppDescriptor,
	AppManifestEntry,
	SettingValue,
	SettingSchema,
	AppConfiguration,
	ShellBrandingConfig,

	// Workspace
	WorkspacePrefs,
	IWorkspaceContext,

	// Shell config
	ShellApiConfig,
	ShellThemeConfig,
	ShellThemeOption,

	// Virtual file system
	IVirtualFileSystem,

	// Documents model
	Document,
	Editor,
	EditorGroup,
	SplitOrientation,
	DocumentsState,

	// Event map
	ShellEventMap,
} from './types';

// =============================================================================
// IMPORTS FOR HOOK RETURN TYPES
// =============================================================================

import type * as React from 'react';
import type { RocketRideClient } from '../client/index';
import type { IWorkspaceContext, ShellApiConfig, ConnectResult, DocumentsState, Document, ShellEventMap } from './types';

/**
 * Every export in this file is a stub: Module Federation's shared-singleton
 * mechanism swaps it for the shell host's real implementation at runtime, so
 * none of this code is meant to actually run standalone (see the module
 * doc-comment above). Calling one outside the host — a plain Node/browser
 * environment, or a unit test that hasn't mocked `rocketride/app-sdk` —
 * throws this instead of returning `undefined`, so the failure points
 * straight at the missing host/mock rather than surfacing later as a
 * confusing "cannot read properties of undefined".
 */
function shellHostRequired(name: string): never {
	throw new Error(`rocketride/app-sdk: '${name}' has no standalone implementation — it only works when the app is loaded ` + `by the RocketRide shell host, which replaces this stub with the real implementation via Module ` + `Federation's shared-singleton mechanism. If you're seeing this in a unit test or a plain Node/browser ` + `environment, mock '${name}' instead of calling the real export.`);
}

// =============================================================================
// CONNECTION HOOKS
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
export function useShellConnection(): {
	client: RocketRideClient | null;
	isConnected: boolean;
	statusMessage: string | null;
} {
	return shellHostRequired('useShellConnection');
}

/**
 * Access the shell-level API config keys (environment variables forwarded
 * from the server, plus user-configured settings).
 *
 * @returns A string-keyed record of config values.
 */
export function useShellApiConfig(): ShellApiConfig {
	return shellHostRequired('useShellApiConfig');
}

// =============================================================================
// WORKSPACE HOOKS
// =============================================================================

/**
 * Access the workspace context: preferences, settings, app manifest,
 * opaque app state, and the dispatch function.
 *
 * @returns The workspace context object.
 */
export function useWorkspace(): IWorkspaceContext {
	return shellHostRequired('useWorkspace');
}

// =============================================================================
// AUTH HOOKS
// =============================================================================

/**
 * Access the currently authenticated user's identity.
 *
 * @returns The ConnectResult from the server, or null if not authenticated.
 */
export function useAuthUser(): ConnectResult | null {
	return shellHostRequired('useAuthUser');
}

/**
 * Get the logout function.
 *
 * @returns A function that triggers logout, or null.
 */
export function useLogout(): (() => void) | null {
	return shellHostRequired('useLogout');
}

/**
 * Access the user's desktop apps and subscription state.
 *
 * @returns Object with desktopApps array, isOnDesktop lookup, and getStatus lookup.
 */
export function useSubscriptions(): {
	desktopApps: { appId: string; appStatus: string; onDesktop: boolean; seats?: number; seatsUsed?: number; features?: string[] }[];
	isOnDesktop: (appId: string) => boolean;
	getStatus: (appId: string) => string | undefined;
} {
	return shellHostRequired('useSubscriptions');
}

// =============================================================================
// DOCUMENTS CLASS
// =============================================================================

/**
 * VS Code-style document model.  App-owned — create an instance, pass it
 * to your components, destroy it when done.
 *
 * @example
 * ```typescript
 * const docs = new Documents(vfs);
 * await docs.openDocument('myfile.pipe');
 * const state = docs.useStore();  // React hook
 * docs.destroy();
 * ```
 */
export class Documents {
	constructor(_vfs?: import('./types').IVirtualFileSystem | null, _initialState?: DocumentsState) {
		shellHostRequired('Documents');
	}

	// State access
	getState(): DocumentsState {
		return shellHostRequired('Documents.getState');
	}
	getDocument(_uri: string): Document | undefined {
		return shellHostRequired('Documents.getDocument');
	}

	// React hook — subscribes to state changes
	useStore(): DocumentsState {
		return shellHostRequired('Documents.useStore');
	}

	// Document operations
	openDocument(_uri: string, _groupId?: string): Promise<void> {
		return shellHostRequired('Documents.openDocument');
	}
	createDocument(_groupId?: string, _initialContent?: unknown): string {
		return shellHostRequired('Documents.createDocument');
	}
	closeEditor(_editorId: string): void {
		return shellHostRequired('Documents.closeEditor');
	}
	updateContent(_uri: string, _content: unknown): void {
		return shellHostRequired('Documents.updateContent');
	}
	saveDocument(_uri: string): Promise<void> {
		return shellHostRequired('Documents.saveDocument');
	}
	revertDocument(_uri: string): Promise<void> {
		return shellHostRequired('Documents.revertDocument');
	}

	// Editor group operations
	splitGroup(_groupId: string, _orientation: import('./types').SplitOrientation): void {
		return shellHostRequired('Documents.splitGroup');
	}
	moveEditor(_editorId: string, _targetGroupId: string): void {
		return shellHostRequired('Documents.moveEditor');
	}
	closeGroup(_groupId: string): void {
		return shellHostRequired('Documents.closeGroup');
	}
	setActiveEditor(_groupId: string, _editorIndex: number): void {
		return shellHostRequired('Documents.setActiveEditor');
	}
	setActiveGroup(_groupId: string): void {
		return shellHostRequired('Documents.setActiveGroup');
	}
	updateEditorViewport(_editorId: string, _patch: Partial<Pick<import('./types').Editor, 'scrollTop' | 'scrollLeft' | 'cursorLine' | 'cursorColumn'>>): void {
		return shellHostRequired('Documents.updateEditorViewport');
	}

	// Lifecycle
	destroy(): void {
		return shellHostRequired('Documents.destroy');
	}
}

// =============================================================================
// CONNECTION MANAGER
// =============================================================================

/**
 * Module-level connection manager singleton.
 *
 * Provides typed `emit` and `on` methods backed by the shell's event system,
 * plus client access and connection state.  Works from React components,
 * hooks, or plain functions.
 */
export const connectionManager: {
	/** Emit a typed shell event. */
	emit<K extends keyof ShellEventMap>(event: K, payload: ShellEventMap[K]): void;
	/** Subscribe to a typed shell event. Returns an unsubscribe function. */
	on<K extends keyof ShellEventMap>(event: K, handler: (payload: ShellEventMap[K]) => void): () => void;
	/** Returns the RocketRide client singleton, or null if not initialised. */
	getClient(): import('../client/index').RocketRideClient | null;
	/** Returns true when the WebSocket is authenticated and connected. */
	isConnected(): boolean;
} = {
	emit() {
		return shellHostRequired('connectionManager.emit');
	},
	on() {
		return shellHostRequired('connectionManager.on');
	},
	getClient() {
		return shellHostRequired('connectionManager.getClient');
	},
	isConnected() {
		return shellHostRequired('connectionManager.isConnected');
	},
};

/**
 * Returns a snapshot of the debug event log (last 500 events).
 */
export function getDebugLog(): Array<{ timestamp: string; event: string; payload: unknown }> {
	return shellHostRequired('getDebugLog');
}

/** Clears all entries from the debug log. */
export function clearDebugLog(): void {
	return shellHostRequired('clearDebugLog');
}

/**
 * Registers a wildcard listener called for every emitted event.
 * Returns an unsubscribe function.
 */
export function onAny(_handler: (event: string, payload: unknown) => void): () => void {
	return shellHostRequired('onAny');
}

// =============================================================================
// CROSS-APP COMPONENT LOADING
// =============================================================================

/**
 * Loads a React component from another app's component catalog.
 *
 * If the target app's descriptor hasn't been loaded yet, triggers a lazy
 * load automatically.  Returns `null` while loading, then the component
 * once the descriptor is available.
 *
 * @param appId         - The appId of the target app (e.g. 'rocketride.pipeBuilder').
 * @param componentName - The key in that app's `components` object (e.g. 'SpecialChart').
 * @returns The React component, or null if not yet loaded / not found.
 */
export function useAppComponent(_appId: string, _componentName: string): React.ComponentType<any> | null {
	return shellHostRequired('useAppComponent');
}

// =============================================================================
// CLIENT ACCESS (non-React)
// =============================================================================

/** Returns the RocketRide client singleton, or null if not initialised. */
export function getClient(): RocketRideClient | null {
	return shellHostRequired('getClient');
}
