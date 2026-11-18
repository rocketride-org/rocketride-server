/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Read-only stand-in for the builder's FlowPreferencesContext (see
 * resolve.ts). The canvas is always read-only and locked, and nothing is
 * persisted: the widget has no host preference store.
 */
import type { ReactElement, ReactNode } from 'react';
import { createContext, useContext } from 'react';

// Type-only: a value import here would bundle the real context.
import type { IFlowPreferencesContext, NavigationMode } from '@app-shared/tools/pipelines/panels/design/canvas/context/FlowPreferencesContext';

export type { IFlowPreferencesContext };

const noop = (): void => undefined;

/** The only value this stand-in ever provides. */
export const READ_ONLY_PREFERENCES: IFlowPreferencesContext = {
	navigationMode: 'drag' as NavigationMode.DRAG,
	setNavigationMode: noop,
	isReadonly: true,
	isLocked: true,
	toggleLock: noop,
	projectLayout: { isLocked: true, snapToGrid: false, snapGridSize: [10, 10] },
	updateProjectLayout: noop,
};

const FlowPreferencesContext = createContext<IFlowPreferencesContext>(READ_ONLY_PREFERENCES);

/** Provides the locked, read-only preferences. */
export function ReadOnlyFlowPreferencesProvider({ children }: { children: ReactNode }): ReactElement {
	return <FlowPreferencesContext.Provider value={READ_ONLY_PREFERENCES}>{children}</FlowPreferencesContext.Provider>;
}

/** Same name as the builder's hook. */
export function useFlowPreferences(): IFlowPreferencesContext {
	return useContext(FlowPreferencesContext);
}
