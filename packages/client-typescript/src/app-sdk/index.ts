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
// rocketride/app-sdk — subpath export for shell-ui app development
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
//                  these stubs with the real implementations from the shell
//                  host (shell-ui).  Third-party apps never bundle the
//                  implementations.
// =============================================================================

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type {
	// Shell component prop contracts
	ShellAppProps,
	ShellSidebarProps,
	ConnectResult,

	// App configuration
	AppDescriptor,
	AppManifestEntry,
	AppSettingDefinition,
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

import type { RocketRideClient } from '../client/index';
import type { IWorkspaceContext, ShellApiConfig, ConnectResult, DocumentsState, Document, ShellEventMap } from './types';

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
export declare function useShellConnection(): {
	client: RocketRideClient | null;
	isConnected: boolean;
	statusMessage: string | null;
};

/**
 * Access the shell-level API config keys (environment variables forwarded
 * from the server, plus user-configured settings).
 *
 * @returns A string-keyed record of config values.
 */
export declare function useShellApiConfig(): ShellApiConfig;

// =============================================================================
// WORKSPACE HOOKS
// =============================================================================

/**
 * Access the workspace context: preferences, settings, app manifest,
 * opaque app state, and the dispatch function.
 *
 * @returns The workspace context object.
 */
export declare function useWorkspace(): IWorkspaceContext;

// =============================================================================
// AUTH HOOKS
// =============================================================================

/**
 * Access the currently authenticated user's identity.
 *
 * @returns The ConnectResult from the server, or null if not authenticated.
 */
export declare function useAuthUser(): ConnectResult | null;

/**
 * Get the logout function.
 *
 * @returns A function that triggers logout, or null.
 */
export declare function useLogout(): (() => void) | null;

/**
 * Access the user's desktop apps and subscription state.
 *
 * @returns Object with desktopApps array, isOnDesktop lookup, and getStatus lookup.
 */
export declare function useSubscriptions(): {
	desktopApps: { appId: string; appStatus: string; onDesktop: boolean; seats?: number; seatsUsed?: number; features?: string[] }[];
	isOnDesktop: (appId: string) => boolean;
	getStatus: (appId: string) => string | undefined;
};

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
export declare class Documents {
	constructor(vfs?: import('./types').IVirtualFileSystem | null, initialState?: DocumentsState);

	// State access
	getState(): DocumentsState;
	getDocument(uri: string): Document | undefined;

	// React hook — subscribes to state changes
	useStore(): DocumentsState;

	// Document operations
	openDocument(uri: string, groupId?: string): Promise<void>;
	createDocument(groupId?: string, initialContent?: unknown): string;
	closeEditor(editorId: string): void;
	updateContent(uri: string, content: unknown): void;
	saveDocument(uri: string): Promise<void>;
	revertDocument(uri: string): Promise<void>;

	// Editor group operations
	splitGroup(groupId: string, orientation: import('./types').SplitOrientation): void;
	moveEditor(editorId: string, targetGroupId: string): void;
	closeGroup(groupId: string): void;
	setActiveEditor(groupId: string, editorIndex: number): void;
	setActiveGroup(groupId: string): void;
	updateEditorViewport(editorId: string, patch: Partial<Pick<import('./types').Editor, 'scrollTop' | 'scrollLeft' | 'cursorLine' | 'cursorColumn'>>): void;

	// Lifecycle
	destroy(): void;
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
export declare const connectionManager: {
	/** Emit a typed shell event. */
	emit<K extends keyof ShellEventMap>(event: K, payload: ShellEventMap[K]): void;
	/** Subscribe to a typed shell event. Returns an unsubscribe function. */
	on<K extends keyof ShellEventMap>(event: K, handler: (payload: ShellEventMap[K]) => void): () => void;
	/** Returns the RocketRide client singleton, or null if not initialised. */
	getClient(): import('../client/index').RocketRideClient | null;
	/** Returns true when the WebSocket is authenticated and connected. */
	isConnected(): boolean;
};

/**
 * Returns a snapshot of the debug event log (last 500 events).
 */
export declare function getDebugLog(): Array<{ timestamp: string; event: string; payload: unknown }>;

/** Clears all entries from the debug log. */
export declare function clearDebugLog(): void;

/**
 * Registers a wildcard listener called for every emitted event.
 * Returns an unsubscribe function.
 */
export declare function onAny(handler: (event: string, payload: unknown) => void): () => void;

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
export declare function useAppComponent(appId: string, componentName: string): React.ComponentType<any> | null;

// =============================================================================
// CLIENT ACCESS (non-React)
// =============================================================================

/** Returns the RocketRide client singleton, or null if not initialised. */
export declare function getClient(): RocketRideClient | null;
