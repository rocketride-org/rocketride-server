// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AppStateContext — the workspace's SECOND accessor, beside {@link usePrefs}.
 *
 * The workspace persists two different kinds of state, and conflating them is
 * how a per-document affordance ends up following the user everywhere:
 *
 *   usePrefs()     PREFERENCES — one value for the user, everywhere. Owned by
 *                  the shell (theme, sidebar) or by an app, and MIRRORED to
 *                  every realm.
 *
 *   useAppState()  APP STATE — completely managed by the app. The shell
 *                  persists it and never reads it. Not mirrored: it is the
 *                  bulk of a workspace file.
 *
 * An app using the DOCUMENTS protocol delegates its appState to the
 * `Documents` class, which layers per-document storage on top of it (see
 * `updateEditorViewState`). Such an app provides this accessor scoped to the
 * ACTIVE DOCUMENT, so a component reading `getAppState('toolbarPosition')`
 * gets this document's value and writes back to this document's slice. An app
 * not using the protocol provides it over its own appState directly.
 *
 * Either way a shared component sees one accessor and needs to know nothing
 * about documents, hosts, or where the bytes land.
 */

import React, { createContext, useContext, ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** The app-state accessor: read one key, write one key. */
export interface IAppStateApi {
	/** Current value for `key`, or `undefined` if unset. Caller narrows. */
	getAppState: (key: string) => unknown;
	/** Persist `value` under `key` (shallow-merged into the app's slice). */
	setAppState: (key: string, value: unknown) => void;
}

// =============================================================================
// CONTEXT
// =============================================================================

/** No-op accessor used when no provider is mounted — persistence no-ops. */
const NOOP_APP_STATE: IAppStateApi = {
	getAppState: () => undefined,
	setAppState: () => undefined,
};

/** The accessor context; null until a host mounts an {@link AppStateProvider}. */
const AppStateContext = createContext<IAppStateApi | null>(null);

// =============================================================================
// PROVIDER + HOOK
// =============================================================================

/**
 * Provides the app's state accessor to every shared component beneath it.
 *
 * Mount it where the relevant SLICE is owned — which for a documents-based app
 * is per document (one provider per open editor), not once at the app root.
 *
 * @param props.value - The `{ getAppState, setAppState }` implementation.
 * @param props.children - The subtree that may read it via {@link useAppState}.
 * @returns The provider element.
 */
export function AppStateProvider({ value, children }: { value: IAppStateApi; children: ReactNode }): React.ReactElement {
	return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

/**
 * Reads the ambient app-state accessor. Returns a no-op accessor when no
 * provider is mounted, so callers never need to null-check.
 *
 * @returns The `{ getAppState, setAppState }` accessor.
 */
export function useAppState(): IAppStateApi {
	return useContext(AppStateContext) ?? NOOP_APP_STATE;
}
