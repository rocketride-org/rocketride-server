// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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
 * FlowContext -- the central state and action provider for the project canvas.
 *
 * This module defines:
 * - `IFlowContext` -- the context shape exposing all canvas state, node/edge operations,
 *   panel toggles, project save/run/abort actions, and host callbacks.
 * - `FlowProvider` -- the React context provider that initialises ReactFlow state,
 *   wires up event handlers, and manages the full lifecycle of the pipeline editor.
 * - `useFlow` -- a convenience hook that consumes the context with a guard.
 */
import {
	Dispatch,
	ReactElement,
	ReactNode,
	RefObject,
	SetStateAction,
	createContext,
	useCallback,
	useContext,
	useState,
	useEffect,
	useMemo,
	useRef,
	MouseEvent,
} from 'react';

import {
	useNodesState,
	useEdgesState,
	useReactFlow,
	getConnectedEdges,
	Edge,
	Node,
	useOnSelectionChange,
	NodeChange,
	EdgeChange,
	Connection,
	Viewport,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';

import { uuid } from '../../utils/uuid';
import { getNativeQueryParam } from '../../utils/query-helper';
import { getDefaultFormState, validateFormData } from '../../utils/rjsf';

import { FlowFeatures, DEFAULT_FLOW_FEATURES } from './types/features';
import {
	generateId,
	propertyToObject,
	objectToProperty,
	getNodePositionInsideParent,
	getDefaultNodePosition,
	computeEdgesFromNodes,
} from './helpers';
import {
	ActionsType,
	defaultToolchainState,
	IToolchainState,
	NavigationMode,
	NodePosition,
	NodeType,
} from './constants';

import {
	createAnnotationNode,
	createRemoteGroupNode,
	createNode,
	createGroupNode,
} from './factories';
import { useImportExport, ExportOptions } from './hooks/useImportExport';
import { useNavigationMode } from './hooks/useNavigationMode';

import { useSnackbar } from '../../contexts/snackbar/SnackbarContext';

import {
	IProject,
	IToolchainExport,
	IValidateResponse,
	IControl,
	IInputLane,
	INodeData,
	TaskStatus,
	TASK_STATE,
} from './types';
import { IDynamicForms } from '../../services/dynamic-forms/types';
import { resolveDefaultFormData } from '../../services/dynamic-forms/utils';


/**
 * Tuple representing a selected handle: [nodeId, handleId, laneKeys, optionalInputKey].
 * Used to track which output/input handle the user clicked so the create-node panel
 * can auto-connect the new node to that handle.
 */
type NodeHandleSelection = [string, string, string[], string?];

/**
 * Shape of the FlowContext value.
 *
 * Exposes all canvas state (nodes, edges, selection, panel, toolchain state),
 * ReactFlow event handlers, node CRUD operations, project save/run/abort actions,
 * import/export functionality, and pass-through host callbacks.
 */
export interface IFlowContext {
	canvasRef: RefObject<HTMLDivElement | null>;

	// State
	currentProject: IProject;
	toolchainState: IToolchainState;
	toggleDevMode: () => void;
	features: FlowFeatures;
	/** User-controlled canvas lock; when true, nodes/edges cannot be edited. */
	isLocked: boolean;
	/** Toggles the canvas lock. */
	handleLock: () => void;
	nodeIdsWithErrors: string[];
	nodeIdToRerun: string | null;

	edges: Edge[];
	nodes: Node[];

	selectedNode: Node | undefined;
	selectedNodeId: string | undefined;
	setSelectedNodeId: Dispatch<SetStateAction<string | undefined>>;
	selectedHandle: NodeHandleSelection | undefined;
	hoveredGroupNodeId: string | undefined;

	actionPannelBlocked: boolean;
	actionsPanelType: string | undefined;
	actionsPanelData: Record<string, unknown>;

	// ReactFlow Events
	onEditNode: () => void;
	onNodeClick: (node: Node) => void;
	onDoubleClickNode: (node: Node) => void;
	onHandleClick: (nodeId: string, handleId: string, keys: string[], inputKey?: string) => void;
	onNodesChange: (changes: NodeChange[]) => void;
	onEdgesChange: (changes: EdgeChange[]) => void;
	onEdgeConnect: (params: Connection) => void;
	onNodeDrag: (event: MouseEvent, node: Node) => void;
	onNodeDragStop: (event: MouseEvent, node: Node) => void;
	onDragOver: (event: DragEvent) => void;
	onDrop: (event: DragEvent) => void;

	navigationMode: NavigationMode;
	setNavigationMode: (mode: NavigationMode) => void;
	selectedNodes: Node[];
	groupSelectedNodes: (size: { width: number; height: number }, position: NodePosition) => void;
	setViewport: (viewport: Viewport, options?: { duration?: number }) => void;
	getViewport: () => Viewport;
	focusOnNode: (nodeId: string) => void;

	// Node Actions
	setSelectedNode: (nodeId?: string) => void;
	setSelectedHandle: (nodeId?: string, handleId?: string, keys?: string[], inputKey?: string) => void;
	setTempNode: Dispatch<SetStateAction<Record<string, unknown> | undefined>>;
	addNode: (data: Record<string, unknown>, position?: NodePosition, type?: NodeType) => void;
	addAnnotationNode: () => void;
	addRemoteGroupNode: (data: Record<string, unknown>, position?: NodePosition) => void;
	updateNode: (nodeId: string, data: Record<string, unknown>) => Node | undefined;
	onNodesDelete: (deletedNodes: Node[]) => void;
	deleteNodesById: (nodeIds: string[], deleteChildren?: boolean) => void;
	ungroupNode: (nodeIds: string[]) => void;
	toggleGroupLock: (groupId: string) => void;
	setNodes: Dispatch<SetStateAction<Node[]>>;
	setEdges: Dispatch<SetStateAction<Edge[]>>;
	setSelectedNodes: Dispatch<SetStateAction<Node[]>>;
	onToolchainUpdated: () => void;

	// Panel Actions
	toggleActionsPanel: (type?: ActionsType, data?: Record<string, unknown>) => void;
	setActionPanelBlocked: Dispatch<SetStateAction<boolean>>;

	// Project Actions
	saveChanges: (data?: Partial<IProject>) => Promise<unknown>;
	runPipeline: (nodeId: string) => Promise<boolean | undefined>;
	abortPipeline: (nodeId: string) => Promise<void>;

	nodeMap: Record<string, Node>;

	exportToolchain: () => Promise<boolean>;
	importToolchain: (data: IToolchainExport) => Promise<void>;
	exportOptions: ExportOptions;
	setExportOptions: Dispatch<SetStateAction<ExportOptions>>;

	// Passing props down
	projects: Record<string, IProject>[];
	taskStatuses?: Record<string, TaskStatus>;
	componentPipeCounts?: Record<string, number>;
	totalPipes?: number;
	inventory?: Record<string, unknown>;
	servicesJson?: Record<string, unknown>;
	servicesJsonError?: string;
	inventoryConnectorTitleMap?: Record<string, string>;
	handleValidatePipeline?: (pipeline: IProject) => Promise<IValidateResponse>;
	oauth2RootUrl: string;

	// Optional host callbacks
	isAutosaveEnabled?: boolean;
	onAutosaveEnabledChange?: (enabled: boolean) => void;
	onOpenLink?: (url: string) => void;
	getPreference?: (key: string) => unknown;
	setPreference?: (key: string, value: unknown) => void;
	onRegisterPanelActions?: (actions: { toggleActionsPanel?: (type?: ActionsType) => void }) => void;
	onOpenLogHistory?: () => void;
	googlePickerDeveloperKey?: string;
	googlePickerClientId?: string;
}

/** React context instance for the flow/canvas state. Initialised to `null` and guarded by `useFlow`. */
const FlowContext = createContext<IFlowContext | null>(null);

/**
 * Props accepted by the {@link FlowProvider} component.
 * The host supplies project data, service definitions, feature flags,
 * and all callback handlers for save, run, stop, and validation.
 */
interface IProps {
	children: ReactNode;
	/** Root OAuth2 URL for the refresh path (lambda) passed to the services OAuth2 endpoint. Required. */
	oauth2RootUrl: string;
	project: IProject;
	projects?: Record<string, IProject>[];
	panel?: string;
	activeNodeId?: string;
	features?: FlowFeatures;
	taskStatuses?: Record<string, TaskStatus>;
	componentPipeCounts?: Record<string, number>;
	totalPipes?: number;
	inventory?: Record<string, unknown>;
	servicesJson?: Record<string, unknown>;
	servicesJsonError?: string;
	inventoryConnectorTitleMap?: Record<string, string>;
	runPipeline: (pipeline: IProject) => Promise<void>;
	stopPipeline: (projectId: string, source: string) => void;
	saveProject?: (project: IProject) => Promise<void>;
	handleValidatePipeline?: (pipeline: IProject) => Promise<IValidateResponse>;
	onAddNodeSuccess?: (data: { nodeData: { provider: string } }) => void;
	// Optional: when provided, AutosaveButton is shown and uses these
	isAutosaveEnabled?: boolean;
	onAutosaveEnabledChange?: (enabled: boolean) => void;
	// Optional: when provided, external links (OAuth, docs, usage) use this instead of window.open/location
	onOpenLink?: (url: string) => void;
	// Optional: when provided, preferences use these instead of localStorage (host can use settings.json etc.)
	getPreference?: (key: string) => unknown;
	setPreference?: (key: string, value: unknown) => void;
	// Optional: host can register for panel actions (e.g. tour opening create-node panel)
	onRegisterPanelActions?: (actions: { toggleActionsPanel?: (type?: ActionsType) => void }) => void;
	// Optional: host shows log history (e.g. drawer); canvas calls this when user opens logs or after run
	onOpenLogHistory?: () => void;
	/** Google Picker API keys; host passes from env/config. Forwarded to formContext for GoogleDrivePickerWidget. */
	googlePickerDeveloperKey?: string;
	googlePickerClientId?: string;
	/** Optional: when provided, called when pipeline content changes (nodes, edges, etc.) with current project. Not called for viewport-only changes. */
	onContentChanged?: (project: IProject) => void;
}

/**
 * Context provider that owns all canvas state and exposes it via {@link IFlowContext}.
 *
 * Responsibilities:
 * - Deserialises the incoming `IProject` into ReactFlow nodes and edges.
 * - Manages node CRUD (add, update, delete, group, ungroup).
 * - Handles edge connection/disconnection keeping `node.data.input` and
 *   `node.data.controlConnections` as the single source of truth.
 * - Provides save, run, and abort pipeline actions.
 * - Tracks toolchain state (saving, running, pending) and disables UI accordingly.
 * - Exposes import/export and navigation-mode hooks.
 * - Notifies the host of content changes (dirty-state) when nodes or edges change.
 */
export const FlowProvider = ({
	children,
	oauth2RootUrl,
	project: currentProject,
	projects = [],
	taskStatuses,
	componentPipeCounts,
	totalPipes,
	panel,
	activeNodeId,
	features = DEFAULT_FLOW_FEATURES,
	inventory,
	servicesJson,
	servicesJsonError,
	inventoryConnectorTitleMap,
	runPipeline: _runPipeline,
	stopPipeline: _stopPipeline,
	handleValidatePipeline,
	saveProject,
	onAddNodeSuccess,
	isAutosaveEnabled,
	onAutosaveEnabledChange,
	onOpenLink,
	getPreference,
	setPreference,
	onRegisterPanelActions,
	onOpenLogHistory,
	googlePickerDeveloperKey,
	googlePickerClientId,
	onContentChanged,
}: IProps): ReactElement => {
	const { openSnackbar } = useSnackbar();
	const { t } = useTranslation();

	// Ref to the canvas DOM element; used for coordinate conversion and positioning
	const canvasRef = useRef<HTMLDivElement | null>(null);

	//
	// React Flow
	//
	const {
		screenToFlowPosition,
		setViewport,
		getIntersectingNodes,
		deleteElements,
		getInternalNode,
		getViewport,
		toObject,
		setCenter,
		getNode,
	} = useReactFlow();

	// Tracks which nodes are currently multi-selected (e.g. via lasso or Shift+click)
	const [selectedNodes, setSelectedNodes] = useState<Node[]>([]);
	// Node IDs whose form data failed validation -- used to highlight errors in the UI
	const [nodeIdsWithErrors, setNodeIdsWithErrors] = useState<string[]>([]);
	// When a run is blocked by validation errors, stores the node ID so "re-run" can resume
	const [nodeIdToRerun, setNodeIdToRerun] = useState<string | null>(null);

	// TODO: refactor selecting nodes functionality to only use this method
	const onSelectionChange = useCallback(({ nodes: _selectedNodes }: { nodes: Node[] }) => {
		setSelectedNodes(_selectedNodes);
	}, []);

	useOnSelectionChange({
		onChange: onSelectionChange,
	});

	const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

	// id->Node lookup map, rebuilt whenever nodes change; avoids O(n) scans in hot paths
	const nodeMap = useMemo(() => Object.fromEntries(nodes.map((n: Node) => [n.id, n])), [nodes]);

	const { navigationMode, setNavigationMode } = useNavigationMode(getPreference, setPreference);

	const [isLocked, setIsLocked] = useState(false);
	const handleLock = useCallback(() => setIsLocked((prev) => !prev), []);

	// Selected Node/Handle
	const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(activeNodeId);

	const selectedNode = useMemo(
		() => (selectedNodeId ? nodes.find((n: Node) => n.id === selectedNodeId) : undefined),
		[selectedNodeId, nodes]
	);

	const [selectedHandle, _setSelectedHandle] = useState<NodeHandleSelection | undefined>(
		undefined
	);

	const setSelectedNode = (nodeId?: string) => {
		// Do nothing if selecting already selected node
		if (nodeId === selectedNodeId) return;

		// Reset selected handle
		setSelectedHandle(undefined, undefined, undefined);

		// Set the selected node
		setSelectedNodeId(nodeId);
	};

	const setSelectedHandle = (
		nodeId?: string,
		handleId?: string,
		keys?: string[],
		inputKey?: string
	) => {
		// Build the tuple only when both nodeId and handleId are present; clear otherwise
		const tuple: NodeHandleSelection | undefined =
			nodeId != null && handleId != null ? [nodeId, handleId, keys ?? [], inputKey] : undefined;
		_setSelectedHandle(tuple);
	};

	const [tempNode, setTempNode] = useState<Record<string, unknown> | undefined>(undefined);

	const [hoveredGroupNodeId, setHoveredGroupNodeId] = useState<string | undefined>(undefined);

	//
	// Panel
	//
	const [actionsPanelType, setActionsPanelType] = useState(panel);
	const [actionPannelBlocked, setActionPanelBlocked] = useState(false);
	const [actionsPanelData, setActionsPanelData] = useState<Record<string, unknown>>({});

	// Open/close actions panel: passing undefined closes it; a type value opens that panel
	const toggleActionsPanel = (type?: ActionsType, data?: Record<string, unknown>) => {
		setActionsPanelType(type);
		// Only overwrite panel data when the caller explicitly provides it
		if (data) {
			setActionsPanelData(data);
		}
	};

	//
	// Auth
	//
	const [oAuthPanelInit, setOAuthPanelInit] = useState(false);

	// Extract OAuth query parameters that the auth redirect lands on (used to auto-open the node panel)
	const authType = getNativeQueryParam('type');
	const clientId = getNativeQueryParam('client_id');
	const clientSecret = getNativeQueryParam('client_secret');
	const nodeId = getNativeQueryParam('node_id');
	// Google OAuth passes additional state as a JSON-encoded query param
	const state = getNativeQueryParam('state');

	//
	// Toolchain State
	//
	const [toolchainState, setToolchainState] = useState<IToolchainState>(defaultToolchainState);

	// Derive running state from task statuses: true if any task is neither completed nor cancelled
	const isPipelineRunning = useMemo(
		() =>
			Object.values(taskStatuses ?? {}).filter(
				(status) =>
					status.state !== TASK_STATE.COMPLETED && status.state !== TASK_STATE.CANCELLED
			).length > 0,
		[taskStatuses]
	);

	// Import/Export functionality
	const { importToolchain, exportToolchain, exportOptions, setExportOptions } = useImportExport({
		nodes,
		project: currentProject,
		servicesJson: servicesJson as IDynamicForms,
		setNodes,
		setEdges,
		setViewport,
	});

	// When true, node/edge changes should trigger onContentChanged (skip right after initial load)
	const contentChangeEnabledRef = useRef(false);

	const onToolchainUpdated = useCallback(() => {
		// Mark the toolchain as dirty (unsaved changes exist)
		setToolchainState((prev) => ({
			...prev,
			isUpdated: true,
			isSaved: false,
		}));
		// Notify host only for real content changes (not selection).
		// Defer 50ms so React has committed the latest nodes/edges before we serialise.
		if (onContentChanged && contentChangeEnabledRef.current) {
			setTimeout(() => {
				const flowObject = toObject();
				const name = currentProject?.name;
				const description = currentProject?.description;
				const version = currentProject?.version;
				// Serialise the current canvas state into the IProject format for the host
				const project = objectToProperty(flowObject, name, description, version);
				// Preserve project_id so the host (and echoed 'update') keep it; otherwise Save would generate a new uuid
				if (currentProject?.project_id) {
					project.project_id = currentProject.project_id;
				}
				onContentChanged(project);
			}, 50);
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [currentProject?.name, currentProject?.description, currentProject?.version, onContentChanged]);

	const detectChange = useCallback((changes: NodeChange[]) => {
		// Ignore cosmetic changes (select/deselect, dimensions) and only fire for structural ones
		const meaningfulChanges = changes.filter((change) =>
			['add', 'remove', 'position'].includes(change.type)
		);

		if (meaningfulChanges.length > 0) {
			onToolchainUpdated();
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	//
	// Node Related
	//

	const addNode = useCallback(
		(
			data: Record<string, unknown>,
			position?: NodePosition,
			type: NodeType = NodeType.Default
		) => {
			// Generate a collision-free ID based on the provider name
			const id = generateId(nodes, data.provider as string);

			// Use the caller-supplied position or fall back to a centred default
			const _position = position
				? position
				: getDefaultNodePosition(
						NodeType.RemoteGroup,
						canvasRef,
						nodes,
						screenToFlowPosition
					);

			// Dispatch to the annotation factory or the standard node factory
			const node =
				type === NodeType.Annotation
					? createAnnotationNode(id, _position, data)
					: createNode(id, _position, data);

			const nd = node.data as INodeData;
			const savedFormData = nd.formData ?? {};
			const hasExistingData = Object.keys(savedFormData).length > 0;

			if (nd.Pipe?.schema) {
				if (hasExistingData) {
					// Duplicated nodes already carry form data -- keep it as-is
					nd.formData = savedFormData;
				} else {
					// Brand-new node: resolve default values from the JSON schema
					const resolvedFormData = resolveDefaultFormData(id, nd.Pipe.schema);
					nd.formData = resolvedFormData;

					// Eagerly validate so the node can show a red/green indicator immediately
					const validationResult = validateFormData(
						nd.Pipe.schema,
						nd.formData
					);

					nd.formDataValid = validationResult.errors.length === 0;
				}
			}
			// Notify the host (e.g. analytics) about the newly added node
			onAddNodeSuccess?.({
				nodeData: {
					provider: data.provider as string,
				},
			});

			// Append the new node to the end of the array
			setNodes((nds: Node[]) => [...nds, node]);
			onToolchainUpdated();
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[nodes, selectedHandle, setEdges, screenToFlowPosition, canvasRef]
	);

	const addAnnotationNode = useCallback(() => {
		const id = generateId(nodes, NodeType.Annotation);
		const position = getDefaultNodePosition(
			NodeType.Annotation,
			canvasRef,
			nodes,
			screenToFlowPosition
		);
		const node = createAnnotationNode(id, position);
		setNodes((nds: Node[]) => [...nds, node]);
		onToolchainUpdated();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [nodes, screenToFlowPosition, canvasRef]);

	const addRemoteGroupNode = useCallback(
		(data: Record<string, unknown>, position?: NodePosition) => {
			const id = generateId(nodes, NodeType.RemoteGroup);
			const _position = position
				? position
				: getDefaultNodePosition(
						NodeType.RemoteGroup,
						canvasRef,
						nodes,
						screenToFlowPosition
					);
			const node = createRemoteGroupNode(id, _position, data);

			// ReactFlow renders nodes in array order; group nodes must come first
			// so child nodes render on top and receive pointer events correctly.
			const groupNodes = [
				...nodes.filter((n: Node) => n.type === NodeType.RemoteGroup),
				node,
			];
			const otherNodes = nodes.filter((n: Node) => n.type !== NodeType.RemoteGroup);
			const _nodes = [...groupNodes, ...otherNodes];

			setNodes(_nodes);
			onToolchainUpdated();
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[nodes, screenToFlowPosition, canvasRef]
	);

	const groupSelectedNodes = useCallback(
		(size: { width: number; height: number }, position: NodePosition) => {
			// Create a new group node that will visually contain the selected nodes
			const groupNodeId = generateId(nodes, NodeType.Group);
			const groupNode = createGroupNode(groupNodeId, position, {}, size);
			(groupNode.data as INodeData).isLocked = true;
			groupNode.style = { ...groupNode.style, zIndex: 1001 };

			// Re-parent each selected node under the new group, converting absolute
			// positions to group-relative coordinates and raising their zIndex.
			const updatedNodes: Node[] = nodes.map((node) => {
				const isSelected = selectedNodes.some(
					(selectedNode: Node) => selectedNode.id === node.id
				);
				return isSelected
					? {
							...node,
							position: {
								x: node.position.x - position.x,
								y: node.position.y - position.y,
							},
							parentId: groupNodeId,
							extent: 'parent',
							style: { ...node.style, zIndex: 1000 },
							selected: false,
						}
					: node;
			});

			// Group node must be first so ReactFlow renders children on top
			setNodes([groupNode, ...updatedNodes]);
			setSelectedNodes([]);
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[nodes, selectedNodes]
	);

	const updateNode = useCallback(
		(nodeId: string, data: Record<string, unknown>): Node | undefined => {
			let updatedNode: Node | undefined;

			setNodes((nds: Node[]) =>
				nds.map((n: Node) => {
					if (n.id !== nodeId) return n;
					const _updatedNode = {
						...n,
						data: { ...n.data, ...data },
					};

					updatedNode = _updatedNode;
					return _updatedNode;
				})
			);

			return updatedNode;
		},
		[setNodes]
	);

	const onEditNode = useCallback(() => {
		toggleActionsPanel(ActionsType.Node);
	}, []);

	const onDoubleClickNode = useCallback((node: Node) => {
		setSelectedNode(node.id);
		toggleActionsPanel(ActionsType.Node);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const onNodeDrag = useCallback(
		(event: MouseEvent, node: Node) => {
			// Signal that a drag is in progress (used to suppress actions during drag)
			setToolchainState((prev) => ({
				...prev,
				isDragging: true,
			}));

			if (node.parentId) {
				// Node is already inside a group -- keep highlighting its parent
				setHoveredGroupNodeId(node.parentId);
			}

			// For top-level nodes, detect whether the drag position overlaps a group
			else if (!node.parentId) {
				const groupNode = getIntersectingNodes(node, true, nodes).find(
					(n: Node) => n.id !== node.id && n.type === NodeType.RemoteGroup
				);
				if (!groupNode) {
					setHoveredGroupNodeId(undefined);
				} else {
					// Highlight the group the node is hovering over (visual drop target feedback)
					setHoveredGroupNodeId(groupNode.id);
				}
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[nodes, setNodes, setToolchainState]
	);

	const onNodeDragStop = useCallback(
		(event: MouseEvent, node: Node) => {
			// Clear the dragging flag so the UI re-enables actions
			setToolchainState((prev) => ({
				...prev,
				isDragging: false,
			}));

			setHoveredGroupNodeId(undefined);

			// Nodes that already belong to a group, or are groups themselves, can't be re-parented
			if (
				node.parentId != null ||
				node.type === NodeType.RemoteGroup ||
				node.type === NodeType.Group
			)
				return;

			// Check whether the drop position overlaps with any group node
			const groupNode = getIntersectingNodes(node, true, nodes).find(
				(n: Node) =>
					n.id !== node.id &&
					(n.type === NodeType.RemoteGroup || n.type === NodeType.Group)
			);

			if (!groupNode) return;

			// Clamp the position to stay within the group's bounds
			const position = getNodePositionInsideParent(node, groupNode);
			if (!position) return;

			// Re-parent the dropped node inside the group and convert to parent-relative coordinates
			setNodes((nds: Node[]) =>
				nds.map((n: Node) => {
					if (n.id !== node.id) return n;
					return {
						...node,
						position,
						parentId: groupNode.id,
						extent: 'parent',
					};
				})
			);
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[nodes, setNodes, setToolchainState]
	);

	const ungroupNode = useCallback(
		(nodeIds: string[]) => {
			for (const id of nodeIds) {
				const node = nodeMap?.[id];
				// Skip nodes that are not inside a group
				if (node?.parentId == null) return;

				// Convert parent-relative position back to absolute canvas coordinates
				const parentNode = getInternalNode(node.parentId);

				const position = {
					x: node.position.x + (parentNode?.internals.positionAbsolute.x ?? 0),
					y: node.position.y + (parentNode?.internals.positionAbsolute.y ?? 0),
				};

				// Detach the node from its parent group
				setNodes((nds: Node[]) =>
					nds.map((n: Node) => {
						if (n.id !== id) return n;
						const _node: Node = {
							...n,
							position,
							parentId: undefined,
							expandParent: undefined,
							extent: undefined,
						};
						return _node;
					})
				);
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[nodeMap, setNodes]
	);

	const onDragOver = useCallback((event: DragEvent) => {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
	}, []);

	const onDrop = useCallback(
		(event: DragEvent) => {
			event.preventDefault();

			// Only process drops that originated from the create-node panel (tempNode is set on drag start)
			if (!tempNode) return;

			// Convert the browser drop coordinates to ReactFlow's coordinate space
			const position = screenToFlowPosition({
				x: event.clientX,
				y: event.clientY,
			});

			// Route to the appropriate factory based on the provider type
			if (tempNode.provider == 'remote') {
				addRemoteGroupNode(tempNode, position);
			} else {
				addNode(tempNode, position);
			}

			// Clear the drag payload so subsequent unrelated drops are ignored
			setTempNode(undefined);
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[screenToFlowPosition, tempNode, nodes]
	);

	const onNodeClick = useCallback(
		(node: Node) => {
			setSelectedNode(node.id);
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[nodes]
	);

	const onHandleClick = useCallback(
		(nodeId: string, handleId: string, keys: string[], inputKey?: string) => {
			toggleActionsPanel(ActionsType.CreateNode);
			setSelectedHandle(nodeId, handleId, keys, inputKey);
		},
		[]
	);

	const onNodesDelete = useCallback(
		(deletedNodes: Node[]) => {
			let newEdges: Edge[] = [];

			// For each deleted node, remove all edges that were connected to it
			deletedNodes.forEach((node: Node) => {
				const connectedEdges = getConnectedEdges([node], edges);
				const remainingEdges = edges.filter((edge) => !connectedEdges.includes(edge));

				newEdges = [...newEdges, ...remainingEdges];
			});

			setEdges(newEdges);

			// Close the node panel if the deleted node was being edited
			if (actionsPanelType === ActionsType.Node) {
				toggleActionsPanel(undefined);
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[nodes, edges, actionsPanelType]
	);

	const deleteNodesById = useCallback(
		(nodeIds: string[], deleteChildren: boolean = false) => {
			const ids = new Set(nodeIds);
			const _nodes = nodes.filter((n: Node) => ids.has(n.id));

			// Build a quick lookup for the nodes being deleted
			const _nodesMap = Object.fromEntries(_nodes.map((n: Node) => [n.id, n]));
			// Identify child nodes that will be orphaned when their parent is deleted
			const childNodes = nodes
				.filter((n: Node) => n.parentId != null && ids.has(n.parentId))
				.map((n: Node) => n.id);
			const childNodeIds = new Set(childNodes);

			let nodesToDelete = _nodes;
			const childNodesToDelete = nodes.filter((n: Node) =>
				n.parentId != null && ids.has(n.parentId)
			);

			// Before deleting the parent, promote its children to top-level by converting
			// their positions back to absolute coordinates and removing parentId/extent.
			setNodes((nds: Node[]) =>
				nds.map((n: Node) => {
					if (!childNodeIds.has(n.id)) return n;
					const parent = _nodesMap[n.parentId!];
					n.position = {
						x: parent.position.x + n.position.x,
						y: parent.position.y + n.position.y,
					};
					delete (n as Partial<Node>)['parentId'];
					delete (n as Partial<Node>)['extent'];
					return n;
				})
			);

			// When deleteChildren is true, also remove all child nodes along with the parent
			if (deleteChildren) {
				nodesToDelete = [...nodesToDelete, ...childNodesToDelete];
			}
			deleteElements({ nodes: nodesToDelete });
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[nodes, setNodes, selectedNodeId, setSelectedNode]
	);

	const toggleGroupLock = useCallback(
		(groupId: string) => {
			setNodes((prevNodes: Node[]) => {
				const groupNode = prevNodes.find((n) => n.id === groupId);

				// Safety check: only valid group types can be locked/unlocked
				if (
					!groupNode ||
					(groupNode.type !== NodeType.Group && groupNode.type !== NodeType.RemoteGroup)
				) {
					console.warn(
						`toggleGroupLock: Group node with id ${groupId} not found or not a valid group type.`
					);
					return prevNodes;
				}

				const currentIsLocked = (groupNode.data as INodeData)?.isLocked || false;
				const newIsLocked = !currentIsLocked;

				return prevNodes.map((n: Node) => {
					if (n.id === groupId) {
						// Update lock state and toggle elevated zIndex for locked groups
						const newStyle = { ...n.style };
						if (newIsLocked) {
							newStyle.zIndex = 1001;
						} else {
							delete newStyle.zIndex;
						}
						return {
							...n,
							data: { ...n.data, isLocked: newIsLocked },
							style: newStyle,
						};
					}
					if (n.parentId === groupId) {
						// Propagate zIndex change to child nodes so they stay above edges when locked
						const newStyle = { ...n.style };
						if (newIsLocked) {
							newStyle.zIndex = 1000;
						} else {
							delete newStyle.zIndex;
						}
						return { ...n, style: newStyle };
					}
					return n;
				});
			});
			onToolchainUpdated();
		},
		[setNodes, onToolchainUpdated]
	);

	const onEdgeConnect = useCallback(
		(params: Connection) => {
			// Connections are stored on the TARGET node (data.input or data.controlConnections)
			// as the single source of truth; edges are then derived from these arrays.
			setNodes((nds) => {
				const updatedNodes = nds.map((node) => {
					if (node.id !== params.target) return node;

					const nd = node.data as INodeData;
					// Distinguish between invoke (control-flow) and lane (data-flow) connections
					if (params.sourceHandle === 'invoke-source') {
						// Extract the target class type from the handle ID suffix
						const classType = params.targetHandle?.split('-')?.at(-1) ?? '';
						const controlConnections: IControl[] = nd.controlConnections || [];

						return {
							...node,
							data: {
								...node.data,
								controlConnections: [
									...controlConnections,
									{
										classType,
										from: params.source,
									},
								],
							},
						};
					} else {
						// Extract the lane name from the source handle ID (format: "source-<lane>")
						const lane = params.sourceHandle?.split('-')?.at(1) ?? '';
						const input: IInputLane[] = nd.input || [];

						return {
							...node,
							data: {
								...node.data,
								input: [
									...input,
									{
										lane,
										from: params.source,
									},
								],
							},
						};
					}
				});

				// Rebuild edges from the updated node data rather than managing edges independently
				const computedEdges = computeEdgesFromNodes(updatedNodes);
				setEdges(computedEdges);

				return updatedNodes;
			});
		},
		[setNodes, setEdges]
	);

	const handleEdgesChange = useCallback(
		(changes: EdgeChange[]) => {
			// Intercept edge removals so we can update the source-of-truth on nodes first
			const removeChanges = changes.filter((c) => c.type === 'remove');

			if (removeChanges.length > 0) {
				setNodes((nds) => {
					// Snapshot edges before they are removed so we can look up connection details
					const currentEdges = edges;

					const updatedNodes = nds.map((node) => {
						let updatedNode = { ...node };

						removeChanges.forEach((change) => {
							const edgeToRemove = currentEdges.find((e) => e.id === change.id);
							// Only process edges whose target is this node
							if (!edgeToRemove || edgeToRemove.target !== node.id) return;

							const und = updatedNode.data as INodeData;
							if (edgeToRemove.sourceHandle === 'invoke-source') {
								// Remove the matching control connection entry
								const controlConnections: IControl[] =
									und.controlConnections || [];
								updatedNode = {
									...updatedNode,
									data: {
										...updatedNode.data,
										controlConnections: controlConnections.filter(
											(c: IControl) => c.from !== edgeToRemove.source
										),
									},
								};
							} else {
								// Remove the matching lane input entry by source+lane pair
								const lane = edgeToRemove.sourceHandle?.split('-')?.at(1) ?? '';
								const input: IInputLane[] = und.input || [];
								updatedNode = {
									...updatedNode,
									data: {
										...updatedNode.data,
										input: input.filter(
											(i: IInputLane) =>
												!(i.from === edgeToRemove.source && i.lane === lane)
										),
									},
								};
							}
						});

						return updatedNode;
					});

					// Rebuild the edge list from the cleaned-up node data
					const computedEdges = computeEdgesFromNodes(updatedNodes);
					setEdges(computedEdges);

					return updatedNodes;
				});
			} else {
				// For non-remove changes (select, etc.), delegate to the default ReactFlow handler
				onEdgesChange(changes);
			}
		},
		[edges, setNodes, setEdges, onEdgesChange]
	);

	const toggleDevMode = useCallback(() => {
		// Close the dev panel if it's currently showing; the mode toggle itself still applies
		if (actionsPanelType === ActionsType.DevPanel) {
			toggleActionsPanel(undefined);
		}
		setToolchainState((prev) => ({
			...prev,
			isDevMode: !prev.isDevMode,
		}));
	}, [actionsPanelType]);

	const focusOnNode = useCallback(
		(nodeId: string) => {
			const node = getNode(nodeId);
			if (node?.position) {
				// Center the view on the node with a zoom level of 2
				setCenter(node.position.x + 200, node.position.y, {
					zoom: 2,
					duration: 800,
				});
			}
		},
		[getNode, setCenter]
	);

	//
	// Project Related
	//

	const saveChanges = useCallback(
		async (data: Partial<IProject> = {}) =>
			new Promise((resolve, reject) => {
				// Defer to the next macrotask so React can flush pending state before serialisation
				setTimeout(async () => {
					try {
						// Enter saving state to disable UI actions during the async save
						setToolchainState((prev) => ({
							...prev,
							isSaving: true,
							isUpdated: false,
							isSaved: false,
						}));

						// Snapshot the current ReactFlow graph (nodes, edges, viewport)
						const flowObject = toObject();

						// Merge any caller-provided overrides (e.g. new name) into the project
						const updatedProject = { ...currentProject, ...data };

						const { version, name, description } = updatedProject;

						// Convert the ReactFlow object into the serialisable IProject format
						const property = objectToProperty(flowObject, name, description, version);

						const _project: IProject = {
							...updatedProject,
							...property,
						};

						// Preserve project_id across saves so running tasks stay matched.
						_project.project_id =
							_project.project_id ??
							updatedProject.project_id ??
							uuid();

						// Delegate to the host-provided persistence callback
						if (saveProject) await saveProject(_project);

						setToolchainState((prev) => ({
							...prev,
							isSaving: false,
							isUpdated: false,
							isSaved: true,
						}));
						resolve(null);
					} catch (error) {
						console.error(error);
						openSnackbar('Failed to save pipeline.', 'error');
						reject(error);
					}
				}, 0);
			}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[currentProject, servicesJson, toolchainState, nodes]
	);

	const runPipeline = useCallback(
		async (nodeId: string) => {
			if (!nodeId) throw new Error(`No node id ${nodeId}`);

			try {
				// Build the pipeline execution request starting from the given source node
				const projectForRun: IProject = {
					version: currentProject?.version,
					name: currentProject?.name,
					description: currentProject?.description,
					components: currentProject?.components,
					source: nodeId,
					project_id: currentProject?.project_id,
				};

				// Ask the backend which nodes are in the execution chain for pre-run validation
				const validationResult = await handleValidatePipeline?.(projectForRun);

				// May be empty when the validation service is unavailable or returns no chain
				const nodesInPipeline = validationResult?.data?.pipeline?.chain || [];

				// Check only the nodes in the pipeline chain; fall back to all nodes if unknown
				const invalidNodes =
					nodesInPipeline.length > 0
						? nodes.filter(
								(n) =>
									(n.data as INodeData).formDataValid === false && nodesInPipeline.includes(n.id)
							)
						: nodes.filter((n) => (n.data as INodeData).formDataValid === false);

				if (invalidNodes.length > 0) {
					// Block the run and highlight the nodes that need fixing
					setNodeIdsWithErrors(invalidNodes.map((n) => n.id));
					// Store the intended source so the user can re-run after fixing errors
					setNodeIdToRerun(nodeId);
					openSnackbar(t('flow.notification.unsavedConnectors'), 'error');
					return;
				}

				setToolchainState((prev) => ({
					...prev,
					isRunning: true,
				}));

				await _runPipeline(projectForRun);
				setToolchainState((prev) => ({
					...prev,
					isRunning: false,
				}));
				setNodeIdToRerun(null);

				// Open the host log panel so the user can see execution output
				onOpenLogHistory?.();

				return true;
			} catch (e: unknown) {
				setToolchainState((prev) => ({
					...prev,
					isRunning: false,
				}));
				const message = e instanceof Error ? e.message : String(e);
				openSnackbar(`${t('flow.notification.runError')}. ${message}`, 'error');
				setNodeIdToRerun(null);
				return false;
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[currentProject, toolchainState, saveChanges, nodes]
	);

	const abortPipeline = useCallback(
		async (nodeId: string) => {
			try {
				await _stopPipeline(currentProject?.project_id ?? '', nodeId);
				openSnackbar(t('flow.notification.abortSuccess'), 'success');
				setToolchainState((prev) => ({
					...prev,
					isRunning: false,
				}));
			} catch (e) {
				console.error('Error aborting pipeline', e);
				openSnackbar(t('flow.notification.abortError'), 'error');
				throw new Error('Error aborting pipeline');
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[currentProject?.project_id, _stopPipeline]
	);

	const loadData = useCallback(async () => {
		// Deserialise the IProject into ReactFlow nodes and edges
		const object = propertyToObject(currentProject, servicesJson as IDynamicForms);

		// For each node, merge schema defaults under the saved formData so missing fields have values
		setNodes(
			object.nodes.map((node) => {
				const nd = node.data as INodeData;
				const savedFormData = nd.formData ?? {};
				if (nd.Pipe?.schema) {
					// Schema defaults go first; saved data overwrites to preserve user edits
					const formData = getDefaultFormState(nd.Pipe.schema);
					nd.formData = {
						...formData,
						...savedFormData,
					};
				}
				return node;
			})
		);
		setEdges(object.edges);

		// Restore the viewport position/zoom. Use queueMicrotask so React Flow processes
		// the new nodes first and doesn't immediately overwrite our viewport with its own fitView.
		const vp = object.viewport;
		if (
			vp &&
			typeof vp.x === 'number' &&
			typeof vp.y === 'number' &&
			typeof vp.zoom === 'number'
		) {
			const savedViewport = { x: vp.x, y: vp.y, zoom: vp.zoom };
			queueMicrotask(() => setViewport(savedViewport));
		}

		// Auto-open the create-node panel when starting a brand-new project (no project_id yet)
		if (!currentProject.project_id) toggleActionsPanel(ActionsType.CreateNode);

		// After an OAuth redirect, auto-select the node and open its config panel
		if (!oAuthPanelInit && authType && clientId && clientSecret && nodeId) {
			setSelectedNode(nodeId);
			toggleActionsPanel(ActionsType.Node);
			setOAuthPanelInit(true);
		}

		// Handle Google OAuth redirect which passes state as JSON with service and node_id
		// TODO: Hack - rework this after EA release
		const parsedState = JSON.parse(state ?? '{}');
		if (parsedState?.service && parsedState?.node_id) {
			setSelectedNode(parsedState.node_id);
			toggleActionsPanel(ActionsType.Node);
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [currentProject, servicesJson, oAuthPanelInit, authType, clientId, clientSecret, nodeId]);

	// Initial load: deserialise the project once both servicesJson and currentProject are available
	useEffect(() => {
		// Guard: wait until the service definitions have been fetched
		if (!Object.keys(servicesJson ?? {}).length) return;
		// Guard: wait until the project payload has been populated
		if (!Object.keys(currentProject ?? {}).length) return;

		// Suppress content-change notifications during the initial load to avoid false dirty state
		contentChangeEnabledRef.current = false;
		loadData();
		// Re-enable notifications after a short delay so React Flow finishes initialising
		const id = setTimeout(() => {
			contentChangeEnabledRef.current = true;
		}, 200);
		return () => clearTimeout(id);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [currentProject, servicesJson]);

	// Keep toolchainState.isRunning in sync with the derived isPipelineRunning flag
	// so the UI reflects the actual task status reported by the host.
	useEffect(() => {
		if (toolchainState.isRunning !== isPipelineRunning) {
			setToolchainState((prev) => ({
				...prev,
				isRunning: isPipelineRunning,
			}));
		}
	}, [isPipelineRunning, toolchainState.isRunning]);

	return (
		<FlowContext.Provider
			value={{
				canvasRef,

				// State
				currentProject,
				toolchainState,
				toggleDevMode,
				features,
				nodeIdsWithErrors,
				nodeIdToRerun,

				edges,
				nodes,

				selectedNode,
				selectedNodeId,
				setSelectedNodeId,
				selectedHandle,
				hoveredGroupNodeId,

				actionPannelBlocked,
				actionsPanelType,
				actionsPanelData,

				isLocked,
				handleLock,

				// ReactFlow Events
				onEditNode,
				onNodeClick,
				onDoubleClickNode,
				onHandleClick,
				onNodesChange: (changes: NodeChange[]) => {
					if (isLocked) return;
					detectChange(changes);
					onNodesChange(changes);
				},
				onEdgesChange: (changes: EdgeChange[]) => {
					if (isLocked) return;
					onToolchainUpdated();
					handleEdgesChange(changes);
				},
				onEdgeConnect: (params: Connection) => {
					if (isLocked) return;
					onToolchainUpdated();
					onEdgeConnect(params);
				},
				onNodeDrag,
				onNodeDragStop,
				onDragOver,
				onDrop: (event: DragEvent) => {
					if (!isLocked) onDrop(event);
				},

				navigationMode,
				setNavigationMode,
				selectedNodes,
				groupSelectedNodes,
				setViewport,
				getViewport,
				focusOnNode,

				// Node Actions
				setSelectedNode,
				setSelectedHandle,
				setTempNode,
				addNode,
				addAnnotationNode,
				addRemoteGroupNode,
				updateNode,
				onNodesDelete,
				deleteNodesById,
				ungroupNode,
				toggleGroupLock,
				setNodes,
				setEdges,
				setSelectedNodes,
				onToolchainUpdated,

				// Panel Actions
				toggleActionsPanel,
				setActionPanelBlocked,

				// Project Actions
				saveChanges,
				runPipeline,
				abortPipeline,

				nodeMap,

				exportToolchain,
				importToolchain,
				exportOptions,
				setExportOptions,

				// Passing props down
				projects,
				taskStatuses,
				componentPipeCounts,
				totalPipes,
				inventory,
				servicesJson,
				servicesJsonError,
				inventoryConnectorTitleMap,
				handleValidatePipeline,
				oauth2RootUrl,

				// Optional host callbacks
				isAutosaveEnabled,
				onAutosaveEnabledChange,
				onOpenLink,
				getPreference,
				setPreference,
				onRegisterPanelActions,
				onOpenLogHistory,
				googlePickerDeveloperKey,
				googlePickerClientId,
			}}
		>
			{children}
		</FlowContext.Provider>
	);
};

/**
 * Convenience hook to consume the FlowContext.
 * Throws if called outside a `<FlowProvider>`, ensuring all canvas children
 * have access to the full canvas state and actions.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const useFlow = (): IFlowContext => {
	const ctx = useContext(FlowContext);
	if (!ctx) throw new Error('useFlow must be used within FlowProvider');
	return ctx;
};
