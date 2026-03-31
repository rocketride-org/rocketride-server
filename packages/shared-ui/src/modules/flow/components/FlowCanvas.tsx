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
 * Canvas — The interactive ReactFlow graph surface for the flow editor.
 *
 * This is the minimal POC canvas that renders nodes and edges using the
 * new FlowProvider context system with the new flow node components.
 *
 * Responsibilities:
 *   - Registers node type components with ReactFlow
 *   - Connects ReactFlow event handlers to FlowGraphContext
 *   - Renders the canvas background (dotted grid)
 *   - Applies navigation mode (pan vs lasso-select) and lock state
 */

import { ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlow, Background, SelectionMode, useReactFlow } from '@xyflow/react';
import { IconButton, Snackbar, Tooltip } from '@mui/material';
import { Settings } from '@mui/icons-material';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import { OpenWith, HighlightAlt, AddBox } from '@mui/icons-material';
import WebhookIcon from '@mui/icons-material/Webhook';
import '@xyflow/react/dist/style.css';

// Design tokens — web defaults, then VS Code overrides (cascade order matters)
import '../../../themes/rocketride-web.css';
import '../../../themes/rocketride-vscode.css';
import './reactflow-overrides.css';

// Flow node components
import { NodeComponent } from './node/node-component';
import { default as NodeAnnotation } from './node/node-annotation';
import { default as NodeGroup } from './node/node-group';

// Flow edge component
import { FlowEdge } from './edge';

// Quick-add popup
import QuickAddPopup from './panels/quick-add/QuickAddPopup';

import { useFlowGraph } from '../context/FlowGraphContext';
import { useFlowPreferences, NavigationMode } from '../context/FlowPreferencesContext';
import { FloatingToolbar } from './toolbar';
import type { IToolbarPosition } from './toolbar/FloatingToolbar';
import CreateNodePanel from './panels/create-node/CreateNodePanel';
import EmptyCanvasPrompt from './EmptyCanvasPrompt';
import NodeConfigPanel from './panels/node-config';
import FitIcon from '../../../assets/icons/FitIcon';
import LockIcon from '../../../assets/icons/LockIcon';
import UnlockIcon from '../../../assets/icons/UnlockIcon';
import ZoomInIcon from '../../../assets/icons/ZoomInIcon';
import ZoomOutIcon from '../../../assets/icons/ZoomOutIcon';
import NoteIcon from '../../../assets/icons/NoteIcon';
import TidyIcon from '../../../assets/icons/TidyIcon';

import { INodeType } from '../types';
import { useFlowProject } from '../context/FlowProjectContext';
import { useAutoLayout } from '../hooks/useAutoLayout';
import { useTemplateInstantiator } from '../hooks/useTemplateInstantiator';
import EndpointInfoModal from '../../../components/pipeline-actions/EndpointInfoModal';
import type { IEndpointInfo } from '../../../components/pipeline-actions/PipelineActions';

// =============================================================================
// Node type registry — maps NodeType to its React component
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes: Record<string, any> = {
	[INodeType.Group]: NodeGroup,
	[INodeType.Annotation]: NodeAnnotation,
	[INodeType.Default]: NodeComponent,
};

// =============================================================================
// Edge type registry
// =============================================================================

const edgeTypes = {
	default: FlowEdge,
};

// =============================================================================
// Default zoom
// =============================================================================

const DEFAULT_ZOOM = 0.75;

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the interactive ReactFlow canvas surface.
 *
 * Reads graph state (nodes, edges, event handlers) from FlowGraphContext
 * and preferences (navigation mode, lock) from FlowPreferencesContext.
 *
 * @returns The ReactFlow canvas with background grid.
 */
