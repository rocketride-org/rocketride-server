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

/**
 * useTemplateInstantiator — Resolves a template + user choices into
 * canvas nodes using positions from the template definition.
 *
 * IMPORTANT: This hook must be called from a component that stays mounted
 * after template instantiation (e.g. FlowCanvas), NOT from a dialog that
 * unmounts when the template is created. The post-instantiation effects
 * (measurement, edge computation, fitView) run across multiple render
 * cycles and will be lost if the host component unmounts.
 *
 * Given a template definition and a map of resolved providers for each
 * `requires` slot, this hook:
 *   1. Builds all nodes with connections in a single setNodes batch
 *   2. Waits for isFlowReady (all nodes measured) via FlowGraphContext
 *   3. Once ready, recomputes edges, updates internals, and calls fitView
 */

import { useCallback, useEffect, useState } from 'react';
import { Node, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';

import { useFlowGraph } from '../context/FlowGraphContext';
import { useFlowProject } from '../context/FlowProjectContext';
import { generateNodeId, getEdgesFromNodes } from '../util/graph';
import { resolveDefaultFormData } from '../util/helpers';
import { validateFormData } from '../util/rjsf';
import type { ITemplate } from '../templates/types';
import type { INodeData, INode } from '../types';

/**
 * Instantiates a template onto the canvas.
 *
 * @returns `instantiateTemplate` — call with a template and a map
 *          of slot-name → chosen provider key.
 */
export function useTemplateInstantiator() {
	const { nodes, loadCanvas, onToolchainUpdated, isFlowReady } = useFlowGraph();
	const { servicesJson } = useFlowProject();
	const { fitView } = useReactFlow();
	const updateNodeInternals = useUpdateNodeInternals();

	// IDs of nodes waiting for measurement before post-ready work
	const [pendingIds, setPendingIds] = useState<string[]>([]);

	// -----------------------------------------------------------------
	// Post-ready: once isFlowReady is true and we have pending nodes,
	// update internals, notify host, and fitView. Handles both the
	// false→true transition (template/loadCanvas) and the case where
	// isFlowReady was already true (single addNode).
	// -----------------------------------------------------------------
	useEffect(() => {
		if (!isFlowReady || pendingIds.length === 0) return;

		// Check that all pending nodes are actually measured
		const allMeasured = pendingIds.every((id) => {
			const node = nodes.find((n) => n.id === id);
			return node?.measured?.width != null;
		});
		if (!allMeasured) return;

		updateNodeInternals(pendingIds);
		setPendingIds([]);

		onToolchainUpdated();
		fitView({ padding: 0.15, duration: 300 });
	}, [isFlowReady, pendingIds, nodes, updateNodeInternals, onToolchainUpdated, fitView]);

	// -----------------------------------------------------------------
	// instantiateTemplate — builds nodes with template positions
	// -----------------------------------------------------------------
	const instantiateTemplate = useCallback(
		(template: ITemplate, resolvedProviders: Record<string, string>): number => {
			const newIds: string[] = [];
			let unconfiguredCount = 0;

			// Read current nodes synchronously via the ref-backed value
			const currentNodes = [...nodes];
			const templateIdToNodeId = new Map<string, string>();
			const allExisting = [...currentNodes];

			// First pass: generate all node IDs
			for (const comp of template.components) {
				const provider = comp.provider ?? resolvedProviders[comp.ref!];
				const id = generateNodeId(allExisting, provider);
				templateIdToNodeId.set(comp.id, id);
				newIds.push(id);
				allExisting.push({ id } as Node<INodeData>);
			}

			// Second pass: build actual nodes with patched connections
			// and resolved config/formData from the service schema
			const newNodes: Node<INodeData>[] = template.components.map((comp, i) => {
				const provider = comp.provider ?? resolvedProviders[comp.ref!];
				const nodeId = templateIdToNodeId.get(comp.id)!;

				const input = comp.input.map((inp) => ({
					lane: inp.lane,
					from: templateIdToNodeId.get(inp.from) ?? inp.from,
				}));

				const control = comp.control.map((ctrl) => ({
					classType: ctrl.classType,
					from: templateIdToNodeId.get(ctrl.from) ?? ctrl.from,
				}));

				// Use template position, fall back to horizontal stagger
				const position = comp.position ?? { x: i * 230, y: 0 };

				// Resolve default config from the service JSON schema
				// (same logic as addNode in FlowGraphContext)
				const service = servicesJson?.[provider];
				const pipe = service?.Pipe as { schema?: Record<string, unknown> } | undefined;
				let formData: Record<string, unknown> = {};
				let formDataValid = true;

				if (pipe?.schema) {
					formData = resolveDefaultFormData(nodeId, pipe.schema);
					const validation = validateFormData(pipe.schema, formData);
					formDataValid = validation.errors.length === 0;
				} else if (service) {
					// Service exists but has no schema — check if it needs config
					const pipeSchema = pipe?.schema as { properties?: Record<string, unknown> } | undefined;
					const hasSchema = pipeSchema?.properties?.hideForm == undefined && pipeSchema?.properties != undefined;
					formDataValid = !hasSchema;
				}

				if (!formDataValid) unconfiguredCount++;

				return {
					id: nodeId,
					type: 'default',
					position,
					data: {
						provider,
						name: '',
						description: '',
						config: formData,
						formData,
						formDataValid,
						input,
						control,
					},
					deletable: true,
					selectable: true,
				};
			});

			// Merge existing + new nodes and compute edges, then load via loadCanvas
			const allNodes = [...currentNodes, ...newNodes];
			const edges = getEdgesFromNodes(allNodes as unknown as INode[]);
			loadCanvas(allNodes, edges);

			// Track new IDs so the post-ready effect can update internals + fitView
			setPendingIds(newIds);

			return unconfiguredCount;
		},
		[nodes, loadCanvas, servicesJson]
	);

	/**
	 * Schedule a fitView. If nodeIds are provided, waits for those nodes
	 * to be measured first (via isFlowReady). Otherwise fires immediately.
	 */
	const requestFitView = useCallback(
		(nodeIds?: string[]) => {
			if (nodeIds && nodeIds.length > 0) {
				setPendingIds(nodeIds);
			} else {
				fitView({ padding: 0.15, duration: 300 });
			}
		},
		[fitView]
	);

	return { instantiateTemplate, requestFitView };
}
