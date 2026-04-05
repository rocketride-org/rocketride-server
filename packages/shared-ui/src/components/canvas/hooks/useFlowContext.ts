// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * useFlow — Composite hook that aggregates all flow contexts into a single
 * return object for backward compatibility.
 *
 * New code should prefer the specific hooks:
 *   - useFlowGraph()       — nodes, edges, CRUD, event handlers
 *   - useFlowProject()     — project data, toolchain state, host callbacks
 *   - useFlowPreferences() — layout, navigation mode, lock state
 *
 * This composite hook exists so that the 30+ existing consumers of useFlow()
 * continue to work without changes. Over time, consumers should be migrated
 * to the specific hooks for better performance (fewer re-renders).
 *
 * NOTE: Any state change in any sub-context will cause all useFlow() consumers
 * to re-render. This is the same behavior as the old monolithic context.
 */

import { useFlowGraph } from '../context/FlowGraphContext';
import { useFlowProject } from '../context/FlowProjectContext';
import { useFlowPreferences } from '../context/FlowPreferencesContext';

/**
 * Returns a combined object containing all flow context state and functions.
 *
 * @throws When called outside of a FlowProvider.
 */
export function useFlow() {
	const graph = useFlowGraph();
	const project = useFlowProject();
	const prefs = useFlowPreferences();

	return {
		...graph,
		...project,
		...prefs,
	};
}