export default function Canvas(): ReactElement {
	// --- Graph state from context ------------------------------------------
	const { canvasRef, nodes, edges, nodeMap, setNodes, onNodesChange, onEdgesChange, onEdgeConnect, onNodesDelete, onDragOver, onDrop, onNodeDragStop, isValidConnection, editingNodeId, setEditingNodeId, addNode, onToolchainUpdated } = useFlowGraph();

	// --- Preferences from context ------------------------------------------
	const { navigationMode, setNavigationMode, isLocked, toggleLock, getPreference, setPreference } = useFlowPreferences();

	const { features, onUndo, onRedo, taskStatuses, serverHost, onOpenLink } = useFlowProject();
	const { fitView, zoomIn, zoomOut } = useReactFlow();

	// --- Auto-layout -------------------------------------------------------
	const { autoLayout, isLayouting } = useAutoLayout(nodes, edges, setNodes, onToolchainUpdated);

	// Auto-apply tidy layout on first load (when nodes appear from a file)
	const hasAutoLayouted = useRef(false);
	useEffect(() => {
		if (nodes.length > 0 && !hasAutoLayouted.current && !isLayouting) {
			hasAutoLayouted.current = true;
			// Delay to let nodes measure first
			const timer = setTimeout(() => {
				autoLayout();
			}, 500);
			return () => clearTimeout(timer);
		}
	}, [nodes.length, isLayouting, autoLayout]);

	// --- Template instantiation (must live here, not in the dialog) ---------
	const { instantiateTemplate: rawInstantiateTemplate, requestFitView } = useTemplateInstantiator();
	const [configSnackbar, setConfigSnackbar] = useState<string | null>(null);
	const [isWebhookModalOpen, setIsWebhookModalOpen] = useState(false);

	const instantiateTemplate = useCallback(
		(...args: Parameters<typeof rawInstantiateTemplate>) => {
			const unconfigured = rawInstantiateTemplate(...args);
			if (unconfigured > 0) {
				setConfigSnackbar(unconfigured === 1 ? '1 node needs configuration — look for the red gear' : `${unconfigured} nodes need configuration — look for the red gear`);
			}
			return unconfigured;
		},
		[rawInstantiateTemplate]
	);

	// --- Callback for when a source node is added from the welcome screen ----
	const onNodeAdded = useCallback(
		(nodeId: string, formDataValid: boolean) => {
			requestFitView([nodeId]);
			if (!formDataValid) {
				setConfigSnackbar('1 node needs configuration — look for the red gear');
			}
		},
		[requestFitView]
	);

	// --- Compute ReactFlow props from navigation mode and lock state --------
	const editable = !isLocked;
	const isPanMode = navigationMode === NavigationMode.DRAG;

	// --- Toolbar position from preferences ---------------------------------
	const defaultToolbarPos: IToolbarPosition = { anchorX: 'right', offsetX: 20, anchorY: 'top', offsetY: 20 };
	const storedToolbarPos = getPreference('toolbarPosition') as IToolbarPosition | undefined;
	const toolbarPosition = storedToolbarPos?.anchorX ? storedToolbarPos : defaultToolbarPos;

	const onToolbarPositionChange = useCallback(
		(pos: IToolbarPosition) => {
			setPreference('toolbarPosition', pos);
		},
		[setPreference]
	);

	// --- Annotation shortcut -----------------------------------------------
	const addAnnotation = useCallback(() => {
		addNode(
			{
				provider: 'annotation',
				name: 'Note',
				config: { content: '', bgColor: '#fff9c4', fgColor: '#000000' },
			},
			undefined, // centres in viewport
			INodeType.Annotation
		);
	}, [addNode]);

	// --- Panel state -------------------------------------------------------
	const [showCreatePanel, setShowCreatePanel] = useState(false);

	/** Whether the node config panel should be shown. */
	const showConfigPanel = !!editingNodeId;
	/** The node being edited (derived from editingNodeId). */
	const editingNode = editingNodeId ? nodeMap[editingNodeId] : undefined;

	const endpointEntries = Object.entries(taskStatuses ?? {}).filter(([, status]) => {
		const note = status.notes?.[0];
		if (!(note && typeof note === 'object' && 'url-text' in note && 'url-link' in note && 'auth-text' in note && 'auth-key' in note)) {
			return false;
		}
		const endpointNote = note as IEndpointInfo;
		return /web[\s-]?hook/i.test(endpointNote['url-link']) || /web[\s-]?hook/i.test(endpointNote['url-text'] ?? '');
	}) as [string, { notes: [IEndpointInfo] }][];

	const selectedNodeIds = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
	const activeEndpointEntry = endpointEntries.find(([nodeId]) => selectedNodeIds.has(nodeId)) ?? (endpointEntries.length === 1 ? endpointEntries[0] : undefined);
	const activeEndpointNodeId = activeEndpointEntry?.[0];
	const activeEndpointInfo = activeEndpointEntry?.[1]?.notes?.[0] ?? null;

	// Close create panel when config panel opens
	useEffect(() => {
		if (showConfigPanel) setShowCreatePanel(false);
	}, [showConfigPanel]);

	// Ctrl+A / Cmd+A — select all nodes and suppress browser text selection
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
				e.preventDefault();
				e.stopPropagation();
				setNodes((current) => current.map((n) => ({ ...n, selected: true })));
			}
		};
		document.addEventListener('keydown', handler, true);
		return () => document.removeEventListener('keydown', handler, true);
	}, [setNodes]);

	// --- Toolbar button style ----------------------------------------------
	const iconButtonSx = {
		padding: '4px',
		color: 'var(--rr-text-secondary)',
		'&:hover': { color: 'var(--rr-text-primary)' },
		'& svg': { width: 'auto', height: '16px' },
	};

	return (
		<div ref={canvasRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
			{/* Floating toolbar — draggable, position persisted as % */}
			<FloatingToolbar position={toolbarPosition} onPositionChange={onToolbarPositionChange}>
				{/* Add Node — toggles the create-node panel */}
				<Tooltip title="Add node">
					<IconButton
						onClick={() => {
							setShowCreatePanel((v) => {
								if (!v) setEditingNodeId(undefined);
								return !v;
							});
						}}
						size="small"
						sx={{
							...iconButtonSx,
							color: showCreatePanel ? 'var(--rr-accent)' : iconButtonSx.color,
						}}
					>
						<AddBox />
					</IconButton>
				</Tooltip>

				{/* Add Annotation */}
				{features.addAnnotation && (
					<Tooltip title="Add annotation">
						<IconButton onClick={addAnnotation} size="small" sx={iconButtonSx}>
							<NoteIcon color="currentColor" />
						</IconButton>
					</Tooltip>
				)}

				{/* Lock / Unlock */}
				<Tooltip title={isLocked ? 'Unlock canvas' : 'Lock canvas'}>
					<IconButton onClick={toggleLock} size="small" sx={iconButtonSx}>
						{isLocked ? <LockIcon color="currentColor" /> : <UnlockIcon color="currentColor" />}
					</IconButton>
				</Tooltip>

				{/* Fit view */}
				<Tooltip title="Fit to screen">
					<IconButton onClick={() => fitView()} size="small" sx={iconButtonSx}>
						<FitIcon color="currentColor" />
					</IconButton>
				</Tooltip>

				{/* Auto-layout (Tidy) */}
				{features.autoLayout !== false && (
					<Tooltip title="Tidy layout">
						<span>
							<IconButton onClick={autoLayout} disabled={isLayouting || nodes.length === 0} size="small" sx={iconButtonSx}>
								<TidyIcon color="currentColor" />
							</IconButton>
						</span>
					</Tooltip>
				)}

				{/* Zoom in / out */}
				<Tooltip title="Zoom in">
					<IconButton onClick={() => zoomIn()} size="small" sx={iconButtonSx}>
						<ZoomInIcon color="currentColor" />
					</IconButton>
				</Tooltip>
				<Tooltip title="Zoom out">
					<IconButton onClick={() => zoomOut()} size="small" sx={iconButtonSx}>
						<ZoomOutIcon color="currentColor" />
					</IconButton>
				</Tooltip>

				{/* Undo / Redo */}
				{onUndo && (
					<Tooltip title="Undo">
						<IconButton onClick={onUndo} size="small" sx={iconButtonSx}>
							<UndoIcon />
						</IconButton>
					</Tooltip>
				)}
				{onRedo && (
					<Tooltip title="Redo">
						<IconButton onClick={onRedo} size="small" sx={iconButtonSx}>
							<RedoIcon />
						</IconButton>
					</Tooltip>
				)}

				{/* Navigation mode toggle */}
				<Tooltip title={isPanMode ? 'Switch to lasso select' : 'Switch to pan'}>
					<IconButton onClick={() => setNavigationMode(isPanMode ? NavigationMode.SELECT : NavigationMode.DRAG)} size="small" sx={iconButtonSx}>
						{isPanMode ? <HighlightAlt /> : <OpenWith />}
					</IconButton>
				</Tooltip>

				{/* Webhook quick access — uses selected source when multiple webhooks exist */}
				<Tooltip title={activeEndpointInfo ? 'Open webhook endpoint info' : endpointEntries.length > 1 ? 'Select a webhook source on the canvas to open its endpoint info' : 'Run a webhook source to expose endpoint info'}>
					<span>
						<IconButton onClick={() => setIsWebhookModalOpen(true)} size="small" sx={iconButtonSx} disabled={!activeEndpointInfo}>
							<WebhookIcon fontSize="small" />
						</IconButton>
					</span>
				</Tooltip>
			</FloatingToolbar>

			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onConnect={onEdgeConnect}
				isValidConnection={isValidConnection}
				onNodesDelete={onNodesDelete}
				deleteKeyCode={['Backspace', 'Delete']}
				onDragOver={onDragOver}
				onDrop={onDrop}
				onNodeDragStop={onNodeDragStop}
				/* Navigation mode: pan on drag vs lasso-select on drag */
				selectionMode={SelectionMode.Partial}
				panOnScroll={!isPanMode}
				panOnDrag={isPanMode}
				selectionOnDrag={!isPanMode}
				/* Lock state: disable editing when locked */
				nodesDraggable={editable}
				nodesConnectable={editable}
				nodesFocusable={editable}
				edgesFocusable={editable}
				elementsSelectable={editable}
				/* Viewport defaults */
				defaultViewport={{ x: 0, y: 0, zoom: DEFAULT_ZOOM }}
				proOptions={{ hideAttribution: true }}
				fitView
			>
				<Background color="var(--rr-text-disabled)" gap={20} style={{ backgroundColor: 'var(--rr-bg-paper)' }} />
			</ReactFlow>

			{/* Empty canvas prompt — shown when no nodes and create panel is closed */}
			{nodes.length === 0 && !showCreatePanel && <EmptyCanvasPrompt instantiateTemplate={instantiateTemplate} onNodeAdded={onNodeAdded} />}

			{/* Quick-add popup — appears at handle click position */}
			<QuickAddPopup />

			{/* Create-node panel — slides in from the right */}
			{showCreatePanel && <CreateNodePanel onClose={() => setShowCreatePanel(false)} />}

			{/* Node config panel — slides in from the right */}
			{showConfigPanel && editingNode && <NodeConfigPanel node={editingNode as unknown as import('../types').INode} onClose={() => setEditingNodeId(undefined)} />}
			{/* Configuration reminder after template instantiation */}
			<Snackbar
				open={configSnackbar !== null}
				autoHideDuration={6000}
				onClose={() => setConfigSnackbar(null)}
				anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
				message={
					<span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
						<Settings style={{ color: '#f44336', fontSize: 18 }} />
						{configSnackbar}
					</span>
				}
			/>
			<EndpointInfoModal endpointInfo={activeEndpointInfo} isOpen={isWebhookModalOpen && !!activeEndpointInfo} onClose={() => setIsWebhookModalOpen(false)} onOpenLink={onOpenLink} displayName={activeEndpointNodeId} host={serverHost} />
		</div>
	);
}
