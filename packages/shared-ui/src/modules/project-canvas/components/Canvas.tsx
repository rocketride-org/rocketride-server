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

import { ReactElement, useMemo, useEffect, useCallback } from 'react';
import { Node as RFNode, ReactFlow, Background } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTheme } from '@mui/material/styles';
import { isMacOs } from 'react-device-detect';

import { isInVSCode } from '../../../utils/vscode';
import { canvasBackgroundStyles } from './styles';
import { useKeyDown } from '../../../hooks/useKeyDown';
import { useSearchParams } from '../../../hooks/useSearchParams';

import Node from './nodes/node/Node';
import Edge from './edges/edge/Edge';
import AnnotationNode from './nodes/annotation/AnnotationNode';
import RemoteGroupNode from './nodes/remote/RemoteGroupNode';
import GroupNode from './nodes/group/GroupNode';
import ContextMenu from './ContextMenu';

import SearchPanel from './SearchPanel';
import ActionsPanel from './ActionsPanel';
import { useFlow } from '../FlowContext';
import Controls from './controls/Controls';
import FloatingGroupButton from './floating-group-button/FloatingGroupButton';
import {
	useArrowNavigation,
	useDevMode,
	useRunPipeline,
	useSelectAll,
	useGroup,
	useUngroup,
	useSave,
	useCopy,
	usePaste,
	useNodeTraversal,
	useUndoRedo,
} from './helpers/shortcuts';

import { ActionsType, getDefaultCanvasProps, NodeType, SHORTCUTS } from '../constants';
import useCanvasState from '../hooks/useCanvasState';
import ServicesJsonError from './ServicesJsonError';

/**
 * Registry of custom ReactFlow node type components.
 * Maps each NodeType enum value to its corresponding React component so that
 * ReactFlow can render the correct node UI for each type in the pipeline canvas.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes: Record<string, any> = {
	[NodeType.RemoteGroup]: RemoteGroupNode,
	[NodeType.Group]: GroupNode,
	[NodeType.Annotation]: AnnotationNode,
	[NodeType.Default]: Node,
};

/**
 * Registry of custom ReactFlow edge type components.
 * Maps the default edge type to the custom Edge component for rendering
 * connections between nodes on the pipeline canvas.
 */
const edgeTypes = {
	default: Edge,
};

/**
 * The main pipeline canvas component that hosts the ReactFlow graph editor.
 * Renders all pipeline nodes and edges, wires up keyboard shortcuts (save, copy/paste,
 * undo/redo, grouping, etc.), manages the actions panel, search panel, context menu,
 * snap-to-grid controls, and floating group button. This is the central interactive
 * workspace where users visually build and edit their data pipelines.
 *
 * @returns The full canvas view including ReactFlow, overlays, and panels.
 */
