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
import { Settings } from 'lucide-react';
import '@xyflow/react/dist/style.css';

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
import { useToolbarOrientation } from './toolbar';
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
// INLINE ICON HELPERS
// =============================================================================

const BxIcon = ({ d, size = 16, color = 'currentColor' }: { d: string; size?: number; color?: string }) => (
	<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill={color}>
		<path d={d} />
	</svg>
);

const BX_PLUS_SQUARE = 'M5 21h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2zm2-10h4V7h2v4h4v2h-4v4h-2v-4H7v-2z';
const BX_UNDO = 'M9 10h6c1.654 0 3 1.346 3 3s-1.346 3-3 3h-3v2h3c2.757 0 5-2.243 5-5s-2.243-5-5-5H9V5L4 9l5 4v-3z';
const BX_REDO = 'M9 18h3v-2H9c-1.654 0-3-1.346-3-3s1.346-3 3-3h6v3l5-4-5-4v3H9c-2.757 0-5 2.243-5 5s2.243 5 5 5z';
const BX_POINTER = 'M20.978 13.21a1 1 0 0 0-.396-1.024l-14-10a.999.999 0 0 0-1.575.931l2 17a1 1 0 0 0 1.767.516l3.612-4.416 3.377 5.46 1.701-1.052-3.357-5.428 6.089-1.218a.995.995 0 0 0 .782-.769zm-8.674.31a1 1 0 0 0-.578.347l-3.008 3.677L7.257 5.127l10.283 7.345-5.236 1.048z';
const BX_SAVE = 'M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z';

const HandIcon = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
	<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
		<path d="M18 11V6.5a1.5 1.5 0 0 0-3 0V11" />
		<path d="M15 11V4.5a1.5 1.5 0 0 0-3 0V11" />
		<path d="M12 11V5.5a1.5 1.5 0 0 0-3 0v10.81l-2.22-3.6a1.5 1.5 0 0 0-2.56 1.58l3.31 5.34A5 5 0 0 0 9.78 22H17a5 5 0 0 0 5-5V11.5a1.5 1.5 0 0 0-3 0V11" />
	</svg>
);

// =============================================================================
// TOOLBAR COMPONENTS
// =============================================================================

const ToolbarButton = ({ title, onClick, isActive = false, disabled = false, forceColor, children }: { title: string; onClick: () => void; isActive?: boolean; disabled?: boolean; forceColor?: string; children: React.ReactNode }) => {
	const [hovered, setHovered] = useState(false);
	const active = isActive && !disabled;
	return (
		<button
			title={title}
			onClick={onClick}
			disabled={disabled}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			style={{
				padding: '4px',
				background: active ? 'color-mix(in srgb, var(--rr-text-secondary) 20%, transparent)' : hovered && !disabled ? 'color-mix(in srgb, var(--rr-text-secondary) 12%, transparent)' : 'none',
				border: 'none',
				cursor: disabled ? 'default' : 'pointer',
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				width: 28,
				height: 28,
				borderRadius: 6,
				color: forceColor ?? 'var(--rr-text-secondary)',
				opacity: disabled ? 0.4 : 1,
				transition: 'background 100ms ease',
			}}
		>
			{children}
		</button>
	);
};

