// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// SQL-UI — DIAGRAM VIEW (reverse-engineered ER canvas on xyflow)
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow } from '@xyflow/react';
import type { Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useShellConnection } from 'shell';
import { Banner, Button, EmptyState } from 'shell';
import type { ISqlEndpoint } from '../connect';
import { refreshSchema, useSchema } from '../schema/schemaStore';
import type { ErNode } from '../canvas/erModel';
import { buildErModel } from '../canvas/erModel';
import { layoutErNodes } from '../canvas/useErLayout';
import TableNode from '../canvas/TableNode';
import { DatabaseIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link DiagramView} component. */
export interface IDiagramViewProps {
	/** The connection whose schema the diagram shows. */
	endpoint: ISqlEndpoint;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	root: {
		flex: 1,
		minHeight: 0,
		minWidth: 0,
		position: 'relative',
		display: 'flex',
	} as CSSProperties,

	// Floating toolbar over the canvas (pipeline-canvas convention).
	toolbar: {
		position: 'absolute',
		top: 12,
		left: 12,
		zIndex: 5,
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		padding: '6px 8px',
		boxShadow: '0 1px 4px rgba(0,0,0,.08)',
	} as CSSProperties,

	toolbarInfo: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		paddingLeft: 4,
	} as CSSProperties,

	bannerWrap: {
		position: 'absolute',
		top: 12,
		left: '50%',
		transform: 'translateX(-50%)',
		zIndex: 5,
		width: 'min(560px, 80%)',
	} as CSSProperties,

	emptyWrap: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	} as CSSProperties,
};

/** Custom node type registration (static — never rebuilt per render). */
const NODE_TYPES = { table: TableNode };

// =============================================================================
// INNER CANVAS
// =============================================================================

/**
 * The canvas body (inside ReactFlowProvider): builds the model from the
 * schema snapshot, runs the elk layout, and renders the flow with the stock
 * Background / MiniMap / Controls plus the floating toolbar.
 */
const DiagramCanvas: React.FC<IDiagramViewProps> = ({ endpoint }) => {
	const { client } = useShellConnection();
	const snapshot = useSchema(endpoint.key);
	const { fitView } = useReactFlow();

	const [nodes, setNodes, onNodesChange] = useNodesState<ErNode>([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
	const [laidOut, setLaidOut] = useState(false);

	// Rebuild run guard: the async layout of a superseded run (newer snapshot
	// or unmount) must not overwrite the current nodes; the pending fit frame
	// is cancelled alongside it.
	const runIdRef = useRef(0);
	const rafRef = useRef(0);

	/**
	 * Rebuild the model from the snapshot and auto-layout it.
	 */
	const rebuild = useCallback(async (): Promise<void> => {
		if (!snapshot.schema) return;
		// Capture this run's id — a later rebuild bumps the ref and this run's
		// results are discarded when they land.
		const runId = ++runIdRef.current;
		const model = buildErModel(snapshot.schema);
		const positioned = await layoutErNodes(model.nodes, model.edges);
		if (runId !== runIdRef.current) return;
		setNodes(positioned);
		setEdges(model.edges);
		setLaidOut(true);
		// Fit after the nodes have painted at their new positions.
		rafRef.current = requestAnimationFrame(() => fitView({ padding: 0.15 }));
	}, [snapshot.schema, setNodes, setEdges, fitView]);

	// Build once per snapshot refresh (refreshedAt bumps on every reflection).
	useEffect(() => {
		setLaidOut(false);
		void rebuild();
		return () => {
			// Supersede any in-flight rebuild and cancel the pending fit frame.
			runIdRef.current += 1;
			cancelAnimationFrame(rafRef.current);
		};
	}, [snapshot.refreshedAt, rebuild]);

	// ── Framing states ───────────────────────────────────────────────────────

	if (snapshot.status === 'error') {
		return (
			<div style={styles.emptyWrap}>
				<EmptyState
					icon={<DatabaseIcon />}
					title="Reverse engineering failed"
					description={snapshot.error ?? 'Schema reflection failed.'}
					action={<Button variant="primary" onClick={() => { if (client) void refreshSchema(client, endpoint); }}>Retry</Button>}
				/>
			</div>
		);
	}

	if (snapshot.status !== 'ready' || !laidOut) {
		return (
			<div style={styles.emptyWrap}>
				<EmptyState
					icon={<DatabaseIcon />}
					title="Reverse engineering"
					description={`Reading tables, keys, and relations from ${endpoint.nodeName} and computing the layout...`}
				/>
			</div>
		);
	}

	return (
		<>
			{/* Floating toolbar (pipeline-canvas convention). */}
			<div style={styles.toolbar}>
				<Button variant="ghost" small onClick={() => { void layoutErNodes(nodes, edges).then((n) => { setNodes(n); requestAnimationFrame(() => fitView({ padding: 0.15 })); }); }}>
					Auto-layout
				</Button>
				<Button variant="ghost" small onClick={() => fitView({ padding: 0.15 })}>Fit</Button>
				<Button
					variant="secondary"
					small
					onClick={() => { if (client) void refreshSchema(client, endpoint); }}
					disabled={!client || snapshot.status !== 'ready'}
				>
					Reverse Engineer
				</Button>
				<span style={styles.toolbarInfo}>
					{nodes.length} tables - {edges.length} relations
				</span>
			</div>

			{snapshot.schema?.error && (
				<div style={styles.bannerWrap}><Banner variant="warning">{snapshot.schema.error}</Banner></div>
			)}

			<ReactFlow
				nodes={nodes}
				edges={edges}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				nodeTypes={NODE_TYPES}
				fitView
				minZoom={0.15}
				proOptions={{ hideAttribution: true }}
				nodesConnectable={false}
				deleteKeyCode={null}
			>
				<Background gap={18} size={1} />
				<MiniMap pannable zoomable />
				<Controls showInteractive={false} />
			</ReactFlow>
		</>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The ER diagram document for one connection: the reverse-engineered schema
 * as table nodes with per-column FK edges, elk auto-layout, and the stock
 * xyflow minimap/controls.
 */
export const DiagramView: React.FC<IDiagramViewProps> = ({ endpoint }) => {
	const { client, isConnected } = useShellConnection();
	const snapshot = useSchema(endpoint.key);

	// A diagram opened before the schema was read kicks the reflection itself.
	useEffect(() => {
		if (client && isConnected && snapshot.status === 'idle') {
			void refreshSchema(client, endpoint);
		}
	}, [client, isConnected, snapshot.status, endpoint]);

	return (
		<div style={styles.root}>
			<ReactFlowProvider>
				<DiagramCanvas endpoint={endpoint} />
			</ReactFlowProvider>
		</div>
	);
};

export default DiagramView;
