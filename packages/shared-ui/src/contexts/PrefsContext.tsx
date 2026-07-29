// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PrefsContext — THE one workspace-preferences accessor for shared-ui.
 *
 * A single, host-agnostic `{ getPref, setPref }` API that any shared-ui component
 * (DetailPanel, the canvas, record panels) reads via {@link usePrefs}, plus a
 * {@link PrefsProvider} each host wires ONCE from whatever prefs store it owns:
 *
 *   - Web apps under shell-ui: `useWorkspace().prefs` / `updatePrefs`.
 *   - The canvas: its injected `getPreference` / `setPreference` (which each of
 *     its hosts already routes — web to `useWorkspace`, VS Code to the extension
 *     host over postMessage). So the canvas works in both with no extra code.
 *   - A VS Code webview: the prefs it holds + a prefs-write message to the host.
 *
 * `shared-ui` sits BELOW shell-ui in the layer graph and cannot import it, so it
 * can never call `useWorkspace` itself — the value is always PROVIDED by the app
 * (which can see both layers). Where no provider is mounted, {@link usePrefs}
 * returns a no-op accessor: reads yield `undefined`, writes are dropped, so a
 * component simply doesn't persist rather than crashing.
 *
 * Values are stored in the app's per-app workspace file, so a preference set here
 * persists per-user and rides the workspace exactly like theme or sidebar state —
 * never browser `localStorage`.
 */

import React, { createContext, useContext, ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** The shared preferences accessor: read one key, write one key. */
export interface IPrefsApi {
	/** Current value for `key`, or `undefined` if unset. Caller narrows the type. */
	getPref: (key: string) => unknown;
	/** Persist `value` under `key` (shallow-merged into the prefs bag). */
	setPref: (key: string, value: unknown) => void;
}

// =============================================================================
// CONTEXT
// =============================================================================

/** No-op accessor used when no provider is mounted — persistence just no-ops. */
const NOOP_PREFS: IPrefsApi = {
	getPref: () => undefined,
	setPref: () => undefined,
};

/** The prefs accessor context; null until a host mounts a {@link PrefsProvider}. */
const PrefsContext = createContext<IPrefsApi | null>(null);

// =============================================================================
// PROVIDER + HOOK
// =============================================================================

/**
 * Provides the app's prefs accessor to every shared-ui component beneath it.
 * Mount ONCE near the app root with a value backed by the host's prefs store.
 *
 * @param props.value - The `{ getPref, setPref }` implementation for this host.
 * @param props.children - The subtree that may read prefs via {@link usePrefs}.
 * @returns The provider element.
 */
export function PrefsProvider({ value, children }: { value: IPrefsApi; children: ReactNode }): React.ReactElement {
	return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

/**
 * Reads the ambient prefs accessor. Returns a no-op accessor when no provider is
 * mounted, so callers never need to null-check.
 *
 * @returns The `{ getPref, setPref }` accessor.
 */
export function usePrefs(): IPrefsApi {
	return useContext(PrefsContext) ?? NOOP_PREFS;
}
