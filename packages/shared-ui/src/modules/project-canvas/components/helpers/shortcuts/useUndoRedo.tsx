// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

import { useState, useCallback, useEffect, useRef } from 'react';
import { Node, Edge } from '@xyflow/react';
import { useFlow } from '../../../FlowContext';
import { produce } from 'immer';
import { INodeData } from '../../../types';

/**
 * Represents a snapshot of the canvas at a point in time, containing nodes and edges.
 * Used by the undo/redo history stack to capture and restore flow state.
 */
interface FlowState {
	nodes: Node[];
	edges: Edge[];
}

/**
 * Strips transient, runtime-only properties (selected, dragging, measured) from nodes
 * and edges so that history comparisons are based solely on meaningful structural changes.
 * Without this cleaning, cosmetic state changes like selection toggling would pollute
 * the undo history.
 */
const cleanState = (flowState: FlowState): FlowState => {
	// Strip transient visual properties from nodes that should not affect history comparison
	const cleanedNodes = flowState.nodes.map((node) => {
		const {
			selected: _selected,
			dragging: _dragging,
			measured: _measured,
			...rest
		} = node;
		return rest as Node;
	});

	// Strip selection state from edges for the same reason
	const cleanedEdges = flowState.edges.map((edge) => {
		const { selected: _selected, ...rest } = edge;
		return rest as Edge;
	});

	return { nodes: cleanedNodes, edges: cleanedEdges };
};

/**
 * Hook that provides undo and redo capabilities for the project canvas.
 * Maintains an internal history stack of cleaned flow states (nodes + edges) and
 * detects meaningful changes while ignoring transient UI state such as dragging and
 * selection. Continuous actions like dragging or form editing are coalesced into a
 * single history entry to keep the stack concise.
 *
 * @param onToolchainUpdated - Optional callback invoked after an undo or redo to trigger
 *   side effects like autosave or dirty-state notification.
 * @returns An object with `undoLastChange`, `redoLastChange`, `canUndo`, and `canRedo`.
 */
export const useUndoRedo = (onToolchainUpdated?: () => void) => {
	const { nodes, edges, setNodes, setEdges } = useFlow();
	// Tracks whether a continuous action (drag or form edit) is ongoing so
	// intermediate states are coalesced into a single history entry
	const isActionInProgress = useRef(false);

	// Initialize history with a cleaned snapshot of the initial canvas state
	const [history, setHistory] = useState<FlowState[]>([cleanState({ nodes, edges })]);
	const [currentIndex, setCurrentIndex] = useState(0);

	useEffect(() => {
		const currentState = { nodes, edges };
		const previousStateFromHistory = history[currentIndex] ?? {
			nodes: [],
			edges: [],
		};

		// Compare cleaned versions to ignore transient properties (selected, dragging, measured)
		const isDifferentFromHistory =
			JSON.stringify(cleanState(currentState)) !== JSON.stringify(previousStateFromHistory);

		// If the state is functionally identical to what is already in history and no
		// continuous action is in flight, skip to prevent a rebound/double-push
		if (!isDifferentFromHistory && !isActionInProgress.current) {
			return;
		}

		// Detect whether the user is in the middle of dragging a node
		const isDragging = currentState.nodes.some((node) => node.dragging);

		// Detect whether the user is editing a node's form (formData changed but node count is stable)
		let isEditingForm = false;
		if (!isDragging && currentState.nodes.length === previousStateFromHistory.nodes.length) {
			for (let i = 0; i < currentState.nodes.length; i++) {
				const currentNode = currentState.nodes[i];
				const previousNode = previousStateFromHistory.nodes[i];
				if (
					currentNode &&
					previousNode &&
					currentNode.id === previousNode.id &&
					JSON.stringify((currentNode.data as INodeData).formData) !==
						JSON.stringify((previousNode.data as INodeData).formData)
				) {
					isEditingForm = true;
					break;
				}
			}
		}

		// For continuous actions (drag / form edit), coalesce changes into the current
		// history slot rather than pushing a new entry on every micro-change
		if (isDragging || isEditingForm) {
			isActionInProgress.current = true;
			// Overwrite the latest history entry in-place with the current cleaned state
			const newHistory = produce(history, (draft) => {
				draft[currentIndex] = cleanState(currentState);
			});

			if (history !== newHistory) {
				setHistory(newHistory);
			}
			return;
		}

		// The continuous action just ended; clear the flag.
		// If state hasn't diverged further, the coalesced entry already captured the result.
		if (isActionInProgress.current) {
			isActionInProgress.current = false;
			if (!isDifferentFromHistory) {
				return;
			}
		}

		// A new, distinct action has occurred -- push a fresh history entry.
		// Discard any redo-future beyond the current index (standard undo behavior).
		const newHistory = history.slice(0, currentIndex + 1);
		let updatedHistory = [...newHistory, cleanState(currentState)];

		// Cap the stack size to prevent unbounded memory growth
		const HISTORY_LIMIT = 25;
		if (updatedHistory.length > HISTORY_LIMIT) {
			updatedHistory = updatedHistory.slice(updatedHistory.length - HISTORY_LIMIT);
		}

		setHistory(updatedHistory);
		setCurrentIndex(updatedHistory.length - 1);

	}, [nodes, edges, currentIndex, history]);

	const undoLastChange = useCallback(() => {
		// Prevent undoing back to an empty initial state (nothing meaningful to restore)
		if (currentIndex === 1 && history[0].nodes.length === 0 && history[0].edges.length === 0) {
			return;
		}

		if (currentIndex > 0) {
			// Step one position back in the history stack and restore that snapshot
			const newIndex = currentIndex - 1;
			const prevState = history[newIndex];
			setNodes(prevState.nodes);
			setEdges(prevState.edges);
			setCurrentIndex(newIndex);
			// Notify the host so autosave / dirty-state is updated after undo
			onToolchainUpdated?.();
		}
	}, [currentIndex, history, setNodes, setEdges, onToolchainUpdated]);

	const redoLastChange = useCallback(() => {
		if (currentIndex < history.length - 1) {
			// Step one position forward and restore the next snapshot
			const newIndex = currentIndex + 1;
			const nextState = history[newIndex];
			setNodes(nextState.nodes);
			setEdges(nextState.edges);
			setCurrentIndex(newIndex);
			// Notify the host so autosave / dirty-state is updated after redo
			onToolchainUpdated?.();
		}
	}, [currentIndex, history, setNodes, setEdges, onToolchainUpdated]);

	return {
		undoLastChange,
		redoLastChange,
		canUndo: currentIndex > 0,
		canRedo: currentIndex < history.length - 1,
	};
};
