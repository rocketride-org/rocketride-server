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
 * FlowGraphContext — Owns the ReactFlow graph state and all mutations.
 *
 * This is the heaviest context and the one that changes most frequently.
 * It manages:
 *
 *   - Nodes and edges (via ReactFlow's useNodesState/useEdgesState)
 *   - A fast node lookup map (nodeMap)
 *   - Node CRUD: addNode, updateNode, deleteNode
 *   - Edge connection/disconnection with bidirectional sync to node.data
 *   - Drag and drop from the create-node panel
 *   - Viewport operations: focusOnNode
 *   - Content-change detection and notification to the host
 *   - Save/load project serialization
 *
 * **Key invariant**: Connections are stored on the TARGET node's data
 * (data.input for lane edges, data.control for invoke edges). Edges
 * are always derived from these arrays, never managed independently.
 * This eliminates edge/node data drift.
 *
 * Reads from:
 *   - FlowPreferencesContext (isLocked — guards all mutations)
 *   - FlowProjectContext (currentProject, servicesJson, onContentChanged, etc.)
 */

import { createContext, ReactElement, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { Connection, Edge, EdgeChange, Node, NodeChange, useEdgesState, useNodesState, useReactFlow, getConnectedEdges } from '@xyflow/react';

import { INode, INodeData, IInputConnection, IControlConnection, IProject, IProjectLayout, INodeType, PIPELINE_SCHEMA_VERSION } from '../types';

/** ReactFlow Node with strongly-typed data. Used throughout this context. */
type FlowNode = Node<INodeData>;

import { getNodesFromProject, getEdgesFromNodes, getProjectComponents, generateNodeId } from '../util/graph';
import { useFlowPreferences } from './FlowPreferencesContext';
import { useFlowProject } from './FlowProjectContext';
import { resolveDefaultFormData } from '../util/helpers';
import { validateFormData } from '../util/rjsf';

// =============================================================================
// Quick-add state (click handle → popup → create + connect)
// =============================================================================

/** State for the quick-add popup triggered by clicking a lane or invoke handle. */
export interface IQuickAddState {
	/** ID of the node whose handle was clicked. */
	nodeId: string;
	/** Handle ID (e.g. "source-data", "target-text", "invoke-source.llm"). */
	handleId: string;
	/** Lane type extracted from the handle ID (e.g. "data", "text"). Unused in invoke mode. */
	laneType: string;
	/** Whether the clicked handle is a source or target. */
	isSource: boolean;
	/** Screen position for the popup. */
	position: { x: number; y: number };
	/** Connection mode: lane (left/right data handles) or invoke (top/bottom control handles). */
	mode: 'lane' | 'invoke';
	/** For invoke-source clicks: the channel key (e.g. "llm"). Undefined for invoke-target or lane mode. */
	invokeKey?: string;
}

// =============================================================================
// Context shape
// =============================================================================

export interface IFlowGraphContext {
	/** Ref to the canvas wrapper div (used for coordinate conversion). */
	canvasRef: React.RefObject<HTMLDivElement>;

	// --- Graph data --------------------------------------------------------

	/** All nodes currently on the canvas. */
	nodes: FlowNode[];

	/** All edges currently on the canvas. */
	edges: Edge[];

	/** Fast O(1) lookup of nodes by ID. */
	nodeMap: Record<string, FlowNode>;

	// --- Node setters (for ReactFlow props) --------------------------------

	/** Direct setter for nodes (used by ReactFlow internals). */
	setNodes: React.Dispatch<React.SetStateAction<FlowNode[]>>;

	/** Direct setter for edges (used by ReactFlow internals). */
	setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;

	// --- ReactFlow event handlers ------------------------------------------

	/** Handles node changes (position, dimensions, selection). Guarded by isLocked. */
	onNodesChange: (changes: NodeChange<FlowNode>[]) => void;

	/** Handles edge changes (removal, selection). Guarded by isLocked. Syncs node.data. */
	onEdgesChange: (changes: EdgeChange[]) => void;

	/** Handles new connections. Guarded by isLocked. Stores on target node, rebuilds edges. */
	onEdgeConnect: (params: Connection) => void;

	/** Validates whether a proposed connection is allowed. Used by ReactFlow for cursor feedback. */
	isValidConnection: (edge: Edge | Connection) => boolean;

	/** Drag-over handler for the canvas (sets dropEffect). */
	onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;

	/** Drop handler for the canvas (creates a node from tempNode). */
	onDrop: (event: React.DragEvent<HTMLDivElement>) => void;

	/** Called when a node drag ends. Handles drop-into-group and notifies the host. */
	onNodeDragStop: (event: React.MouseEvent, node: Node, nodes: Node[]) => void;

	// --- Node CRUD ---------------------------------------------------------

	/**
	 * Creates a new node from service data and appends it to the canvas.
	 *
	 * @param data     - Node data including at minimum a `provider` key.
	 * @param position - Optional canvas position. Defaults to center of viewport.
	 * @param type     - Node type (default: Default).
	 */
	addNode: (data: INodeData, position?: { x: number; y: number }, type?: INodeType) => string;

	/**
	 * Updates a node's data by merging the provided fields.
	 *
	 * @param nodeId - The ID of the node to update.
	 * @param data   - Partial data to merge into node.data.
	 * @returns The updated node, or undefined if not found.
	 */
	updateNode: (nodeId: string, data: Partial<INodeData>) => FlowNode | undefined;

	/**
	 * Deletes one or more nodes by ID.
	 *
	 * @param nodeIds        - IDs of nodes to delete.
	 * @param deleteChildren - When true, also deletes child nodes of groups.
	 */
	deleteNode: (nodeIds: string[], deleteChildren?: boolean) => void;

	/** Callback after nodes are deleted (cleanup edges, close panels). */
	onNodesDelete: (deletedNodes: FlowNode[]) => void;

	// --- Drag state --------------------------------------------------------

	/** Temporary node data set during drag from the create-node panel. */
	tempNode?: INodeData;

	/** Sets/clears the temporary node for drag and drop. */
	setTempNode: (node?: INodeData) => void;

	// --- Viewport ----------------------------------------------------------

	/** Centers the viewport on a specific node with animation. */
	focusOnNode: (nodeId: string) => void;

	// --- Persistence -------------------------------------------------------

	/** ID of the node whose config panel is open (undefined = closed). */
	editingNodeId: string | undefined;

	/** Opens or closes the config panel for a node. Pass undefined to close. */
	setEditingNodeId: (nodeId: string | undefined) => void;

	/** Marks the project as dirty and notifies the host of content changes. */
	onContentUpdated: () => void;

	// --- Quick-add popup ---------------------------------------------------

	/** When set, the quick-add popup is shown at the given position. */
	quickAddState: IQuickAddState | null;

	/** Opens the quick-add popup for a handle click. */
	setQuickAddState: (state: IQuickAddState | null) => void;

	/**
	 * Loads a project into the canvas, replacing all nodes and edges.
	 *
	 * @param project - The project to load.
	 */
	loadData: (project: IProject) => void;

	/**
	 * Low-level canvas loader. Sets nodes and edges, resets isFlowReady,
	 * and guards against spurious content-change notifications until
	 * ReactFlow has measured all nodes.
	 *
	 * Use loadData for project loads (handles layout prefs + viewport).
	 * Use loadCanvas directly when building nodes programmatically
	 * (e.g. template instantiation).
	 *
	 * @param nodes - Nodes to set on the canvas.
	 * @param edges - Edges to set on the canvas.
	 */
	loadCanvas: (nodes: FlowNode[], edges: Edge[]) => void;

	/**
	 * True once ReactFlow has rendered and measured all nodes after a
	 * structural change (loadData, loadCanvas, addNode).
	 * Resets to false when nodes change structurally, flips to true
	 * when all nodes have measured dimensions.
	 */
	isFlowReady: boolean;
}

const FlowGraphContext = createContext<IFlowGraphContext | null>(null);

// =============================================================================
// Helpers
// =============================================================================

/**
 * Sorts nodes so that parents always appear before their children.
 * Required by ReactFlow for parentId relationships to work.
 */
function sortNodesParentFirst(nodes: FlowNode[]): FlowNode[] {
	const nodeMap = new Map(nodes.map((n) => [n.id, n]));
	const sorted: FlowNode[] = [];
	const visited = new Set<string>();

	const visit = (node: FlowNode) => {
		if (visited.has(node.id)) return;
		if (node.parentId) {
			const parent = nodeMap.get(node.parentId);
			if (parent) visit(parent);
		}
		visited.add(node.id);
		sorted.push(node);
	};

	for (const node of nodes) visit(node);
	return sorted;
}

// =============================================================================
// Provider props
// =============================================================================

export interface IFlowGraphProviderProps {
	children: ReactNode;
}

// =============================================================================
// Provider
// =============================================================================

/**
 * Provides the complete graph state and all mutation operations.
 *
 * Must be nested inside FlowPreferencesProvider and FlowProjectProvider
 * so it can read isLocked, currentProject, servicesJson, etc.
 */
export function FlowGraphProvider({ children }: IFlowGraphProviderProps): ReactElement {
	const { isLocked, projectLayout, updateProjectLayout } = useFlowPreferences();
	const { currentProject, initialViewport, servicesJson, onContentChanged, patchToolchainState } = useFlowProject();

	// --- ReactFlow hooks ---------------------------------------------------

	const [nodes, setNodes, onNodesChangeInternal] = useNodesState<FlowNode>([]);
	const [edges, setEdges, onEdgesChangeInternal] = useEdgesState<Edge>([]);
	const { screenToFlowPosition, getNode, setCenter, setViewport, fitView, getIntersectingNodes, deleteElements } = useReactFlow();

	// --- Refs --------------------------------------------------------------

	const canvasRef = useRef<HTMLDivElement | null>(null);

	/** True while loadData is replacing all nodes/edges. Prevents onNodesChange from notifying the host. */
	const isLoadingRef = useRef(false);

	/** True once ReactFlow has measured all nodes after a structural change. */
	const [isFlowReady, setFlowReady] = useState(false);

	/** The last docRevision number we sent to the host. -1 ensures initial load always runs. */
	const lastSentVersion = useRef(-1);
	/** The project_id we last loaded — used to bypass echo-detection when project identity changes. */
	const lastLoadedProjectId = useRef<string | undefined>(undefined);

	// --- Derived state -----------------------------------------------------

	/** O(1) node lookup by ID. Rebuilt whenever nodes change. */
	const nodeMap = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes]);

	// --- Temp node for drag-and-drop from create panel ---------------------

	const [tempNode, setTempNode] = useState<INodeData | undefined>(undefined);

	/** ID of the node whose config panel is open (undefined = closed). */
	const [editingNodeId, setEditingNodeId] = useState<string | undefined>(undefined);
	const [quickAddState, setQuickAddState] = useState<IQuickAddState | null>(null);

	// =====================================================================
	// Content change notification
	// =====================================================================

	/** Ref to the latest nodes array so deferred callbacks always read current state. */
	const nodesRef = useRef(nodes);
	nodesRef.current = nodes;

	/** Ref to the latest currentProject so deferred callbacks always read current state. */
	const currentProjectRef = useRef(currentProject);
	currentProjectRef.current = currentProject;

	/** Ref to the latest projectLayout so onContentUpdated reads current values without re-creating. */
	const projectLayoutRef = useRef(projectLayout);
	projectLayoutRef.current = projectLayout;

	/**
	 * Marks the project as dirty and notifies the host of content changes.
	 *
	 * Rebuilds the component tree from the current canvas nodes via
	 * getProjectComponents and sends the full project to the host.
	 *
	 * Defers serialization by 50ms so React has committed the latest
	 * nodes/edges before we snapshot the graph.
	 */
	const onContentUpdated = useCallback(() => {
		patchToolchainState({ isUpdated: true, isSaved: false });

		if (!onContentChanged || isLoadingRef.current) return;

		setTimeout(() => {
			const components = getProjectComponents(nodesRef.current as INode[]);
			const nextVersion = (lastSentVersion.current ?? 0) + 1;
			const layout = projectLayoutRef.current;
			const project: IProject = {
				...currentProjectRef.current,
				components,
				isLocked: layout.isLocked,
				snapToGrid: layout.snapToGrid,
				snapGridSize: layout.snapGridSize,
				version: PIPELINE_SCHEMA_VERSION,
				docRevision: nextVersion,
			};
			// Remove viewport from content — it's a user preference, not document content
			delete (project as any).viewport;
			lastSentVersion.current = nextVersion;
			onContentChanged(project);
		}, 50);
	}, [onContentChanged, patchToolchainState]);

	// =====================================================================
	// ReactFlow event handlers (guarded by isLocked)
	// =====================================================================

	/**
	 * Handles node changes from ReactFlow (position, dimensions, selection, add, remove).
	 *
	 * Position changes during drag are handled by ReactFlow internally — we
	 * only notify the host on structural changes (add/remove). Position changes
	 * are captured on drag end via onNodeDragStop.
	 */
	const onNodesChange = useCallback(
		(changes: NodeChange<FlowNode>[]) => {
			if (isLocked) return;

			// Only fire content change for structural modifications, not position/select
			const structural = changes.some((c) => c.type === 'add' || c.type === 'remove');
			if (structural) onContentUpdated();

			onNodesChangeInternal(changes);
		},
		[isLocked, onNodesChangeInternal, onContentUpdated]
	);

	/**
	 * Called when a node drag operation completes.
	 *
	 * Detects whether dragged nodes were dropped inside (or pulled out of)
	 * a group node and updates parentId / position accordingly. Supports
	 * nested groups while preventing circular references.
	 */
	const onNodeDragStop = useCallback(
		(_event: React.MouseEvent, _node: Node, draggedNodes: Node[]) => {
			let changed = false;

			setNodes((nds) => {
				const nodeMap = new Map(nds.map((n) => [n.id, n]));

				const isDescendant = (ancestorId: string, candidateId: string): boolean => {
					const visited = new Set<string>();
					let current = nodeMap.get(candidateId);
					while (current?.parentId) {
						if (visited.has(current.id)) return false;
						visited.add(current.id);
						if (current.parentId === ancestorId) return true;
						current = nodeMap.get(current.parentId);
					}
					return false;
				};

				const getAbsolutePosition = (node: Node): { x: number; y: number } => {
					let x = node.position.x;
					let y = node.position.y;
					let parent = node.parentId ? nodeMap.get(node.parentId) : undefined;
					while (parent) {
						x += parent.position.x;
						y += parent.position.y;
						parent = parent.parentId ? nodeMap.get(parent.parentId) : undefined;
					}
					return { x, y };
				};

				const draggedIds = new Set(draggedNodes.map((n) => n.id));

				const updated = nds.map((n) => {
					if (!draggedIds.has(n.id)) return n;

					const intersecting = getIntersectingNodes(n).filter((candidate) => candidate.type === INodeType.Group && candidate.id !== n.id && !isDescendant(n.id, candidate.id));

					const targetGroup =
						intersecting.length > 0
							? intersecting.reduce((smallest, g) => {
									const sw = (smallest.measured?.width ?? 0) * (smallest.measured?.height ?? 0);
									const gw = (g.measured?.width ?? 0) * (g.measured?.height ?? 0);
									return gw < sw ? g : smallest;
								})
							: undefined;

					const currentParentId = n.parentId;
					const newParentId = targetGroup?.id;

					if (currentParentId === newParentId) return n;

					changed = true;
					const absPos = getAbsolutePosition(n);

					if (newParentId) {
						const parentAbsPos = getAbsolutePosition(nodeMap.get(newParentId)!);
						return {
							...n,
							parentId: newParentId,
							position: {
								x: absPos.x - parentAbsPos.x,
								y: absPos.y - parentAbsPos.y,
							},
						};
					} else {
						return {
							...n,
							parentId: undefined,
							extent: undefined,
							position: absPos,
						};
					}
				});

				if (!changed) return nds;

				return sortNodesParentFirst(updated as FlowNode[]);
			});

			onContentUpdated();
		},
		[setNodes, getIntersectingNodes, onContentUpdated]
	);

	/**
	 * Validates whether a proposed connection is allowed.
	 *
	 * ReactFlow may pass source/target in either direction depending on
	 * which handle the user started dragging from. For invoke connections,
	 * we normalize so that "source" is always the invoke-source handle
	 * and "target" is always invoke-target.
	 */
	const isValidConnection = useCallback(
		(edge: Edge | Connection): boolean => {
			// No self-connections
			if (edge.source === edge.target) return false;

			const { sourceHandle, targetHandle } = edge;

			// Invoke connection — both handles start with "invoke-"
			if (sourceHandle?.startsWith('invoke-') && targetHandle?.startsWith('invoke-')) {
				let srcId = edge.source;
				let tgtId = edge.target;
				let srcHandle = sourceHandle;

				// Normalize: if user dragged from target to source, swap
				if (sourceHandle === 'invoke-target') {
					srcId = edge.target;
					tgtId = edge.source;
					srcHandle = targetHandle;
				}

				const sourceNode = nodeMap[srcId];
				const targetNode = nodeMap[tgtId];

				if (sourceNode?.parentId != targetNode?.parentId) return false;

				const invokeKey = srcHandle.split('.').at(1) ?? '';
				const targetData = targetNode?.data as INodeData;
				const targetService = servicesJson[targetData?.provider ?? ''];
				const targetClassType = targetService?.classType ?? [];
				const valid = targetClassType.includes(invokeKey);

				return valid;
			}

			// Lane validation — source lane type must match target lane type
			// Handle IDs are "source-{type}" and "target-{type}"
			const sourceLaneType = sourceHandle?.split('-')?.[1];
			const targetLaneType = targetHandle?.split('-')?.[1];
			const valid = sourceLaneType === targetLaneType;

			return valid;
		},
		[nodeMap, servicesJson]
	);

	const onEdgesChange = useCallback(
		(changes: EdgeChange[]) => {
			if (isLocked) return;

			// Intercept edge removals to sync node.data before removing the edge
			const removeChanges = changes.filter((c) => c.type === 'remove');

			if (removeChanges.length > 0) {
				setNodes((nds) => {
					const currentEdges = edges;
					const updatedNodes = nds.map((node) => {
						let updated = { ...node };

						removeChanges.forEach((change) => {
							const edgeToRemove = currentEdges.find((e) => e.id === change.id);
							if (!edgeToRemove || edgeToRemove.target !== node.id) return;

							const nd = updated.data as INodeData;

							if (edgeToRemove.sourceHandle?.startsWith('invoke-source')) {
								// Remove matching control connection
								const control: IControlConnection[] = nd.control || [];
								updated = {
									...updated,
									data: {
										...updated.data,
										control: control.filter((c: IControlConnection) => c.from !== edgeToRemove.source),
									},
								};
							} else {
								// Remove matching lane input by source + lane
								const lane = edgeToRemove.sourceHandle?.split('-')?.at(1) ?? '';
								const input: IInputConnection[] = nd.input || [];
								updated = {
									...updated,
									data: {
										...updated.data,
										input: input.filter((i: IInputConnection) => !(i.from === edgeToRemove.source && i.lane === lane)),
									},
								};
							}
						});

						return updated;
					});

					// Rebuild edges from the cleaned node data
					const computedEdges = getEdgesFromNodes(updatedNodes as INode[]);
					setEdges(computedEdges);

					return updatedNodes;
				});
			} else {
				// Non-removal changes (select, etc.) go straight through
				onEdgesChangeInternal(changes);
			}

			onContentUpdated();
		},
		[isLocked, edges, setNodes, setEdges, onEdgesChangeInternal, onContentUpdated]
	);

	const onEdgeConnect = useCallback(
		(params: Connection) => {
			if (isLocked) return;

			// Store the connection on the TARGET node's data, then rebuild edges
			setNodes((nds) => {
				const updatedNodes = nds.map((node) => {
					if (node.id !== params.target) return node;

					const nd = node.data as INodeData;

					if (params.sourceHandle?.startsWith('invoke-source')) {
						// Invoke (control-flow) connection — extract classType from the source handle
						// e.g. "invoke-source.llm" → "llm"
						const classType = params.sourceHandle?.split('.').at(1) ?? '';
						const control: IControlConnection[] = nd.control || [];
						return {
							...node,
							data: {
								...node.data,
								control: [...control, { classType, from: params.source }],
							},
						};
					} else {
						// Lane (data-flow) connection
						const lane = params.sourceHandle?.split('-')?.at(1) ?? '';
						const input: IInputConnection[] = nd.input || [];
						return {
							...node,
							data: {
								...node.data,
								input: [...input, { lane, from: params.source }],
							},
						};
					}
				});

				const computedEdges = getEdgesFromNodes(updatedNodes as INode[]);
				setEdges(computedEdges);

				return updatedNodes;
			});

			onContentUpdated();
		},
		[isLocked, setNodes, setEdges, onContentUpdated]
	);

	// =====================================================================
	// Drag and drop
	// =====================================================================

	const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
	}, []);

	const onDrop = useCallback(
		(event: React.DragEvent<HTMLDivElement>) => {
			if (isLocked) return;
			event.preventDefault();
			if (!tempNode) return;

			const position = screenToFlowPosition({
				x: event.clientX,
				y: event.clientY,
			});

			// Route to the appropriate add function based on provider type
			addNode(tempNode, position);
			setTempNode(undefined);
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[isLocked, tempNode, screenToFlowPosition]
	);

	// =====================================================================
	// Node CRUD
	// =====================================================================

	/**
	 * Determines the initial formDataValid state for a new node by
	 * checking whether its service schema requires configuration.
	 *
	 * A node requires config when its Pipe schema has properties
	 * (excluding the hideForm flag). Nodes without schemas or with
	 * hideForm set are considered valid by default.
	 *
	 * Matches the logic from the old factory code in factories.ts.
	 */
	const getInitialFormDataValid = useCallback(
		(data: INodeData): boolean => {
			if (data.formDataValid !== undefined) return data.formDataValid;
			const service = servicesJson?.[data.provider];
			if (!service) return true;
			const pipe = service.Pipe as { schema?: { properties?: Record<string, unknown> } } | undefined;
			const hasSchema = pipe?.schema?.properties?.hideForm == undefined && pipe?.schema?.properties != undefined;
			return hasSchema ? false : true;
		},
		[servicesJson]
	);

	/**
	 * Low-level canvas loader. Sets nodes/edges, guards against spurious
	 * content-change notifications, and resets isFlowReady so downstream
	 * effects wait until ReactFlow has measured all nodes.
	 */
	const loadCanvas = useCallback(
		(newNodes: FlowNode[], newEdges: Edge[]) => {
			isLoadingRef.current = true;
			setFlowReady(false);
			setNodes(newNodes);
			setEdges(newEdges);
		},
		[setNodes, setEdges]
	);

	const addNode = useCallback(
		(data: INodeData, position?: { x: number; y: number }, type: INodeType = INodeType.Default): string => {
			const id = generateNodeId(nodes, data.provider);

			// Default to center of viewport if no position given, then search
			// outward in a spiral pattern to find the nearest non-overlapping spot.
			let nodePosition =
				position ??
				screenToFlowPosition({
					x: (canvasRef.current?.clientWidth ?? 800) / 2,
					y: (canvasRef.current?.clientHeight ?? 600) / 2,
				});

			if (!position) {
				const estW = 200;
				const estH = 80;
				const gap = 20;
				const stepX = estW + gap;
				const stepY = estH + gap;
				const overlaps = (x: number, y: number) =>
					nodes.some((n) => {
						const nw = n.measured?.width ?? 200;
						const nh = n.measured?.height ?? 80;
						return x < n.position.x + nw && x + estW > n.position.x && y < n.position.y + nh && y + estH > n.position.y;
					});
				const cx = nodePosition.x;
				const cy = nodePosition.y;
				if (overlaps(cx, cy)) {
					let found = false;
					for (let ring = 1; ring <= 10 && !found; ring++) {
						for (let dy = -ring; dy <= ring && !found; dy++) {
							for (let dx = -ring; dx <= ring && !found; dx++) {
								if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
								const tx = cx + dx * stepX;
								const ty = cy + dy * stepY;
								if (!overlaps(tx, ty)) {
									nodePosition = { x: tx, y: ty };
									found = true;
								}
							}
						}
					}
				}
			}

			// Resolve default config from the service JSON schema (same as old FlowContext)
			const service = servicesJson?.[data.provider];
			const pipe = service?.Pipe as { schema?: Record<string, unknown> } | undefined;
			let formData = data.formData ?? {};
			let formDataValid = getInitialFormDataValid(data);

			if (pipe?.schema && Object.keys(formData).length === 0) {
				formData = resolveDefaultFormData(id, pipe.schema);
				const validation = validateFormData(pipe.schema, formData);
				formDataValid = validation.errors.length === 0;
			}

			// config is the persisted form data — use resolved defaults if empty
			const config = data.config && Object.keys(data.config).length > 0 ? { ...data.config } : { ...formData };

			// Default the display name from the service catalog if not already set
			if (!config.name && service?.title) {
				config.name = service.title;
			}

			// Default the node display name from the service catalog
			const name = data.name || config.name || service?.title || data.provider;

			const node: FlowNode = {
				id,
				type,
				position: nodePosition,
				data: {
					...data,
					name,
					config,
					formData,
					formDataValid,
					input: data.input ?? [],
					control: data.control ?? [],
				},
				deletable: true,
				selectable: true,
			};

			const allNodes = [...nodes, node];
			const allEdges = getEdgesFromNodes(allNodes as unknown as INode[]);
			loadCanvas(allNodes, allEdges);

			// Notify host immediately with the new project state.
			// loadCanvas sets isLoading=true which blocks onContentUpdated,
			// so we build the project directly from allNodes instead.
			if (onContentChanged) {
				const components = getProjectComponents(allNodes as unknown as INode[]);
				const layout = projectLayoutRef.current;
				const project: IProject = {
					...currentProjectRef.current,
					components,
					isLocked: layout.isLocked,
					snapToGrid: layout.snapToGrid,
					snapGridSize: layout.snapGridSize,
					version: PIPELINE_SCHEMA_VERSION,
				};
				delete (project as any).viewport;
				onContentChanged(project);
			}

			return id;
		},
		[nodes, screenToFlowPosition, loadCanvas, getInitialFormDataValid, servicesJson, onContentChanged]
	);

	const updateNode = useCallback(
		(nodeId: string, data: Partial<INodeData>): FlowNode | undefined => {
			let updatedNode: FlowNode | undefined;

			setNodes((nds: FlowNode[]) =>
				nds.map((n: FlowNode) => {
					if (n.id !== nodeId) return n;
					updatedNode = { ...n, data: { ...n.data, ...data } };
					return updatedNode;
				})
			);

			return updatedNode;
		},
		[setNodes]
	);

	const deleteNode = useCallback(
		(nodeIds: string[], deleteChildren: boolean = false) => {
			const ids = new Set(nodeIds);
			const nodesToRemove = nodes.filter((n: FlowNode) => ids.has(n.id));
			const parentMap = Object.fromEntries(nodesToRemove.map((n) => [n.id, n]));

			// Identify child nodes that would be orphaned
			const childNodeIds = new Set(nodes.filter((n: FlowNode) => n.parentId != null && ids.has(n.parentId)).map((n) => n.id));

			// Promote children to top-level before deleting parents
			setNodes((nds: FlowNode[]) =>
				nds.map((n: FlowNode) => {
					if (!childNodeIds.has(n.id)) return n;
					const parent = parentMap[n.parentId!];
					return {
						...n,
						position: {
							x: (parent?.position.x ?? 0) + n.position.x,
							y: (parent?.position.y ?? 0) + n.position.y,
						},
						parentId: undefined,
						extent: undefined,
					};
				})
			);

			// Build the final list of nodes to delete
			let toDelete = nodesToRemove;
			if (deleteChildren) {
				const childNodes = nodes.filter((n) => childNodeIds.has(n.id));
				toDelete = [...toDelete, ...childNodes];
			}

			deleteElements({ nodes: toDelete });
		},
		[nodes, setNodes, deleteElements]
	);

	const onNodesDelete = useCallback(
		(deletedNodes: FlowNode[]) => {
			// Remove all edges connected to any of the deleted nodes in one pass
			const connected = getConnectedEdges(deletedNodes, edges);
			const connectedSet = new Set(connected.map((e) => e.id));
			setEdges(edges.filter((e) => !connectedSet.has(e.id)));
		},
		[edges, setEdges]
	);

	// =====================================================================
	// Viewport
	// =====================================================================

	const focusOnNode = useCallback(
		(nodeId: string) => {
			const node = getNode(nodeId);
			if (node?.position) {
				setCenter(node.position.x + 200, node.position.y, {
					zoom: 2,
					duration: 800,
				});
			}
		},
		[getNode, setCenter]
	);

	// =====================================================================
	// Persistence
	// =====================================================================

	/**
	 * Loads a project into the canvas, replacing all nodes and edges.
	 *
	 * Converts the IProject component tree into INode[] and derives
	 * edges from the node connection data. Restores the viewport if
	 * a saved viewport exists in project layout preferences.
	 */
	/** Viewport to restore once isFlowReady becomes true. */
	const pendingViewportRef = useRef<{ x: number; y: number; zoom: number } | 'fitView' | null>(null);

	/**
	 * Loads a full project into the canvas. Converts the IProject component
	 * tree into nodes/edges via loadCanvas, syncs layout preferences, and
	 * queues viewport restoration for when isFlowReady transitions to true.
	 */
	const loadData = useCallback(
		(project: IProject) => {
			const newNodes = getNodesFromProject(project);
			const sortedNodes = sortNodesParentFirst(newNodes as FlowNode[]);
			const newEdges = getEdgesFromNodes(sortedNodes);

			loadCanvas(sortedNodes, newEdges);

			// Sync layout preferences from the project document
			const layoutPatch: Partial<IProjectLayout> = {};
			if (project.isLocked !== undefined) layoutPatch.isLocked = project.isLocked;
			if (project.snapToGrid !== undefined) layoutPatch.snapToGrid = project.snapToGrid;
			if (project.snapGridSize !== undefined) layoutPatch.snapGridSize = project.snapGridSize;
			if (Object.keys(layoutPatch).length > 0) {
				updateProjectLayout(layoutPatch);
			}

			// Queue viewport restoration — from initialViewport prop (passed separately by host)
			if (initialViewport) {
				pendingViewportRef.current = initialViewport;
			} else if (sortedNodes.length > 0) {
				pendingViewportRef.current = 'fitView';
			} else {
				pendingViewportRef.current = null;
			}
		},
		[loadCanvas, updateProjectLayout]
	);

	// --- Detect when ReactFlow has measured all nodes -----------------------
	// Transitions isFlowReady:
	//   false → true: when all nodes have measured dimensions (or canvas is empty)
	//   true → false: when unmeasured nodes appear (e.g. template instantiation, addNode)
	useEffect(() => {
		const allMeasured = nodes.length === 0 || nodes.every((n) => n.measured?.width != null);
		if (allMeasured && !isFlowReady) {
			setFlowReady(true);
		} else if (!allMeasured && isFlowReady) {
			setFlowReady(false);
		}
	}, [nodes, isFlowReady]);

	// --- Load project on mount / when host sends a new docRevision ----------
	// Reloads the canvas whenever the host sends a project with a different
	// docRevision than what we last sent. Our own changes increment docRevision
	// before sending, so echoed updates match lastSentVersion and are skipped.
	// Undo/redo sends an older docRevision, which triggers a reload.

	const incomingVersion = currentProject?.docRevision ?? 0;
	const incomingProjectId = currentProject?.project_id;

	useEffect(() => {
		if (!currentProject) return;

		const projectChanged = incomingProjectId !== lastLoadedProjectId.current;

		// Skip if this is an echo of our own change — but always load when project identity changes
		if (!projectChanged && incomingVersion === lastSentVersion.current) return;

		lastSentVersion.current = incomingVersion;
		lastLoadedProjectId.current = incomingProjectId;
		loadData(currentProject);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [incomingVersion, incomingProjectId]);

	// --- Restore viewport + clear loading guard when flow is ready ----------
	useEffect(() => {
		if (!isFlowReady) return;

		const pending = pendingViewportRef.current;
		pendingViewportRef.current = null;

		if (pending === 'fitView') {
			fitView({ padding: 0.15, duration: 0 });
		} else if (pending) {
			setViewport(pending, { duration: 0 });
		}

		isLoadingRef.current = false;
	}, [isFlowReady, fitView, setViewport]);

	// =====================================================================
	// Context value
	// =====================================================================

	const value: IFlowGraphContext = {
		canvasRef,
		nodes,
		edges,
		nodeMap,
		setNodes,
		setEdges,
		onNodesChange,
		onEdgesChange,
		onEdgeConnect,
		isValidConnection,
		onDragOver,
		onDrop,
		onNodeDragStop,
		addNode,
		updateNode,
		deleteNode,
		onNodesDelete,
		tempNode,
		setTempNode,
		focusOnNode,
		editingNodeId,
		setEditingNodeId,
		onContentUpdated,
		loadData,
		loadCanvas,
		isFlowReady,
		quickAddState,
		setQuickAddState,
	};

	return <FlowGraphContext.Provider value={value}>{children}</FlowGraphContext.Provider>;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Returns the flow graph context.
 *
 * @throws When called outside of a FlowGraphProvider.
 */
export function useFlowGraph(): IFlowGraphContext {
	const ctx = useContext(FlowGraphContext);
	if (!ctx) {
		throw new Error('useFlowGraph must be used within a FlowGraphProvider');
	}
	return ctx;
}