export default function Canvas(): ReactElement {
	// Get MUI theme for dynamic background color based on host environment
	const theme = useTheme();
	// Detect VS Code webview to apply alternative styling (e.g., background)
	const inVSCode = isInVSCode();

	// Check if loading from a template so we can fit-view on initial render
	const [searchParams] = useSearchParams();
	const templateId = searchParams.get('templateId');

	// Custom Contexts
	const {
		actionsPanelType,
		canvasRef,
		edges,
		nodes,
		setSelectedNode,
		toggleActionsPanel,
		onNodeClick,
		onDoubleClickNode,
		onNodesChange,
		onNodesDelete,
		onEdgesChange,
		onEdgeConnect,
		onNodeDrag,
		onNodeDragStop,
		onDragOver,
		onDrop,
		navigationMode,
		isLocked,
		handleLock,
		addAnnotationNode,
		toolchainState,
		currentProject,
		features,
		projects,
		servicesJsonError,
		onToolchainUpdated,
		nodeIdsWithErrors,
		focusOnNode,
		getPreference,
		setPreference,
		onRegisterPanelActions,
	} = useFlow();
	// Wire up undo/redo handlers; they wrap onToolchainUpdated to persist state snapshots
	const { undoLastChange, redoLastChange } = useUndoRedo(onToolchainUpdated);
	// Canvas-level state for snap-to-grid settings and the right-click context menu
	const {
		snapToGrid,
		snapGridSize,
		contextMenu,
		handleToggleSnapToGrid,
		handleChangeSnapGrid,
		onPaneContextMenu,
		handleCloseContextMenu,
	} = useCanvasState(getPreference, setPreference);

	// Expose panel toggle to the host app (e.g., for guided tour to programmatically open panels)
	useEffect(() => {
		onRegisterPanelActions?.({ toggleActionsPanel });
	}, [toggleActionsPanel, onRegisterPanelActions]);

	// Register all keyboard shortcuts for canvas interactions
	useArrowNavigation();

	useNodeTraversal({ containerRef: canvasRef as React.RefObject<HTMLElement> });

	useKeyDown(SHORTCUTS.SAVE, useSave());

	useKeyDown(SHORTCUTS.DEV_MODE, useDevMode());
	useKeyDown(SHORTCUTS.UNGROUP, useUngroup());
	useKeyDown(SHORTCUTS.GROUP, useGroup());
	useKeyDown(SHORTCUTS.COPY, useCopy());
	useKeyDown(SHORTCUTS.PASTE, usePaste());
	useKeyDown(SHORTCUTS.RUN_PIPELINE, useRunPipeline());
	useKeyDown(SHORTCUTS.SELECT_ALL, useSelectAll());
	// Conditionally bind undo/redo shortcuts; use no-op when the feature is disabled
	useKeyDown(SHORTCUTS.UNDO, features?.undo ? undoLastChange : () => {});
	useKeyDown(SHORTCUTS.REDO, features?.redo ? redoLastChange : () => {});

	/**
	 * Handles clicks on the empty canvas pane area.
	 * Deselects the current node and closes any open action panels, unless
	 * the user is currently editing a node. Also dismisses the context menu.
	 */
	const onPaneClick = (event: React.MouseEvent) => {
		// Only handle clicks on the pane background, not bubbled clicks from nodes
		if (!(event.target as HTMLElement).closest('.react-flow__node')) {
			// Prevent deselection while the node config panel is open to avoid losing edits
			if (actionsPanelType === ActionsType.Node) {
				return;
			}
			// Clear selected node and close any open side panels
			setSelectedNode(undefined);
			toggleActionsPanel(undefined);
		}
		// Always dismiss the right-click context menu on any pane click
		handleCloseContextMenu();
	};

	// Merge navigation mode and user lock into ReactFlow default props
	const defaultProps = getDefaultCanvasProps(navigationMode, isLocked);

	/**
	 * Determines whether the "Save As" action should be disabled.
	 * Save As is disabled when the current project is new (not yet persisted)
	 * because there is no existing project to fork from.
	 */
	const disableSaveAs = useMemo(() => {
		// A project is "new" if its ID does not exist in the projects map (not yet persisted)
		const projectIsNew = Object.keys(projects).every(
			(projectId: string) => projectId !== currentProject.project_id
		);

		// Disable Save As for new projects since there is nothing to fork from
		return projectIsNew;

	}, [currentProject, projects]);

	/**
	 * Opens the node configuration panel and focuses on the first node
	 * that has validation errors, allowing the user to fix the issue.
	 */
	const showNodeConfiguration = useCallback(() => {
		// Pick the first node that has validation errors
		const firstErrorNode = nodeIdsWithErrors[0];

		if (firstErrorNode) {
			// Open the node config panel, select the error node, and pan the viewport to it
			toggleActionsPanel(ActionsType.Node);
			setSelectedNode(firstErrorNode);
			focusOnNode(firstErrorNode);
		}
	}, [toggleActionsPanel, setSelectedNode, nodeIdsWithErrors, focusOnNode]);

	// Auto-navigate to the first node with errors whenever the error list changes
	useEffect(() => {
		if (nodeIdsWithErrors?.length === 0) return;

		showNodeConfiguration();

	}, [nodeIdsWithErrors, showNodeConfiguration]);

	return (
		<div style={{ height: '100%' }}>
			<ReactFlow
				id="pipelines-reactflow"
				ref={canvasRef as React.RefObject<HTMLDivElement>}
				nodes={servicesJsonError ? [] : nodes}
				edges={servicesJsonError ? [] : edges}
				onPaneClick={onPaneClick}
				onPaneContextMenu={onPaneContextMenu as (event: React.MouseEvent | MouseEvent) => void}
				deleteKeyCode={isMacOs ? ['Delete', 'Backspace'] : ['Delete']} // Mac: Delete+Backspace, Windows: Delete only
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onNodesDelete={onNodesDelete}
				onConnect={onEdgeConnect}
				onNodeClick={(event: React.MouseEvent, node: RFNode) => {
					event.stopPropagation();
					onNodeClick(node);
				}}
				onNodeDoubleClick={(event: React.MouseEvent, node: RFNode) => {
					event.stopPropagation();
					onDoubleClickNode(node);
				}}
				onBeforeDelete={async () => !isLocked}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				onNodeDrag={onNodeDrag as any}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				onNodeDragStop={onNodeDragStop as any}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				onDragOver={onDragOver as any}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				onDrop={onDrop as any}
				onMoveEnd={() => {
					// Viewport (pan/zoom) changes do not signal content changed
				}}
				multiSelectionKeyCode={['Shift', 'Ctrl', 'Meta']}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				snapToGrid={snapToGrid}
				snapGrid={snapGridSize}
				{...defaultProps}
				fitView={!!templateId}
			>
				<ServicesJsonError error={servicesJsonError} />
				{snapToGrid && (
					<Background
						gap={snapGridSize}
						style={
							inVSCode
								? {
										background: theme.palette.background.default,
									}
								: canvasBackgroundStyles
						}
					/>
				)}
				<Controls
					itemName={currentProject?.name}
					disableSave={toolchainState.isSaved}
					disableSaveAs={disableSaveAs}
					enableLog={features?.logs}
					enableFitView={features?.fitView}
					enableZoom={features?.zoomIn && features?.zoomOut}
					isLocked={isLocked}
					handleLock={features?.lock ? handleLock : undefined}
					addNode={
						features?.addNode
							? () => toggleActionsPanel(ActionsType.CreateNode)
							: undefined
					}
					addAnnotationNote={features?.addAnnotation ? addAnnotationNode : undefined}
					undo={features?.undo ? undoLastChange : undefined}
					redo={features?.redo ? redoLastChange : undefined}
				/>
				<ActionsPanel />
				<SearchPanel />
				<FloatingGroupButton />
			</ReactFlow>
			{contextMenu && (
				<ContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					snapToGrid={snapToGrid}
					snapGridSize={snapGridSize}
					onToggleSnapToGrid={handleToggleSnapToGrid}
					onChangeSnapGrid={handleChangeSnapGrid}
					onClose={handleCloseContextMenu}
				/>
			)}
		</div>
	);
}
