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

import { ReactElement, useCallback, useEffect, useState } from 'react';
import { ReactFlow, Background, SelectionMode, useReactFlow } from '@xyflow/react';
import { Settings, Undo2, Redo2, Move, BoxSelect, PlusSquare } from 'lucide-react';
import '@xyflow/react/dist/style.css';

// Design tokens — light defaults
import '../../../themes/rocketride-default.css';
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
import FloatingToolbar, { type IToolbarPosition } from './toolbar/FloatingToolbar';
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
	const { canvasRef, nodes, edges, nodeMap, setNodes, onNodesChange, onEdgesChange, onEdgeConnect, onNodesDelete, onDragOver, onDrop, onNodeDragStop, isValidConnection, editingNodeId, setEditingNodeId, addNode, onToolchainUpdated, isFlowReady } = useFlowGraph();

	// --- Preferences from context ------------------------------------------
	const { navigationMode, setNavigationMode, isLocked, toggleLock, projectLayout, getPreference, setPreference } = useFlowPreferences();

	// --- Floating toolbar position (persisted via workspace state) ----------
	const toolbarPosition = getPreference('toolbarPosition') as IToolbarPosition | undefined;
	const handleToolbarPositionChange = useCallback(
		(pos: IToolbarPosition) => {
			setPreference('toolbarPosition', pos);
		},
		[setPreference]
	);

	const { features, onUndo, onRedo } = useFlowProject();
	const { fitView, zoomIn, zoomOut } = useReactFlow();

	// --- Auto-layout -------------------------------------------------------
	const { autoLayout, isLayouting } = useAutoLayout(nodes, edges, setNodes, onToolchainUpdated);

	// --- Template instantiation (must live here, not in the dialog) ---------
	const { instantiateTemplate: rawInstantiateTemplate, requestFitView } = useTemplateInstantiator();
	const [configSnackbar, setConfigSnackbar] = useState<string | null>(null);

	// Auto-hide config snackbar after 6 seconds
	useEffect(() => {
		if (configSnackbar === null) return;
		const timer = setTimeout(() => setConfigSnackbar(null), 6000);
		return () => clearTimeout(timer);
	}, [configSnackbar]);

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

	// --- Annotation shortcut -----------------------------------------------
	const addAnnotation = useCallback(() => {
		addNode(
			{
				provider: 'annotation',
				name: 'Note',
				config: { content: '', bgColor: 'var(--rr-annotation-bg-default)', fgColor: 'var(--rr-text-primary)' },
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

	// --- Canvas toolbar component (registered in context for external use) ---
	const iconButtonStyle: React.CSSProperties = {
		padding: '4px',
		color: 'var(--rr-text-secondary)',
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 28,
		height: 28,
	};

	const canvasToolbar = (
		<>
			<button
				title="Add node"
				onClick={() => {
					setShowCreatePanel((v) => {
						if (!v) setEditingNodeId(undefined);
						return !v;
					});
				}}
				style={{ ...iconButtonStyle, color: showCreatePanel ? 'var(--rr-accent)' : iconButtonStyle.color }}
			>
				<PlusSquare size={16} />
			</button>
			{features.addAnnotation && (
				<button title="Add annotation" onClick={addAnnotation} style={iconButtonStyle}>
					<NoteIcon color="currentColor" size={18} />
				</button>
			)}
			<button title={isLocked ? 'Unlock canvas' : 'Lock canvas'} onClick={toggleLock} style={iconButtonStyle}>
				{isLocked ? <LockIcon color="currentColor" size={18} /> : <UnlockIcon color="currentColor" size={18} />}
			</button>
			<button title="Fit to screen" onClick={() => fitView()} style={iconButtonStyle}>
				<FitIcon color="currentColor" size={18} />
			</button>
			{features.autoLayout !== false && (
				<button title="Tidy layout" onClick={autoLayout} disabled={isLayouting || nodes.length === 0} style={iconButtonStyle}>
					<TidyIcon color="currentColor" size={18} />
				</button>
			)}
			<button title="Zoom in" onClick={() => zoomIn()} style={iconButtonStyle}>
				<ZoomInIcon color="currentColor" size={18} />
			</button>
			<button title="Zoom out" onClick={() => zoomOut()} style={iconButtonStyle}>
				<ZoomOutIcon color="currentColor" size={18} />
			</button>
			{onUndo && (
				<button title="Undo" onClick={onUndo} style={iconButtonStyle}>
					<Undo2 size={16} />
				</button>
			)}
			{onRedo && (
				<button title="Redo" onClick={onRedo} style={iconButtonStyle}>
					<Redo2 size={16} />
				</button>
			)}
			<button title={isPanMode ? 'Switch to lasso select' : 'Switch to pan'} onClick={() => setNavigationMode(isPanMode ? NavigationMode.SELECT : NavigationMode.DRAG)} style={iconButtonStyle}>
				{isPanMode ? <BoxSelect size={16} /> : <Move size={16} />}
			</button>
		</>
	);

	return (
		<div ref={canvasRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
			<FloatingToolbar position={toolbarPosition} onPositionChange={handleToolbarPositionChange}>
				{canvasToolbar}
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
				onMoveEnd={() => onToolchainUpdated()}
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
				/* Viewport defaults — fitView is handled programmatically in loadData */
				defaultViewport={{ x: 0, y: 0, zoom: DEFAULT_ZOOM }}
				proOptions={{ hideAttribution: true }}
				snapToGrid={projectLayout.snapToGrid ?? true}
				snapGrid={projectLayout.snapGridSize ?? [10, 10]}
			>
				<Background color="var(--rr-text-disabled)" gap={20} style={{ backgroundColor: 'var(--rr-bg-paper)' }} />
			</ReactFlow>

			{/* Empty canvas prompt — shown when no nodes and create panel is closed */}
			{nodes.length === 0 && !showCreatePanel && isFlowReady && <EmptyCanvasPrompt instantiateTemplate={instantiateTemplate} onNodeAdded={onNodeAdded} />}

			{/* Quick-add popup — appears at handle click position */}
			<QuickAddPopup />

			{/* Create-node panel — slides in from the right */}
			{showCreatePanel && <CreateNodePanel onClose={() => setShowCreatePanel(false)} />}

			{/* Node config panel — slides in from the right */}
			{showConfigPanel && editingNode && <NodeConfigPanel node={editingNode as unknown as import('../types').INode} onClose={() => setEditingNodeId(undefined)} />}
			{/* Configuration reminder after template instantiation */}
			{configSnackbar !== null && (
				<div
					style={{
						position: 'fixed',
						bottom: 62,
						left: '50%',
						transform: 'translateX(-50%)',
						backgroundColor: 'var(--rr-bg-widget)',
						border: '1px solid var(--rr-border)',
						borderRadius: 8,
						padding: '8px 16px',
						boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
						display: 'flex',
						alignItems: 'center',
						gap: 8,
						zIndex: 1400,
						fontSize: 'var(--rr-font-size-widget)',
						color: 'var(--rr-text-primary)',
					}}
				>
					<Settings size={18} style={{ color: 'var(--rr-color-error)' }} />
					{configSnackbar}
				</div>
			)}
		</div>
	);
}
