/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Read-only stand-in for the builder's FlowProjectContext (see resolve.ts).
 * It carries the node catalog for the providers in the drawn pipeline. It
 * has no task status, no run or save callbacks and no host links, so the
 * reused components draw no run, status or link controls.
 */
import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from 'react';

import type { IFlowProjectContext } from '@app-shared/tools/pipelines/panels/design/canvas/context/FlowProjectContext';
import type { IProject, IServiceCatalog } from '@app-shared/tools/pipelines/panels/design/canvas/types';
import { DEFAULT_TOOLCHAIN_STATE } from 'shell';

export type { IFlowProjectContext };

const noop = (): void => undefined;

const FlowProjectContext = createContext<IFlowProjectContext | null>(null);

/** Builds the read-only context value for `project` and its catalog. */
export function readOnlyProject(project: IProject, servicesJson: IServiceCatalog): IFlowProjectContext {
	return {
		currentProject: project,
		toolchainState: DEFAULT_TOOLCHAIN_STATE,
		patchToolchainState: noop,
		toggleDevMode: noop,
		isPipelineRunning: false,
		isReadonly: true,
		servicesJson,
		requestNodeSchema: noop,
		oauth2RootUrl: '',
	};
}

/** Provides the read-only project and catalog to the reused components. */
export function ReadOnlyFlowProjectProvider({ project, servicesJson, children }: { project: IProject; servicesJson: IServiceCatalog; children: ReactNode }): ReactElement {
	const value = useMemo(() => readOnlyProject(project, servicesJson), [project, servicesJson]);
	return <FlowProjectContext.Provider value={value}>{children}</FlowProjectContext.Provider>;
}

/** Same contract as the builder's hook: throws outside the provider. */
export function useFlowProject(): IFlowProjectContext {
	const ctx = useContext(FlowProjectContext);
	if (!ctx) throw new Error('useFlowProject must be used within ReadOnlyFlowProjectProvider');
	return ctx;
}