const ToolbarDivider = () => {
	const dir = useToolbarOrientation();
	const isVert = dir === 'vertical';
	return (
		<div
			style={{
				width: isVert ? 16 : 1,
				height: isVert ? 1 : 16,
				background: 'var(--rr-border)',
				margin: isVert ? '2px 0' : '0 2px',
				flexShrink: 0,
			}}
		/>
	);
};

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
	const { canvasRef, nodes, edges, nodeMap, setNodes, onNodesChange, onEdgesChange, onEdgeConnect, onNodesDelete, onDragOver, onDrop, onNodeDragStop, isValidConnection, editingNodeId, setEditingNodeId, addNode, onContentUpdated, isFlowReady } = useFlowGraph();

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

	const { features, onUndo, onRedo, onViewportChange, isDirty, isNew, onSave, initialViewport } = useFlowProject();
	const { fitView, zoomIn, zoomOut, setViewport } = useReactFlow();

	// Keep a ref so the restore handler always sees the latest viewport value
	// without needing to re-register the event listener.
	const initialViewportRef = useRef(initialViewport);
	useEffect(() => {
		initialViewportRef.current = initialViewport;
	}, [initialViewport]);

	// Restore saved viewport on initial ReactFlow mount.
	const handleInit = useCallback(() => {
		if (initialViewportRef.current) {
			setViewport(initialViewportRef.current, { duration: 0 });
		}
	}, [setViewport]);

	// Restore viewport when the shell activates this tab (canvas:restoreViewport
	// is dispatched by ProjectView when it receives shell:viewActivated).
	useEffect(() => {
		const handler = () => {
			if (initialViewportRef.current) {
				setViewport(initialViewportRef.current, { duration: 0 });
			}
		};
		window.addEventListener('canvas:restoreViewport', handler);
		return () => window.removeEventListener('canvas:restoreViewport', handler);
	}, [setViewport]);

	// --- Auto-layout -------------------------------------------------------
	const { autoLayout, isLayouting } = useAutoLayout(nodes, edges, setNodes, onContentUpdated);

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

	// --- Canvas toolbar --------------------------------------------------------
	const canvasToolbar = (
		<>
			<ToolbarButton
				title="Add node"
				onClick={() => {
					setShowCreatePanel((v) => {
						if (!v) setEditingNodeId(undefined);
						return !v;
					});
				}}
				isActive={showCreatePanel}
				forceColor="var(--rr-brand)"
			>
				<BxIcon d={BX_PLUS_SQUARE} size={16} />
			</ToolbarButton>
			{features.addAnnotation && (
				<ToolbarButton title="Add annotation" onClick={addAnnotation}>
					<NoteIcon color="currentColor" size={18} />
				</ToolbarButton>
			)}
			<ToolbarDivider />
			<ToolbarButton title={isLocked ? 'Unlock canvas' : 'Lock canvas'} onClick={toggleLock} isActive={isLocked}>
				{isLocked ? <LockIcon color="currentColor" size={18} /> : <UnlockIcon color="currentColor" size={18} />}
			</ToolbarButton>
			<ToolbarButton title="Fit to screen" onClick={() => fitView()}>
				<FitIcon color="currentColor" size={18} />
			</ToolbarButton>
			{features.autoLayout !== false && (
				<ToolbarButton title="Tidy layout" onClick={autoLayout} disabled={isLayouting || nodes.length === 0}>
					<TidyIcon color="currentColor" size={18} />
				</ToolbarButton>
			)}
			<ToolbarButton title="Zoom in" onClick={() => zoomIn()}>
				<ZoomInIcon color="currentColor" size={18} />
			</ToolbarButton>
			<ToolbarButton title="Zoom out" onClick={() => zoomOut()}>
				<ZoomOutIcon color="currentColor" size={18} />
			</ToolbarButton>
			<ToolbarDivider />
			{onUndo && (
				<ToolbarButton title="Undo" onClick={onUndo}>
					<BxIcon d={BX_UNDO} size={16} />
				</ToolbarButton>
			)}
			{onRedo && (
				<ToolbarButton title="Redo" onClick={onRedo}>
					<BxIcon d={BX_REDO} size={16} />
				</ToolbarButton>
			)}
			<ToolbarButton title="Select mode" onClick={() => setNavigationMode(NavigationMode.SELECT)} isActive={!isPanMode}>
				<BxIcon d={BX_POINTER} size={16} />
			</ToolbarButton>
			<ToolbarButton title="Pan mode" onClick={() => setNavigationMode(NavigationMode.DRAG)} isActive={isPanMode}>
				<HandIcon size={16} />
			</ToolbarButton>
			{features.save && onSave && (
				<>
					<ToolbarDivider />
					<ToolbarButton title={isNew ? 'Save As…' : 'Save'} onClick={onSave} disabled={!isDirty && !isNew} forceColor={isDirty ? 'var(--rr-brand)' : undefined}>
						<BxIcon d={BX_SAVE} size={16} />
					</ToolbarButton>
				</>
			)}
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
				onInit={handleInit}
				onMoveEnd={(_event, viewport) => onViewportChange?.(viewport)}
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
				<Background color="var(--rr-text-disabled)" gap={20} style={{ backgroundColor: 'var(--rr-bg-default)' }} />
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
